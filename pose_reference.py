"""参考姿势（Pose Reference）—— 从姿势素材库里取一张参考图，喂给编辑模型。

素材分两层，运行时合并成一个索引：

1. **插件自带** `pose_assets/` —— 随插件分发，只放非敏感大类（上半身单人、
   全身单人・标准系），别人装完节点就能用。
2. **本机外挂** —— 默认 `D:\\pose`，可用环境变量 `TP_POSE_ROOT` 改（也可放
   `ComfyUI/models/pose_reference`）。敏感或自建素材丢进去，刷新即出现，不进 git。

查找顺序是「本机外挂 → models → 插件自带」，所以同名素材以本机为准。

素材目录结构（每一层根目录都一样）：
    <root>/01_AI线稿姿势/<大类>/<姿势组>/<编号_姿势名>/<编号_视角>.webp
    <root>/02_AI深度姿势库/<同上>/

线稿与深度两套的文件名、目录结构一一对应，所以只需扫一套来建索引，
取图时按 source 决定去哪个目录拿。

选线稿还是深度：实测（FIBO 2.0 / Qwen-Image-2.1 各两组对照）深度图因为
没有边界线，脚底和地面的亮度几乎相同，模型会把亮部补成不存在的鞋或护具
（3/3 复现）；线稿有明确黑线，1/3 才出现小瑕疵。默认用线稿。

深度的唯一优势是遮挡关系（手臂在腿前还是后），复杂交叠姿势可以切过去。
"""

import base64
import hashlib
import io
import json
import mimetypes
import os
import re

import numpy as np
import torch
from PIL import Image, ImageFile, ImageOps

import folder_paths

ImageFile.LOAD_TRUNCATED_IMAGES = True

DEFAULT_ROOT = r"D:\pose"
BUILTIN_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pose_assets")
IMAGE_EXT = (".webp", ".png", ".jpg", ".jpeg", ".bmp")
# 视角按常见构图顺序排，不跟着中文编码字典序走
VIEW_ORDER = ["正面", "侧面", "斜侧", "俯视", "仰视"]

_cache = {"stamp": None, "tree": None}


def _roots():
    """按优先级返回可用的素材根目录（前面的优先）。

    顺序：TP_POSE_ROOT（或默认 D:\\pose）→ models/pose_reference → 插件自带。
    本机目录在前，所以自己放的素材会覆盖插件自带里的同名额。
    """
    cands = []
    env = os.environ.get("TP_POSE_ROOT")
    if env:
        cands.append(env)
    elif DEFAULT_ROOT:
        cands.append(DEFAULT_ROOT)
    try:
        cands.append(os.path.join(folder_paths.models_dir, "pose_reference"))
    except Exception:
        pass
    cands.append(BUILTIN_ROOT)

    out = []
    for d in cands:
        if d and os.path.isdir(d) and os.path.abspath(d) not in [os.path.abspath(x) for x in out]:
            out.append(d)
    return out


def _root():
    """兼容旧调用：返回主素材目录（没有可用的就返回默认路径，方便报错信息）。"""
    roots = _roots()
    return roots[0] if roots else DEFAULT_ROOT


def _mtime(path):
    try:
        return os.stat(path).st_mtime
    except OSError:
        return 0.0


def _stamp(root):
    """素材指纹，扫到「大类/姿势组」这一层。

    只看根目录一层不够：往已有大类里新放一个姿势组，根目录 mtime 不会变，
    缓存就永远不刷新。所以按 套/大类/组 逐层取 mtime，外加每组里的条目数。
    """
    if not os.path.isdir(root):
        return None
    parts = []
    for set_name in sorted(os.listdir(root)):
        set_path = os.path.join(root, set_name)
        if not os.path.isdir(set_path):
            continue
        parts.append("{0}:{1:.0f}".format(set_name, _mtime(set_path)))
        for cat in sorted(os.listdir(set_path)):
            cat_path = os.path.join(set_path, cat)
            if not os.path.isdir(cat_path):
                continue
            parts.append("  {0}:{1:.0f}".format(cat, _mtime(cat_path)))
            for grp in sorted(os.listdir(cat_path)):
                grp_path = os.path.join(cat_path, grp)
                if not os.path.isdir(grp_path):
                    continue
                try:
                    n = len(os.listdir(grp_path))
                except OSError:
                    n = -1
                parts.append("    {0}:{1:.0f}:{2}".format(grp, _mtime(grp_path), n))
    return "|".join(parts)


