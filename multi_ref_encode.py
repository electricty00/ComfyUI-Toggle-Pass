"""
Multi-Reference Image Encode Node
Supports 3/5/10 reference images for Qwen2.5-VL / FLUX2 workflows.
Each image is encoded into a reference latent and injected into conditioning.

Version: 3.0 - Multiple node classes (3/5/10 images) + Custom output size for img2img
"""

import math
import torch
import comfy.utils
import node_helpers
import comfy.model_management


class DynamicRefImageEncode:
    """
    动态 Ref Image Encode 节点，合并原 III/V/X 三个节点。
    前端 JS 根据 num_images 增删 IMAGE 输入槽（1~10）。
    所有参考图共享同一个 prompt，输出 1 个 conditioning + 1 个 latent。
    """

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
                "模型类型": (["Flux2", "Qwen Layered", "SD / SDXL"], {"default": "Flux2"}),
                "匹配原图尺寸": (["OFF", "ON"], {"default": "OFF"}),
                "输出宽度": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 8}),
                "输出高度": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 8}),
                "图层数": ("INT", {"default": 3, "min": 1, "max": 64, "step": 1}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("conditioning", "latent")
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
        elif 模型类型 == "Flux2":
            h = height // 16
            w = width // 16
            latent = torch.zeros(1, 4, h, w)
        else:
            h = height // 8
            w = width // 8
            latent = torch.zeros(1, 4, h, w)
        return {"samples": latent}

    def encode(self, clip, num_images, prompt, instruction="",
               vae=None, 模型类型="Flux2", 匹配原图尺寸="OFF",
               输出宽度=1024, 输出高度=1024, 图层数=3, **kwargs):

        n = max(1, min(10, int(num_images)))
        llama_template = self._get_system_prompt(instruction)

        ref_latents = []
        vl_images = []
        image_prompt = ""
        first_img_w = 0
        first_img_h = 0

        for i in range(1, n + 1):
            image = kwargs.get(f"image{i}", None)
            if image is None:
                continue

            samples = image.movedim(-1, 1)  # [B, C, H, W]
            current_total = samples.shape[3] * samples.shape[2]

            if 匹配原图尺寸 == "ON":
                pixel_width = samples.shape[3]
                pixel_height = samples.shape[2]
            else:
                pixel_width = 输出宽度
                pixel_height = 输出高度

            # 记录最后一张有效图的原始像素尺寸
            first_img_w = samples.shape[3]
            first_img_h = samples.shape[2]

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

        full_prompt = image_prompt + prompt
        tokens = clip.tokenize(full_prompt, images=vl_images, llama_template=llama_template)
        conditioning = clip.encode_from_tokens_scheduled(tokens)

        if len(ref_latents) > 0:
            conditioning = node_helpers.conditioning_set_values(
                conditioning,
                {"reference_latents": ref_latents},
                append=True,
            )

        # Qwen Layered 模式：始终输出分层 latent
        if 模型类型 == "Qwen Layered":
            if 匹配原图尺寸 == "ON" and first_img_w > 0:
                latent_out = self._make_empty_latent(模型类型, first_img_w, first_img_h, 图层数)
            else:
                latent_out = self._make_empty_latent(模型类型, 输出宽度, 输出高度, 图层数)
        elif len(ref_latents) > 0:
            latent_out = {"samples": ref_latents[0]}
        else:
            latent_out = self._make_empty_latent(模型类型, 输出宽度, 输出高度, 图层数)

        return (conditioning, latent_out)


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
                "模型类型": (["Flux2", "SD / SDXL"], {"default": "Flux2"}),
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
               **kwargs):

        n = max(2, min(8, int(prompt数量)))
        llama_template = self._get_system_prompt(instruction)

        # ---- 图片预处理（只做一次）----
        samples = image.movedim(-1, 1)  # [B, C, H, W]
        current_total = samples.shape[3] * samples.shape[2]

        if 匹配原图尺寸 == "ON":
            pixel_width = samples.shape[3]
            pixel_height = samples.shape[2]
        else:
            pixel_width = 输出宽度
            pixel_height = 输出高度

        # VAE 编码参考图（图生图用）
        ref_latent = None
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
            full_prompt = image_prompt + p
            tokens = clip.tokenize(full_prompt, images=[vl_image], llama_template=llama_template)
            cond = clip.encode_from_tokens_scheduled(tokens)

            if ref_latent is not None:
                cond = node_helpers.conditioning_set_values(
                    cond,
                    {"reference_latents": [ref_latent]},
                    append=True,
                )

            results.append(cond)

        # ---- 共享 latent 输出 ----
        if ref_latent is not None:
            latent_out = {"samples": ref_latent}
        else:
            # 纯文生图
            scale = 16 if 模型类型 == "Flux2" else 8
            lw = 输出宽度 // scale
            lh = 输出高度 // scale
            latent_out = {"samples": torch.zeros(1, 4, lh, lw)}

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

    def encode(self, clip, num_images, instruction="", vae=None, **kwargs):
        n = max(1, min(10, int(num_images)))
        llama_template = self._get_system_prompt(instruction)
        conds = []
        latents = []          # 每张图自己的 latent
        first_latent = None   # 第一张非空图的 latent，用于共享 latent_out

        for i in range(1, n + 1):
            img = kwargs.get(f"image{i}", None)
            prompt = kwargs.get(f"prompt{i}", "")

            if img is None:
                # 空槽：用纯文本 prompt 编码，不带图片，格式正确
                text = prompt or ""
                tokens = clip.tokenize(text, llama_template=llama_template)
                cond = clip.encode_from_tokens_scheduled(tokens)
                conds.append(cond)
                latents.append(None)  # 空槽没有 latent
                continue

            samples = img.movedim(-1, 1)
            current_total = samples.shape[3] * samples.shape[2]

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
            image_tag = "Picture 1: "
            full_prompt = image_tag + (prompt or "")
            tokens = clip.tokenize(full_prompt, images=[vl_image], llama_template=llama_template)
            cond = clip.encode_from_tokens_scheduled(tokens)

            # ---- 每张图的 conditioning 绑定自己的 latent ----
            if img_latent is not None:
                cond = node_helpers.conditioning_set_values(
                    cond,
                    {"reference_latents": [img_latent]},
                    append=True,
                )

            conds.append(cond)
            latents.append(img_latent)
            del samples, s_vl, vl_image

        # 补齐到 10 个 conditioning
        while len(conds) < 10:
            conds.append((torch.zeros(1, 768), {}))
        while len(latents) < 10:
            latents.append(None)

        # 共享 latent_out（取第一张非空图的 latent，供下游 Empty Latent 参考尺寸用）
        if first_latent is None:
            first_latent = torch.zeros(1, 4, 1, 1)
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
