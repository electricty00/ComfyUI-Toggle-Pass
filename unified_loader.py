"""
ComfyUI-Toggle-Pass: Unified Loader
整合 UNet + 多 LoRA + CLIP + VAE 加载到一个节点
前端通过「+ 添加 LoRA」按钮动态显示 LoRA 槽位
Author: Clever
"""

import logging
import math
import re

import folder_paths
import comfy.sd
import comfy.model_detection
import comfy.utils

# 加载模式：一体包（CheckpointLoaderSimple 同款）vs 分离组件（原行为）
LOAD_MODE_SPLIT = "分离组件 (UNet+CLIP+VAE)"
LOAD_MODE_CKPT = "Checkpoint 一体包"

# CLIP 类型映射
CLIP_TYPE_MAP = {
    "auto": None,
    "stable_diffusion": comfy.sd.CLIPType.STABLE_DIFFUSION,
    "stable_cascade": comfy.sd.CLIPType.STABLE_CASCADE,
    "sd3": comfy.sd.CLIPType.SD3,
    "flux": comfy.sd.CLIPType.FLUX,
    "flux2": comfy.sd.CLIPType.FLUX2,
    "mochi": comfy.sd.CLIPType.MOCHI,
    "ltxv": comfy.sd.CLIPType.LTXV,
    "wan": comfy.sd.CLIPType.WAN,
    "hidream": comfy.sd.CLIPType.HIDREAM,
    # Qwen-Image / Qwen-Image-2.1 专用（旧版 QwenImage 用 Qwen2.5-VL，2.1 用 Qwen3-VL-8B）
    "qwen_image": comfy.sd.CLIPType.QWEN_IMAGE,
    # Krea-2 专用：TE 是 Qwen3-VL-4B（12 层 tap），与 Qwen-Image 的 8B 不是一回事，
    # 选错会建出通用 qwen3vl，conditioning 宽度对不上
    "krea2": comfy.sd.CLIPType.KREA2,
}

# auto 检测用：supported_models 检测出的模型类 -> 对应的 CLIPType 枚举。
# 注意 comfy.sd.load_clip 的 clip_type 参数是与 CLIPType 枚举比较的
# （见 comfy/sd.py load_text_encoder_state_dicts），所以这里必须返回枚举，
# 不能返回 model_config.clip_target（那是 ClipTarget 对象，比较恒为 False，
# 会导致 Qwen-Image-2.1 退化成通用 qwen3vl，进而丢掉 image_slots 让编辑失效）。
_MODEL_CLASS_TO_CLIPTYPE = {
    "QwenImage21": comfy.sd.CLIPType.QWEN_IMAGE,
    "QwenImage": comfy.sd.CLIPType.QWEN_IMAGE,
    "Krea2": comfy.sd.CLIPType.KREA2,
    "Flux2": comfy.sd.CLIPType.FLUX2,
    "Flux": comfy.sd.CLIPType.FLUX,
    "SD3": comfy.sd.CLIPType.SD3,
    "SDXL": comfy.sd.CLIPType.STABLE_DIFFUSION,
    "SD15": comfy.sd.CLIPType.STABLE_DIFFUSION,
    "SD20": comfy.sd.CLIPType.STABLE_DIFFUSION,
    "SD21": comfy.sd.CLIPType.STABLE_DIFFUSION,
    "WAN21": comfy.sd.CLIPType.WAN,
    "WAN22": comfy.sd.CLIPType.WAN,
    "HunyuanVideo": comfy.sd.CLIPType.HUNYUAN_VIDEO,
    "LTXV": comfy.sd.CLIPType.LTXV,
    "Mochi": comfy.sd.CLIPType.MOCHI,
    "HiDream": comfy.sd.CLIPType.HIDREAM,
}

