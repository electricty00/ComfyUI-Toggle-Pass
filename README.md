# ComfyUI-Toggle-Pass

[English](#english) | [中文](#中文)

---

<a id="english"></a>
## English

Toggle-Pass node collection — toggle controls, image load/save/preview, privacy mask, and dynamic multi-reference image encoding.

### Nodes

#### SaveLoadImage — Save/Load Toggle

Image save node with Save/Load mode toggle.
- **Save mode**: Save image to output directory, output IMAGE and MASK
- **Load mode**: Reuse the last saved image, skip saving
- Click 👁 icon in the title bar to toggle privacy mask (hide/show image preview)

#### ToggleLoadImage — Load Image

Custom image loading node, same functionality as built-in LoadImage, with privacy mask support.
- Click 👁 icon in the title bar to toggle privacy mask

#### TogglePreviewImage — Preview Image

Custom image preview node, saves to temp (not output), with privacy mask support.
- Click 👁 icon in the title bar to toggle privacy mask

#### ToggleEmptyLatent — Toggle Empty Latent

Toggleable empty Latent generation node.
- **ON**: Use width/height parameters
- **OFF**: Use fallback_width/fallback_height parameters (useful for A/B size comparison)

---

#### DynamicRefIndependent — Multi-Reference Independent Encoding (Core Node)

Each reference image is independently VAE-encoded, outputting separate CONDITIONING and LATENT pairs. Ideal for scenarios where multiple images control style/content independently.

**Inputs** (dynamic, controlled by `num_images`):
- `clip` — CLIP model
- `vae` — VAE model
- `num_images` — Number of reference images (1~10)
- `instruction` — System prompt (leave empty for default)
- `image1` ~ `imageN` — Reference images
- `prompt1` ~ `promptN` — Per-image prompts (collapsible widgets inside node)

**Outputs** (dynamic, N×2):
- `cond_1`, `latent1`, `cond_2`, `latent2`, ... `cond_N`, `latentN`

**Usage**:
1. Drag in the node, default is 1 reference image
2. Adjust `num_images` to desired count (1~10), input/output slots auto-adjust
3. Connect each reference image and fill in corresponding prompts
4. Connect `cond_N` to sampler's conditioning, `latentN` to VAE Encode's latent

---

#### DynamicRefImageEncode — Dynamic Reference Image Encoding

Single prompt control, dynamically add/remove reference image input slots.

**Inputs**: `clip`, `num_images`, `prompt`, `image1` ~ `imageN`
**Outputs**: `CONDITIONING`, `LATENT` (all images share the same conditioning, latents output separately)

#### DynamicRefLatentInput — Dynamic Latent Input

Dynamically add/remove LATENT input slots, for use with DynamicRef series.

#### ImageBatcher — Image Batcher

Dynamically add/remove IMAGE input slots, batch multiple images together.

#### OneImageMultiPrompt — One Image Multiple Prompts

One reference image with multiple prompts, output separate conditionings.

---

### Privacy Mask

SaveLoadImage, ToggleLoadImage, and TogglePreviewImage support privacy mask:
- Title bar shows 👁 (show image) / 🫣 (hide image) icon
- Click icon to toggle privacy state; when hidden, image preview area is blank
- Privacy state is saved/restored with workflow, does not affect image generation

---

### Notes

- When `num_images` changes, input/output slots auto-adjust, **existing connections are not broken**
- Switching pages and back, nodes auto-restore to correct slot count
- Requires Qwen2.5-VL or compatible CLIP model
- Default instruction is for Qwen-Image-Edit models, modify as needed

---

<a id="中文"></a>
## 中文

Toggle-Pass 系列节点——开关控制、图片加载/保存/预览、隐私遮罩、多参考图动态编码。

### 节点说明

#### SaveLoadImage — 保存/加载切换

图片保存节点，支持 Save/Load 模式切换。
- **Save 模式**：保存图片到 output 目录，同时输出 IMAGE 和 MASK
- **Load 模式**：直接复用上次保存的图片，跳过保存流程
- 点击标题栏 👁 图标可切换隐私遮罩（隐藏/显示图片预览）

#### ToggleLoadImage — 加载图片

自定义加载图像节点，和原生 LoadImage 功能一致，额外支持隐私遮罩。
- 点击标题栏 👁 图标可切换隐私遮罩（隐藏/显示图片预览）

#### TogglePreviewImage — 预览图片

自定义预览图像节点，不保存到 output 目录（保存到 temp），支持隐私遮罩。
- 点击标题栏 👁 图标可切换隐私遮罩（隐藏/显示图片预览）

#### ToggleEmptyLatent — 开关空 Latent

可切换的空 Latent 生成节点。
- **ON**：使用 width/height 参数生成
- **OFF**：使用 fallback_width/fallback_height 参数（可用于 A/B 尺寸对比）

---

#### DynamicRefIndependent — 多参考图独立编码（核心节点）

每张参考图独立 VAE 编码，输出各自独立的 CONDITIONING 和 LATENT，适合多图各自控制风格/内容的场景。

**输入**（动态，由 `num_images` 控制）：
- `clip` — CLIP 模型
- `vae` — VAE 模型
- `num_images` — 参考图数量（1~10）
- `instruction` — 系统提示词（可留空使用默认）
- `image1` ~ `imageN` — 参考图
- `prompt1` ~ `promptN` — 每张图对应的提示词（控件在节点内，可折叠）

**输出**（动态，N×2 个）：
- `cond_1`, `latent1`, `cond_2`, `latent2`, ... `cond_N`, `latentN`

**用法**：
1. 拖入节点，默认 1 张参考图
2. 调整 `num_images` 到需要的数量（1~10），输入槽和输出槽自动增减
3. 每张图连接自己的参考图，填写对应 prompt
4. `cond_N` 连到 sampler 的 conditioning，`latentN` 连到 VAE Encode 的 latent（供参考图编码使用）

---

#### DynamicRefImageEncode — 动态参考图编码

单张 prompt 控制，动态增删参考图输入槽。

**输入**：`clip`, `num_images`, `prompt`, `image1` ~ `imageN`
**输出**：`CONDITIONING`, `LATENT`（所有图共享同一份 conditioning，分别输出 latent）

#### DynamicRefLatentInput — 动态 Latent 输入

动态增删 LATENT 输入槽，配合 DynamicRef 系列使用。

#### ImageBatcher — 图像批处理

动态增删 IMAGE 输入槽，将多张图打包成批次。

#### OneImageMultiPrompt — 单图多提示词

一张参考图对应多个提示词，分别输出 conditioning。

---

### 隐私遮罩功能

SaveLoadImage、ToggleLoadImage、TogglePreviewImage 三个节点均支持隐私遮罩：
- 标题栏右侧显示 👁（显示图片）/ 🫣（隐藏图片）图标
- 点击图标切换隐私状态，隐藏时图片预览区域留空
- 隐私状态随工作流自动保存/恢复，不影响生图流程

---

### 注意事项

- `num_images` 调整时，输入/输出槽会自动增减，**已有连线不会被断开**
- 切换页面再回来，节点会自动恢复到正确的槽位数量
- 需要 Qwen2.5-VL 或兼容的 CLIP 模型支持
- 默认 instruction 适用于 Qwen-Image-Edit 类模型，可按需修改

---

## 更新日志 / Changelog

### 2026-05-08
- 新增 SaveLoadImage（保存/加载切换）、ToggleLoadImage（加载图片）、TogglePreviewImage（预览图片）、ToggleEmptyLatent（开关空 Latent）节点
- 新增隐私遮罩功能（👁/🫣 图标切换，适用于图片节点）
- 新增 DynamicRef 系列节点（DynamicRefIndependent、DynamicRefImageEncode、DynamicRefLatentInput、ImageBatcher、OneImageMultiPrompt）

---

## 安装 / Installation

Place this folder under `ComfyUI/custom_nodes/` and restart ComfyUI.