def _stamp_all():
    """所有根目录的总指纹（前端轮询它判断要不要重建下拉）。"""
    roots = _roots()
    return "||".join("{0}#{1}".format(r, _stamp(r) or "-") for r in roots), roots


def _pick_sets(root):
    """按目录名里的关键词区分线稿套与深度套，认不出就退回「前两个目录」。"""
    lineart = depth = None
    subs = []
    if os.path.isdir(root):
        subs = [d for d in sorted(os.listdir(root)) if os.path.isdir(os.path.join(root, d))]
    for d in subs:
        low = d.lower()
        if lineart is None and ("线稿" in d or "lineart" in low or low.startswith("01")):
            lineart = os.path.join(root, d)
        elif depth is None and ("深度" in d or "depth" in low or low.startswith("02")):
            depth = os.path.join(root, d)
    if lineart is None and subs:
        lineart = os.path.join(root, subs[0])
    if depth is None and len(subs) > 1:
        depth = os.path.join(root, subs[1])
    return lineart, depth


def _view_of(filename):
    stem = os.path.splitext(filename)[0]
    return re.sub(r"^P\d+_", "", stem)


def _view_key(view):
    try:
        return (VIEW_ORDER.index(view), "")
    except ValueError:
        return (len(VIEW_ORDER), view)


def _scan(base):
    """扫一套素材，返回 {大类: {姿势组: {姿势目录: [视角...]}}}。"""
    tree = {}
    if not base or not os.path.isdir(base):
        return tree
    for cat in sorted(os.listdir(base)):
        cat_path = os.path.join(base, cat)
        if not os.path.isdir(cat_path):
            continue
        groups = {}
        for group in sorted(os.listdir(cat_path)):
            group_path = os.path.join(cat_path, group)
            if not os.path.isdir(group_path):
                continue
            poses = {}
            for pose in sorted(os.listdir(group_path)):
                pose_path = os.path.join(group_path, pose)
                if not os.path.isdir(pose_path):
                    continue
                try:
                    names = os.listdir(pose_path)
                except OSError:
                    continue
                views = sorted(
                    {_view_of(f) for f in names if f.lower().endswith(IMAGE_EXT)},
                    key=_view_key,
                )
                if views:
                    poses[pose] = views
            if poses:
                groups[group] = poses
        if groups:
            tree[cat] = groups
    return tree


def _merge_into(dst, src):
    """把 src 的 大类/组/姿势/视角 并进 dst：取并集，已有顺序不动。"""
    for cat, group_map in src.items():
        dcat = dst.setdefault(cat, {})
        for group, pose_map in group_map.items():
            dgrp = dcat.setdefault(group, {})
            for pose, views in pose_map.items():
                dviews = dgrp.setdefault(pose, [])
                for v in views:
                    if v not in dviews:
                        dviews.append(v)
                dviews.sort(key=_view_key)


def pose_tree(force=False):
    """把各根目录的线稿套合并成一份带缓存的索引（本机目录在前）。"""
    stamp, roots = _stamp_all()
    if not force and _cache["stamp"] == stamp and _cache["tree"] is not None:
        return _cache["tree"]
    tree = {}
    for root in roots:
        lineart, _depth = _pick_sets(root)
        if lineart and os.path.isdir(lineart):
            _merge_into(tree, _scan(lineart))
    _cache["stamp"] = stamp
    _cache["tree"] = tree
    return tree


def flatten(tree):
    """下拉框用的三个平铺清单：大类 / 姿势组 / 姿势全名。"""
    cats, groups, poses, views = [], [], [], []
    for cat, group_map in tree.items():
        cats.append(cat)
        for group, pose_map in group_map.items():
            if group not in groups:
                groups.append(group)
            for pose, view_list in pose_map.items():
                if pose not in poses:
                    poses.append(pose)
                for v in view_list:
                    if v not in views:
                        views.append(v)
    views.sort(key=_view_key)
    return cats, groups, poses, views