# 模型类 -> 文本编码器类名前缀（用于分体模式的 CLIP 校验）。
# 只登记「实测确认过类名」的几类；没登记的模型不做校验，宁可漏报也不误报。
# ⚠️ 这不是等价关系：QwenImage(v1, Qwen2.5-VL) 与 QwenImage21(Qwen3-VL-8B) 的 TE 类
#    **不能互认**（实测日志：QwenImageTEModel_ 7910MB vs QwenImage21TEModel_ 6018MB）。
_MODEL_CLASS_TO_TE_PREFIX = {
    "QwenImage21": "QwenImage21TEModel",
    "QwenImage": "QwenImageTEModel",
    "Krea2": "Krea2TEModel",
    "Flux2": "Flux2TEModel",
    "Flux": "FluxTEModel",
}


def _detect_clip_type(unet_name):
    """【已弃用，保留备查】从 UNet 文件猜 CLIPType 枚举。

    ⚠️ 2026-10-21 起 `_load_separate` 不再调用它，改用「先 load_unet 拿到模型类再查表」：
      · 本函数要额外把整个 unet 读一遍（6.9G 读两次）
      · 实测 Qwen2.1 上 `model_config_from_unet` 返回 None（sd 已剥前缀），
        于是静默退化成 STABLE_DIFFUSION，TE 建成通用 Qwen3VL —— 提示词全废且很难发现
    
    必须返回 CLIPType 枚举：comfy.sd.load_clip 的 clip_type 会与 CLIPType 枚举比较，
    传 ClipTarget 对象会恒不匹配，导致 Qwen-Image-2.1 退化成通用 qwen3vl。
    """
    try:
        unet_path = folder_paths.get_full_path("unet", unet_name)
        sd, metadata = comfy.utils.load_torch_file(unet_path, return_metadata=True)
        prefix = comfy.model_detection.unet_prefix_from_state_dict(sd)
        model_config = comfy.model_detection.model_config_from_unet(
            sd, prefix, metadata=metadata
        )
        if model_config is not None:
            name = type(model_config).__name__
            ct = _MODEL_CLASS_TO_CLIPTYPE.get(name)
            if ct is not None:
                print(f"[ToggleUnifiedLoader] 自动检测 CLIP 类型: {name} -> {ct}")
                return ct
            print(f"[ToggleUnifiedLoader] 模型类 {name} 未登记映射，CLIP 类型无法自动确定")
    except Exception as e:
        print(f"[ToggleUnifiedLoader] 自动检测 CLIP 类型失败: {e}")
    return None


def _probe_quantization(model_patcher):
    """探测 base model 的权重量化形态。

    返回 (描述文本, 是否量化)。

    为什么要看这个：量化（INT8/FP8）底座上 LoRA 的表现与全精度底座不同，
    需要在界面上说清楚，免得把「本来就不明显的 LoRA」误判成「节点没加载」。

    ⚠️ 实测结论（2026-10-09 同 seed 受控 A/B，别再引用旧版说法）：
    ComfyUI 对量化层走「反量化 -> 叠加 patch -> 重新量化回 int8」，
    用的是随机舍入 + 重算 scale，增量幅度能保留约 113%~120%、方向余弦 0.4~0.7
    → **LoRA 依然生效**，只是会更「糊」一点。
    同一 INT8 一体包下，本节点与官方 CheckpointLoaderSimple+LoraLoader 输出逐像素一致
    （meanAbsDiff = 0.00）。所以「看不出效果」一般出在 LoRA 本身或强度，不是量化把 patch 抹掉。
    """
    try:
        from collections import Counter
        base = getattr(model_patcher, "model", None)
        if base is None:
            return "(取不到 base model)", False
        mc = getattr(base, "model_config", None)
        qc = getattr(mc, "quant_config", None)
        dtypes = Counter()
        for i, (_, p) in enumerate(base.named_parameters()):
            dtypes[str(getattr(p, "dtype", "?"))] += 1
            if i >= 300:      # 只抽样，不全量遍历（大模型参数上千个）
                break
        top = "，".join(f"{k}×{v}" for k, v in dtypes.most_common(4))
        dtxt = " / ".join(dtypes.keys())
        quantized = bool(qc) or ("int8" in dtxt or "uint8" in dtxt or "float8" in dtxt)
        return f"权重 dtype: {top}；quant_config={qc}", quantized
    except Exception as e:
        return f"(读取权重信息失败: {e})", False


