"""
ComfyUI-Toggle-Pass: 采样器（一体）

把「随机噪波 + CFG引导器 + K采样器选择 + Sigmas」四件套收进一个节点。
等价于以下官方链路：
    RandomNoise + CFGGuider + KSamplerSelect + (BasicScheduler | ManualSigmas)
        -> SamplerCustomAdvanced

设计要点
  · 模型 / 条件 / Latent 仍是输入插槽，所以换任何模型都能直接用；
    真正随模型变的只有「采样方案（sigma 表）」+ 步数 + CFG，做成参数即可。
  · 「采样方案」分三类：
      1) 自动：按 步数 + 调度器 现算 sigma（= BasicScheduler，Krea2 turbo 走这条）
      2) 预置表：蒸馏模型专用的固定 sigma 轨迹（Qwen-Image-2.1 turbo 走这条）
      3) 自定义：手填一串 sigma，方便接新模型而不用改代码
  · 预置表不能靠 steps 推算 —— 那是 8 步蒸馏轨迹，改了就偏离训练分布。

Author: Clever
"""

import torch

import comfy.model_management
import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview


# ==================== 采样方案 ====================

SCHEME_AUTO = "自动（按步数 + 调度器）"
SCHEME_CUSTOM = "自定义表"

# 蒸馏模型专用的固定 sigma 轨迹（来自官方模板，改一个数字就会跑偏）
# 规则：逗号分隔、严格递减、末值必须 0、N 个点 = N-1 步
SIGMA_PRESETS = {
    "Qwen-Image-2.1 turbo 8步":
        "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0",
    "LTX-2 视频 8步（蒸馏）":
        "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
    "LTX-2 视频 3步（低噪）":
        "0.909375, 0.725, 0.421875, 0.0",
}

SCHEME_LIST = [SCHEME_AUTO] + list(SIGMA_PRESETS.keys()) + [SCHEME_CUSTOM]

# 「自定义表」输入框的默认示例：用户点开就能看到该填什么格式
SCHEMA_SAMPLE = SIGMA_PRESETS["Qwen-Image-2.1 turbo 8步"]


# ==================== 模型预设 ====================
# 一键把「采样方案 + 采样器 + 调度器 + 步数 + CFG」设成该模型的常用组合。
#
# 数值不是凭印象写的，全部来自本机 `ComfyUI/user/default/workflows/` 里
# 实际跑通的工作流（括号内是来源文件），改之前请先跑一遍再到这里调：
#   · Qwen-Image 2.1        25 步 euler simple CFG 1   ← qwen-iamge-2.1-Full / qwen-image-2.1-aio
#   · Qwen-Image 2.1 turbo  8 步 固定 sigma 表          ← Qwen21_turbo_TogglePass
#   · Krea 2 turbo          8 步 euler simple CFG 1    ← Krea2_Ostris_Edit_outfit
#   · Krea 2 细节增强       12 步 euler simple CFG 1    ← krea2_turbo_edit
#   · FLUX.2 klein          4 步 euler beta CFG 1      ← Flux2/Flux2图文合一、画质提升
#   · FLUX.2 klein 高清修复 4 步 euler_ancestral simple ← Flux2/flux2-klein-高清修复
#   · Z-Image turbo         8 步 euler_ancestral simple ← z-image/z-image-turbo
#   · Qwen-Image Layered    9 步 euler simple CFG 2.5   ← Qwen-image/image_qwen_layered
#   · Qwen-Image Edit 2511  4 步 euler_ancestral beta   ← Qwen-image/qwen_Image-AIO-2511-*
#   · FIBO 2.0 turbo        4 步 euler simple CFG 1    ← FIBO2-文生图+图编辑
#   · MOSS-Image            30 步 euler normal CFG 4    ← image_moss_image_edit
#
# 前端会读 /toggle_pass/sampler_presets 拿这张表（单一数据源，别在前端再抄一份）。
# Python 本身**不套用**预设：它只是前端的一键填充，参数最终以 widget 上的值为准，
# 这样用户选完预设再手改任何一个值都不会被后端偷偷改回去。
PRESET_NONE = "手动（不套用）"