def locate(category, group, pose, view):
    """定位到具体文件用的四元组，容错到「只要姿势名对」也能找到。"""
    tree = pose_tree()
    if category in tree and group in tree[category] and pose in tree[category][group]:
        views = tree[category][group][pose]
        if view in views:
            return category, group, pose, view
        if views:
            return category, group, pose, views[0]
    for cat, group_map in tree.items():
        for grp, pose_map in group_map.items():
            if pose in pose_map:
                views = pose_map[pose]
                return cat, grp, pose, (view if view in views else views[0])
    raise ValueError(
        "在姿势素材库里找不到 {0} / {1} / {2}。已搜索：{3}".format(
            category, group, pose, "；".join(_roots()) or "无可用素材目录")
    )


def build_path(category, group, pose, view, source):
    """按根目录优先级找文件：本机放的同名素材会盖过插件自带的。"""
    tried = []
    for root in _roots():
        lineart, depth = _pick_sets(root)
        base = depth if source == "深度" else lineart
        if not base or not os.path.isdir(base):
            tried.append("{0}（没有{1}套）".format(root, source))
            continue
        folder = os.path.join(base, category, group, pose)
        if not os.path.isdir(folder):
            tried.append(folder)
            continue
        for fn in sorted(os.listdir(folder)):
            if fn.lower().endswith(IMAGE_EXT) and _view_of(fn) == view:
                return os.path.join(folder, fn)
        tried.append("{0}（无 {1} 视角）".format(folder, view))
    raise ValueError(
        "找不到 {0} / {1} / {2} / {3}。已搜索：{4}".format(
            category, group, pose, view, "；".join(tried) or "无可用素材目录")
    )


# 视觉编码器 / VAE 的下采样倍数是 8，加上 patch 2 ⇒ 实际要求 16 的倍数。
# 不满足时 VAEEncode 会自己 pad 或 crop，边缘发生轻微位移 —— 线稿/深度图对位移特别敏感，
# 会表现成「人物整体歪了一点点」。
ALIGN = 16


def _align_down(v, m=ALIGN):
    """向下取到 m 的倍数。比 m 还小就不动 —— 把 8px 硬拉到 16px 只会更糊。"""
    if v < m:
        return max(1, v)
    return v - (v % m)


def _resize(img, long_edge):
    """按长边等比缩放，再把宽高对齐到 ALIGN 的倍数。"""
    if long_edge and long_edge > 0:
        w, h = img.size
        scale = float(long_edge) / max(w, h)
        if abs(scale - 1.0) > 1e-3:
            img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)

    w, h = img.size
    aw, ah = _align_down(w), _align_down(h)
    if (aw, ah) != (w, h):
        # 用缩放而不是裁切：1% 以内的形变看不出来，裁切却可能切掉脚尖或手指
        img = img.resize((aw, ah), Image.LANCZOS)
    return img


def _load(path, long_edge, flip):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img).convert("RGB")
    if flip:
        img = ImageOps.mirror(img)
    return _resize(img, long_edge)


# ---- 工作流内嵌图：让别人下载工作流后，没有素材库也能看见图、也能出图 ----
EMBED_PROP = "tp_pose"
EMBED_MAX_BYTES = 2 * 1024 * 1024  # 防御：内嵌字段异常大就不解析


def embed_key(category, group, pose, view, source):
    """前端与后端必须用同一套拼法，回退时才对得上。"""
    return "|".join(str(x) for x in (category, group, pose, view, source))


def _node_properties(extra_pnginfo, unique_id):
    """从工作流 JSON 里捞出本节点的 properties（properties 不会进 prompt inputs）。"""
    try:
        wf = (extra_pnginfo or {}).get("workflow") or {}
        for node in wf.get("nodes") or []:
            if str(node.get("id")) == str(unique_id):
                return node.get("properties") or {}
    except Exception:
        pass
    return {}


