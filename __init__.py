"""
ComfyUI Toggle Pass - Toggle nodes + Image IO + Multi-Ref Encode
Author: Clever
"""
from .multi_ref_encode import NODE_CLASS_MAPPINGS as MULTI_REF_NODES, NODE_DISPLAY_NAME_MAPPINGS as MULTI_REF_NAMES
from .unified_loader import NODE_CLASS_MAPPINGS as UNIFIED_NODES, NODE_DISPLAY_NAME_MAPPINGS as UNIFIED_NAMES
from .sampler import NODE_CLASS_MAPPINGS as SAMPLER_NODES, NODE_DISPLAY_NAME_MAPPINGS as SAMPLER_NAMES

import os
import json
import math
import time
import random
import hashlib
import torch
import numpy as np
from PIL import Image, ImageDraw, ImageOps, ImageSequence, ImageFile, ImageFont
from PIL.PngImagePlugin import PngInfo
import comfy.model_management
import comfy.utils
import folder_paths
import node_helpers


WEB_DIRECTORY = "./js"

_last_saved_path = {}


# ==================== Toggle Load Image ====================

class ToggleLoadImage:
    """Load image from input folder with privacy toggle support."""

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return {
            "required": {
                "image": (sorted(files), {"image_upload": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "MASK")
    FUNCTION = "load_image"
    CATEGORY = "Toggle-Pass"
    DESCRIPTION = "Load image with privacy toggle."

    def load_image(self, image):
        image_path = folder_paths.get_annotated_filepath(image)

        # 尝试视频帧提取（如果安装了 comfy-extras 的 InputImpl）
        try:
            from comfy_extras.nodes_input import InputImpl
            components = InputImpl.VideoFromFile(image_path).get_components()
            if components.images.shape[0] > 0:
                return (components.images, 1.0 - components.alpha[..., -1] if components.alpha is not None else torch.zeros((components.images.shape[0], 64, 64), dtype=torch.float32, device="cpu"))
        except Exception:
            pass

        img = node_helpers.pillow(Image.open, image_path)

        output_images = []
        output_masks = []
        w, h = None, None

        dtype = comfy.model_management.intermediate_dtype()

        for i in ImageSequence.Iterator(img):
            i = node_helpers.pillow(ImageOps.exif_transpose, i)

            if i.mode == 'I':
                i = i.point(lambda i: i * (1 / 255))
            image = i.convert("RGB")

            if len(output_images) == 0:
                w = image.size[0]
                h = image.size[1]

            if image.size[0] != w or image.size[1] != h:
                continue

            image = np.array(image).astype(np.float32) / 255.0
            image = torch.from_numpy(image)[None,]
            if 'A' in i.getbands():
                mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
                mask = 1. - torch.from_numpy(mask)
            elif i.mode == 'P' and 'transparency' in i.info:
                mask = np.array(i.convert('RGBA').getchannel('A')).astype(np.float32) / 255.0
                mask = 1. - torch.from_numpy(mask)
            else:
                mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")
            output_images.append(image.to(dtype=dtype))
            output_masks.append(mask.unsqueeze(0).to(dtype=dtype))

            if img.format == "MPO":
                break

        if len(output_images) > 1:
            output_image = torch.cat(output_images, dim=0)
            output_mask = torch.cat(output_masks, dim=0)
        else:
            output_image = output_images[0]
            output_mask = output_masks[0]

        return (output_image, output_mask)

    @classmethod
    def IS_CHANGED(cls, image):
        image_path = folder_paths.get_annotated_filepath(image)
        m = hashlib.sha256()
        with open(image_path, 'rb') as f:
            m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        if not folder_paths.exists_annotated_filepath(image):
            return "Invalid image file: {}".format(image)
        return True


# ==================== Toggle Preview Image ====================

class TogglePreviewImage:
    """Preview image with privacy toggle support. Saves to temp like built-in PreviewImage."""

    def __init__(self):
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"
        self.compress_level = 1

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_NODE = True
    FUNCTION = "preview"
    CATEGORY = "Toggle-Pass"
    DESCRIPTION = "Preview image with privacy toggle. Saves to temp like PreviewImage."

    def preview(self, images, prompt=None, extra_pnginfo=None):
        results = []
        for idx, img in enumerate(images):
            img_np = 255. * img.cpu().numpy()
            pil_img = Image.fromarray(np.clip(img_np, 0, 255).astype(np.uint8))
            filename = f"toggle_preview_{idx:05}.png"
            filepath = os.path.join(self.output_dir, filename)
            pil_img.save(filepath, format="PNG", compress_level=self.compress_level)
            results.append({
                "filename": filename,
                "subfolder": "",
                "type": self.type,
            })

        return {"result": (images,), "ui": {"images": results}}


class SaveLoadImage:
    """Save image AND output it. Toggle OFF to auto-load last saved image instead."""

    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"
        self.prefix_append = ""
        self.compress_level = 4

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "use_saved": (["Save", "Load"],),
            },
            "optional": {
                "filename_prefix": ("STRING", {"default": "ComfyUI"}),
            },
            "hidden": {
                "prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "MASK")
    OUTPUT_NODE = True
    FUNCTION = "execute"
    CATEGORY = "Toggle-Pass"
    DESCRIPTION = "Save image and output IMAGE. Toggle use_saved=ON to reuse last saved image."

    def execute(self, images, use_saved="Save", filename_prefix="ComfyUI", prompt=None, extra_pnginfo=None):
        if use_saved == "Load":
            return self._load_last()
        else:
            return self._save(images, filename_prefix, prompt, extra_pnginfo)

    def _save(self, images, filename_prefix, prompt, extra_pnginfo):
        if images is None:
            images = torch.zeros((1, 64, 64, 3), dtype=torch.float32)

        filename_prefix += self.prefix_append
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            filename_prefix, self.output_dir, images[0].shape[1], images[0].shape[0]
        )
        results = list()
        for (batch_number, image) in enumerate(images):
            i = 255. * image.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))
            metadata = None
            if not comfy.utils.args.disable_metadata:
                metadata = PngInfo()
                if prompt is not None:
                    metadata.add_text("prompt", json.dumps(prompt))
                if extra_pnginfo is not None:
                    for x in extra_pnginfo:
                        metadata.add_text(x, json.dumps(extra_pnginfo[x]))

            filename_with_batch_num = filename.replace("%batch_num%", str(batch_number))
            file = f"{filename_with_batch_num}_{counter:05}_.png"
            filepath = os.path.join(full_output_folder, file)
            img.save(filepath, pnginfo=metadata, compress_level=self.compress_level)
            results.append({
                "filename": file,
                "subfolder": subfolder,
                "type": self.type
            })

            if id(self) not in _last_saved_path:
                _last_saved_path[id(self)] = filepath

            counter += 1

        last_file = os.path.join(full_output_folder, results[0]["filename"])
        _last_saved_path[id(self)] = last_file

        mask = torch.zeros((images.shape[0], images.shape[1], images.shape[2]), dtype=torch.float32)
        return {"result": (images, mask), "ui": {"images": results}}

    def _load_last(self):
        node_id = id(self)
        if node_id in _last_saved_path and os.path.isfile(_last_saved_path[node_id]):
            filepath = _last_saved_path[node_id]
            img = node_helpers.pillow(Image.open, filepath)
            output_images = []
            output_masks = []
            w, h = None, None
            dtype = comfy.model_management.intermediate_dtype()

            for i in ImageSequence.Iterator(img):
                i = node_helpers.pillow(ImageOps.exif_transpose, i)
                if i.mode == 'I':
                    i = i.point(lambda x: x * (1 / 255))
                image = i.convert("RGB")
                if len(output_images) == 0:
                    w = image.size[0]
                    h = image.size[1]
                if image.size[0] != w or image.size[1] != h:
                    continue
                image = np.array(image).astype(np.float32) / 255.0
                image = torch.from_numpy(image)[None,]
                if 'A' in i.getbands():
                    mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
                    mask = 1. - torch.from_numpy(mask)
                elif i.mode == 'P' and 'transparency' in i.info:
                    mask = np.array(i.convert('RGBA').getchannel('A')).astype(np.float32) / 255.0
                    mask = 1. - torch.from_numpy(mask)
                else:
                    mask = torch.zeros((h, w), dtype=torch.float32, device="cpu")
                output_images.append(image.to(dtype=dtype))
                output_masks.append(mask.unsqueeze(0).to(dtype=dtype))
                if img.format == "MPO":
                    break

            if len(output_images) > 1:
                output_image = torch.cat(output_images, dim=0)
                output_mask = torch.cat(output_masks, dim=0)
            else:
                output_image = output_images[0]
                output_mask = output_masks[0]

            return {"result": (output_image, output_mask), "ui": {"images": []}}

        dummy = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        dummy_mask = torch.zeros((1, 64, 64), dtype=torch.float32)
        return {"result": (dummy, dummy_mask), "ui": {"images": []}}


class ToggleEmptyLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
                "height": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096}),
                "enabled": (["ON", "OFF"],),
            },
            "optional": {
                "fallback_width": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
                "fallback_height": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("LATENT",)
    FUNCTION = "generate"
    CATEGORY = "Toggle-Pass"

    def generate(self, width, height, batch_size=1, enabled="ON", fallback_width=None, fallback_height=None):
        if fallback_width is None:
            fallback_width = 1024
        if fallback_height is None:
            fallback_height = 1024
        if enabled != "ON":
            width = fallback_width
            height = fallback_height
        latent = torch.zeros([batch_size, 4, height // 8, width // 8],
                             device=comfy.model_management.intermediate_device(),
                             dtype=comfy.model_management.intermediate_dtype())
        return ({"samples": latent, "downscale_ratio_spacial": 8},)


# ==================== Image Compare ====================
# 把「N 张原图 + N 张结果」拼成一张对比图
# 后端合成 + 节点内预览（走标准 ui.images，和 SaveLoadImage 同一机制）
# =======================================================

_compare_counter = 0


class ToggleImageCompare:
    """图片对比：多张原图与多张结果拼成一张对比图，节点内直接预览。

    - 两组动态输入：source1..source10（原图）、result1..result10（结果）
    - 排版：自动 / 成对并排 / 上下两排 / 自动网格
    - 排版按**实际接上的图**走（不看你设了几个槽），所以「N 原图 + 1 结果」
      和「N 原图 + N 结果」都不用改设置
    """

    _font_cache = {}

    _CJK_FONTS = (
        "msyh.ttc", "msyhl.ttc", "simhei.ttf", "simsun.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    )
    _LATIN_FONTS = ("arial.ttf", "segoeui.ttf", "DejaVuSans.ttf")

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, 11):
            optional[f"source{i}"] = ("IMAGE",)
            optional[f"result{i}"] = ("IMAGE",)
        return {
            "required": {
                "num_sources": ("INT", {"default": 2, "min": 1, "max": 10, "step": 1}),
                "num_results": ("INT", {"default": 2, "min": 1, "max": 10, "step": 1}),
                "排版": (["自动", "成对并排", "上下两排", "自动网格"],),
                "标签": (["显示", "隐藏"],),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("对比图",)
    OUTPUT_NODE = True
    FUNCTION = "compare"
    CATEGORY = "Toggle-Pass"
    DESCRIPTION = "把多张原图与多张结果拼成一张对比图（before / after）。排版自动适配 N:1 或 N:N。"

    # ---- 字体 ----

    @classmethod
    def _get_font(cls, size):
        size = int(size)
        if size in cls._font_cache:
            return cls._font_cache[size]
        font, cjk = None, False
        for name in cls._CJK_FONTS:
            try:
                font = ImageFont.truetype(name, size)
                cjk = True
                break
            except Exception:
                font = None
        if font is None:
            for name in cls._LATIN_FONTS:
                try:
                    font = ImageFont.truetype(name, size)
                    break
                except Exception:
                    font = None
        if font is None:
            try:
                font = ImageFont.load_default(size=size)
            except Exception:
                try:
                    font = ImageFont.load_default()
                except Exception:
                    font = None
        cls._font_cache[size] = (font, cjk)
        return cls._font_cache[size]

    @classmethod
    def _draw_label(cls, pil, text, size):
        font, _ = cls._get_font(size)
        if font is None or not text:
            return pil
        draw = ImageDraw.Draw(pil, "RGBA")
        pad = max(3, size // 4)
        x0, y0 = max(4, size // 3), max(4, size // 3)
        try:
            box = draw.textbbox((x0, y0), text, font=font)
        except Exception:
            try:
                tw, th = draw.textsize(text, font=font)
            except Exception:
                tw, th = size * len(text), size
            box = (x0, y0, x0 + tw, y0 + th)
        draw.rectangle([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad],
                       fill=(0, 0, 0, 150))
        draw.text((x0, y0), text, font=font, fill=(255, 255, 255, 255))
        return pil

    # ---- 张量 -> PIL ----

    @staticmethod
    def _to_pils(img):
        if img is None:
            return []
        try:
            arr = img.detach().cpu().numpy()
        except Exception:
            arr = np.asarray(img)
        if arr.ndim == 3:
            arr = arr[None, ...]
        out = []
        for i in range(arr.shape[0]):
            a = np.clip(arr[i].astype(np.float32) * 255.0, 0, 255).astype(np.uint8)
            if a.ndim == 2:
                out.append(Image.fromarray(a, "L").convert("RGB"))
            elif a.shape[-1] == 1:
                out.append(Image.fromarray(a[..., 0], "L").convert("RGB"))
            elif a.shape[-1] == 4:
                out.append(Image.fromarray(a[..., :3], "RGB"))
            else:
                out.append(Image.fromarray(a[..., :3], "RGB"))
        return out

    @staticmethod
    def _scale_to_height(pil, h):
        w0, h0 = pil.size
        if h0 <= 0 or h0 == h:
            return pil
        w = max(1, int(round(w0 * h / h0)))
        return pil.resize((w, h), Image.LANCZOS)

    # ---- 合成 ----

    @classmethod
    def _compose(cls, rows, labels_on=True, gap=8, pad=8, bg=(28, 28, 28),
                 blank=(52, 52, 52)):
        norm = []
        for row in rows:
            items = [(p, lab) for (p, lab) in row if p is not None]
            if not items:
                continue
            target_h = max(p.size[1] for p, _ in items)
            fixed = []
            for (p, lab) in row:
                if p is None:
                    fixed.append((Image.new("RGB", (target_h, target_h), blank), None))
                else:
                    fixed.append((cls._scale_to_height(p, target_h), lab))
            norm.append(fixed)
        if not norm:
            return Image.new("RGB", (64, 64), bg)

        row_w = [sum(p.size[0] for p, _ in r) + gap * (len(r) - 1) for r in norm]
        row_h = [max(p.size[1] for p, _ in r) for r in norm]
        W = max(row_w) + pad * 2
        H = sum(row_h) + gap * (len(norm) - 1) + pad * 2
        canvas = Image.new("RGB", (W, H), bg)
        y = pad
        for r, rh, rw in zip(norm, row_h, row_w):
            x = pad + (W - pad * 2 - rw) // 2
            for p, lab in r:
                if labels_on and lab:
                    size = int(max(12, min(38, p.size[1] * 0.055)))
                    cls._draw_label(p, lab, size)
                canvas.paste(p, (x, y))
                x += p.size[0] + gap
            y += rh + gap
        return canvas

    @classmethod
    def _build_rows(cls, sources, results):
        ns, nr = len(sources), len(results)
        s_lab = [f"原{i + 1}" for i in range(ns)]
        r_lab = [f"结{i + 1}" for i in range(nr)]
        n = max(ns, nr, 1)
        rows = []
        for i in range(n):
            left = (sources[i], s_lab[i]) if i < ns else (None, None)
            right = (results[i], r_lab[i]) if i < nr else (None, None)
            rows.append([left, right])
        return rows

    @classmethod
    def _build_stacked(cls, sources, results):
        rows = []
        if sources:
            rows.append([(p, f"原{i + 1}") for i, p in enumerate(sources)])
        if results:
            rows.append([(p, f"结{i + 1}") for i, p in enumerate(results)])
        return rows

    @classmethod
    def _build_grid(cls, sources, results):
        items = [(p, f"原{i + 1}") for i, p in enumerate(sources)]
        items += [(p, f"结{i + 1}") for i, p in enumerate(results)]
        if not items:
            return []
        cols = max(1, int(math.ceil(math.sqrt(len(items)))))
        return [items[i:i + cols] for i in range(0, len(items), cols)]

    def compare(self, num_sources, num_results, **kwargs):
        sources, results = [], []
        for i in range(1, 11):
            sources.extend(self._to_pils(kwargs.get(f"source{i}")))
            results.extend(self._to_pils(kwargs.get(f"result{i}")))

        layout = kwargs.get("排版", "自动")
        labels_on = kwargs.get("标签", "显示") != "隐藏"

        if layout == "自动":
            layout = "成对并排" if (len(sources) == len(results) and sources) else "上下两排"
        if layout == "成对并排":
            rows = self._build_rows(sources, results)
        elif layout == "上下两排":
            rows = self._build_stacked(sources, results)
        else:
            rows = self._build_grid(sources, results)

        canvas = self._compose(rows, labels_on=labels_on)

        arr = np.asarray(canvas).astype(np.float32) / 255.0
        out = torch.from_numpy(arr)[None,]

        global _compare_counter
        _compare_counter += 1
        ui_images = []
        try:
            temp_dir = folder_paths.get_temp_directory()
            fn = f"image_compare_{int(time.time() * 1000)}_{_compare_counter:04d}.png"
            canvas.save(os.path.join(temp_dir, fn), format="PNG", compress_level=1)
            ui_images = [{"filename": fn, "subfolder": "", "type": "temp"}]
        except Exception as e:
            print(f"[ToggleImageCompare] 预览图保存失败: {e}")

        return {"ui": {"images": ui_images}, "result": (out,)}


NODE_CLASS_MAPPINGS = {
    **MULTI_REF_NODES,
    **UNIFIED_NODES,
    **SAMPLER_NODES,
    "ToggleEmptyLatent": ToggleEmptyLatent,
    "SaveLoadImage": SaveLoadImage,
    "ToggleLoadImage": ToggleLoadImage,
    "TogglePreviewImage": TogglePreviewImage,
    "ToggleImageCompare": ToggleImageCompare,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    **MULTI_REF_NAMES,
    **UNIFIED_NAMES,
    **SAMPLER_NAMES,
    "ToggleEmptyLatent": "Toggle Empty Latent",
    "SaveLoadImage": "Save/Load Image",
    "ToggleLoadImage": "Toggle Load Image",
    "TogglePreviewImage": "Toggle Preview Image",
    "ToggleImageCompare": "图片对比",
}
