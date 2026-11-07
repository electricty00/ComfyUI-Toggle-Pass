"""
Multi-Reference Image Encode Node
Supports 3/5/10 reference images for Qwen2.5-VL / FLUX2 workflows.
Each image is encoded into a reference latent and injected into conditioning.

Version: 3.0 - Multiple node classes (3/5/10 images) + Custom output size for img2img
"""

import math
import torch
import torch.nn.functional as F
import comfy.utils
import node_helpers
import comfy.model_management


# ==================== Qwen-Image-2.1 专用 ====================
# 2.1 的文本编码器（comfy/text_encoders/qwen_image21.py）会主动执行
# "drop the system turn" —— 丢弃第二个 <|im_start|> 之前的全部内容（即 system 段）。
# 因此 2.1 下任何写进 system 的指令都会被静默丢弃，导致提示词完全不起作用。
# 官方 TextEncodeQwenImage21 根本没有 instruction 输入，只有 prompt，就是这个原因。
# 结论：2.1 必须把指令并进 user 段的 prompt 文本，绝不能走 system_prompt 参数。
DEFAULT_INSTRUCTION = (
    "Describe the key features of the input image (color, shape, size, "
    "texture, objects, background), then explain how the user's text "
    "instruction should alter or modify the image. Generate a new image "
    "that meets the user's requirements while maintaining consistency "
    "with the original input where appropriate."
)


def _text_for_21(prompt, instruction):
    """2.1 下把 instruction 并进 user 段文本（system 段会被模型丢弃，放那里等于丢指令）。

    默认那段 Flux 时代的英文系统提示对 2.1 无意义，忽略以免污染 prompt。
    """
    text = (prompt or "").strip()
    instr = (instruction or "").strip()
    if not instr or instr == DEFAULT_INSTRUCTION:
        return text
    if not text:
        return instr
    return instr + "\n" + text


def _center_crop(samples, ratio):
    """把 [B, C, H, W] 按目标宽高比居中裁剪（不变形）。"""
    h = samples.shape[2]
    w = samples.shape[3]
    src_ratio = w / h
    if abs(src_ratio - ratio) < 1e-6:
        return samples
    if src_ratio > ratio:
        new_w = min(w, max(1, round(h * ratio)))
        left = (w - new_w) // 2
        return samples[:, :, :, left:left + new_w]
    new_h = min(h, max(1, round(w / ratio)))
    top = (h - new_h) // 2
    return samples[:, :, top:top + new_h, :]


def _ref_target_size(src_w, src_h, ref_size, out_w, out_h, mode):
    """参考图要处理到的像素尺寸（32 的倍数）。

    注意：输出 latent 尺寸由「分辨率参数」决定，**与参考图无关**。
    qwen_image 的 default_ref_method = "index"，参考图与输出各自占一个 index 平面、
    不共用空间坐标，所以尺寸不必同形（官方工作流默认就是「分辨率选择器尺寸 + 参考图各自尺寸」）。

    mode:
      - 参考图保比例 : 按 ref_size² 的面积保原图比例缩放（等同官方 resolution 参数）
      - 参考图裁剪   : 裁到输出宽高比后缩放到输出尺寸（与输出同形，可能丢边缘）
      - 参考图拉伸   : 直接缩放到输出尺寸（画面变形）
    """
    if mode == "参考图裁剪" or mode == "参考图拉伸":
        return max(32, round(out_w / 32) * 32), max(32, round(out_h / 32) * 32)
    ref_size = _safe_int(ref_size, 1024, 0, 4096)
    if 0 < ref_size < 256:
        # 旧工作流参数错位会留下 3、32 这类小值，会把参考图缩成几十像素（画质崩）
        # 256 以下不可能是有效设定（0 另有语义：保持原尺寸），一律视为脏值归位
        ref_size = 1024
    if ref_size <= 0:
        # 官方 resolution=0 语义：保持参考图各自尺寸
        return max(32, round(src_w / 32) * 32), max(32, round(src_h / 32) * 32)
    ratio = src_w / src_h
    base = float(ref_size)
    return (max(32, round(math.sqrt(base * base * ratio) / 32) * 32),
            max(32, round(math.sqrt(base * base / ratio) / 32) * 32))


def _calc_target_size(src_w, src_h, ref_size, match_original):
    """匹配原图尺寸=ON 时输出尺寸取参考图原始尺寸（对齐 32 倍数）。"""
    return max(32, round(src_w / 32) * 32), max(32, round(src_h / 32) * 32)


# ==================== 分辨率选择器（对齐官方 ResolutionSelector）====================
# 官方工作流：ResolutionSelector(宽高比 + 百万像素 + 倍数) -> EmptyLatentImage -> 采样器，
# 且 ComfySwitchNode 默认（on_true）就选这条「分辨率选择器」支路，
# TextEncodeQwenImage21 自带的「跟随参考图尺寸」latent 反而只是备选。
# 所以出图分辨率应该由这组参数决定，参考图只提供内容。
ASPECT_RATIOS = {
    "1:1 (Square)": (1, 1),
    "2:3 (Portrait Photo)": (2, 3),
    "3:2 (Photo)": (3, 2),
    "3:4 (Portrait Standard)": (3, 4),
    "4:3 (Standard)": (4, 3),
    "9:16 (Portrait Widescreen)": (9, 16),
    "16:9 (Widescreen)": (16, 9),
    "21:9 (Ultrawide)": (21, 9),
}
MANUAL_RATIO = "自定义（用输出宽度/高度）"