# 下拉里只显示短名 —— 节点宽度有限，名字太长会把左边的标题「预设」整个挤掉。
# 完整信息都在括注里，而 CFG 之类真正会变的参数选完就能在旁边看到。
MODEL_PRESETS = {
    PRESET_NONE: None,
    "Qwen-Image 2.1（25步）": {
        "scheme": SCHEME_AUTO, "sampler": "euler", "scheduler": "simple",
        "steps": 25, "cfg": 1.0,
    },
    "Qwen-Image 2.1 turbo（8步·固定表）": {
        "scheme": "Qwen-Image-2.1 turbo 8步", "sampler": "euler", "scheduler": "simple",
        "steps": 8, "cfg": 1.0,
    },
    "Krea 2 turbo（8步）": {
        "scheme": SCHEME_AUTO, "sampler": "euler", "scheduler": "simple",
        "steps": 8, "cfg": 1.0,
    },
    "Krea 2 turbo・细节增强（12步）": {
        "scheme": SCHEME_AUTO, "sampler": "euler", "scheduler": "simple",
        "steps": 12, "cfg": 1.0,
    },
    "FLUX.2 klein（4步·beta）": {
        "scheme": SCHEME_AUTO, "sampler": "euler", "scheduler": "beta",
        "steps": 4, "cfg": 1.0,
    },
    "FLUX.2 klein・高清修复（4步）": {
        "scheme": SCHEME_AUTO, "sampler": "euler_ancestral", "scheduler": "simple",
        "steps": 4, "cfg": 1.0,
    },
    "Z-Image turbo（8步）": {
        "scheme": SCHEME_AUTO, "sampler": "euler_ancestral", "scheduler": "simple",
        "steps": 8, "cfg": 1.0,
    },
    "Qwen-Image Layered（9步·CFG2.5）": {
        "scheme": SCHEME_AUTO, "sampler": "euler", "scheduler": "simple",
        "steps": 9, "cfg": 2.5,
    },
    "Qwen-Image Edit 2511 AIO（4步）": {
        "scheme": SCHEME_AUTO, "sampler": "euler_ancestral", "scheduler": "beta",
        "steps": 4, "cfg": 1.0,
    },
    # 下面两个是 11-04 新加：FIBO 是 4 步蒸馏（steps 给大反而崩），MOSS 是 SFT 不是蒸馏，
    # 30 步 + CFG 4 才是它训练时的配置，降到 4 步会糊成一片。
    "FIBO 2.0 turbo（4步）": {
        "scheme": SCHEME_AUTO, "sampler": "euler", "scheduler": "simple",
        "steps": 4, "cfg": 1.0,
    },
    "MOSS-Image（30步·CFG4）": {
        "scheme": SCHEME_AUTO, "sampler": "euler", "scheduler": "normal",
        "steps": 30, "cfg": 4.0,
    },
}

# 中途有过一版用短名（"Qwen 2.1 · 25步" 这种），已存盘的工作流里可能是它。
# 加载时由前端按这张表把旧值翻译成当前全名，否则下拉会显示成空值。
PRESET_ALIASES = {
    "Qwen 2.1 · 25步": "Qwen-Image 2.1（25步）",
    "Qwen 2.1 turbo · 8步表": "Qwen-Image 2.1 turbo（8步·固定表）",
    "Krea2 turbo · 8步": "Krea 2 turbo（8步）",
    "Krea2 细节 · 12步": "Krea 2 turbo・细节增强（12步）",
    "FLUX2 klein · 4步": "FLUX.2 klein（4步·beta）",
    "FLUX2 高清 · 4步": "FLUX.2 klein・高清修复（4步）",
    "Z-Image turbo · 8步": "Z-Image turbo（8步）",
    "Layered · 9步": "Qwen-Image Layered（9步·CFG2.5）",
    "2511 AIO · 4步": "Qwen-Image Edit 2511 AIO（4步）",
}

PRESET_LIST = [PRESET_NONE] + [k for k in MODEL_PRESETS if k != PRESET_NONE]

# widgets_values 是「按顺序」存的，而 1.57 之前的老存档没有 widgets_values_named，
# 只能靠位置对上号。把「模型预设」挪到最前面之后，这份「老顺序」就是给前端
# 填 nodeData.fallbackWidgetsValuesNames 用的 —— 老存档照这张表按名字重新对应。
LEGACY_WIDGET_ORDER = [
    "采样方案", "采样器", "调度器", "步数", "CFG", "降噪",
    "噪波随机种", "control_after_generate", "自定义Sigma表", "模型预设",
]


