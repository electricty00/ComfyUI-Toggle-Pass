"""
ComfyUI Toggle Pass - Toggle nodes + Image IO + Multi-Ref Encode
Author: Clever
"""
from .multi_ref_encode import NODE_CLASS_MAPPINGS as MULTI_REF_NODES, NODE_DISPLAY_NAME_MAPPINGS as MULTI_REF_NAMES

import os
import json
import torch
import numpy as np
from PIL import Image, ImageOps, ImageSequence, ImageFile
from PIL.PngImagePlugin import PngInfo
import comfy.model_management
import comfy.utils
import folder_paths
import node_helpers


WEB_DIRECTORY = "./js"

_last_saved_path = {}


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


NODE_CLASS_MAPPINGS = {
    **MULTI_REF_NODES,
    "ToggleEmptyLatent": ToggleEmptyLatent,
    "SaveLoadImage": SaveLoadImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    **MULTI_REF_NAMES,
    "ToggleEmptyLatent": "Toggle Empty Latent",
    "SaveLoadImage": "Save/Load Image",
}
