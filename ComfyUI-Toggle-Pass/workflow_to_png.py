"""
把 example_workflows/ 目录下的 .json 工作流
转成可直接拖入 ComfyUI 的 PNG 图片。

用法：
    python workflow_to_png.py

输出：每个 JSON 文件旁边生成同名 .png
（PIL 未安装时会自动提示安装命令）
"""

import json
import os
import sys

WORKFLOWS_DIR = os.path.join(os.path.dirname(__file__), "example_workflows")

# ---------- 尝试导入 PIL ----------
try:
    from PIL import Image, PngImagePlugin
except ImportError:
    print("缺少 Pillow，请先运行：")
    print("  pip install Pillow")
    sys.exit(1)


def json_to_png(json_path: str) -> str:
    """把单个 JSON 工作流嵌入 PNG，返回输出路径。"""
    with open(json_path, "r", encoding="utf-8") as f:
        workflow_text = f.read()

    # 解析一次确保合法 JSON
    json.loads(workflow_text)

    # 生成一张 1×1 的透明占位图（ComfyUI 只需要元数据，图像内容无关紧要）
    img = Image.new("RGB", (1, 1), color=(30, 30, 30))

    meta = PngImagePlugin.PngInfo()
    meta.add_text("workflow", workflow_text)

    out_path = os.path.splitext(json_path)[0] + ".png"
    img.save(out_path, pnginfo=meta, compress_level=9)
    return out_path


def main():
    json_files = [
        os.path.join(WORKFLOWS_DIR, f)
        for f in os.listdir(WORKFLOWS_DIR)
        if f.endswith(".json")
    ]

    if not json_files:
        print("没有找到 .json 文件")
        return

    print(f"共找到 {len(json_files)} 个工作流文件：\n")
    for jf in json_files:
        try:
            out = json_to_png(jf)
            print(f"  ✓  {os.path.basename(jf)}")
            print(f"     → {os.path.basename(out)}")
        except Exception as e:
            print(f"  ✗  {os.path.basename(jf)}  错误: {e}")

    print("\n完成！把生成的 .png 直接拖入 ComfyUI 即可恢复工作流。")


if __name__ == "__main__":
    main()