# ==================== 工具 ====================

class _RandomNoise:
    """等价于官方的 Noise_RandomNoise。"""

    def __init__(self, seed):
        self.seed = seed

    def generate_noise(self, input_latent):
        latent_image = input_latent["samples"]
        batch_inds = input_latent.get("batch_index")
        return comfy.sample.prepare_noise(latent_image, self.seed, batch_inds)


def parse_sigmas(text):
    """把 "1.0, 0.9, 0" 解析成 tensor，并做基本校验。"""
    if text is None:
        raise ValueError("Sigma 表为空")
    raw = str(text).replace("\n", ",").replace(";", ",").replace("\t", ",")
    values = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            values.append(float(part))
        except ValueError:
            raise ValueError(f"Sigma 表里有无法解析的值：{part!r}（只能是数字和逗号）")

    if len(values) < 2:
        raise ValueError("Sigma 表至少需要 2 个值（N 个点 = N-1 步）")
    if abs(values[-1]) > 1e-6:
        raise ValueError(f"Sigma 表末值必须是 0，现在是 {values[-1]}（否则采样收不干净）")
    for i in range(len(values) - 1):
        if values[i + 1] > values[i] + 1e-6:
            raise ValueError(
                f"Sigma 表必须严格递减，第 {i + 1} 个值 {values[i]} -> {values[i + 1]} 是上涨的"
            )
    return torch.FloatTensor(values)


def truncate_sigmas(sigmas, denoise):
    """按降噪比例从表尾截取 —— 与 BasicScheduler 的 denoise 语义一致。

    img2img / 细化时从较低噪声处起步，所以砍掉表头的高噪声段。
    """
    if denoise >= 0.999:
        return sigmas
    if denoise <= 0.0:
        raise ValueError("降噪为 0 时没有可采样的步数")

    total = sigmas.shape[-1] - 1          # 总步数
    keep = max(1, min(total, int(round(total * denoise))))
    return sigmas[-(keep + 1):]


# ==================== 节点 ====================

