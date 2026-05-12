# ComfyUI-Toggle-Pass

[English](#english) | [中文](#中文)

---

<a id="english"></a>
## English

Toggle-Pass node collection — toggle controls, image load/save/preview, privacy mask, dynamic multi-reference image encoding, and unified model loader.

### Nodes

#### ToggleUnifiedLoader — Unified Model + LoRA Loader

All-in-one model loading node: UNet + CLIP + VAE + multiple LoRAs in a single node.

**Inputs**:
- `unet_name` — UNet model file
- `clip_name` — CLIP text encoder file
- `vae_name` — VAE model file
- `clip_type` — CLIP type (auto-detect from UNet, or manually select: SD, SD3, FLUX, FLUX2, etc.)
- `+ Add LoRA` button — Click to add LoRA slots one by one (up to 10)
- `- Remove LoRA` button — Click to remove LoRA slots from the last group (up to 10)

**LoRA Controls** (added via button, up to 10 groups):
- Select a LoRA file → strength sliders appear automatically
- Select "none" → strength sliders hide
- All LoRAs are applied sequentially

**Outputs**: `MODEL`, `CLIP`, `VAE`

---

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

**Model type**: Choose from `Flux2` / `Qwen Layered` / `SD / SDXL`
- `Qwen Layered`: Adds a `layers` parameter; latent output is a layered latent (`[1, 16, layers+1, h/8, w/8]`), directly connectable to Ksampler's latent input (replaces `EmptyQwenImageLayeredLatentImage`)
- When `匹配原图尺寸` = ON, uses the actual image size; when OFF, uses `输出宽度/高度` settings

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

Toggle-Pass 系列节点——开关控制、图片加载/保存/预览、隐私遮罩、多参考图动态编码、统一模型加载。

### 节点说明

#### ToggleUnifiedLoader — 统一模型 + LoRA 加载器

一体化模型加载节点：UNet + CLIP + VAE + 多 LoRA 整合到一个节点中。

**输入**：
- `unet_name` — UNet 模型文件
- `clip_name` — CLIP 文本编码器文件
- `vae_name` — VAE 模型文件
- `clip_type` — CLIP 类型（支持 auto 从 UNet 自动检测，也可手动选择：SD、SD3、FLUX、FLUX2 等）
- `+ 添加 LoRA` 按钮 — 点击逐个添加 LoRA 槽位（最多 10 组）
- `- 移除 LoRA` 按钮 — 点击从最后一组开始移除（最多 10 组）

**LoRA 控件**（通过按钮添加，最多 10 组）：
- 选择 LoRA 文件 → 自动展开 strength 滑块
- 选择 "none" → 自动隐藏 strength 滑块
- 多个 LoRA 按顺序依次应用

**输出**：`MODEL`、`CLIP`、`VAE`

---

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

**模型类型**：可选 `Flux2` / `Qwen Layered` / `SD / SDXL`
- `Qwen Layered`：增加「图层数」参数；输出的 latent 为分层格式（`[1, 16, layers+1, h/8, w/8]`），可直接接到 K采样器的 latent 输入（省掉 `EmptyQwenImageLayeredLatentImage` 节点）
- 「匹配原图尺寸」= ON 时，使用图片实际尺寸；= OFF 时，使用「输出宽度/高度」设置值

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

### 2026-05-12
- DynamicRefImageEncode 新增 `Qwen Layered` 模型类型
  - 选中后显示「图层数」参数，输出分层 latent（`[1, 16, layers+1, h/8, w/8]`），可直接接到 K 采样器
  - 「匹配原图尺寸」开关正常工作（ON 用图片实际尺寸，OFF 用输出宽度/高度）
- ToggleUnifiedLoader 新增「- 移除 LoRA」按钮，从最后一组开始移除

### 2026-05-10
- 新增 ToggleUnifiedLoader（统一模型 + LoRA 加载器）：整合 UNet/CLIP/VAE/多 LoRA 到单一节点
  - 支持按钮动态添加 LoRA 槽位（最多 10 组），选了才显示
  - 支持自动检测 CLIP 类型（从 UNet 模型文件），也支持手动选择

### 2026-05-08
- 新增 SaveLoadImage（保存/加载切换）、ToggleLoadImage（加载图片）、TogglePreviewImage（预览图片）、ToggleEmptyLatent（开关空 Latent）节点
- 新增隐私遮罩功能（👁/🫣 图标切换，适用于图片节点）
- 新增 DynamicRef 系列节点（DynamicRefIndependent、DynamicRefImageEncode、DynamicRefLatentInput、ImageBatcher、OneImageMultiPrompt）

---

## 安装 / Installation

Place this folder under `ComfyUI/custom_nodes/` and restart ComfyUI.