def _decode_data_uri(data_uri):
    """把前端存进 properties 的 data URI 解回 PIL 图。"""
    if not isinstance(data_uri, str) or "," not in data_uri:
        return None
    head, _, payload = data_uri.partition(",")
    if "base64" not in head or len(payload) > EMBED_MAX_BYTES:
        return None
    try:
        raw = base64.b64decode(payload)
        img = Image.open(io.BytesIO(raw))
        return ImageOps.exif_transpose(img).convert("RGB")
    except Exception:
        return None


def _png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


class PoseReference:
    """从本地姿势素材库取一张参考图。"""

    @classmethod
    def INPUT_TYPES(cls):
        tree = pose_tree()
        cats, groups, poses, views = flatten(tree)
        if not cats:
            cats, groups, poses, views = ["（未找到素材）"], ["—"], ["—"], ["—"]
        return {
            "required": {
                "category": (cats, {"tooltip": "素材大类"}),
                "group": (groups, {"tooltip": "姿势组，如 站姿 / 坐姿"}),
                "pose": (poses, {"tooltip": "具体姿势，编号_名称"}),
                "view": (views, {"tooltip": "机位视角"}),
            },
            "optional": {
                "source": (["线稿", "深度"], {"default": "线稿", "tooltip": "线稿更稳；深度适合肢体交叠多、需要遮挡关系的姿势"}),
                "long_edge": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 64,
                                      "tooltip": "输出图长边像素，素材原始只有 300x400"}),
                # 用下拉而不是 BOOL：1.57 会把 BOOL 渲染成可接线插槽，节点上看不到勾选框
                "flip": (["关", "开"], {"default": "关", "tooltip": "水平翻转，左右镜像的姿势不用另找"}),
            },
            # properties 不会进 prompt inputs，只能靠 extra_pnginfo 把整份工作流带过来，
            # 从里面按 unique_id 找到本节点，读内嵌图
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "load"
    CATEGORY = "Toggle-Pass"
    DESCRIPTION = ("从本地姿势素材库取参考图，输出 IMAGE。接 Qwen-Image-2.1 / MOSS / FIBO 的 images 输入；"
                   "接 2511 / FLUX.2 这类编辑模型时必须多图：原图接 image1，本节点接 image2，"
                   "否则模型会把线稿当成待修改的原图，出图但姿势不变。"
                   "Krea 2 只有 Ostris 节点（TextEncodeKrea2OstrisEdit）能吃骨架图，接 image2；"
                   "krea2Edit 那套的 image_b 是「第二个主体」，接进来线稿会被画进画面。")

    def load(self, category, group, pose, view, source="线稿", long_edge=1024, flip="关",
             unique_id=None, extra_pnginfo=None):
        want = embed_key(category, group, pose, view, source)
        embed = (_node_properties(extra_pnginfo, unique_id) or {}).get(EMBED_PROP) or {}
        origin = "素材库"
        try:
            cat, grp, ps, vw = locate(category, group, pose, view)
            path = build_path(cat, grp, ps, vw, source)
            img = _load(path, long_edge, flip in (True, "开"))
        except Exception as exc:
            # 素材库里没有 → 用工作流内嵌的那张。别人下载工作流就是走这条路
            img0 = _decode_data_uri(embed.get("img"))
            if img0 is None:
                raise
            print("[PoseReference] 素材库取图失败（{0}），改用工作流内嵌图".format(str(exc)[:140]))
            if embed.get("key") != want:
                print("[PoseReference] 提示：内嵌图对应「{0}」，与当前所选「{1}」不同".format(
                    embed.get("key"), want))
            if flip in (True, "开"):
                img0 = ImageOps.mirror(img0)
            img = _resize(img0, long_edge)
            cat, grp, ps, vw = category, group, pose, view
            origin = "内嵌"

        arr = np.array(img).astype(np.float32) / 255.0
        tensor = torch.from_numpy(arr)[None,]
        # 这里**故意不返回 ui.images**。一旦返回，ComfyUI 1.57 前端就会给节点设
        # node.imgs，进而挂一个 `$$canvas-image-preview` 的官方预览 widget：它占掉
        # 节点底部一行，并把这张执行结果画在预览区上面。于是「生图一开始」画面就被
        # 一张定死的图盖住 —— 下拉照点、节点自己画的预览在背面其实也换了，但看起来
        # 就是再也切不动。本节点的预览由前端 onDrawForeground 自绘，不需要这一份。
        return {"ui": {"text": ["{0}/{1}/{2}/{3} · {4} · {5}".format(
            cat, grp, ps, vw, source, origin)]},
            "result": (tensor,)}