class ToggleSampler:
    """一体化采样器：噪波 + CFG引导器 + 采样器 + Sigmas => 出一个 Latent。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL",),
                "正面条件": ("CONDITIONING",),
                "负面条件": ("CONDITIONING",),
                "Latent图像": ("LATENT",),
                # 「模型预设」放在所有参数控件的最前面：先选模型、再微调，才是真实顺序。
                # 它只是前端的一键填充按钮，后端不参与计算。
                "模型预设": (PRESET_LIST, {
                    "default": PRESET_NONE,
                    "tooltip": "选一个模型，自动把下面的采样方案/采样器/调度器/步数/CFG 填好；"
                               "之后手动改其中任何一个会自动回到「手动」",
                }),
                "采样方案": (SCHEME_LIST, {"default": SCHEME_AUTO}),
                "采样器": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
                "调度器": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple"}),
                "步数": ("INT", {
                    "default": 20, "min": 1, "max": 10000, "step": 1,
                    "tooltip": "仅「自动」方案生效；选预置表时步数由表的点数决定",
                }),
                "CFG": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1}),
                "降噪": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "噪波随机种": ("INT", {
                    "default": 0, "min": 0, "max": 0xffffffffffffffff,
                    "control_after_generate": True,
                }),
                "自定义Sigma表": ("STRING", {
                    "default": SCHEMA_SAMPLE,
                    "multiline": True,
                    "tooltip": "仅「自定义表」方案生效。逗号分隔、严格递减、末值必须是 0",
                }),
            }
        }

    RETURN_TYPES = ("LATENT", "LATENT")
    RETURN_NAMES = ("Latent", "降噪Latent")
    FUNCTION = "sample"
    CATEGORY = "Toggle-Pass"

    # ---------- sigma ----------

    @staticmethod
    def build_sigmas(model, scheme, scheduler, steps, denoise, custom_text):
        if scheme == SCHEME_AUTO:
            total = steps
            if denoise < 1.0:
                if denoise <= 0.0:
                    raise ValueError("降噪为 0 时没有可采样的步数")
                total = int(steps / denoise)
            sigmas = comfy.samplers.calculate_sigmas(
                model.get_model_object("model_sampling"), scheduler, total
            ).cpu()
            return sigmas[-(steps + 1):]

        text = custom_text if scheme == SCHEME_CUSTOM else SIGMA_PRESETS.get(scheme)
        if text is None:
            raise ValueError(f"未知采样方案：{scheme}")
        return truncate_sigmas(parse_sigmas(text), denoise)

    # ---------- 主流程 ----------

    def sample(self, 模型, 正面条件, 负面条件, Latent图像, 采样方案, 采样器,
               调度器, 步数, CFG, 降噪, 噪波随机种, 自定义Sigma表,
               模型预设=PRESET_NONE):
        # ⚠️ 这里的参数顺序和 INPUT_TYPES 不一样是故意的：`模型预设` 在 INPUT_TYPES 里排第一
        #    （决定前端控件的显示顺序），但这里必须留在末尾 —— Python 不允许有默认值的参数
        #    排在无默认值的前面。ComfyUI 用关键字传参（getattr(obj, FUNCTION)(**inputs)），
        #    所以顺序差异不影响调用。
        # 模型预设只是个前端快捷填充：选中时前端已经把下面几个参数改好了，
        # 这里不能再套一次 —— 否则用户选完预设又手改了步数，会被后端悄悄改回去。
        model = 模型
        latent = Latent图像
        work = latent.copy()

        samples = comfy.sample.fix_empty_latent_channels(
            model,
            latent["samples"],
            work.get("downscale_ratio_spacial"),
            work.get("downscale_ratio_temporal"),
        )
        work["samples"] = samples
        noise_mask = work.get("noise_mask")

        sigmas = self.build_sigmas(model, 采样方案, 调度器, 步数, 降噪, 自定义Sigma表)
        if sigmas.shape[-1] < 2:
            raise ValueError("Sigma 表换算后不足 2 个点，请加大步数或减小降噪")

        guider = comfy.samplers.CFGGuider(model)
        guider.set_conds(正面条件, 负面条件)
        guider.set_cfg(CFG)

        sampler = comfy.samplers.sampler_object(采样器)
        noise = _RandomNoise(噪波随机种)

        x0_output = {}
        callback = latent_preview.prepare_callback(model, sigmas.shape[-1] - 1, x0_output)
        disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

        out_samples = guider.sample(
            noise.generate_noise(work),
            samples,
            sampler,
            sigmas,
            denoise_mask=noise_mask,
            callback=callback,
            disable_pbar=disable_pbar,
            seed=噪波随机种,
        )
        out_samples = out_samples.to(comfy.model_management.intermediate_device())

        out = latent.copy()
        out.pop("downscale_ratio_spacial", None)
        out.pop("downscale_ratio_temporal", None)
        out["samples"] = out_samples

        if "x0" in x0_output:
            x0_out = model.model.process_latent_out(x0_output["x0"].cpu())
            out_denoised = latent.copy()
            out_denoised["samples"] = x0_out
        else:
            out_denoised = out

        return (out, out_denoised)


NODE_CLASS_MAPPINGS = {
    "ToggleSampler": ToggleSampler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ToggleSampler": "采样器（一体）",
}


# ---- 给前端用的预设表接口 ----
def _register_routes():
    """把 MODEL_PRESETS 原样吐给前端，避免 JS 里再抄一份导致两边不同步。"""
    try:
        from aiohttp import web
        from server import PromptServer

        instance = getattr(PromptServer, "instance", None)
        routes = getattr(instance, "routes", None) if instance is not None else None
        if routes is None:
            return

        @routes.get("/toggle_pass/sampler_presets")
        async def _sampler_presets(request):
            return web.json_response({
                "presets": MODEL_PRESETS,
                "list": PRESET_LIST,
                "default": PRESET_NONE,
                "schemes": SCHEME_LIST,
                # 老存档里存的是长名，前端加载时按这张表换成新名
                "aliases": PRESET_ALIASES,
                # 1.57 之前的老存档只有按位置的 widgets_values，用这张表按名字重新对应
                "legacyWidgetOrder": LEGACY_WIDGET_ORDER,
            })
    except Exception:
        # 独立导入 / 无 server 模块时静默跳过，不影响节点本身
        return


_register_routes()