def _safe_float(v, default=1.0):
    """强度兜底：None / 空串 / NaN / Inf / 非数字一律回落到 default。

    前端偶发把滑块值传成 null（widget 被隐藏时），直接进 load_lora_for_models
    会让 patch 权重变成 None，表现为「LoRA 静默不生效」。
    """
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    return f


_LORA_PAIR_RE = re.compile(r"\.lora_(A|B|up|down)\b")


def _lora_module_names(lora_sd):
    """LoRA 文件里有多少个「模块」（把 lora_A/lora_B、lora_up/lora_down 归一）。

    这个数是「本 LoRA 理论上要挂多少层」，用作覆盖率的分母。
    例：Qwen2.1_Anime_consistency 是 448 个 key -> 224 个模块（32 block x 7）。
    """
    base = set()
    for k in lora_sd.keys():
        m = _LORA_PAIR_RE.search(k)
        if m:
            base.add(k[: m.start()].rstrip("."))
    return base


def _lora_key_map(model, clip):
    """生成「LoRA 键名 -> 模型层」映射表（与 comfy.sd.load_lora_for_models 内部同一套逻辑）。

    只依赖模型的 state_dict 键名，不复制权重；多个 LoRA 共用同一份，
    所以调用方在循环外只算一次，避免对量化大模型反复遍历 state_dict。
    """
    try:
        import comfy.lora
        key_map = {}
        base_model = getattr(model, "model", None)
        if base_model is not None:
            key_map = comfy.lora.model_lora_keys_unet(base_model, key_map)
        if clip is not None:
            csm = getattr(clip, "cond_stage_model", None)
            if csm is not None:
                key_map = comfy.lora.model_lora_keys_clip(csm, key_map)
        return key_map
    except Exception as e:
        print(f"[ToggleUnifiedLoader] 生成 LoRA 键名表失败（不影响出图）: {e}")
        return None


def _lora_coverage(key_map, lora_sd):
    """算这份 LoRA 有多少模块能对上当前模型，返回 dict 或 None（纯展示，异常全吞）。

    为什么需要它：真机上 LoRA「加载成功」但只挂上一部分 key 是常见现象——
    例如 INT8 一体包 repack 时把 `img_mlp.gate_layer` 融进了 `gate_up` 的切片，
    LoRA 里对应的模块就会落到模型里不存在的层上（add_patches 会直接丢掉）。
    这个差异必须在界面上可见，否则用户只会看到「LoRA 没效果」，然后怀疑节点。
    """
    if not key_map:
        return None
    try:
        mods = _lora_module_names(lora_sd)
        if not mods:
            return None
        miss = sorted(b for b in mods if b not in key_map)
        return {"modules": len(mods), "matched": len(mods) - len(miss), "missing": miss}
    except Exception as e:
        print(f"[ToggleUnifiedLoader] 覆盖率统计失败（不影响出图）: {e}")
        return None


def _te_class_name(clip):
    """取文本编码器的实际类名（如 QwenImage21TEModel_）。

    ⚠️ 必须显式判 None：`type(None).__name__` 是字符串 "NoneType"（truthy），
    会被当成「类名不符」误报 CLIP 校验失败。
    """
    try:
        csm = getattr(clip, "cond_stage_model", None)
        if csm is None:
            return None
        return type(csm).__name__
    except Exception:
        return None


def _check_clip_match(model_cls, clip):
    """校验分体模式下 CLIP 文件是否与模型配套。

    背景：换 CLIP 文件会改变 ComfyUI 建出的文本编码器类，日志实测出现过
    QwenImage21TEModel_(6018MB，正确) / QwenImageTEModel_(7910MB，v1) /
    Flux2TEModel_(8262MB，完全不对)。建错了 conditioning 就是废的，
    表现却是「跑得通但什么都不生效」，极难自查 —— 所以这里主动报出来。
    返回 {"te":..., "expect":..., "ok": True/False/None}（None = 该模型不做校验）。
    """
    te = _te_class_name(clip)
    expect = _MODEL_CLASS_TO_TE_PREFIX.get(model_cls)
    if not te or not expect:
        return {"te": te, "expect": expect, "ok": None}
    return {"te": te, "expect": expect, "ok": te.startswith(expect)}


