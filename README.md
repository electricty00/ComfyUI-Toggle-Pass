# ComfyUI-Toggle-Pass

[English](#english) | [中文](#中文)

---

<a id="english"></a>
## English

Toggle-Pass node collection — toggle controls, image load/save/preview, privacy mask, dynamic multi-reference image encoding, unified model loader, and an all-in-one sampler.

### Nodes

#### ToggleUnifiedLoader — Unified Model + LoRA Loader

All-in-one model loading node: UNet + CLIP + VAE + multiple LoRAs in a single node.

**Loader mode** (`加载模式`) — one node, two ways to load:

| Mode | What it does | Parameters shown |
|---|---|---|
| `分离组件 (UNet+CLIP+VAE)` (default) | Pick UNet / CLIP / VAE separately | `unet_name`, `clip_name`, `vae_name`, `clip_type` |
| `Checkpoint 一体包` | Load an all-in-one checkpoint (same as the official **CheckpointLoaderSimple**): UNet + CLIP + VAE are extracted automatically by guessing the config | `ckpt_name` only |

- **The mode is a two-segment switch — `UNet | Checkpoint`**, not a dropdown. Click the left half for
  separate components, the right half for an all-in-one checkpoint; the current side is highlighted
- The switch sits **on the node's top row, level with the `模型 / MODEL` output slot**, and its left
  edge lines up with the dropdown widgets below
- The `加载模式` value is still stored and serialised normally, so **existing workflows and API calls
  keep working** — the switch only takes over how it is drawn and clicked
- Under the Vue node renderer ("modern node design") the switch is drawn inside the combo widget instead
- In `Checkpoint 一体包` mode the separate model dropdowns are hidden, so the node stays clean
- **LoRA works in both modes** — the LoRA groups are applied after loading, regardless of mode
- The VAE comes from the checkpoint itself (same as the official simple loader)
- **Widget order — the model comes first**: `ckpt_name` → `unet_name` → `clip_name` → `vae_name` →
  `clip_type` → `加载模式` → LoRA groups → buttons. In `Checkpoint 一体包` mode the checkpoint
  dropdown is literally the top row
- Old workflows load correctly: saved widget values are re-mapped **by parameter name** on load, so
  nothing gets scrambled. Missing values fall back to the default mode (separate components)

**Inputs**:
- `ckpt_name` — checkpoint file from `models/checkpoints` (only in `Checkpoint 一体包` mode)
- `unet_name` — UNet model file
- `clip_name` — CLIP text encoder file
- `vae_name` — VAE model file
- `clip_type` — CLIP type (auto-detect from UNet, or manually select: SD, SD3, FLUX, FLUX2, `qwen_image`, etc.)
  - Auto-detection recognises the Qwen-Image-2.1 UNet class (`QwenImage21`) and maps it to `qwen_image`.
    ⚠️ This is mandatory for 2.1: only `CLIPType.QWEN_IMAGE` loads the dedicated text encoder (Qwen3-VL 8B)
    that produces `image_slots`. Without it the generic Qwen3-VL encoder is used and **reference images are silently dropped**.
  - Manual override available: select `qwen_image` explicitly (recommended if you suspect auto-detection failed)
- `+ Add LoRA` button — Click to add LoRA slots one by one (up to 10)
- `- Remove LoRA` button — Click to remove LoRA slots from the last group (up to 10)

**LoRA Controls** (added via button, up to 10 groups):
- Select a LoRA file → one `Strength` slider appears automatically
- Select "none" → the slider hides
- All LoRAs are applied sequentially

> **One strength slider, on purpose.** The CLIP side always follows the MODEL side, so the strength you set is exactly what takes effect.

**LoRA status on the button** — after a run the loader reports back what it actually did, right on the
`+ Add LoRA` button, so you never have to guess:

| Button text | Meaning |
|---|---|
| `· 224p` | the LoRA really was patched into the model — 224 patches (count produced by Python) |
| `· 192/224p` | 192 of this LoRA's 224 modules landed; the remaining 32 have no target layer in the base checkpoint. Typical for **repacked INT8 all-in-one checkpoints** (e.g. `img_mlp.gate_layer` was fused into `gate_up`), not a node bug |
| `· ⚠️未写入` | nothing was patched — wrong architecture / incompatible file |
| `· ⚠️N不匹配` | N LoRAs matched zero weights (wrong base model) |
| `· ⚠️N跳过` | N LoRAs were skipped (file missing) |
| `· ⚠️N个强度0` | N selected LoRAs have strength 0 — they do nothing |
| `· ⚠️CLIP不符` | the text encoder that got built doesn't match the model (split mode: wrong CLIP file / clip type) — conditioning is silently useless |

The label is kept short on purpose (a long one would overflow a narrow node); hover the button to see
the full per-LoRA breakdown (module coverage, CLIP check result, per-slot patch counts). The label is
also cleared as soon as you add/remove/switch a LoRA, so a stale count from a previous run never lingers.
Note this reports whether the patch was **written**, not whether it is visible in the picture —
a quantized base, a reference-image-dominated edit, or a very subtle LoRA can all make the effect hard to see.

**Outputs**: `MODEL`, `CLIP`, `VAE`

**Global broadcast** (`全局广播` switch, built in — no extra plugin needed):

Turn it **on** and the node's three outputs are automatically wired to every **empty** `MODEL` / `CLIP` /
`VAE` input in the graph when you press Run. No dragging cables through half the canvas.
Turn it **off** (default) and nothing changes — you wire everything yourself.

- The real wires are made **only while the prompt is being built** and removed immediately afterwards, so
  they never get saved into your workflow
- **While the switch is on, the canvas draws a violet preview curve** for every wire that will be created
  at run time, with a small dot at both ends landing exactly on the output/input slots. The curves are pure
  overlay — they create no real links, are not serializable, and disappear as soon as you switch it off
- **The curves pass behind the nodes**: they are drawn on the background layer, so they show up in the empty
  space between nodes and are naturally hidden where they cross a node — titles and parameters stay readable
  (on a very tightly packed graph you will see less of the line, which is the intended trade-off)
- **It only fills empty inputs.** Anything you connected by hand is left untouched — which is why
  "auto" and "manual" can coexist in the same graph
- Covers `MODEL` / `CLIP` / `VAE` only (the node's three outputs)
- If more than one loader has the switch on, the first one wins for each type and a warning is logged
- **The switch lives at the top of the node**: directly **below** the `UNet / Checkpoint` pill, on its
  left half (a small pill labelled `广播` / "broadcast") — click it to toggle. It no longer takes up a
  full row at the bottom; the bottom now only holds the two LoRA buttons
- Its size matches the pill: **width = half of the pill**, **height identical to the pill** (14px, edges aligned)
- The switch state is stored in the node's `properties`, so it is **not** part of `widgets_values` —
  old workflows keep every parameter in its original position, and the switch simply defaults to off
- Works alongside `cg-use-everywhere` (it does not touch that plugin's `ue_convert` flag)

> **Limitation**: the broadcast happens on the front-end, so it applies when you press Run or export the
> API format from the UI. A raw `POST /prompt` with a hand-written API JSON never passes through the
> front-end, so no auto-wiring happens there — export the API format once and the JSON already has the links.

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

**Model type**: `Flux2` / `Qwen Layered` / `Qwen Image 2.1` / `SD / SDXL`
- Selecting `Qwen Image 2.1` reveals its own parameter group (see [Qwen Image 2.1](#qwen-image-21-support))
- Selecting `Qwen Layered` reveals `layers`; latent output is layered (`[1, 16, layers+1, h/8, w/8]`)
- Selecting `Flux2` / `SD / SDXL` only shows the classic `输出宽度/高度` (old behaviour, unchanged)

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

**Model type**: `Flux2` / `Qwen Layered` / `Qwen Image 2.1` / `SD / SDXL`
- `Qwen Layered`: Adds a `layers` parameter; latent output is a layered latent (`[1, 16, layers+1, h/8, w/8]`), directly connectable to Ksampler's latent input (replaces `EmptyQwenImageLayeredLatentImage`)
- `Qwen Image 2.1`: Adds its own parameter group for editing + resolution control (see below)
- Every model type only shows the parameters it actually uses — switching the dropdown hides the rest, so the node stays clean
- When `匹配原图尺寸` = ON, uses the actual image size; when OFF, uses the 2.1 resolution parameters (or `输出宽度/高度` for other models)

#### DynamicRefLatentInput — Dynamic Latent Input

Dynamically add/remove LATENT input slots, for use with DynamicRef series.

#### ImageBatcher — Image Batcher

Dynamically add/remove IMAGE input slots, batch multiple images together.

#### ToggleImageCompare — 图片对比

Compare multiple "source" images against multiple "result" images by composing them into a single
side-by-side sheet, previewed right inside the node.

**Inputs**: `num_sources`, `num_results`, `source1`~`source10`, `result1`~`result10`
- `num_sources` / `num_results` — how many slots to show for each group (1~10), adjusted independently,
  so **N sources + 1 result** and **N sources + N results** are both supported
- `source1`~`source10` — the "before" / original images
- `result1`~`result10` — the "after" / generated images

> In the node UI these are shown in Chinese: slots as `原图1`~`原图10` / `结果1`~`结果10`,
> counters as `原图数` / `结果数`, and the output as `对比图`. The English keys above are kept
> unchanged so existing workflows keep loading.

**Parameters**
- `排版` (layout) — `自动` (auto) / `成对并排` (paired) / `上下两排` (stacked) / `自动网格` (grid)
  - `自动` picks paired when the two groups have equal counts, otherwise stacked
- `标签` (labels) — burn `原1 / 结1 …` badges on each tile, or hide them

**Outputs**: `comparison` — one composed IMAGE (feed it into `SaveLoadImage` or a preview node)

Layout is decided by the images **actually connected**, not by how many slots you enabled, so you
never have to touch the settings when the counts change. Images of different sizes are scaled to a
common row height (aspect ratio preserved).

#### OneImageMultiPrompt — One Image Multiple Prompts

One reference image with multiple prompts, output separate conditionings (up to 8), sharing a single latent.

**Inputs**: `clip`, `image`, `prompt数量`, `prompt1` ~ `prompt8`
- `prompt数量` — how many prompts to use (2~8); unused prompt boxes are hidden automatically
- `模型类型` — `Flux2` / `Qwen Image 2.1` / `SD / SDXL` / `Krea2`. Selecting `Qwen Image 2.1` adds the
  full resolution parameter group, so one photo can be rendered from multiple viewpoints / edits at once.

**Outputs**: `cond_1` ~ `cond_8`, `latent`

---

#### ToggleSampler — All-in-one Sampler (采样器（一体）)

Collapses the official four-node chain into a single node:

```
RandomNoise + CFGGuider + KSamplerSelect + (BasicScheduler | ManualSigmas)  ->  SamplerCustomAdvanced
```

**Inputs**: `模型` (MODEL), `正面条件` / `负面条件` (CONDITIONING), `Latent图像` (LATENT)
**Parameters**: `采样方案`, `采样器`, `调度器`, `步数`, `CFG`, `降噪`, `噪波随机种`, `自定义Sigma表`
**Outputs**: `Latent`, `降噪Latent`

Model / conditioning / latent stay as **sockets on purpose** — the only thing that really differs
between models is the sigma curve, so switching models never needs a new node. `采样方案` comes in
three flavours:

| Scheme | What it does | Which parameters matter |
|---|---|---|
| `自动（按步数 + 调度器）` | computes sigmas live — numerically identical to official `BasicScheduler` | `步数` + `调度器` |
| Preset tables: `Qwen-Image-2.1 turbo 8步`, `LTX-2 视频 8步（蒸馏）`, `LTX-2 视频 3步（低噪）` | fixed distillation trajectory | none — the step count is baked into the table |
| `自定义表` | hand-typed sigma list | `自定义Sigma表` |

A sigma table must be comma separated, **strictly decreasing**, **end with 0**, and `N` values = `N-1`
steps (9 values = 8 steps).

Parameters that a preset makes irrelevant are greyed out *and* locked: `步数` flips to the preset's real
value (still readable, just not editable), and switching back to `自动` restores your own step count.
`降噪` < 1.0 trims the tail of the table, so low-denoise refinement works with presets too.

For distilled turbo models use `采样器` = `euler` and `CFG` = `1.0`.

---

<a id="qwen-image-21-support"></a>
### Qwen Image 2.1 Support

`DynamicRefImageEncode`, `DynamicRefIndependent` and `OneImageMultiPrompt` all support **Qwen-Image-2.1**
image editing / multi-view generation. Select `Qwen Image 2.1` in `模型类型` and these parameters appear:

| Parameter | Meaning |
|---|---|
| `宽高比` (Aspect ratio) | Preset ratios (1:1 / 3:2 / 16:9 / 21:9 ...), or `自定义（用输出宽度/高度）` |
| `百万像素` (Megapixels) | Total pixel budget, e.g. `1.0` ≈ 1024×1024, `2.6` ≈ 2016×1344. Range 0.1~16, **do not fill 1024 here** |
| `倍数` (Multiple) | Alignment step, fixed ≥ **32** (16 will break shapes) |
| `参考图分辨率` (Ref resolution) | How large the *reference* image is fed to the model (area target). `0` = keep original size |
| `尺寸适配` (Ref fit mode) | `参考图保比例` (default, no distortion) / `参考图裁剪` / `参考图拉伸` |

Key rules learned from aligning with the official `TextEncodeQwenImage21`:

- **Output size and reference size are independent.** `qwen_image` uses `default_ref_method = "index"`,
  so the reference and the output live on separate RoPE planes and need not be the same shape.
  Changing `参考图分辨率` does **not** change the output size.
- **Instructions must go into the prompt text, not the `instruction` field.**
  `comfy/text_encoders/qwen_image21.py` drops the system turn, so anything written into `instruction`
  is silently discarded for 2.1 — the node merges it into the user text automatically.
  The default Flux-era English instruction is ignored (it would pollute the prompt).
- **The latent output is all-zero.** Feeding the reference image's real latent turns editing into img2img
  (nothing changes). The real latent only goes into `reference_latents` in the conditioning.
- Images must be multiples of **32**; RGBA reference images are composited on white for the vision tower.

Recommended setup for editing: `匹配原图尺寸` = **OFF**, `尺寸适配` = `参考图保比例`,
`百万像素` = 1.0, `倍数` = 32, `参考图分辨率` = 1024.

---

<a id="krea2-support"></a>
### Krea2 Support

`ToggleUnifiedLoader`, `DynamicRefImageEncode`, `DynamicRefIndependent` and `OneImageMultiPrompt`
all support **Krea2**. The loader detects `Krea2` from the UNet automatically and picks
`CLIPType.KREA2` + the `Krea2TEModel` text encoder; the three encoding nodes just need
`模型类型` = `Krea2`.

⚠️ **VAE must match the model.** This is the single most common failure — mixing them up does not
fail at load time, it fails deep inside `VAEDecode`:

| Model | VAE file | latent |
|---|---|---|
| Qwen-Image **2.1** | `qwen_image_2.1_vae_bf16.safetensors` | 64 ch / 16x / RGBA |
| **Krea2** | `qwen_image_vae.safetensors` | 16 ch / 8x / RGB |

A wrong VAE is silently padded by `fix_empty_latent_channels` (16 → 64), sampling still finishes, and
then decode dies with `IndexError: tuple index out of range` from the Wan 2.1 branch.
The loader now compares `latent_channels` / `latent_dimensions` at load time and prints the exact file
you should use instead.

Key rules learned from aligning with the official `TextEncodeQwenImageEditPlus`:

- **Reference latent size ≠ output size.** Reference images are VAE-encoded at ~1 MP (multiples of 8),
  the vision tower gets a ~384 px thumbnail.
- **The VAE only takes RGB** — alpha is dropped, not composited.
- **Vision placeholders must be written by hand.** With an explicit `llama_template` the Qwen3-VL
  tokenizer does *not* auto-insert them, so the node emits
  `Picture N: <|vision_start|><|image_pad|><|vision_end|>`. Without it the reference image is
  completely invisible to the model.
- **`reference_latents_method` is mandatory.** Krea2's `default_ref_method` is `None`, so references
  are *silently ignored* unless the method is set; the node always sets `index_timestep_zero`
  (same as the official style-reference template).
- **The latent output is all-zero** (16 ch / 8x) — same "editing, not img2img" rule as 2.1.
- **Sigma curve:** Krea2 turbo uses the `自动（按步数 + 调度器）` scheme in `采样器（一体）`.
  The `Qwen-Image-2.1 turbo 8步` table is *not* interchangeable with it.

---

### Canvas Menu Entry

All Toggle-Pass nodes are also reachable from the canvas menu (same place as KJNodes / rgthree entries):

```
🔄 Toggle-Pass  ▸
   ├ 采样器（一体）
   ├ Image Batcher
   ├ Multi Ref Latent Input
   ├ One Image Multi Prompt
   ├ Ref Image Encode
   ├ Ref Independent
   └ ...
```

- The list is **collected at runtime** — new nodes show up automatically, no code change needed
- Clicking an item spawns the node **at your pointer position**

---

### Privacy Mask

SaveLoadImage, ToggleLoadImage, and TogglePreviewImage support privacy mask:
- Title bar shows 👁 (show image) / 🫣 (hide image) icon
- Click icon to toggle privacy state; when hidden, image preview area is blank
- Privacy state is saved/restored with workflow, does not affect image generation

---

### Example Workflows

Ready-to-load graphs live in [`example_workflows/`](example_workflows/) — drag a `.json` onto the
canvas, or open it from the workflow menu.

| File | What it demonstrates | Extra deps |
| --- | --- | --- |
| `All-in-One Demo.json` | Every Toggle-Pass node in one graph: `ToggleUnifiedLoader`, `ToggleSampler`, `ToggleLoadImage` ×2, `ToggleImageCompare`, `TogglePreviewImage`, `DynamicRefImageEncode`, `SaveLoadImage` + `VAEDecode`. **Best place to start** — needs no third-party nodes. | — |
| `Graphic-Text Integration Editing.json` | Text + single reference image editing through `DynamicRefImageEncode`, saved by `SaveLoadImage`. | — |
| `Batch Editing.json` | Six input images batched into one reference set for batch editing. | `RTXVideoSuperResolution` |
| `Lazy Person's Multi-angle View.json` | One image + `OneImageMultiPrompt` ("一图多视角") to generate several camera angles in one run. | `CR Upscale Image` |

> The model filenames inside these graphs reflect the author's local setup. If a loader shows red
> after loading, point it at your own checkpoint / text encoder / VAE.

---

### Notes

- When `num_images` changes, input/output slots auto-adjust, **existing connections are not broken**
- Switching pages and back, nodes auto-restore to correct slot count
- Requires Qwen2.5-VL or compatible CLIP model; Qwen-Image-2.1 requires Qwen3-VL 8B + `qwen_image` clip type
- Default instruction is for Qwen-Image-Edit models, modify as needed
- Only parameters relevant to the selected `模型类型` are shown; the rest are hidden
- Illegal widget values (e.g. `倍数 = NaN`) fall back to safe defaults on load. **After upgrading,
  restart ComfyUI and hard-refresh (Ctrl+F5) once**, then save your workflow
- ⚠️ Modern node design (Vue nodes) breaks `widget.hidden` and custom drawing — with it enabled every
  parameter stays visible and the privacy icon disappears. Turn it off in ComfyUI settings.
- ⚠️ On quantized checkpoints (INT8/FP8) a LoRA still takes effect, but it comes out "blurrier": ComfyUI
  dequantizes → patches → re-quantizes with stochastic rounding, so the delta keeps its magnitude
  (~115%) while its direction picks up noise (cosine 0.4–0.7). Pose/structure LoRAs stay visible,
  very subtle style LoRAs may not. This is upstream behavior — official `LoraLoader` is identical
  (A/B with the same seed gave **pixel-identical** output, meanAbsDiff = 0.00)
- The loader reports how many patches each LoRA actually wrote **plus module coverage**
  (`192/224p`) — see the button labels above. A missing fraction usually means the checkpoint was
  repacked and those layers don't exist in it, not that the LoRA failed to load
- ⚠️ **CLIP check (split mode)**: after loading, the loader verifies the text-encoder class it actually
  built (e.g. `QwenImage21TEModel_` vs a wrong `QwenImageTEModel_` / `Flux2TEModel_`). A mismatched CLIP
  file still runs silently but makes the conditioning useless; the button then shows `⚠️CLIP不符`
  and the log prints the expected class + what to do
- ⚠️ **VAE check (split mode)**: the loader also compares latent channels / dimensions against the model.
  A mismatched VAE never fails at load time — it dies later inside `VAEDecode`
  (`IndexError: tuple index out of range`), so the loader now warns immediately and names the file to use
- Hiding/collapsing a LoRA group **reclaims the node height**, so the node never stays as a long empty box
- **Selection box on canvas follows the mouse again**: ComfyUI 1.57.x clamps the drag-selection rectangle to
  `.graph-canvas-panel`, which only covers the lower part of the canvas — dragging in the upper half pushed the
  box's top edge down (and squashed its height to 0), so the box seemed to appear "somewhere else".
  `js/selection_rect_fix.js` rewrites that box's position from the real mouse points. Disable it with
  `localStorage.setItem("tp_selrect_fix", "off")` in the browser console + refresh
- Python changes require a **ComfyUI restart**; pure JS changes only need Ctrl+F5

---

<a id="中文"></a>
## 中文

Toggle-Pass 系列节点——开关控制、图片加载/保存/预览、隐私遮罩、多参考图动态编码、统一模型加载、一体化采样器。

### 节点说明

#### ToggleUnifiedLoader — 统一模型 + LoRA 加载器

一体化模型加载节点：UNet + CLIP + VAE + 多 LoRA 整合到一个节点中。

**加载模式**（`加载模式`）— 一个节点，两种加载方式：

| 模式 | 作用 | 显示的参数 |
|---|---|---|
| `分离组件 (UNet+CLIP+VAE)`（默认） | UNet / CLIP / VAE 分别指定 | `unet_name`、`clip_name`、`vae_name`、`clip_type` |
| `Checkpoint 一体包` | 加载一体化 checkpoint（等同官方 **CheckpointLoaderSimple**）：自动猜配置，UNet + CLIP + VAE 一次出齐 | 只显示 `ckpt_name` |

- **加载模式做成了一个两段式开关 `UNet | Checkpoint`**（不再是下拉框）：点左半是分离组件、点右半是一体包，
  当前档高亮。开关位于**节点顶部第一行，与输出插槽 `模型 / MODEL` 同一行**，左端与**下方所有下拉框的
  左边缘对齐**
- 底层 `加载模式` 的值照常保存与序列化，**旧工作流与 API 调用完全不受影响** —— 开关只是接管了绘制与点击
- 「现代节点设计」（Vue 节点渲染）下，开关会改为画在下拉框内部
- 选 `Checkpoint 一体包` 时，分离的三个模型下拉会自动隐藏，界面不眼花
- **两种模式都能加 LoRA** —— LoRA 组在加载完成后统一应用
- VAE 用一体包自带的（与官方简易版一致）
- **参数顺序：模型在最前** —— `ckpt_name` → `unet_name` → `clip_name` → `vae_name` → `clip_type`
  → `加载模式` → LoRA 组 → 按钮。一体包模式下第一行就是 checkpoint 下拉框
- 旧工作流能正常加载：加载时会按**参数名**把保存的值对回去，不会串位
- 缺失的值仍然回退到默认模式（分离组件）

**输入**：
- `ckpt_name` — `models/checkpoints` 里的 checkpoint 文件（只在「Checkpoint 一体包」模式下显示）
- `unet_name` — UNet 模型文件
- `clip_name` — CLIP 文本编码器文件
- `vae_name` — VAE 模型文件
- `clip_type` — CLIP 类型（支持 auto 从 UNet 自动检测，也可手动选择：SD、SD3、FLUX、FLUX2、`qwen_image` 等）
  - 自动检测能识别 Qwen-Image-2.1 的 UNet 类名（`QwenImage21`）并映射到 `qwen_image`
  - ⚠️ **这是 2.1 的必备条件**：只有 `CLIPType.QWEN_IMAGE` 才能加载 2.1 专用文本编码器（Qwen3-VL 8B），
    它会生成 `image_slots`；否则会退回通用 Qwen3-VL 编码器，**参考图被静默丢弃**
  - 也支持手动指定：怀疑自动检测没生效时直接选 `qwen_image`
- `+ 添加 LoRA` 按钮 — 点击逐个添加 LoRA 槽位（最多 10 组）
- `- 移除 LoRA` 按钮 — 点击从最后一组开始移除（最多 10 组）

**LoRA 控件**（通过按钮添加，最多 10 组）：
- 选择 LoRA 文件 → 自动展开**一个**「强度」滑块
- 选择 "none" → 自动隐藏滑块
- 多个 LoRA 按顺序依次应用

> **只有一个强度滑块是有意为之**：CLIP 侧**始终跟随 MODEL 侧**，保证「看到的强度 = 实际生效强度」。

**跑完之后按钮上直接告诉你 LoRA 到底写没写进去**（后端回传，不用再猜）：

| 按钮文案 | 含义 |
|---|---|
| `· 224p` | LoRA **确实写进了模型**，共 224 个 patch（数字是 Python 侧统计的真实值） |
| `· 192/224p` | 这份 LoRA 的 224 个模块里只落下 192 个，剩下 32 个在当前底座上**没有对应层**。典型于**被 repack 过的 INT8 一体包**（如 `img_mlp.gate_layer` 被融进 `gate_up`），不是节点的问题 |
| `· ⚠️未写入` | 一个 patch 都没挂上 —— 架构不匹配 / 文件不对 |
| `· ⚠️N不匹配` | N 个 LoRA 的键名跟底座完全对不上（拿错底座的 LoRA） |
| `· ⚠️N跳过` | N 个 LoRA 被跳过（文件找不到） |
| `· ⚠️N个强度0` | 有 N 个已选 LoRA 强度是 0 —— 等于没加 |
| `· ⚠️CLIP不符` | 建出的文本编码器与模型不配套（分体模式下换错 CLIP 文件 / 选错 clip 类型）—— 提示词会被错误编码，跑得通但什么都不生效 |

按钮文案故意写得很短（太长会溢出窄节点），鼠标悬停在按钮上能看到**每个 LoRA 的完整明细**
（模块覆盖率、CLIP 校验结果、每个槽位实际写入的 patch 数）；
另外只要增删/切换 LoRA，上一次运行的数字会立刻清掉，不会留一个过期读数误导你。
注意它反映的是「patch 有没有写进去」，不等于「画面上一定看得出来」——量化底座、参考图主导的编辑、过于细微的 LoRA，都会让效果不明显。

**输出**：`MODEL`、`CLIP`、`VAE`

**全局广播**（节点自带开关，不需要装任何额外插件）：

打开后，点「运行」时会把这三个输出**自动接到图里所有空着的** `MODEL` / `CLIP` / `VAE` 输入上，
不用再横跨半张画布拉线。关掉（默认）就完全保持原样，自己连线。

- 这些线**只在提交的那一刻真实存在**，提交完立刻拆掉 —— 不会被存进工作流
- **开关打开时，画布上会用紫色曲线画出「运行时会自动接上的每一条线」**，起点/终点各有一个小圆点，
  精确落在输出口和输入口上。曲线只是视觉预览：不创建真实连线、不参与序列化，关掉开关立刻消失
- **曲线从节点背后穿过**：画在节点下层，节点之间的空白处正常显示，穿过节点的地方被节点自然遮住，
  所以永远不会盖住节点标题和参数（节点排得密时可见部分会少一些，这是刻意的取舍）
- **只补空位**：凡是已经手连的输入一律不动，所以「自动」和「手动」可以在同一张图里混用
- 只覆盖 `MODEL` / `CLIP` / `VAE`（也就是本节点的三个输出）
- 如果图里有多个加载器都开了广播，同一类型只取第一个，并在控制台给出提示
- **开关在节点顶部**：就在 `加载模式` 那个 `UNet / Checkpoint` 胶囊的**正下方、左半边**（一个小胶囊，
  左边写「广播」）—— 点一下切换。它不再占用节点底部一整行，底部只剩 LoRA 那两个按钮
- 开关状态存在节点的 `properties` 里，**不占 `widgets_values`** —— 旧工作流的每一项参数位置都不变，
  开关默认关闭
- 与 `cg-use-everywhere` 共存，不碰它那套 `ue_convert` 标记

> **限制**：广播发生在前端，所以「界面里点运行」和「从界面导出 API 格式」都算数；
> 但直接 `POST /prompt` 提交手写的 API JSON 不经过前端，就不会自动接线 ——
> 需要的话在界面里导出一次 API 格式，导出的 JSON 里线已经带好了。

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

**模型类型**：`Flux2` / `Qwen Layered` / `Qwen Image 2.1` / `SD / SDXL`
- 选择 `Qwen Image 2.1` 会展开 2.1 专属参数组（见 [Qwen Image 2.1 支持](#qwen-image-21-支持)）
- 选择 `Qwen Layered` 会展开「图层数」
- 每种模型只显示自己用得上的参数，其余自动隐藏，界面不会眼花

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

**模型类型**：`Flux2` / `Qwen Layered` / `Qwen Image 2.1` / `SD / SDXL`
- `Qwen Layered`：增加「图层数」参数；输出的 latent 为分层格式（`[1, 16, layers+1, h/8, w/8]`），可直接接到 K采样器的 latent 输入（省掉 `EmptyQwenImageLayeredLatentImage` 节点）
- `Qwen Image 2.1`：增加 2.1 专属的分辨率参数组（详见下方小节）
- 每个模型类型只显示自己需要的参数，切换下拉框即自动隐藏其余的
- 「匹配原图尺寸」= ON 时，使用图片实际尺寸；= OFF 时，2.1 走分辨率参数组，其他模型仍用「输出宽度/高度」（旧行为不变）

#### DynamicRefLatentInput — 动态 Latent 输入

动态增删 LATENT 输入槽，配合 DynamicRef 系列使用。

#### ImageBatcher — 图像批处理

动态增删 IMAGE 输入槽，将多张图打包成批次。

#### ToggleImageCompare — 图片对比

把多张「原图」与多张「结果」拼成一张对比图，节点内直接预览。

**输入**：`num_sources`、`num_results`、`source1`~`source10`、`result1`~`result10`
- `num_sources` / `num_results` — 每组显示几个槽（1~10），两组各自独立，
  所以 **N 张原图 + 1 张结果** 和 **N 张原图 + N 张结果** 都支持
- `source1`~`source10` — 原图（before）
- `result1`~`result10` — 结果（after）

> 节点上显示为 `原图1`~`原图10` / `结果1`~`结果10`、`原图数` / `结果数`、输出 `对比图`；
> 上面这些英文 key 保持不变，为了兼容已保存的工作流。

**参数**
- `排版` — `自动` / `成对并排` / `上下两排` / `自动网格`
  - `自动`：两组数量相等时用「成对并排」，不等时用「上下两排」
- `标签` — 在每张图上烧 `原1 / 结1 …` 角标，或隐藏

**输出**：`comparison` —— 一张合成图（可直接接 `SaveLoadImage` 或预览节点）

排版按**实际接上的图**算，而不是你开了几个槽，所以数量变了也不用改设置。尺寸不一样的图会
按行统一高度缩放（保持宽高比）。

#### OneImageMultiPrompt — 单图多提示词（一图多视角）

一张参考图对应多个提示词，分别输出各自的 conditioning（最多 8 组），共享同一个 latent。

**输入**：`clip`、`image`、`prompt数量`、`prompt1` ~ `prompt8`
- `prompt数量` — 用几个提示词（2~8），多余的 prompt 框会自动隐藏
- `模型类型` — `Flux2` / `Qwen Image 2.1` / `SD / SDXL` / `Krea2`。选 `Qwen Image 2.1` 会展开完整的分辨率参数组，
  适合「一张图出多个视角 / 多种编辑」。

**输出**：`cond_1` ~ `cond_8`、`latent`

---

#### ToggleSampler — 采样器（一体）

把官方四件套收进一个节点：

```
随机噪波 + CFG引导器 + K采样器选择 + (基础调度器 | 手动Sigmas)  ->  SamplerCustomAdvanced
```

**输入**：`模型`（MODEL）、`正面条件` / `负面条件`（CONDITIONING）、`Latent图像`（LATENT）
**参数**：`采样方案`、`采样器`、`调度器`、`步数`、`CFG`、`降噪`、`噪波随机种`、`自定义Sigma表`
**输出**：`Latent`、`降噪Latent`

模型 / 条件 / Latent **故意保留成插槽**——真正随模型变的只有 sigma 曲线，所以换模型不用换节点。
`采样方案` 分三类：

| 方案 | 作用 | 生效参数 |
|---|---|---|
| `自动（按步数 + 调度器）` | 现场算 sigma，与官方 `BasicScheduler` 数值完全一致 | `步数` + `调度器` |
| 预置表：`Qwen-Image-2.1 turbo 8步`、`LTX-2 视频 8步（蒸馏）`、`LTX-2 视频 3步（低噪）` | 蒸馏模型专用的固定轨迹 | 无——步数已写进表里 |
| `自定义表` | 手填一串 sigma | `自定义Sigma表` |

sigma 表规则：逗号分隔、**严格递减**、**末值必须是 0**、`N` 个点 = `N-1` 步（9 个点 = 8 步）。

选了预置表之后失效的参数会自动变灰**并锁住**：`步数` 会跳到该表真实的步数（看得见但改不动），
切回 `自动` 会还回你自己设的步数。`降噪` < 1.0 会裁掉表的尾部，所以预置表也能做低降噪细化。

蒸馏 turbo 模型推荐 `采样器` = `euler`、`CFG` = `1.0`。

---

<a id="qwen-image-21-支持"></a>
### Qwen Image 2.1 支持

`DynamicRefImageEncode`（Ref Image Encode）、`DynamicRefIndependent`（Ref Independent）、
`OneImageMultiPrompt`（一图多视角）均已支持 **Qwen-Image-2.1** 图像编辑 / 多视角生成。
把「模型类型」选成 `Qwen Image 2.1`，会展开下面这组参数：

| 参数 | 含义 |
|---|---|
| `宽高比` | 预设比例（1:1 / 3:2 / 16:9 / 21:9 …），或 `自定义（用输出宽度/高度）` |
| `百万像素` | 总像素预算：`1.0` ≈ 1024×1024，`2.6` ≈ 2016×1344。范围 0.1~16，**别在这里填 1024** |
| `倍数` | 对齐步长，硬下限 **32**（填 16 会算出非法形状，例如 5024×3344） |
| `参考图分辨率` | 参考图喂给模型前被缩到多大（面积基准）；`0` = 保持原尺寸 |
| `尺寸适配` | `参考图保比例`（默认，不变形）/ `参考图裁剪` / `参考图拉伸` |

对齐官方 `TextEncodeQwenImage21` 时总结出的几条关键规则：

- **出图尺寸和参考图尺寸互不影响。** `qwen_image` 用的是 `default_ref_method = "index"`，
  参考图和输出各占独立的位置平面，不需要同形。改「参考图分辨率」**不会**让出图变大变小。
- **指令要写进提示词文本，不能写在 `instruction` 里。**
  `comfy/text_encoders/qwen_image21.py` 会丢弃 system 段，写进 `instruction` 的内容在 2.1 下会被静默丢弃；
  节点已自动把它并进 user 段（Flux 时代那句默认英文 instruction 会被忽略，免得污染提示词）。
- **latent 输出是全零。** 如果把参考图的真实 latent 当采样起点，编辑就会退化成 img2img（内容完全不变）；
  真实 latent 只进 conditioning 的 `reference_latents`。
- 图片必须是 **32 的倍数**；带 alpha 的参考图会先合成到白底再送进视觉塔。

推荐设置（2.1 图像编辑）：`匹配原图尺寸` = **OFF**、`尺寸适配` = `参考图保比例`、
`百万像素` = 1.0、`倍数` = 32、`参考图分辨率` = 1024。

---

<a id="krea2-支持"></a>
### Krea2 支持

`ToggleUnifiedLoader`（统一加载器）、`DynamicRefImageEncode`（Ref Image Encode）、
`DynamicRefIndependent`（Ref Independent）、`OneImageMultiPrompt`（一图多视角）均已支持 **Krea2**。
加载器会从 UNet 自动认出 `Krea2`，直接配 `CLIPType.KREA2` + `Krea2TEModel` 文本编码器；
三个编码节点只要把「模型类型」选成 `Krea2` 即可。

⚠️ **VAE 必须和模型配套。** 这是最常见的翻车点——配错不会在加载时报错，而是在 `VAEDecode` 深处炸：

| 模型 | VAE 文件 | latent |
|---|---|---|
| Qwen-Image **2.1** | `qwen_image_2.1_vae_bf16.safetensors` | 64 通道 / 16x / RGBA |
| **Krea2** | `qwen_image_vae.safetensors` | 16 通道 / 8x / RGB |

配错时 `fix_empty_latent_channels` 会静默把 16 通道补成 64，采样照样跑完，
然后解码落进 Wan 2.1 分支报 `IndexError: tuple index out of range`。
现在加载器会在加载时比对 `latent_channels` / `latent_dimensions`，直接把该换哪个文件打到日志里。

对齐官方 `TextEncodeQwenImageEditPlus` 后总结的几条规则：

- **参考图尺寸和出图尺寸无关。** 参考图按约 1 MP（对齐 8 倍数）编码进 VAE，
  视觉塔只吃约 384 px 的缩略图。
- **VAE 只吃 RGB** —— alpha 是丢掉，不是合成。
- **视觉占位符必须手写。** 传了显式 `llama_template` 时 Qwen3-VL 的 tokenizer **不会**自动插占位符，
  节点会自己拼 `Picture N: <|vision_start|><|image_pad|><|vision_end|>`；
  漏了就相当于参考图对模型完全不可见。
- **`reference_latents_method` 必须显式给。** Krea2 的 `default_ref_method` 是 `None`，
  不设方法时参考图会被**静默忽略**（不报错，只是没效果）；节点固定设为 `index_timestep_zero`
  （与官方风格参考模板一致）。
- **latent 输出是全零**（16 通道 / 8x）——和 2.1 一样是「编辑而不是 img2img」。
- **sigma 曲线：** Krea2 turbo 在 `采样器（一体）` 里用 `自动（按步数 + 调度器）` 方案，
  `Qwen-Image-2.1 turbo 8步` 那张表不能套过来用。

---

### 画布菜单入口

本插件全部节点也能从画布菜单里直接添加（和 KJNodes / rgthree 的入口在同一处）：

```
🔄 Toggle-Pass  ▸
   ├ 采样器（一体）
   ├ Image Batcher
   ├ Multi Ref Latent Input
   ├ One Image Multi Prompt
   ├ Ref Image Encode
   ├ Ref Independent
   └ ...
```

- 列表是**运行时自动收集**的，以后新增节点自动出现，不用改代码
- 点击任意一项，节点落在**鼠标所在位置**

---

### 隐私遮罩功能

SaveLoadImage、ToggleLoadImage、TogglePreviewImage 三个节点均支持隐私遮罩：
- 标题栏右侧显示 👁（显示图片）/ 🫣（隐藏图片）图标
- 点击图标切换隐私状态，隐藏时图片预览区域留空
- 隐私状态随工作流自动保存/恢复，不影响生图流程

---

### 示例工作流

现成的图都在 [`example_workflows/`](example_workflows/) 里，把 `.json` 拖到画布上就能打开。

| 文件 | 演示什么 | 额外依赖 |
| --- | --- | --- |
| `All-in-One Demo.json` | 一个图里放齐本插件全部节点：`ToggleUnifiedLoader`、`ToggleSampler`、`ToggleLoadImage` ×2、`ToggleImageCompare`、`TogglePreviewImage`、`DynamicRefImageEncode`、`SaveLoadImage` + `VAEDecode`。**想快速上手就从这张开始** —— 不需要任何第三方节点。 | 无 |
| `Graphic-Text Integration Editing.json` | 单张参考图的「文字 + 参考图」编辑，用 `DynamicRefImageEncode` 编码、`SaveLoadImage` 保存。 | 无 |
| `Batch Editing.json` | 六张输入图经批处理组成一组参考图，做批量编辑。 | `RTXVideoSuperResolution` |
| `Lazy Person's Multi-angle View.json` | 一张图 + `OneImageMultiPrompt`（一图多视角），一次生成多个机位。 | `CR Upscale Image` |

> 这些图里的模型文件名是作者本机的配置。加载后如果有加载器变红，在对应节点里改成你自己的
> checkpoint / 文本编码器 / VAE 即可。

---

### 注意事项

- `num_images` 调整时，输入/输出槽会自动增减，**已有连线不会被断开**
- 切换页面再回来，节点会自动恢复到正确的槽位数量
- 需要 Qwen2.5-VL 或兼容的 CLIP 模型；用 Qwen-Image-2.1 时需要 Qwen3-VL 8B + `qwen_image` 类型的 clip
- 默认 instruction 适用于 Qwen-Image-Edit 类模型，可按需修改（2.1 下会自动并进提示词文本）
- 界面只显示当前「模型类型」用得上的参数，其余自动隐藏
- 非法的参数值（如 `倍数 = NaN`、`百万像素 = 1024`）在加载时会自动回退到安全默认值。
  **升级后请重启 ComfyUI + 强刷一次（Ctrl+F5）**，然后保存工作流即可固化
- ⚠️ 「现代节点设计（Vue 节点）」会导致 `widget.hidden` 与自定义绘制失效 —— 开启后所有参数都会展开、
  隐私开关图标也会消失。请在 ComfyUI 设置里关掉它
- ⚠️ 量化底座（INT8/FP8）上 LoRA **依然生效，只是更"糊"**：ComfyUI 走「反量化 → 叠加 patch →
  再量化回 int8」，但用的是**随机舍入 + 重算 scale**，增量幅度能保留约 113%~120%，代价是方向带噪声
  （余弦 0.4~0.7）。姿态/结构类 LoRA 看得出来，特别细微的风格类可能看不出来。
  这是上游行为，官方 `LoraLoader` 一模一样（同 seed A/B 实测：本节点与
  `CheckpointLoaderSimple + LoraLoader` 输出逐像素完全一致，meanAbsDiff = 0.00）
- 加载器会把每个 LoRA 实际写入了多少 patch **以及模块覆盖率**（`192/224p`）回传到按钮上
  （见上面那张表）。覆盖率不满一般是底座被 repack、那几层不存在，而不是 LoRA 没加载
- ⚠️ **分体模式的 CLIP 校验**：加载完 CLIP 后会比对实际建出的文本编码器类名与模型是否配套
  （正确类名如 `QwenImage21TEModel_` / `QwenImageTEModel_` / `Flux2TEModel_`，日志会打印）。
  不配套时按钮显示 `⚠️CLIP不符`，日志会给出预期类名和处理建议 ——
  否则这种情况会「跑得通但什么都不生效」，极难自查
- ⚠️ **分体模式的 VAE 校验**：加载器还会比对 latent 通道数 / 维度与模型是否配套。
  配错的 VAE 在加载时不报错，一路跑到 `VAEDecode` 才炸（`IndexError: tuple index out of range`），
  所以现在加载时就直接提示，并告诉该换哪个 VAE 文件
- 隐藏/收起 LoRA 组后会自动**回收节点高度**，节点不会留成一大条空框
- **画布拖框现在会跟着鼠标走**：ComfyUI 1.57.x 会把拖拽选择框裁剪到 `.graph-canvas-panel`
  （实测这个容器只覆盖画布中下部），在画布上半部分拖框时框的顶边被强行下压、高度被压成 0，
  表现就是「鼠标在左上角拉、框却出现在中间/下面」。`js/selection_rect_fix.js` 按真实鼠标点
  重写框的位置，只改显示、不动画布状态。要关掉：浏览器控制台执行
  `localStorage.setItem("tp_selrect_fix", "off")` 后刷新
- Python 改动需要**重启 ComfyUI**，纯 JS 改动只需 Ctrl+F5

---

## 更新日志 / Changelog

> 按时间记录**新增 / 变更的功能**，以及怎么用。

### 2026-10-25

- **新增示例工作流 `example_workflows/All-in-One Demo.json`**：一个图里放齐本插件全部交互节点
  （`ToggleUnifiedLoader` / `ToggleSampler` / `ToggleLoadImage` ×2 / `ToggleImageCompare` /
  `TogglePreviewImage` / `DynamicRefImageEncode` / `SaveLoadImage` + `VAEDecode`），
  **不依赖任何第三方节点**，拖进画布即可跑通；原 `Toggle-Pass-Test.json` 已改名为它
- **README 新增「示例工作流」小节**（中英双语）：列出 `example_workflows/` 里 4 个示例分别演示什么、
  各自需要哪些额外依赖 —— 此前 README 对示例目录零引用，用户不知道这些文件存在

### 2026-10-24

- **「全局广播」开关搬到节点顶部**：从 widget 列表末尾那整行，移到 `加载模式` 的 `UNet / Checkpoint`
  胶囊**正下方、左半边**，缩成一个小胶囊（左写「广播」，右侧是开关轨道）
  - 尺寸与胶囊对齐：**宽度 = 胶囊的一半**，**高度与胶囊完全相同**（都是 14px，上下边沿齐平）
  - 外观与节点其它控件同语言：淡色托底 + 细轨道 + 白滑块，开启时转高亮蓝（和 `UNet` 选中态呼应），
    鼠标悬停时托底提亮并浮出一道细描边
  - 改法是「原生 toggle 保留但隐藏 + 自绘」：widget 对象、名字、`properties` 存储、`serialize:false`
    全部原样不动 —— `widgets_values` 一项都不动，旧工作流零影响
  - 顺带节点底部少了一整行，只剩「添加 / 移除 LoRA」两个按钮
  - 纯前端改动，**不用重启 ComfyUI**，`Ctrl+F5` 即可
- **修复画布拖框「框不在鼠标那里」**：ComfyUI 1.57.x 会把选择框裁剪到 `.graph-canvas-panel`
  （实测该容器只覆盖画布中下部 `[64,488,...]`），在画布上半部分拖框时框的顶边被强行压到 488、
  高度被压成 0，看起来像「鼠标在左上角拉、框跑到中间」。新增 `js/selection_rect_fix.js`
  按真实鼠标点重写框的位置，纯显示层修正，不改画布状态
  - 关闭方法：控制台 `localStorage.setItem("tp_selrect_fix", "off")` 后刷新
- **预览曲线改为从节点背后穿过**：曲线画在背景层（节点下层），节点之间的空白处正常显示，
  穿过节点的地方被节点自然遮住 —— 不会再盖住节点标题和参数。节点排得密时可见部分会少一些，属正常

### 2026-10-23

- **新增 `ToggleUnifiedLoader` 的「全局广播」开关**（节点自带，不依赖 `cg-use-everywhere`）
  - 打开后点「运行」自动把 `MODEL` / `CLIP` / `VAE` 接到图里所有**空着的**同类型输入上，
    提交完立刻拆线，不会被存进工作流
  - 开关打开期间，画布上用**紫色曲线**画出「运行时会自动接上的线」，两端带小圆点，
    方便一眼核对接去哪（曲线只是预览，不建真实连线、不参与保存）
  - 曲线从节点**背后**穿过（画在节点下层）：空白处可见，节点上一根线都不落 —— 不挡标题和参数
  - 只补空位，手连的一根都不动；关掉就是完全手动
  - 开关状态存在节点 `properties` 里，**不占 `widgets_values`**，旧工作流参数位置一项不变
  - 与 `cg-use-everywhere` 共存（不动它的 `ue_convert`）
  - 纯前端改动，**不用重启 ComfyUI**，`Ctrl+F5` 即可
- **`采样器（一体）` 初始宽度改为 300**（高度不变），「自动（按步数 + 调度器）」这类长值不再被截断

### 2026-10-21

- **新增 `采样器（一体）`（`ToggleSampler`）** —— 把官方「随机噪波 + CFG引导器 + K采样器选择 +
  基础调度器/手动Sigmas → SamplerCustomAdvanced」四件套收进一个节点。
  - 模型 / 条件 / Latent 仍是插槽，换模型不用换节点
  - `采样方案` 三档：`自动`（= 官方 BasicScheduler，数值等价）、预置表（Qwen-Image-2.1 turbo 8步、
    LTX-2 视频 8步/3步）、`自定义表`（手填 sigma，接新模型不用改代码）
  - 选预置表时 `步数` / `调度器` 会变灰并锁住，`步数` 显示该表真实步数；切回 `自动` 自动还原你原来设的步数
  - sigma 表规则：逗号分隔、严格递减、末值必须是 0、N 个点 = N-1 步
- **新增 Krea2 支持** —— `ToggleUnifiedLoader`、`DynamicRefImageEncode`、`DynamicRefIndependent`、
  `OneImageMultiPrompt` 全都能跑 Krea2
  - 加载器从 UNet 自动识别 `Krea2` → `CLIPType.KREA2` + `Krea2TEModel`，无需手选 clip 类型
  - 三个编码节点的「模型类型」新增 `Krea2`：参考图按约 1 MP 编码、VAE 只吃 RGB、
    自动补视觉占位符、自动设 `reference_latents_method = index_timestep_zero`、输出全零 16 通道 latent
- **加载器改进**
  - CLIP 类型改为**由模型类推导**，不再二次读取 UNet 去猜（省一次 6.9 GB 读取，也不会再静默失败）
  - 新增 **VAE 匹配检查**：加载时比对 latent 通道 / 维度，配错直接提示该换哪个 VAE 文件
    （否则会在 `VAEDecode` 报 `IndexError: tuple index out of range`，很难自查）

### 2026-10-10

- **新增 `ToggleImageCompare` 图片对比节点** —— 把多张原图与多张结果拼成一张对比图，节点内直接预览。
  两组动态输入（原图 `source1~10`、结果 `result1~10`）各自独立增减，**N 原图 + 1 结果** 与
  **N 原图 + N 结果** 都支持；排版 `自动` 会按数量自动在「成对并排」和「上下两排」之间选，
  另有「自动网格」；可给每张图烧 `原1 / 结1` 角标。
  - **怎么用**：把原图接到 `source*`、结果接到 `result*`，输出直接给 `SaveLoadImage` 或预览节点；
    排版按**实际接上的图**算，数量变了不用改设置。
- **加载模式开关（外观与交互定型）** —— `ToggleUnifiedLoader` 的 `加载模式` 在下拉框基础上改成
  **两段式开关 `UNet | Checkpoint`**：点左半 = 分离组件、点右半 = 一体包，当前档用蓝色滑块高亮，
  另一半悬停时有淡色反馈。
  位置在**节点顶部第一行，与输出插槽 `模型 / MODEL` 同一行**；左端与下方所有下拉框的左边缘对齐，
  宽度固定、两档同宽（切档不跳动），右侧给插槽文字留出安全距离。
  - **怎么用**：直接点开关左半 / 右半切换，不再弹出下拉菜单；当前档一眼可见。
  - 底层 `加载模式` 参数照常保存与序列化，**旧工作流与 API 调用零影响** —— 开关只接管绘制与点击，
    没有新增或删除任何参数。
- **开关交互修复**：① 点击分界与绘制统一为同一套几何（此前节点较宽时点中段会切错档、点开关右侧空白会误切）；
  ② 挂在节点上的绘制 / 点击钩子改为**链式调用**，不再覆盖别的插件挂的同名钩子；
  ③ 鼠标移出开关后悬停高亮不再残留。

### 2026-10-09

- **加载模式开关上线**：`UNet`（分离组件）/ `Checkpoint`（一体包）两段切换，替代原来的下拉框。
- **模型参数置顶**：`ckpt_name` / `unet_name` / `clip_name` / `vae_name` / `clip_type` 排到参数列表最前，
  一体包模式下一眼就能看到 checkpoint 行。旧工作流加载时**按参数名自动迁移**，不受顺序变化影响。
- **LoRA 状态提示**：按钮回传每个 LoRA 实际写入的 patch 数与模块覆盖率（如 `192/224p`）；
  分体模式下还会比对 CLIP 实例类名与模型是否配套，不匹配时显示 `⚠️CLIP不符`。

### 2026-10-08

- **一体包加载模式**：`ToggleUnifiedLoader` 融合 Checkpoint 加载器，新增 `加载模式` 参数 ——
  `分离组件 (UNet+CLIP+VAE)`（默认）/ `Checkpoint 一体包`，两种模式都能挂 LoRA。
- **LoRA 强度合并为一个滑块**：`model` 与 `clip` 两个强度合并显示，CLIP 侧自动跟随 MODEL 侧 ——
  界面上看到的强度就是实际生效的强度。
- **LoRA 诊断**：按钮显示已启用的 LoRA 数量与「强度为 0」告警；控制台打印每个 LoRA 最终挂上了多少 patch。
- 修复：LoRA 组全部移除后节点自动**回收高度**（不再留一大条空框）；「- 移除 LoRA」不再把强度清成 0。

### 2026-10-03

- 修复画布菜单新建节点的落点：改为**鼠标所在位置**（原来是画布可视中心）。

### 2026-09-25

- **画布菜单入口**「🔄 Toggle-Pass」：在画布右键菜单里即可添加本插件的节点，节点列表运行时自动收集。
  - **怎么用**：画布空白处右键 → 菜单里选 `🔄 Toggle-Pass`。
- `OneImageMultiPrompt` 支持 **Qwen Image 2.1**；`prompt数量` 自动收起多余的 prompt 输入框。

### 2026-09-24

- `DynamicRefImageEncode` / `DynamicRefIndependent` 支持 **Qwen Image 2.1**。
- **分辨率控制**：新增 `宽高比` + `百万像素` + `倍数`，以及 `参考图分辨率`、`尺寸适配`。
- 修复 CLIP 类型检测（此前 Qwen Image 2.1 的专用文本编码器无法加载，参考图会被静默丢弃）。
- 界面按「模型类型」自动显隐参数；旧工作流的错位脏值自动归位；`倍数` 下限由 16 提到 32。

### 2026-05-12

- `DynamicRefImageEncode` 新增 `Qwen Layered` 模型类型：选中后显示「图层数」，输出分层 latent。
- `ToggleUnifiedLoader` 新增「- 移除 LoRA」按钮（从最后一组开始移除）。

### 2026-05-10

- 新增 **`ToggleUnifiedLoader`**（统一模型 + LoRA 加载器）：把 UNet / CLIP / VAE / 多 LoRA 整合到单一节点，
  最多 10 组 LoRA 槽位（选了才显示），支持自动检测 CLIP 类型。

### 2026-05-08

- 新增节点：`SaveLoadImage`（保存/加载切换）、`ToggleLoadImage`、`TogglePreviewImage`、`ToggleEmptyLatent`。
- 新增**隐私遮罩**（👁 / 🫣 切换，适用于图片类节点）。
- 新增 **DynamicRef 系列**：`DynamicRefIndependent`、`DynamicRefImageEncode`、`DynamicRefLatentInput`、
  `ImageBatcher`、`OneImageMultiPrompt`。

---

## 安装 / Installation

Place this folder under `ComfyUI/custom_nodes/` and restart ComfyUI.

把本文件夹放到 `ComfyUI/custom_nodes/` 目录下，重启 ComfyUI 即可。
