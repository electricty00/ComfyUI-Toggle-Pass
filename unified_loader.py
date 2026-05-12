"""
ComfyUI-Toggle-Pass: Unified Loader
整合 UNet + 多 LoRA + CLIP + VAE 加载到一个节点
前端通过「+ 添加 LoRA」按钮动态显示 LoRA 槽位
Author: Clever
"""

import folder_paths
import comfy.sd
import comfy.model_detection
import comfy.utils

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
}


def _detect_clip_type(unet_name):
    """从 UNet 文件自动检测 CLIP 类型，失败返回 None。"""
    try:
        unet_path = folder_paths.get_full_path("unet", unet_name)
        sd, metadata = comfy.utils.load_torch_file(unet_path, return_metadata=True)
        prefix = comfy.model_detection.unet_prefix_from_state_dict(sd)
        model_config = comfy.model_detection.model_config_from_unet(
            sd, prefix, metadata=metadata
        )
        if model_config is not None:
            return model_config.clip_target
    except Exception as e:
        print(f"[ToggleUnifiedLoader] 自动检测 CLIP 类型失败: {e}")
    return None


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

        return {"required": required}

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE")
    FUNCTION = "load"
    CATEGORY = "Toggle-Pass"

    def load(self, **kwargs):
        unet_name = kwargs["unet_name"]
        clip_name = kwargs["clip_name"]
        vae_name  = kwargs["vae_name"]
        clip_type = kwargs["clip_type"]

        # 1. 确定 CLIP 类型
        if clip_type != "auto":
            clip_type_enum = CLIP_TYPE_MAP[clip_type]
        else:
            clip_type_enum = _detect_clip_type(unet_name)
            if clip_type_enum is None:
                print(f"[ToggleUnifiedLoader] 自动检测失败，默认使用 STABLE_DIFFUSION")
                clip_type_enum = comfy.sd.CLIPType.STABLE_DIFFUSION

        # 2. 加载 UNet
        unet_path = folder_paths.get_full_path("unet", unet_name)
        model = comfy.sd.load_unet(unet_path)

        # 3. 加载 CLIP
        clip_path = folder_paths.get_full_path("clip", clip_name)
        clip = comfy.sd.load_clip([clip_path], model_options={}, clip_type=clip_type_enum)

        # 4. 加载 VAE
        vae_path = folder_paths.get_full_path("vae", vae_name)
        sd_vae = comfy.utils.load_torch_file(vae_path)
        vae = comfy.sd.VAE(sd_vae)

        # 5. 应用 LoRA（从 kwargs 中按名称取值）
        for i in range(1, self.MAX_LORAS + 1):
            lora_name      = kwargs.get(f"lora_name_{i}")
            strength_model = kwargs.get(f"lora_strength_model_{i}", 1.0)
            strength_clip  = kwargs.get(f"lora_strength_clip_{i}", 1.0)
            if lora_name is None or lora_name == "none":
                continue
            lora_path = folder_paths.get_full_path("loras", lora_name)
            lora_sd = comfy.utils.load_torch_file(lora_path, safe_load=True)
            model, clip = comfy.sd.load_lora_for_models(
                model, clip, lora_sd, strength_model, strength_clip
            )

        return (model, clip, vae)


# 供 __init__.py 导入
NODE_CLASS_MAPPINGS = {
    "ToggleUnifiedLoader": ToggleUnifiedLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ToggleUnifiedLoader": "Toggle Unified Loader",
}