# 模型类 -> 换 VAE 的具体建议。只登记实测确认过的场景，避免给出误导性推荐。
_VAE_HINT = {
    "QwenImage21": "请换用 qwen_image_2.1_vae_bf16.safetensors（64 通道 / 2 维）；"
                   "qwen_image_vae.safetensors 是 Qwen-Image 1.0 的（16 通道 / 3 维），两者不通用。",
    "Krea2": "Krea-2 用的是 qwen_image_vae.safetensors（16 通道 / 3 维 / 8x）；"
             "别选 qwen_image_2.1_vae_bf16（64 通道 / 2 维），那个是 Qwen-Image-2.1 的。",
}


def _check_vae_match(model_cls, model, vae):
    """校验 VAE 与模型是否配套（latent 通道数 / 维度）。

    背景：VAE 不配套时采样阶段不会报错 —— fix_empty_latent_channels 会把通道补齐，
    25 步照样跑完，直到 VAEDecode 才炸，而且报的是
        IndexError: tuple index out of range（comfy/sd.py 里 Wan VAE 的 5D memory 估算）
    完全指不到「VAE 选错了」这件事上，极难自查。所以加载时就主动比一下。

    返回 {"ok": True/False/None, "expect_ch":.., "expect_dim":.., "vae_ch":.., "vae_dim":..}
    （None = 有一侧拿不到数据，不做判断）
    """
    out = {"ok": None}
    try:
        lf = getattr(getattr(model, "model", None), "latent_format", None)
        out["expect_ch"] = getattr(lf, "latent_channels", None)
        out["expect_dim"] = getattr(lf, "latent_dimensions", None)
    except Exception:
        out["expect_ch"] = out["expect_dim"] = None

    out["vae_ch"] = getattr(vae, "latent_channels", None)
    out["vae_dim"] = getattr(vae, "latent_dim", None)

    if out["expect_ch"] is None or out["vae_ch"] is None:
        return out

    bad = out["expect_ch"] != out["vae_ch"]
    if out["expect_dim"] is not None and out["vae_dim"] is not None:
        bad = bad or (out["expect_dim"] != out["vae_dim"])

    out["ok"] = not bad
    if bad:
        out["hint"] = _VAE_HINT.get(model_cls, "请换用与该模型配套的 VAE 文件。")
    return out


class _LoraWarnCollector(logging.Handler):
    """捕获 comfy.sd.load_lora_for_models 打出的 'NOT LOADED xxx' 警告。

    没有这个收集器时，LoRA 权重与模型不兼容只会往控制台刷一堆 NOT LOADED，
    界面上完全看不出来，表现就是「选了 LoRA 但没效果」。
    """

    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.msgs = []

    def emit(self, record):
        try:
            msg = record.getMessage()
            if msg.startswith("NOT LOADED"):
                self.msgs.append(msg[len("NOT LOADED"):].strip())
        except Exception:
            pass