NODE_CLASS_MAPPINGS = {
    "PoseReference": PoseReference,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PoseReference": "参考姿势 Pose Reference",
}


# ---- 给前端联动用的目录树接口 ----
def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer

        instance = getattr(PromptServer, "instance", None)
        routes = getattr(instance, "routes", None) if instance is not None else None
        if routes is None:
            return

        @routes.get("/toggle_pass/pose_tree")
        async def _pose_tree(request):
            try:
                force = request.rel_url.query.get("refresh") in ("1", "true")
                tree = pose_tree(force=force)
                cats, groups, poses, views = flatten(tree)
                return web.json_response({"tree": tree, "categories": cats,
                                          "groups": groups, "poses": poses,
                                          "views": views, "root": _root(),
                                          "roots": _roots()})
            except Exception as exc:
                return web.json_response({"error": str(exc), "tree": {}}, status=500)

        @routes.get("/toggle_pass/pose_stamp")
        async def _pose_stamp(request):
            """轻量指纹：前端每隔十几秒问一次，变了才重新拉整个 tree。

            往素材目录里丢新文件（尤其是敏感那几类放本机）后，不用刷新浏览器，
            下拉自己就会长出来。
            """
            try:
                stamp, roots = _stamp_all()
                return web.json_response({"stamp": hashlib.md5(stamp.encode("utf-8")).hexdigest(),
                                          "roots": roots, "count": len(roots)})
            except Exception as exc:
                return web.json_response({"error": str(exc)}, status=500)

        @routes.get("/toggle_pass/pose_image")
        async def _pose_image(request):
            """给前端节点内缩略图 + 内嵌用：按参数把选中的那张姿势吐回去。

            参数全在 query 里，同一个 URL 永远对应同一张图，所以放开浏览器缓存，
            来回切下拉不重复解码。

            `raw=1` 时直接返回素材原文件（webp，约 5KB），不缩放不翻转 —— 前端拿它
            当缩略图显示、同时 base64 内嵌进工作流；翻转由前端绘制时镜像。
            """
            try:
                q = request.rel_url.query
                source = q.get("source", "线稿")
                try:
                    long_edge = int(q.get("long_edge", "0") or 0)
                except ValueError:
                    long_edge = 0
                flip = q.get("flip") in ("开", "1", "true", "True")
                cat, grp, ps, vw = locate(q.get("category", ""), q.get("group", ""),
                                          q.get("pose", ""), q.get("view", ""))
                path = build_path(cat, grp, ps, vw, source)
                # 不能强缓存（max-age）：同一个 URL 对应的素材文件可能被同名替换，
                # 强缓存会让浏览器 24 小时都拿旧图，换了素材看起来像"切换不了"。
                # 改用 ETag 逐次校验：没变返回 304（几乎零成本），变了立刻给新内容。
                mtime_ms = int(os.path.getmtime(path) * 1000)
                size = os.path.getsize(path)
                etag = '"{0}-{1}-{2}-{3}"'.format(mtime_ms, size, long_edge, int(flip))
                headers = {"Cache-Control": "no-cache", "ETag": etag}
                if request.headers.get("If-None-Match") == etag:
                    return web.Response(status=304, headers=headers)
                if q.get("raw") in ("1", "true", "开"):
                    with open(path, "rb") as fh:
                        body = fh.read()
                    mime = mimetypes.guess_type(path)[0] or "image/webp"
                    return web.Response(body=body, content_type=mime, headers=headers)
                img = _load(path, long_edge, flip)
                return web.Response(body=_png_bytes(img), content_type="image/png", headers=headers)
            except Exception as exc:
                return web.json_response({"error": str(exc)}, status=404)
    except Exception:
        # 独立导入 / 无 server 模块时静默跳过，不影响节点本身
        return


_register_routes()