def _safe_float(v, default, lo=None, hi=None):
    """widget 值可能是 NaN / None / 字符串（旧工作流错位时的典型症状），统一兜底+夹取。"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    if lo is not None:
        f = max(lo, f)
    if hi is not None:
        f = min(hi, f)
    return f


def _safe_int(v, default, lo=None, hi=None):
    return int(_safe_float(v, default, lo, hi))


def _calc_output_size(aspect_ratio, megapixels, multiple, out_w, out_h):
    """宽高比 + 百万像素 + 倍数 -> 出图宽高（官方 ResolutionSelector 同款算法）。

    倍数硬下限取 32：2.1 的 VAE 是 16x 压缩（latent = 像素 // 16，必须整除），
    且 DiT 按 2x2 patch 切分 latent，等于要求像素是 32 的倍数，否则形状会错。
    百万像素夹取到 0.1~16（官方同范围）：填成 1024 这种越界值会算出几万像素宽的图直接 OOM。
    """
    m = max(32, _safe_int(multiple, 32, 32, 256))
    if aspect_ratio not in ASPECT_RATIOS:
        return (max(m, round(_safe_int(out_w, 1024, 16, 8192) / m) * m),
                max(m, round(_safe_int(out_h, 1024, 16, 8192) / m) * m))
    w_ratio, h_ratio = ASPECT_RATIOS[aspect_ratio]
    total_pixels = _safe_float(megapixels, 1.0, 0.1, 16.0) * 1024 * 1024
    scale = math.sqrt(total_pixels / (w_ratio * h_ratio))
    return max(m, round(w_ratio * scale / m) * m), max(m, round(h_ratio * scale / m) * m)


# ==================== Krea2 共用工具 ====================
# Krea2（latent_format = Wan21：16 通道 / 8x 压缩）的参考图处理照抄官方
# TextEncodeQwenImageEditPlus，三个 Ref 编码节点共用下面这组工具，避免各写一遍走偏。
KREA2_VISION_TOKEN = "<|vision_start|><|image_pad|><|vision_end|>"


def _krea2_ref_preprocess(samples, vae):
    """Krea2 参考图预处理，返回 (ref_latent, vl_image)。

    ⚠️ 2026-11-05 起三个编码节点的 Krea2 分支都改用 `_krea2_fit_ref`（参考图必须先
    fit 到出图网格，否则 ref latent 与采样起点的 h/w 不同 ⇒ 线稿/边缘渗进画面），
    本函数已无调用者，保留作参考（它编码的是「约 1 MP、保持原比例」的 latent）。

    samples : [B, C, H, W]（已 movedim(-1, 1)）
    · ref_latent —— VAE 编码，缩到约 1024x1024 并对齐 8 的倍数，只吃 RGB
                   （qwen_image_vae 输入 3 通道，Krea2 不吃 alpha）
    · vl_image   —— 给 Qwen3-VL 视觉塔，缩到约 384x384
    """
    h, w = samples.shape[2], samples.shape[3]
    total = max(1, h * w)

    ref_latent = None
    if vae is not None:
        scale_by = math.sqrt(1024 * 1024 / total)
        kw = max(8, round(w * scale_by / 8.0) * 8)
        kh = max(8, round(h * scale_by / 8.0) * 8)
        if (kw, kh) == (w, h):
            s = samples
            ref_latent = vae.encode(s.movedim(1, -1)[:, :, :, :3])
        else:
            s = comfy.utils.common_upscale(samples, kw, kh, "area", "disabled")
            ref_latent = vae.encode(s.movedim(1, -1)[:, :, :, :3])
            del s

    vl_scale = math.sqrt(384 * 384 / total)
    s_vl = comfy.utils.common_upscale(
        samples,
        max(8, round(w * vl_scale)),
        max(8, round(h * vl_scale)),
        "area", "disabled",
    )
    vl_image = s_vl.movedim(1, -1)
    del s_vl
    return ref_latent, vl_image


def _krea2_fit_ref(samples, out_w, out_h, mode="参考图保比例"):
    """把参考图 fit 到 Krea2 采样的**空间网格**（= krea2_edit LoRA 的训练几何）。

    原生 krea2 forward 给每张参考图用它**自己的网格**造位置编码：
        ref    = (frame=i, h=0..h_ref-1, w=0..w_ref-1)
        target = (frame=0, h=0..h_tgt-1, w=0..w_tgt-1)
    ref 与 target 的空间尺寸不一致时，模型把它当成「另一块画布」——坐标对不上，
    实测症状是参考图的线条被贴进成图（脸上出现轮廓线）。krea2_edit 训练时源图是
    先 fit 到 target 网格再 VAE 编码的。这里照做：ref latent 与采样起点在 h/w 上
    逐维相等，位置编码只差 frame 轴。

    mode 沿用节点上的「尺寸适配」：
      参考图保比例 → 中心裁到出图宽高比，再缩到出图像素尺寸（默认，几乎无损）
      参考图裁剪   → 直接中心裁到出图尺寸
      参考图拉伸   → 直接缩到出图尺寸（会变形）
    """
    tw = max(8, int(round(out_w / 8.0)) * 8)
    th = max(8, int(round(out_h / 8.0)) * 8)
    if mode != "参考图拉伸":
        samples = _center_crop(samples, tw / th)
    if (samples.shape[3], samples.shape[2]) == (tw, th):
        return samples
    # ★★ antialias 不能省：缩小一张锐利线稿时，无 antialias 的双三次会产生振铃/摩尔纹，
    #    黑白边界的潜空间特征被放大，模型会照着把线条画进成图（实测：脸上出现轮廓线）。
    #    krea2Edit 的像素路径同样是 bicubic + antialias。
    return F.interpolate(samples.float(), size=(th, tw), mode="bicubic",
                         antialias=True).to(samples.dtype)


def _krea2_empty_latent(width, height):
    """Krea2 采样起点：全零 16 通道 / 8x latent。

    参考图只进 conditioning 的 reference_latents，不能当采样起点，
    否则会变成 img2img、编辑语义失效。
    """
    return {
        "samples": torch.zeros(
            [1, 16, max(1, height // 8), max(1, width // 8)],
            device=comfy.model_management.intermediate_device(),
        )
    }


def _krea2_align8(v):
    return max(8, int(round(v / 8.0)) * 8)


def _empty_negative(clip):
    """真正的空文本负条件（不带参考图）。

    ⚠️ 不要用 `ConditioningZeroOut` 把正面条件清零当负面：
       CFG == 1.0 时负面根本不参与计算，看着没问题；
       一旦 CFG > 1，负面真的参与计算了，清零的张量会让整张图花屏（绿紫斑块）。
       实测 Qwen 2.1 fp8 / int8 20 步 CFG 2.5 都崩，换成本函数这种空文本就正常。
    """
    tokens = clip.tokenize("")
    return clip.encode_from_tokens_scheduled(tokens)


# 模型类型改名兼容：老工作流里存的是旧字面量，后端收到旧值时归一化到新名字。
# 前端 js/multi_ref_encode.js 里有一份同样的表（加载时直接把 widget 值改掉），
# 这里再兜一层是为了「手工改 JSON / 第三方节点转存」也能走对分支。
_MODEL_TYPE_ALIASES = {
    "SD / SDXL": "SD / SDXL / Z-Image",
    "SD/SDXL": "SD / SDXL / Z-Image",
    "SD/SDXL/z-image": "SD / SDXL / Z-Image",
    "SDXL": "SD / SDXL / Z-Image",
    "SD 1.5": "SD / SDXL / Z-Image",
    "Z-Image": "SD / SDXL / Z-Image",
    "z-image": "SD / SDXL / Z-Image",
    "ZImage": "SD / SDXL / Z-Image",
}


def _norm_model_type(v):
    """把旧/别名写法的模型类型归一成当前下拉里的正式值。"""
    if not isinstance(v, str):
        return v
    return _MODEL_TYPE_ALIASES.get(v.strip(), v)


def _te_class_name(clip):
    """取文本编码器的实际类名（如 ZImageTEModel_）。取不到返回 None。

    ⚠️ 必须显式判 None：`type(None).__name__` 是字符串 "NoneType"（truthy），
    直接拿去做 `in` 判断会误命中。
    """
    try:
        csm = getattr(clip, "cond_stage_model", None)
        if csm is None:
            return None
        return type(csm).__name__
    except Exception:
        return None


# 底座没有 in-context 参考图通路的模型：一旦接了参考图，出图必然异常。
# 只登记**实测确认过**的，不按型号名字猜。
_NO_REF_CAPABILITY = {
    "ZImage": (
        "Z-Image（Lumina2 / NextDiT 系）是纯文生图模型，训练时没有参考图 token；"
        "官方 5 个 z_image 模板里也没有任何「参考图编辑」接法"
        "（唯一带图输入的是 fun_union_controlnet，走 ControlNet，机制完全不同）。"
        "接上 image1 后参考图 token 进不了模型（缺配套的 reference_latents_text_embeds），"
        "实测出图是满屏方块马赛克。\n"
        "    → 纯文生图：断开 image1 即可，模型类型选「SD / SDXL / Z-Image」"
        "（空 latent 会自动补到 16 通道）；\n"
        "    → 要「看图改图」：换 Qwen-Image 2.1 / Krea2 / Flux2 系；\n"
        "    → 要 Z-Image 的图生图：用 VAE Encode + 采样器 denoise < 1 的普通 img2img。"
    ),
}


_WARNED_NO_REF = set()


def _warn_no_ref_capability(clip, n_refs, tag="Ref Image Encode"):
    """接了参考图、但底座不支持时打一条明确警告。只打印，不改变任何行为。

    同一个（节点, 编码器类）只打一次：`Ref Independent` 是按图循环调用的，
    不去重会刷满日志。
    """
    if n_refs <= 0:
        return
    te = _te_class_name(clip) or ""
    for key, msg in _NO_REF_CAPABILITY.items():
        if key in te:
            if (tag, te) in _WARNED_NO_REF:
                return
            _WARNED_NO_REF.add((tag, te))
            print(
                f"\n[Toggle-Pass][{tag}] ⚠️ 文本编码器 = {te}，已接入 {n_refs} 张参考图，"
                f"但这个底座没有参考图通路。\n    {msg}\n"
                f"    （本次仍按你的接线执行，以上仅为提示，不修改任何参数）\n"
            )
            return


class DynamicRefImageEncode:
    """
    动态 Ref Image Encode 节点，合并原 III/V/X 三个节点。
    前端 JS 根据 num_images 增删 IMAGE 输入槽（1~10）。
    所有参考图共享同一个 prompt，输出 1 个 conditioning + 1 个 latent。
    """

    DESCRIPTION = (
        "一个 prompt + 最多 10 张参考图，输出 CONDITIONING + LATENT + NEGATIVE。"
        "第三个输出 negative 是空文本负条件，直接接采样器「负面条件」即可，"
        "CFG 调多高都不会花屏（别再用 ConditioningZeroOut 清零正面当负面）。"
        "MOSS-Image 与 FIBO 2.0 的 latent 与 Flux2 完全同族（128 通道 / 16x，都用 flux2-vae），"
        "「模型类型」请直接选 Flux2。若需要 MOSS 的 edit_format（必须与编辑 LoRA 的训练格式配对）"
        "或 image_strength、FIBO 的 negative_prompt，请改用官方编码器 "
        "TextEncodeMOSSImageEdit / TextEncodeFibo2。"
        "—— Krea 2：「模型类型」选 Krea2 就能做编辑（保身份 / 换姿势），不需要 krea2Edit 插件。"
        "参考图会先 fit 到出图网格再编码，并以 reference_latents_method=index 注入。"
        "⚠️ 顺序是硬约定：最后一个参考图 = 主体（姿势线稿放 image1、原照片放 image2），"
        "反过来会渲成线稿人偶。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        opt = {}
        for i in range(1, 11):
            opt[f"image{i}"] = ("IMAGE",)
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "num_images": ("INT", {"default": 1, "min": 1, "max": 10, "step": 1}),
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
                "instruction": ("STRING", {
                    "multiline": True,
                    "default": (
                        "Describe the key features of the input image (color, shape, size, "
                        "texture, objects, background), then explain how the user's text "
                        "instruction should alter or modify the image. Generate a new image "
                        "that meets the user's requirements while maintaining consistency "
                        "with the original input where appropriate."
                    ),
                }),
            },
            "optional": {
                **opt,
                "模型类型": (["Flux2", "Qwen Layered", "Qwen Image 2.1", "SD / SDXL / Z-Image", "Krea2"], {"default": "Flux2"}),
                "匹配原图尺寸": (["OFF", "ON"], {"default": "OFF"}),
                "输出宽度": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 8}),
                "输出高度": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 8}),
                "尺寸适配": (["参考图保比例", "参考图裁剪", "参考图拉伸"], {"default": "参考图保比例"}),
                "图层数": ("INT", {"default": 3, "min": 1, "max": 64, "step": 1}),
                # ↓ 2.1 分辨率控制。新参数一律追加在末尾：
                #   ComfyUI 的 widgets_values 是「按位置」存的，插在中间会让旧工作流整体错位。
                "宽高比": (list(ASPECT_RATIOS.keys()) + [MANUAL_RATIO], {"default": "1:1 (Square)"}),
                "百万像素": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 16.0, "step": 0.1}),
                "倍数": ("INT", {"default": 32, "min": 32, "max": 128, "step": 16}),
                "参考图分辨率": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 32}),
            },
        }

    # ↓ 第三个输出是后加的，追加在末尾 ⇒ 旧工作流的 0/1 号口不受影响
    # 输出顺序：conditioning / negative / latent
    # ⚠️ 2026-11-06 调整：`negative` 从末尾挪到 `latent` 前面（纯粹为了节点上好看）。
    #   ⇒ 索引变了（latent: 1 → 2，negative: 2 → 1），所有老工作流的连线索引都失效。
    #   前端 js/multi_ref_encode.js 的 `migrateOutputOrder()` 会在加载时按
    #   outputs[i].name 判断布局并交换 1/2 号口的连线，两层都改才一致。
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("conditioning", "negative", "latent")
    FUNCTION = "encode"
    CATEGORY = "Toggle-Pass"

    def _get_system_prompt(self, instruction):
        prefix = "<|im_start|>system\n"
        suffix = "<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"
        content = instruction if instruction.strip() else (
            "Describe the key features of the input image (color, shape, size, "
            "texture, objects, background), then explain how the user's text "
            "instruction should alter or modify the image. Generate a new image "
            "that meets the user's requirements while maintaining consistency "
            "with the original input where appropriate."
        )
        if prefix in content:
            content = content.split(prefix)[1]
        if suffix in content:
            content = content.split(suffix)[0]
        content = content.replace("{}", "")
        return prefix + content + suffix

    def _make_empty_latent(self, 模型类型, width, height, layers=3):
        """根据模型类型生成空 latent。Qwen Layered 输出分层格式。"""
        if 模型类型 == "Qwen Layered":
            channels = 16
            dim3 = layers + 1
            h = height // 8
            w = width // 8
            latent = torch.zeros(
                [1, channels, dim3, h, w],
                device=comfy.model_management.intermediate_device(),
            )
        elif 模型类型 == "Qwen Image 2.1":
            # Qwen-Image-2.1: 64 通道 RGBA latent，16x 空间压缩，2D（非分层）
            channels = 64
            h = height // 16
            w = width // 16
            latent = torch.zeros(
                [1, channels, h, w],
                device=comfy.model_management.intermediate_device(),
            )
        elif 模型类型 == "Krea2":
            # Krea-2: latent_format = Wan21，16 通道 / 8x 空间压缩（VAE 是 qwen_image_vae）
            channels = 16
            h = height // 8
            w = width // 8
            latent = torch.zeros(
                [1, channels, h, w],
                device=comfy.model_management.intermediate_device(),
            )
        elif 模型类型 == "Flux2":
            # Flux2 latent：128 通道 / 16x 空间压缩（flux2-vae）。
            # MOSS-Image 与 FIBO 2.0 用的是同一套 latent，这两个模型请直接选 Flux2。
            # ⚠️ 这里原来写的是 4 通道（SD 的 latent）。只有「一张参考图都不接、
            #    纯把它当空 latent 源」时才会走到这个分支（接图时走 ref_latents[0]），
            #    所以一直没暴露；接上 Flux2/moss/fibo 采样会直接通道不匹配。
            channels = 128
            h = height // 16
            w = width // 16
            latent = torch.zeros(
                [1, channels, h, w],
                device=comfy.model_management.intermediate_device(),
            )
        else:
            h = height // 8
            w = width // 8
            latent = torch.zeros(1, 4, h, w)
        return {"samples": latent}

    def encode(self, clip, num_images, prompt, instruction="",
               vae=None, 模型类型="Flux2", 匹配原图尺寸="OFF",
               宽高比="1:1 (Square)", 百万像素=1.0, 倍数=32,
               输出宽度=1024, 输出高度=1024, 参考图分辨率=1024,
               尺寸适配="参考图保比例", 图层数=3, **kwargs):

        n = max(1, min(10, int(num_images)))
        llama_template = self._get_system_prompt(instruction)
        模型类型 = _norm_model_type(模型类型)          # 老存档兼容
        is_krea2 = (模型类型 == "Krea2")

        # 出图分辨率：2.1 用官方 ResolutionSelector 同款（宽高比 + 百万像素 + 倍数）；
        # 其他模型那组参数不参与，直接沿用「输出宽度/输出高度」（保持旧行为不变）
        if 模型类型 == "Qwen Image 2.1":
            out_w, out_h = _calc_output_size(宽高比, 百万像素, 倍数, 输出宽度, 输出高度)
        else:
            out_w, out_h = 输出宽度, 输出高度

        ref_latents = []
        vl_images = []
        image_prompt = ""
        # 最终出图尺寸（None = 还没确定，用 out_w/out_h）
        first_tw, first_th = None, None

        for i in range(1, n + 1):
            image = kwargs.get(f"image{i}", None)
            if image is None:
                continue

            samples = image.movedim(-1, 1)  # [B, C, H, W]
            current_total = samples.shape[3] * samples.shape[2]

            if 匹配原图尺寸 == "ON":
                pixel_width = samples.shape[3]
                pixel_height = samples.shape[2]
                if first_tw is None:
                    first_tw, first_th = _calc_target_size(samples.shape[3], samples.shape[2], 0, "ON")
            else:
                pixel_width = out_w
                pixel_height = out_h

            if 模型类型 == "Qwen Image 2.1":
                # 官方同款：文本编码器与 VAE 用同一张、同一尺寸，
                # 保证每个 vision slot 覆盖 2x2 latents；尺寸对齐 32 倍数。
                # 参考图尺寸由「参考图分辨率 + 尺寸适配」决定，与出图尺寸解耦
                # （out_w/out_h 才是出图分辨率，官方默认「分辨率选择器 + 参考图各自尺寸」）。
                tw, th = _ref_target_size(samples.shape[3], samples.shape[2],
                                          参考图分辨率, out_w, out_h, 尺寸适配)
                if 尺寸适配 == "参考图裁剪":
                    samples = _center_crop(samples, tw / th)
                if (tw, th) == (samples.shape[3], samples.shape[2]):
                    s = samples
                else:
                    s = comfy.utils.common_upscale(samples, tw, th, "lanczos", "center")
                img_s = s.movedim(1, -1)  # [B, H, W, C]
                if vae is not None:
                    ref_latents.append(vae.encode(img_s))  # VAE 保留全部通道（含 alpha）
                # 视觉塔：带 alpha 时合成到白底（官方 rgb * a + (1 - a)）
                rgb = img_s[:, :, :, :3]
                if img_s.shape[-1] > 3:
                    rgb = rgb * img_s[:, :, :, 3:] + (1.0 - img_s[:, :, :, 3:])
                vl_images.append(rgb)
                # 2.1 不加 "Picture N: " 文本前缀（Qwen3-VL 靠占位符，不靠文本）
            elif is_krea2:
                # ---- Krea2：参考图先 fit 到「出图网格」再 VAE 编码 ----
                # 原生 krea2 forward 用每张参考图**自己的网格**造位置编码，尺寸与 target
                # 不一致时模型把它当另一块画布 ⇒ 参考图的线条会被贴进成图（实测症状：
                # 脸上出现轮廓线）。krea2_edit LoRA 训练时源图就是先 fit 到 target 网格
                # 再编码的，这里对齐它。VAE 只吃 RGB（qwen_image_vae 3 通道）。
                if first_tw is None:
                    first_tw, first_th = _krea2_align8(pixel_width), _krea2_align8(pixel_height)
                s = _krea2_fit_ref(samples, first_tw, first_th, 尺寸适配)
                if vae is not None:
                    ref_latents.append(vae.encode(s.movedim(1, -1)[:, :, :, :3]))

                # 视觉塔：384x384 附近（语义 grounding，与潜空间几何无关）
                vl_total = 384 * 384
                vl_scale = math.sqrt(vl_total / current_total)
                s_vl = comfy.utils.common_upscale(
                    samples,
                    max(8, round(samples.shape[3] * vl_scale)),
                    max(8, round(samples.shape[2] * vl_scale)),
                    "area", "disabled",
                )
                vl_images.append(s_vl.movedim(1, -1))

                # ⚠️ 下面这条和通用分支不一样：传了 llama_template 时 Qwen3VL tokenizer
                # 不会自动插视觉占位符（只有用内置 llama_template_images 时才自动插），
                # 所以必须自己写 <|vision_start|><|image_pad|><|vision_end|>，
                # 否则参考图对模型完全不可见。官方 EditPlus 就是这么拼的。
                image_prompt += "Picture {}: <|vision_start|><|image_pad|><|vision_end|>".format(
                    len(vl_images)
                )
            else:
                if vae is not None:
                    s = comfy.utils.common_upscale(samples, pixel_width, pixel_height, "lanczos", "center")
                    img_for_vae = s.movedim(1, -1)
                    ref_latents.append(vae.encode(img_for_vae[:, :, :, :3]))

                # VL image: resize down for vision-language token
                vl_total = 384 * 384
                vl_scale = math.sqrt(vl_total / current_total)
                vl_w = round(samples.shape[3] * vl_scale)
                vl_h = round(samples.shape[2] * vl_scale)
                s_vl = comfy.utils.common_upscale(samples, vl_w, vl_h, "lanczos", "center")
                img_vl = s_vl.movedim(1, -1)

                vl_images.append(img_vl)
                # 注意：不要手动加 <|vision_start|><|image_pad|><|vision_end|>
                # ComfyUI 的 Qwen2.5-VL CLIP tokenizer 会在 images 参数传入时自动插入这些 token
                image_prompt += "Picture {}: ".format(len(vl_images))

        if 模型类型 == "Qwen Image 2.1":
            # 对齐官方 TextEncodeQwenImage21：不传 llama_template（核心自动插 N 个占位符）、
            # 不传 system_prompt（2.1 会丢弃 system 段，指令必须并进 user 段文本才生效）。
            keep_vision = (len(ref_latents) == 0)
            tokens = clip.tokenize(
                _text_for_21(prompt, instruction),
                images=vl_images,
                keep_vision=keep_vision,
                prevent_empty_text=True,
            )
        else:
            full_prompt = image_prompt + prompt
            tokens = clip.tokenize(full_prompt, images=vl_images, llama_template=llama_template)
        conditioning = clip.encode_from_tokens_scheduled(tokens)

        _warn_no_ref_capability(clip, len(ref_latents), "Ref Image Encode")

        if len(ref_latents) > 0:
            ref_vals = {"reference_latents": ref_latents}
            if is_krea2:
                # ⚠️ Krea2 的 default_ref_method 实测是 None，而模型侧写的是
                #     if ref_method is not None and ref_latents is not None and len(...)
                # ⇒ 不显式给方法时参考图会被**静默忽略**（不报错、只是没效果）。
                #
                # ★★ 方法必须用 "index"，不能照官方模板用 "index_timestep_zero"：
                #   "index_timestep_zero" 会让参考图 token 走 **t=0 的 adaLN 调制**
                #   （见 comfy/ldm/krea2/model.py SingleStreamBlock.forward 的
                #     timestep_zero_index 分支），target 走当前 t —— 两套调制。
                #   而 krea2_edit LoRA（ai-toolkit predict_velocity_edit）训练时
                #   全序列共用**同一个 tvec**，正好对应原生的 "index"（不分裂 tvec）。
                #   实测：用 timestep_zero 时参考线稿会被"描"进成图（脸上出轮廓线）。
                ref_vals["reference_latents_method"] = "index"
            conditioning = node_helpers.conditioning_set_values(
                conditioning,
                ref_vals,
                append=True,
            )

        # 最终出图尺寸：默认用分辨率参数算出的 out_w/out_h；
        # 「匹配原图尺寸=ON」时已跟随第一张参考图（first_tw/first_th）
        final_w = first_tw if first_tw else out_w
        final_h = first_th if first_th else out_h

        # Qwen Layered 模式：始终输出分层 latent
        if 模型类型 == "Qwen Layered":
            latent_out = self._make_empty_latent(模型类型, final_w, final_h, 图层数)
        elif 模型类型 == "Qwen Image 2.1":
            # 全零 latent 才是「编辑」；参考图的真实 latent 只进 conditioning 的 reference_latents。
            # 尺寸 = 分辨率参数算出的出图宽高（对齐官方「分辨率选择器 -> EmptyLatentImage」这条默认支路）
            latent_out = {
                "samples": torch.zeros(
                    [1, 64, final_h // 16, final_w // 16],
                    device=comfy.model_management.intermediate_device(),
                )
            }
        elif is_krea2:
            # Krea2 也要「全零 latent 作采样起点」：参考图只进 conditioning 的 reference_latents，
            # 不能拿来当起点，否则就变成 img2img 了。16 通道 / 8x（Wan21 latent_format）。
            latent_out = {
                "samples": torch.zeros(
                    [1, 16, final_h // 8, final_w // 8],
                    device=comfy.model_management.intermediate_device(),
                )
            }
        elif len(ref_latents) > 0:
            latent_out = {"samples": ref_latents[0]}
        else:
            latent_out = self._make_empty_latent(模型类型, final_w, final_h, 图层数)

        # 第二/三个输出：空文本负条件 + 采样起点 latent。
        # 顺序见 RETURN_NAMES —— negative 在前、latent 在后。
        # CFG=1.0 时负面不参与计算（等价于原来的 ConditioningZeroOut），
        # CFG>1 时它是唯一正确的接法。
        return (conditioning, _empty_negative(clip), latent_out)


NODE_CLASS_MAPPINGS = {
    "DynamicRefImageEncode": DynamicRefImageEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "DynamicRefImageEncode": "Ref Image Encode",
}




# ==================== Multi Ref Latent Input Nodes ====================
# 接收多个 LATENT 输入，打包进 conditioning 的 reference_latents
# 和图片版本不同：这些节点直接接收 latent，不需要 VAE 编码
# ====================================================================


class DynamicRefLatentInput:
    """
    动态 LATENT 输入节点，前端 JS 提供 +/- 按钮增减输入槽。
    后端固定定义 latent1~latent10，由 num_latents 控制生效数量。
    """
    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, 11):
            optional[f"latent{i}"] = ("LATENT",)
        return {
            "required": {
                "conditioning": ("CONDITIONING",),
                "num_latents": ("INT", {"default": 1, "min": 1, "max": 10, "step": 1}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("conditioning",)
    FUNCTION = "pack"
    CATEGORY = "Toggle-Pass"

    def pack(self, conditioning, num_latents, **kwargs):
        ref_latents = []
        n = max(1, min(10, int(num_latents)))
        for i in range(1, n + 1):
            lat = kwargs.get(f"latent{i}", None)
            if lat is not None and "samples" in lat:
                ref_latents.append(lat["samples"])

        if len(ref_latents) == 0:
            return (conditioning,)

        return (node_helpers.conditioning_set_values(
            conditioning,
            {"reference_latents": ref_latents},
            append=True,
        ),)


NODE_CLASS_MAPPINGS["DynamicRefLatentInput"] = DynamicRefLatentInput
NODE_DISPLAY_NAME_MAPPINGS["DynamicRefLatentInput"] = "Ref Latent Input"





# ==================== Image Batcher ====================
# 把多个独立 IMAGE 输入打包成 1 个 batch IMAGE 输出
# ======================================================


class ImageBatcher:
    """
    动态 IMAGE 输入节点，前端 JS 提供 +/- 按钮增减输入槽。
    把多个独立 IMAGE 打包成一个 batch IMAGE 输出。
    后端固定定义 image1~image10，由 num_images 控制生效数量。
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, 11):
            optional[f"image{i}"] = ("IMAGE",)
        return {
            "required": {
                "num_images": ("INT", {"default": 1, "min": 1, "max": 10, "step": 1}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "batch"
    CATEGORY = "Toggle-Pass"

    def batch(self, num_images, **kwargs):
        images = []
        n = max(1, min(10, int(num_images)))
        for i in range(1, n + 1):
            img = kwargs.get(f"image{i}", None)
            if img is not None:
                images.append(img)

        if len(images) == 0:
            return (torch.zeros(1, 64, 64, 3),)

        # 把所有图片缩放成相同尺寸（以第一张图为基准）
        target_h = images[0].shape[1]
        target_w = images[0].shape[2]

        resized = []
        for img in images:
            h, w = img.shape[1], img.shape[2]
            if h != target_h or w != target_w:
                img = img.movedim(-1, 1)  # [B, H, W, C] -> [B, C, H, W]
                img = comfy.utils.common_upscale(img, target_w, target_h, "lanczos", "center")
                img = img.movedim(1, -1)  # [B, C, H, W] -> [B, H, W, C]
            resized.append(img)

        result = torch.cat(resized, dim=0)
        return (result,)


NODE_CLASS_MAPPINGS["ImageBatcher"] = ImageBatcher
NODE_DISPLAY_NAME_MAPPINGS["ImageBatcher"] = "Image Batcher"


# ==================== One Image Multi Prompt ====================
# 1 张参考图 + 多个 prompt → 多组 conditioning + 1 个共享 latent
# 顺序执行，避免显存爆炸
# ================================================================


class OneImageMultiPrompt:
    """
    1 张参考图 + 多个 prompt → 多组独立 conditioning + 1 个共享 latent。
    图片只预处理一次，然后逐个 prompt 顺序编码（节省显存）。
    每组 conditioning 可外接独立的 Sampler 采样不同效果。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "image": ("IMAGE",),
                "prompt数量": ("INT", {"default": 4, "min": 2, "max": 8, "step": 1}),
            },
            "optional": {
                "vae": ("VAE",),
                "instruction": ("STRING", {
                    "multiline": True,
                    "default": (
                        "Describe the key features of the input image (color, shape, size, "
                        "texture, objects, background), then explain how the user's text "
                        "instruction should alter or modify the image. Generate a new image "
                        "that meets the user's requirements while maintaining consistency "
                        "with the original input where appropriate."
                    ),
                }),
                "模型类型": (["Flux2", "Qwen Image 2.1", "SD / SDXL / Z-Image", "Krea2"], {"default": "Flux2"}),
                "匹配原图尺寸": (["OFF", "ON"], {"default": "OFF"}),
                "输出宽度": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 8}),
                "输出高度": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 8}),
                "prompt1": ("STRING", {"multiline": True, "default": ""}),
                "prompt2": ("STRING", {"multiline": True, "default": ""}),
                "prompt3": ("STRING", {"multiline": True, "default": ""}),
                "prompt4": ("STRING", {"multiline": True, "default": ""}),
                "prompt5": ("STRING", {"multiline": True, "default": ""}),
                "prompt6": ("STRING", {"multiline": True, "default": ""}),
                "prompt7": ("STRING", {"multiline": True, "default": ""}),
                "prompt8": ("STRING", {"multiline": True, "default": ""}),
                # ↓ 2.1 分辨率控制。新参数一律追加在末尾：
                #   ComfyUI 的 widgets_values 是「按位置」存的，插在中间会让旧工作流整体错位。
                "宽高比": (list(ASPECT_RATIOS.keys()) + [MANUAL_RATIO], {"default": "1:1 (Square)"}),
                "百万像素": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 16.0, "step": 0.1}),
                "倍数": ("INT", {"default": 32, "min": 32, "max": 128, "step": 16}),
                "参考图分辨率": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 32}),
                "尺寸适配": (["参考图保比例", "参考图裁剪", "参考图拉伸"], {"default": "参考图保比例"}),
            },
        }

    RETURN_TYPES = ("CONDITIONING",) * 8 + ("LATENT",)
    RETURN_NAMES = ("cond_1", "cond_2", "cond_3", "cond_4",
                    "cond_5", "cond_6", "cond_7", "cond_8", "latent")
    FUNCTION = "encode"
    CATEGORY = "Toggle-Pass"

    def _get_system_prompt(self, instruction):
        prefix = "<|im_start|>system\n"
        suffix = "<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"
        content = instruction if instruction.strip() else (
            "Describe the key features of the input image (color, shape, size, "
            "texture, objects, background), then explain how the user's text "
            "instruction should alter or modify the image. Generate a new image "
            "that meets the user's requirements while maintaining consistency "
            "with the original input where appropriate."
        )
        if prefix in content:
            content = content.split(prefix)[1]
        if suffix in content:
            content = content.split(suffix)[0]
        content = content.replace("{}", "")
        return prefix + content + suffix

    def encode(self, clip, image, prompt数量=4,
               vae=None, instruction="", 模型类型="Flux2",
               匹配原图尺寸="OFF", 输出宽度=1024, 输出高度=1024,
               宽高比="1:1 (Square)", 百万像素=1.0, 倍数=32,
               参考图分辨率=1024, 尺寸适配="参考图保比例", **kwargs):

        n = max(2, min(8, int(prompt数量)))
        llama_template = self._get_system_prompt(instruction)
        模型类型 = _norm_model_type(模型类型)          # 老存档兼容
        is_21 = (模型类型 == "Qwen Image 2.1")
        is_krea2 = (模型类型 == "Krea2")

        # 出图分辨率：2.1 走官方 ResolutionSelector 同款（宽高比 + 百万像素 + 倍数）；
        # 其他模型沿用「输出宽度/输出高度」（保持旧行为一字不变）
        if is_21:
            out_w, out_h = _calc_output_size(宽高比, 百万像素, 倍数, 输出宽度, 输出高度)
        else:
            out_w, out_h = 输出宽度, 输出高度

        # ---- 图片预处理（只做一次，多组 prompt 复用）----
        samples = image.movedim(-1, 1)  # [B, C, H, W]
        current_total = samples.shape[3] * samples.shape[2]
        orig_w, orig_h = samples.shape[3], samples.shape[2]

        if 匹配原图尺寸 == "ON":
            pixel_width = samples.shape[3]
            pixel_height = samples.shape[2]
        else:
            pixel_width = out_w
            pixel_height = out_h

        ref_latent = None
        if is_21:
            # 官方同款：文本编码器与 VAE 用同一张、同一尺寸（对齐 32 倍数），
            # 保证每个 vision slot 覆盖 2x2 latents；带 alpha 时合成到白底。
            # 2.1 不加 "Picture 1: " 文本前缀（Qwen3-VL 靠占位符，不靠文本）
            tw, th = _ref_target_size(samples.shape[3], samples.shape[2],
                                      参考图分辨率, out_w, out_h, 尺寸适配)
            if 尺寸适配 == "参考图裁剪":
                samples = _center_crop(samples, tw / th)
            if (tw, th) == (samples.shape[3], samples.shape[2]):
                s = samples
            else:
                s = comfy.utils.common_upscale(samples, tw, th, "lanczos", "center")
            img_s = s.movedim(1, -1)  # [B, H, W, C]
            if vae is not None:
                ref_latent = vae.encode(img_s)  # 2.1 的 VAE 吃 RGBA，保留全部通道
            # 视觉塔：带 alpha 时合成到白底（官方 rgb * a + (1 - a)）
            rgb = img_s[:, :, :, :3]
            if img_s.shape[-1] > 3:
                rgb = rgb * img_s[:, :, :, 3:] + (1.0 - img_s[:, :, :, 3:])
            vl_image = rgb
            image_prompt = ""
        elif is_krea2:
            # Krea2：VAE 只吃 RGB（qwen_image_vae 3 通道），视觉塔用 384 附近的缩略图。
            # ⚠️ 传了 llama_template 时 Qwen3VL tokenizer 不会自动插视觉占位符
            #    （只有用内置 llama_template_images 时才自动），必须自己写
            #    <|vision_start|><|image_pad|><|vision_end|>，否则参考图对模型完全不可见。
            # ★ 参考图先 fit 到出图网格（krea2_edit 训练几何），理由见 _krea2_fit_ref。
            kw_, kh_ = (_krea2_align8(pixel_width), _krea2_align8(pixel_height))
            s = _krea2_fit_ref(samples, kw_, kh_, 尺寸适配)
            ref_latent = vae.encode(s.movedim(1, -1)[:, :, :, :3]) if vae is not None else None
            vl_total = 384 * 384
            vl_scale = math.sqrt(vl_total / current_total)
            s_vl = comfy.utils.common_upscale(
                samples,
                max(8, round(samples.shape[3] * vl_scale)),
                max(8, round(samples.shape[2] * vl_scale)),
                "area", "disabled",
            )
            vl_image = s_vl.movedim(1, -1)
            image_prompt = "Picture 1: " + KREA2_VISION_TOKEN
        else:
            # VAE 编码参考图（图生图用）
            if vae is not None:
                s = comfy.utils.common_upscale(samples, pixel_width, pixel_height, "lanczos", "center")
                img_for_vae = s.movedim(1, -1)
                ref_latent = vae.encode(img_for_vae[:, :, :, :3])

            # VL 缩放（给 CLIP vision encoder 用的图）
            vl_total = 384 * 384
            vl_scale = math.sqrt(vl_total / current_total)
            vl_w = round(samples.shape[3] * vl_scale)
            vl_h = round(samples.shape[2] * vl_scale)
            s_vl = comfy.utils.common_upscale(samples, vl_w, vl_h, "lanczos", "center")
            vl_image = s_vl.movedim(1, -1)  # [B, H, W, C]

            # 图片 prompt 片段（固定不变）
            # 注意：不要手动加 <|vision_start|><|image_pad|><|vision_end|>
            # ComfyUI 的 Qwen2.5-VL CLIP tokenizer 会在 images 参数传入时自动插入这些 token
            image_prompt = "Picture 1: "

        # ---- 顺序编码每个 prompt ----
        results = []
        for i in range(n):
            p = kwargs.get(f"prompt{i + 1}", "")
            if is_21:
                # 对齐官方 TextEncodeQwenImage21：不传 llama_template（核心自动插占位符）、
                # 不传 system_prompt（2.1 会丢弃 system 段，指令必须并进 user 段文本才生效）
                tokens = clip.tokenize(
                    _text_for_21(p, instruction),
                    images=[vl_image],
                    keep_vision=(ref_latent is None),
                    prevent_empty_text=True,
                )
            else:
                tokens = clip.tokenize(image_prompt + p, images=[vl_image], llama_template=llama_template)
            cond = clip.encode_from_tokens_scheduled(tokens)

            _warn_no_ref_capability(clip, 0 if ref_latent is None else 1, "一图多Prompt")

            if ref_latent is not None:
                ref_vals = {"reference_latents": [ref_latent]}
                if is_krea2:
                    # Krea2 的 default_ref_method 是 None ⇒ 不显式给方法时参考图会被
                    # 静默忽略（不报错、只是没效果）。
                    # ★★ 必须用 "index" 而非 "index_timestep_zero"：后者给参考图单独
                    #    一套 t=0 的 adaLN 调制，与 krea2_edit LoRA 的训练（全序列同一
                    #    tvec）不符，实测会把参考线稿"描"进成图。详见 DynamicRefImageEncode。
                    ref_vals["reference_latents_method"] = "index"
                cond = node_helpers.conditioning_set_values(
                    cond,
                    ref_vals,
                    append=True,
                )

            results.append(cond)

        # ---- 共享 latent 输出 ----
        if is_21:
            # 全零 latent 才是「编辑」；参考图的真实 latent 只进 conditioning 的 reference_latents。
            # 若把参考图 latent 当采样起点，每组视角都会变成从原图重建的 img2img，改不动内容。
            if 匹配原图尺寸 == "ON":
                final_w = max(32, round(orig_w / 32) * 32)
                final_h = max(32, round(orig_h / 32) * 32)
            else:
                final_w, final_h = out_w, out_h
            latent_out = {
                "samples": torch.zeros(
                    [1, 64, final_h // 16, final_w // 16],
                    device=comfy.model_management.intermediate_device(),
                )
            }
        elif is_krea2:
            # Krea2 同样是「全零 latent 作采样起点」，参考图只进 reference_latents；
            # 若拿参考图 latent 当起点，每组视角都会变成从原图重建的 img2img。
            if 匹配原图尺寸 == "ON":
                final_w, final_h = _krea2_align8(orig_w), _krea2_align8(orig_h)
            else:
                final_w, final_h = _krea2_align8(out_w), _krea2_align8(out_h)
            latent_out = _krea2_empty_latent(final_w, final_h)
        elif ref_latent is not None:
            latent_out = {"samples": ref_latent}
        else:
            # 纯文生图：通道数必须跟模型一致。
            # Flux2（以及同族的 MOSS-Image / FIBO 2.0）是 128 通道 / 16x，SD 是 4 通道 / 8x。
            # 原来不分类型一律 4 通道，接 Flux2 采样会直接通道不匹配。
            if 模型类型 == "Flux2":
                scale, channels = 16, 128
            else:
                scale, channels = 8, 4
            lw = 输出宽度 // scale
            lh = 输出高度 // scale
            latent_out = {"samples": torch.zeros(
                [1, channels, lh, lw],
                device=comfy.model_management.intermediate_device(),
            )}

        # 补齐到 8 个 conditioning（未使用的填空 conditioning）
        while len(results) < 8:
            results.append((torch.zeros(1, 768), {}))

        # 释放临时张量
        del samples, vl_image
        if ref_latent is not None:
            del ref_latent

        return (*results, latent_out)


NODE_CLASS_MAPPINGS["OneImageMultiPrompt"] = OneImageMultiPrompt
NODE_DISPLAY_NAME_MAPPINGS["OneImageMultiPrompt"] = "一图多视角"
# ==================== Ref Independent Output ====================
# 每张图片独立编码，conditioning 和 latent 完全隔离，无交叉
# 每张图走独立通道，适合需要完全独立控制每张参考图的场景
# ================================================================



class DynamicRefIndependent:
    """
    动态独立参考图编码节点。
    前端 JS 根据 num_images 同步增删：
      - IMAGE 输入槽 (image1~imageN)
      - prompt 控件 (prompt1~promptN)
      - CONDITIONING 输出槽 (cond_1~cond_N)
      - LATENT 输出槽 (latent1~latentN)
    每张图独立编码，输出自己的 CONDITIONING 和 LATENT。
    共 2*N 个输出：cond_1, latent1, cond_2, latent2, ..., cond_N, latentN
    """

    @classmethod
    def INPUT_TYPES(cls):
        opt = {}
        for i in range(1, 11):
            opt[f"image{i}"] = ("IMAGE",)
            opt[f"prompt{i}"] = ("STRING", {"multiline": True, "default": ""})
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "num_images": ("INT", {"default": 1, "min": 1, "max": 10, "step": 1}),
                "instruction": ("STRING", {
                    "multiline": True,
                    "default": (
                        "Describe the key features of the input image (color, shape, size, "
                        "texture, objects, background), then explain how the user's text "
                        "instruction should alter or modify the image. Generate a new image "
                        "that meets the user's requirements while maintaining consistency "
                        "with the original input where appropriate."
                    ),
                }),
            },
            "optional": {
                **opt,
                "模型类型": (["Flux2", "Qwen Layered", "Qwen Image 2.1", "SD / SDXL / Z-Image", "Krea2"], {"default": "Flux2"}),
                "匹配原图尺寸": (["OFF", "ON"], {"default": "OFF"}),
                "输出宽度": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 8}),
                "输出高度": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 8}),
                "尺寸适配": (["参考图保比例", "参考图裁剪", "参考图拉伸"], {"default": "参考图保比例"}),
                # ↓ 2.1 分辨率控制，新参数一律追加在末尾（避免旧工作流 widgets_values 按位置错位）
                "宽高比": (list(ASPECT_RATIOS.keys()) + [MANUAL_RATIO], {"default": "1:1 (Square)"}),
                "百万像素": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 16.0, "step": 0.1}),
                "倍数": ("INT", {"default": 32, "min": 32, "max": 128, "step": 16}),
                "参考图分辨率": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 32}),
            },
        }

    # 输出顺序：cond_1, latent1, cond_2, latent2, ..., cond_10, latent10（交替）
    # 每组：1个 CONDITIONING + 1个 LATENT（每张图各自独立的 latent）
    # 前端通过 removeOutput 只保留 N 组（N*2 个输出槽）
    RETURN_TYPES = tuple(
        item
        for i in range(10)
        for item in ("CONDITIONING", "LATENT")
    )
    RETURN_NAMES = tuple(
        item
        for i in range(1, 11)
        for item in (f"cond_{i}", f"latent{i}")
    )
    FUNCTION = "encode"
    CATEGORY = "Toggle-Pass"

    def _get_system_prompt(self, instruction):
        prefix = "<|im_start|>system\n"
        suffix = "<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"
        content = instruction if instruction.strip() else (
            "Describe the key features of the input image (color, shape, size, "
            "texture, objects, background), then explain how the user's text "
            "instruction should alter or modify the image. Generate a new image "
            "that meets the user's requirements while maintaining consistency "
            "with the original input where appropriate."
        )
        if prefix in content:
            content = content.split(prefix)[1]
        if suffix in content:
            content = content.split(suffix)[0]
        content = content.replace("{}", "")
        return prefix + content + suffix

    def encode(self, clip, num_images, instruction="", vae=None, 模型类型="Flux2",
               匹配原图尺寸="OFF", 宽高比="1:1 (Square)", 百万像素=1.0, 倍数=32,
               输出宽度=1024, 输出高度=1024, 参考图分辨率=1024,
               尺寸适配="参考图保比例", **kwargs):
        n = max(1, min(10, int(num_images)))
        llama_template = self._get_system_prompt(instruction)
        模型类型 = _norm_model_type(模型类型)          # 老存档兼容
        is_21 = (模型类型 == "Qwen Image 2.1")
        is_krea2 = (模型类型 == "Krea2")
        if is_krea2 and n > 1:
            # 本节点把每张图编进各自独立的 conditioning（Qwen 2.1 的每图独立 index 平面那套设计）。
            # Krea2 需要的是「一条连贯的参考序列」：合并多个独立 conditioning 后，
            # reference_latents 的 frame 语义会乱 —— 实测线稿残留 + 姿势跑偏，而且不报错。
            print("[Toggle-Pass] ⚠️ DynamicRefIndependent 在 Krea2 多图下不可靠：多图请改用 "
                  "Ref Image Encode（DynamicRefImageEncode），一个节点就能带上多张参考图。",
                  flush=True)

        conds = []
        latents = []          # 每张图自己的 latent
        first_latent = None   # 第一张非空图的 latent，用于共享 latent_out

        # 出图分辨率（2.1 用官方 ResolutionSelector 同款；其他模型沿用「输出宽度/输出高度」）
        if is_21:
            out_w, out_h = _calc_output_size(宽高比, 百万像素, 倍数, 输出宽度, 输出高度)
        else:
            out_w, out_h = 输出宽度, 输出高度
        final_w, final_h = out_w, out_h
        size_locked = False

        for i in range(1, n + 1):
            img = kwargs.get(f"image{i}", None)
            prompt = kwargs.get(f"prompt{i}", "")

            if img is None:
                # 空槽：用纯文本 prompt 编码，不带图片，格式正确
                text = prompt or ""
                if is_21:
                    # 无图 → 核心自动用无图模板；指令并进 user 段文本，不走 system_prompt
                    tokens = clip.tokenize(
                        _text_for_21(text, instruction),
                        prevent_empty_text=True,
                    )
                else:
                    tokens = clip.tokenize(text, llama_template=llama_template)
                cond = clip.encode_from_tokens_scheduled(tokens)
                conds.append(cond)
                latents.append(None)  # 空槽没有 latent
                continue

            samples = img.movedim(-1, 1)
            current_total = samples.shape[3] * samples.shape[2]

            if is_21:
                # 官方同款：文本编码器与 VAE 用同一张、同一尺寸（对齐 32 倍数）
                if 匹配原图尺寸 == "ON" and not size_locked:
                    final_w, final_h = _calc_target_size(samples.shape[3], samples.shape[2], 0, "ON")
                    size_locked = True
                tw, th = _ref_target_size(samples.shape[3], samples.shape[2],
                                          参考图分辨率, final_w, final_h, 尺寸适配)
                if 尺寸适配 == "参考图裁剪":
                    samples = _center_crop(samples, tw / th)
                if (tw, th) == (samples.shape[3], samples.shape[2]):
                    s = samples
                else:
                    s = comfy.utils.common_upscale(samples, tw, th, "lanczos", "center")
                img_s = s.movedim(1, -1)
                img_latent = None
                if vae is not None:
                    img_latent = vae.encode(img_s)  # VAE 保留全部通道（含 alpha）
                    if first_latent is None:
                        first_latent = img_latent
                # 视觉塔：带 alpha 时合成到白底（官方 rgb * a + (1 - a)）
                rgb = img_s[:, :, :, :3]
                if img_s.shape[-1] > 3:
                    rgb = rgb * img_s[:, :, :, 3:] + (1.0 - img_s[:, :, :, 3:])
                vl_image = rgb
            elif is_krea2:
                # Krea2：参考图的真实 latent 只进 conditioning 的 reference_latents，
                # 采样起点另外给全零 latent（16 通道 / 8x），否则就成了 img2img。
                if 匹配原图尺寸 == "ON" and not size_locked:
                    final_w = _krea2_align8(samples.shape[3])
                    final_h = _krea2_align8(samples.shape[2])
                    size_locked = True
                # ★ 参考图先 fit 到出图网格（krea2_edit 训练几何），理由见 _krea2_fit_ref
                s_k = _krea2_fit_ref(samples, final_w, final_h, 尺寸适配)
                img_latent = vae.encode(s_k.movedim(1, -1)[:, :, :, :3]) if vae is not None else None
                vl_total = 384 * 384
                vl_scale = math.sqrt(vl_total / current_total)
                s_vl = comfy.utils.common_upscale(
                    samples,
                    max(8, round(samples.shape[3] * vl_scale)),
                    max(8, round(samples.shape[2] * vl_scale)),
                    "area", "disabled",
                )
                vl_image = s_vl.movedim(1, -1)
                if img_latent is not None and first_latent is None:
                    first_latent = img_latent
            else:
                # ---- VAE 编码（每张图独立编码自己的 latent）----
                img_latent = None
                if vae is not None:
                    s = comfy.utils.common_upscale(samples, samples.shape[3], samples.shape[2], "lanczos", "center")
                    img_for_vae = s.movedim(1, -1)
                    img_latent = vae.encode(img_for_vae[:, :, :, :3])
                    del s, img_for_vae
                    if first_latent is None:
                        first_latent = img_latent  # 记录第一张图的 latent 作为 latent_out

                # ---- VL 编码 ----
                vl_total = 384 * 384
                vl_scale = math.sqrt(vl_total / current_total)
                vl_w = round(samples.shape[3] * vl_scale)
                vl_h = round(samples.shape[2] * vl_scale)
                s_vl = comfy.utils.common_upscale(samples, vl_w, vl_h, "lanczos", "center")
                vl_image = s_vl.movedim(1, -1)

            # ---- tokenize + encode ----
            if is_21:
                # 对齐官方：不传 llama_template（核心自动插 1 个占位符），
                # 指令并进 user 段文本（不走 system_prompt，否则会被 2.1 丢 system 段时丢弃）
                tokens = clip.tokenize(
                    _text_for_21(prompt or "", instruction),
                    images=[vl_image],
                    keep_vision=(img_latent is None),
                    prevent_empty_text=True,
                )
            else:
                image_tag = ("Picture 1: " + KREA2_VISION_TOKEN) if is_krea2 else "Picture 1: "
                full_prompt = image_tag + (prompt or "")
                tokens = clip.tokenize(full_prompt, images=[vl_image], llama_template=llama_template)
            cond = clip.encode_from_tokens_scheduled(tokens)

            # ---- 每张图的 conditioning 绑定自己的 latent ----
            _warn_no_ref_capability(clip, 0 if img_latent is None else 1, "Ref Independent")

            if img_latent is not None:
                ref_vals = {"reference_latents": [img_latent]}
                if is_krea2:
                    # Krea2 的 default_ref_method 是 None ⇒ 不显式给方法时参考图会被
                    # 静默忽略（不报错、只是没效果）。
                    # ★★ 必须用 "index" 而非 "index_timestep_zero"：后者给参考图单独
                    #    一套 t=0 的 adaLN 调制，与 krea2_edit LoRA 的训练（全序列同一
                    #    tvec）不符，实测会把参考线稿"描"进成图。
                    ref_vals["reference_latents_method"] = "index"
                cond = node_helpers.conditioning_set_values(
                    cond,
                    ref_vals,
                    append=True,
                )

            conds.append(cond)
            # 2.1：latent 是采样起点，必须是全零（官方语义），
            # 不能是参考图的真实 latent，否则接 KSampler 就变成 img2img、编辑失效。
            # 尺寸统一用「出图分辨率」（每个 latentN 槽都一样），与参考图尺寸解耦。
            if is_21:
                latents.append(torch.zeros(
                    [1, 64, final_h // 16, final_w // 16],
                    device=comfy.model_management.intermediate_device(),
                ))
            elif is_krea2:
                # Krea2 也是全零起点（16 通道 / 8x），参考图不进采样起点。
                latents.append(_krea2_empty_latent(final_w, final_h)["samples"])
            else:
                latents.append(img_latent)
            del samples, vl_image

        # 补齐到 10 个 conditioning
        while len(conds) < 10:
            conds.append((torch.zeros(1, 768), {}))
        while len(latents) < 10:
            latents.append(None)

        # 共享 latent_out（非 2.1 取第一张非空图的 latent；2.1 用出图分辨率的全零 latent）
        if is_21:
            latent_out = {"samples": torch.zeros(
                [1, 64, final_h // 16, final_w // 16],
                device=comfy.model_management.intermediate_device(),
            )}
        elif is_krea2:
            latent_out = _krea2_empty_latent(final_w, final_h)
        elif first_latent is None:
            # 一张图都没接：给一个与模型匹配的空 latent。
            # 原来固定 4 通道 1×1 —— KSampler 的 fix_empty_latent_channels 会把它补成
            # (1, 128, 1, 1) 并照常采样，最后解码出一张 16×16 的废图（不报错，很难查）。
            if 模型类型 == "Flux2":
                scale, channels = 16, 128
            else:
                scale, channels = 8, 4
            latent_out = {"samples": torch.zeros(
                [1, channels, max(1, 输出高度 // scale), max(1, 输出宽度 // scale)],
                device=comfy.model_management.intermediate_device(),
            )}
        else:
            latent_out = {"samples": first_latent}

        # 返回：交替排列 cond_1, latent1, cond_2, latent2, ...
        # 每个 latentN 槽输出对应图的 latent（空槽用 latent_out 兜底）
        results = []
        for i in range(10):
            results.append(conds[i])
            lat_i = latents[i]
            results.append({"samples": lat_i} if lat_i is not None else latent_out)
        return (*results,)


NODE_CLASS_MAPPINGS["DynamicRefIndependent"] = DynamicRefIndependent
NODE_DISPLAY_NAME_MAPPINGS["DynamicRefIndependent"] = "Ref Independent"