class ToggleUnifiedLoader:
    """
    整合加载节点：
    - 加载 UNet 模型（输出 MODEL）
    - 加载 CLIP（输出 CLIP）
    - 加载 VAE（输出 VAE）
    - 按顺序应用多个 LoRA（前端按钮动态添加，选 none 跳过）
    """

    MAX_LORAS = 10

    @classmethod
    def INPUT_TYPES(cls):
        lora_names = ["none"] + folder_paths.get_filename_list("loras")
        unet_names = folder_paths.get_filename_list("unet")
        clip_names = folder_paths.get_filename_list("clip")
        vae_names = folder_paths.get_filename_list("vae")
        ckpt_names = folder_paths.get_filename_list("checkpoints")
        if not ckpt_names:
            ckpt_names = ["（models/checkpoints 为空）"]

        required = {
            "unet_name": (unet_names,),
            "clip_name": (clip_names,),
            "vae_name": (vae_names,),
            "clip_type": (list(CLIP_TYPE_MAP.keys()),),
        }

        # 预定义最多 MAX_LORAS 组，前端通过按钮按需显示
        for i in range(1, cls.MAX_LORAS + 1):
            required[f"lora_name_{i}"] = (lora_names,)
            required[f"lora_strength_model_{i}"] = (
                "FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01},
            )
            required[f"lora_strength_clip_{i}"] = (
                "FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01},
            )

        # ↓ 新增：加载模式 + Checkpoint 选择。
        #   一律追加在末尾：ComfyUI 的 widgets_values 是按位置存的，
        #   插在中间会让旧工作流的参数整体错位（之前踩过 NaN 那次）。
        required["加载模式"] = ([LOAD_MODE_SPLIT, LOAD_MODE_CKPT],
                              {"default": LOAD_MODE_SPLIT})
        required["ckpt_name"] = (ckpt_names,)

        # hidden 只用于拿节点 id，把「LoRA 到底写进去没有」回传到画面上。
        # hidden 属于 prompt 级输入，不会产生 widget，也不进 widgets_values
        # （参数位置序列化完全不受影响）。
        return {"required": required, "hidden": {"unique_id": "UNIQUE_ID"}}

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE")
    FUNCTION = "load"
    CATEGORY = "Toggle-Pass"

    def _load_checkpoint(self, kwargs):
        """Checkpoint 一体包：官方 CheckpointLoaderSimple 同款（自动猜配置，一次出 MODEL/CLIP/VAE）。"""
        ckpt_name = kwargs.get("ckpt_name")
        ckpt_path = folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)
        print(f"[ToggleUnifiedLoader] Checkpoint 一体包: {ckpt_name}")
        out = comfy.sd.load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        model, clip, vae = out[:3]
        # 打印自动猜出的架构：guess_config 猜错时 LoRA 的权重会全部对不上
        # （NOT LOADED），表现就是「选了 LoRA 却完全没效果」，这里留个可查的线索
        try:
            inner = getattr(model, "model", None)
            cfg = getattr(inner, "model_config", None)
            print(f"[ToggleUnifiedLoader] 一体包自动识别架构: "
                  f"{type(inner).__name__}"
                  f"{' / ' + type(cfg).__name__ if cfg is not None else ''}"
                  f"；CLIP={'有' if clip is not None else '无'}，VAE={'有' if vae is not None else '无'}")
        except Exception as e:
            print(f"[ToggleUnifiedLoader] 打印架构信息失败: {e}")

        # 量化只影响「效果强弱」，不代表 LoRA 没写进去；这里只做中性提示
        note, quantized = _probe_quantization(model)
        print(f"[ToggleUnifiedLoader] 权重形态: {note}")
        self._base_quantized = quantized
        if quantized:
            print("[ToggleUnifiedLoader] 提示：底座是量化版（INT8/FP8）。LoRA 依然会正常写入"
                  "（实测与官方节点逐像素一致），只是效果会比全精度底座更『糊』一些；"
                  "风格特别细腻的 LoRA 可能不易看出，想要更干净可换 bf16/fp16 一体包。")
        # 一体包也会自动猜 CLIP，同样校验一下（猜错时 conditioning 会整体失效）
        self._clip_check = _check_clip_match(type(getattr(model, "model", None)).__name__, clip)
        if self._clip_check.get("ok") is False:
            print(f"[ToggleUnifiedLoader] ⚠️ CLIP 校验：文本编码器建成 {self._clip_check['te']}"
                  f"（预期 {self._clip_check['expect']}），该 checkpoint 的 CLIP 可能与模型不配套")
        return model, clip, vae

    def _load_separate(self, kwargs):
        """分离组件：UNet + CLIP + VAE 各自指定（原行为，一字未改）。"""
        unet_name = kwargs.get("unet_name")
        clip_name = kwargs.get("clip_name")
        vae_name  = kwargs.get("vae_name")
        clip_type = kwargs.get("clip_type")

        # 1. 先加载 UNet —— 必须先有模型对象，才知道该配哪种 CLIP。
        #    旧做法是先用 _detect_clip_type 猜：它要额外把整个 unet 读一遍（6.9G 读两次），
        #    而且 model_config_from_unet 对已剥离前缀的 sd 常常返回 None（实测 Qwen2.1 就是这样），
        #    猜不出来就退化成 STABLE_DIFFUSION，导致 TE 建成通用 Qwen3VL、提示词全废。
        unet_path = folder_paths.get_full_path("unet", unet_name)
        model = comfy.sd.load_unet(unet_path)
        model_cls = type(getattr(model, "model", None)).__name__

        # 2. 确定 CLIP 类型（直接按已加载模型的类名查表，最可靠）
        if clip_type != "auto":
            clip_type_enum = CLIP_TYPE_MAP[clip_type]
            print(f"[ToggleUnifiedLoader] CLIP 类型: 手动指定 {clip_type}")
        else:
            clip_type_enum = _MODEL_CLASS_TO_CLIPTYPE.get(model_cls)
            if clip_type_enum is None:
                print(f"[ToggleUnifiedLoader] 模型类 {model_cls} 未登记映射，"
                      f"CLIP 类型默认使用 STABLE_DIFFUSION")
                clip_type_enum = comfy.sd.CLIPType.STABLE_DIFFUSION
            else:
                print(f"[ToggleUnifiedLoader] 自动检测 CLIP 类型: {model_cls} -> {clip_type_enum}")

        # 3. 加载 CLIP
        clip_path = folder_paths.get_full_path("clip", clip_name)
        clip = comfy.sd.load_clip([clip_path], model_options={}, clip_type=clip_type_enum)

        # 3.1 校验文本编码器是否与模型配套。
        #     选错 CLIP 文件时 ComfyUI 会静静建出另一个 TE 类，跑得通但 conditioning 全废。
        self._clip_check = _check_clip_match(model_cls, clip)
        if self._clip_check.get("ok") is False:
            print(f"[ToggleUnifiedLoader] ⚠️ CLIP 校验失败：模型是 {model_cls}，"
                  f"但文本编码器建成了 {self._clip_check['te']}"
                  f"（预期 {self._clip_check['expect']}）。"
                  f"这个 CLIP 文件与模型不配套 → 提示词会被错误编码（跑得通但什么都不生效）。"
                  f"请更换 CLIP 文件，或检查『CLIP 类型』是否选对。")
        elif self._clip_check.get("te"):
            print(f"[ToggleUnifiedLoader] CLIP 校验通过: 文本编码器 = {self._clip_check['te']}")

        # 4. 加载 VAE
        vae_path = folder_paths.get_full_path("vae", vae_name)
        sd_vae, vae_meta = comfy.utils.load_torch_file(vae_path, return_metadata=True)
        vae = comfy.sd.VAE(sd=sd_vae, metadata=vae_meta)

        # 4.1 校验 VAE 与模型是否配套。
        #     latent 通道/维度不对时，采样阶段能被 fix_empty_latent_channels 蒙混过关，
        #     到 VAEDecode 才炸（典型症状：IndexError: tuple index out of range，跑完 25 步才崩）。
        self._vae_check = _check_vae_match(model_cls, model, vae)
        vc = self._vae_check
        if vc.get("ok") is False:
            print(f"[ToggleUnifiedLoader] ⚠️ VAE 校验失败：模型 {model_cls} 需要 "
                  f"{vc['expect_ch']} 通道 / {vc['expect_dim']} 维 latent，"
                  f"但 VAE 是 {vc['vae_ch']} 通道 / {vc['vae_dim']} 维 → 解码会直接报错。"
                  f"{vc.get('hint', '')}")
        elif vc.get("vae_ch") is not None:
            print(f"[ToggleUnifiedLoader] VAE 校验通过: {vc['vae_ch']} 通道 / {vc['vae_dim']} 维 latent")

        return model, clip, vae

    def load(self, **kwargs):
        mode = kwargs.get("加载模式", LOAD_MODE_SPLIT)
        is_ckpt = (mode == LOAD_MODE_CKPT)
        node_id = kwargs.get("unique_id")
        self._base_quantized = False
        self._clip_check = None
        print(f"[ToggleUnifiedLoader] 加载模式: {mode}")

        # 诊断：先打印前端实际传进来的 LoRA 参数。
        # 这是区分「前端根本没提交」与「提交了但权重没匹配上」的唯一依据。
        got = []
        for i in range(1, self.MAX_LORAS + 1):
            v = kwargs.get(f"lora_name_{i}")
            if v is not None and v != "none":
                got.append(
                    f"#{i}={v} (model={kwargs.get(f'lora_strength_model_{i}')}, "
                    f"clip={kwargs.get(f'lora_strength_clip_{i}')})"
                )
        print(f"[ToggleUnifiedLoader] 收到 LoRA: {'; '.join(got) if got else '（无）'}")

        if is_ckpt:
            model, clip, vae = self._load_checkpoint(kwargs)
        else:
            model, clip, vae = self._load_separate(kwargs)
            note, quantized = _probe_quantization(model)
            print(f"[ToggleUnifiedLoader] 权重形态: {note}")
            self._base_quantized = quantized
            if quantized:
                print("[ToggleUnifiedLoader] ⚠️ 该模型是量化版（INT8/FP8），LoRA 增量可能被量化抹平"
                      "（见上一节说明），表现就是『加载成功却没效果』。")

        # 应用 LoRA（两种加载模式共用；从 kwargs 中按名称取值）
        applied = []
        report = []          # 回传到界面：每个 LoRA 实际写入了多少个 patch
        # 键名表只依赖模型结构（不动权重），所有 LoRA 共用一份 → 循环外只算一次，
        # 避免对量化大模型反复遍历 state_dict
        key_map = None
        if any(kwargs.get(f"lora_name_{i}") not in (None, "none")
               for i in range(1, self.MAX_LORAS + 1)):
            key_map = _lora_key_map(model, clip)
        for i in range(1, self.MAX_LORAS + 1):
            lora_name      = kwargs.get(f"lora_name_{i}")
            strength_model = _safe_float(kwargs.get(f"lora_strength_model_{i}", 1.0), 1.0)
            # 界面上只保留一个「强度」滑块（lora_strength_clip_i 已隐藏、值跟随 model）。
            # 这里再兜一层：clip 缺失 / 传 null 时直接跟随 model，
            # 避免用到工作流里遗留的旧 clip 值导致「看到的强度 ≠ 实际强度」。
            _sc = kwargs.get(f"lora_strength_clip_{i}", None)
            strength_clip = strength_model if _sc is None else _safe_float(_sc, strength_model)
            if lora_name is None or lora_name == "none":
                continue
            lora_path = folder_paths.get_full_path("loras", lora_name)
            if lora_path is None:
                print(f"[ToggleUnifiedLoader] ⚠️ LoRA #{i} 找不到文件: {lora_name}，已跳过")
                report.append({"slot": i, "name": lora_name, "patches": 0,
                               "error": "找不到文件"})
                continue

            lora_sd = comfy.utils.load_torch_file(lora_path, safe_load=True)

            # 强度为 0 的 LoRA 等于没加载，但界面上几乎看不出来（滑块收在组里），
            # 之前「移除 LoRA」会把它设成 0 且复用复发，就是这个坑
            if abs(strength_model) < 1e-6:
                print(f"[ToggleUnifiedLoader] ⚠️ LoRA #{i} ({lora_name}) 强度为 0 —— "
                      f"文件会正常加载，但等于完全没生效，请检查界面上的『强度』滑块")

            collector = _LoraWarnCollector()
            root = logging.getLogger()
            root.addHandler(collector)
            try:
                new_model, new_clip = comfy.sd.load_lora_for_models(
                    model, clip, lora_sd, strength_model, strength_clip
                )
            finally:
                root.removeHandler(collector)

            # 校验 patch 是否真的挂上去了
            n_before = len(getattr(model, "patches", None) or {})
            n_after = len(getattr(new_model, "patches", None) or {})
            added = n_after - n_before
            model, clip = new_model, new_clip

            if added <= 0 and not collector.msgs:
                print(f"[ToggleUnifiedLoader] ⚠️ LoRA #{i} ({lora_name}) 未产生任何 patch，"
                      f"请确认它与当前模型架构匹配")
            elif collector.msgs:
                print(f"[ToggleUnifiedLoader] ⚠️ LoRA #{i} ({lora_name})："
                      f"{len(collector.msgs)}/{len(collector.msgs) + added} 个权重未匹配到模型"
                      f"（架构不兼容会静默无效果）。示例: "
                      f"{collector.msgs[:2]}")
            else:
                print(f"[ToggleUnifiedLoader] ✅ LoRA #{i} ({lora_name}) 已应用 "
                      f"{added} 个 patch (model={strength_model}, clip={strength_clip})")
                applied.append(added)

            # 模块覆盖率：LoRA 自己有多少模块 / 实际落下多少个 patch。
            # 一体包被别人 repack 过的层（如 img_mlp.gate_layer）会挂不上，
            # 这个差值必须说出来，否则用户只会看到「LoRA 没效果」而怀疑节点。
            cov = _lora_coverage(key_map, lora_sd)
            if cov and added < cov["modules"]:
                if cov["matched"] < cov["modules"]:
                    why = f"{cov['modules'] - cov['matched']} 个模块键名对不上（架构不匹配）"
                else:
                    why = (f"{cov['modules'] - added} 个模块的目标层在当前底座上不存在"
                           f"（一体化包 repack 融合过，属正常差异）")
                print(f"[ToggleUnifiedLoader]   ↳ 模块覆盖 {added}/{cov['modules']}：{why}")
                if cov["missing"]:
                    print(f"[ToggleUnifiedLoader]     未命中示例: {cov['missing'][:3]}")

            report.append({"slot": i, "name": lora_name, "strength": strength_model,
                           "patches": int(added), "unmatched": len(collector.msgs),
                           "modules": (cov or {}).get("modules"),
                           "matched": (cov or {}).get("matched")})

        if applied:
            extra = ""
            if getattr(self, "_base_quantized", False):
                extra = "；底座是量化模型，LoRA 会变『糊』（幅度保留、方向带噪声），风格类不易看出"
            print(f"[ToggleUnifiedLoader] LoRA 汇总: {len(applied)} 个生效，"
                  f"合计 {sum(applied)} 个 patch{extra}")
        elif not got:
            print("[ToggleUnifiedLoader] 本次未添加任何 LoRA（10 个槽位都选的是 none）")

        cov_mod = sum(r.get("modules") or 0 for r in report if (r.get("patches") or 0) > 0)
        coverage = {"patches": int(sum(applied)), "modules": int(cov_mod)}
        self._push_status(node_id, report, applied,
                          bool(getattr(self, "_base_quantized", False)),
                          getattr(self, "_clip_check", None), coverage)

        return (model, clip, vae)

    @staticmethod
    def _push_status(node_id, report, applied, quantized, clip_info=None, coverage=None):
        """把 LoRA 实际写入结果回传到节点画面上（send_sync）。

        控制台里也有同样的信息，但要翻要滚；直接写在按钮文案上最省事：
        `+ 添加 LoRA · 已启用 1 · 已写入 224 patch`。
        这一步纯展示，任何异常都不能影响出图，所以整体 try 住。
        """
        if node_id is None:
            return
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("toggle-pass-lora-status", {
                "node": str(node_id),
                "quantized": bool(quantized),
                "count": len(applied),
                "total_patches": int(sum(applied)),
                "items": report,
                "coverage": coverage,      # {"patches": N, "modules": M} -> 按钮显示 N/Mp
                "clip": clip_info,         # {"te":..., "expect":..., "ok":...} -> CLIP 校验结果
            })
        except Exception as e:
            print(f"[ToggleUnifiedLoader] 状态回传失败（不影响出图）: {e}")


# 供 __init__.py 导入
NODE_CLASS_MAPPINGS = {
    "ToggleUnifiedLoader": ToggleUnifiedLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ToggleUnifiedLoader": "Toggle Unified Loader",
}
