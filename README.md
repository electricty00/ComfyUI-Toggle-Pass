# ComfyUI-Toggle-Pass

**v1.0.0** · [English](#english) | [中文](#中文)

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
  - `fibo2` and `moss_image` are supported as well (auto-detected from the `Fibo2` / `MOSSImage` UNet class).
    Both share weight files with `krea2` (FIBO 2.0 uses the same Qwen3-VL-4B; MOSS-Image uses Qwen3.5-**9B**),
    but they tap completely different layers — a wrong type is not "slightly worse", the conditioning width
    stops matching. The loader also validates the text encoder class (`Fibo2TEModel_` / `MOSSImageTEModel_`)
    and the VAE (both use the Flux2 latent, so `flux2-vae*`, never a Qwen VAE).
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
- **The slots that will be wired get "lit up"**: those inputs are still empty (no real link), so ComfyUI
  renders them as hollow rings. While the switch is on they get a **solid dot** in the official type colour,
  matching how a manually connected slot looks — so you can see at a glance which inputs will be wired
  automatically and which are already connected. Switching it off restores the hollow look
- **The curves and their end dots both pass behind the nodes**: they are drawn on the background layer, so
  they show up in the empty space between nodes and are naturally hidden where they cross a node — including
  the half of each end dot that sits under the node edge. Titles and parameters stay readable, and nothing
  leaks out when you park a node on top of a wire as a mask
  (on a very tightly packed graph you will see less of the line, which is the intended trade-off)
  - Want the old look (dots always on top)? Run `localStorage.tp_dots_layer = "front"` in the console and reload
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
- **`latent_type`** — channels and spatial scale, must match the base model's `latent_format`:
  | Option | Channels | Scale | Models |
  |---|---|---|---|
  | `SD / SDXL（4 通道 · 8×）` | 4 | 8× | SD 1.5 / SDXL / Pony |
  | `SD3 / Flux / Krea 2（16 通道 · 8×）` | 16 | 8× | SD3, Flux.1, **Krea 2** (Wan21 format, `latent_dimensions=3`) |
  | `Qwen-Image 2.1（64 通道 · 16×）` | 64 | 16× | Qwen-Image 2.1 |
  | `Flux2（128 通道 · 16×）` | 128 | 16× | FLUX.2 |

  Default is `SD / SDXL` so existing workflows keep their old behaviour. Picking the wrong
  row does **not** raise an error — KSampler's `fix_empty_latent_channels` silently pads the
  channels when the latent is all zeros, but any node that consumes the latent directly
  (without going through a sampler) will get the wrong shape. With the matching row the
  output is byte-identical to the official `EmptySD3LatentImage` (verified: same shape,
  dtype, `downscale_ratio_spacial`, tensor diff = 0).

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

**Model type**: `Flux2` / `Qwen Layered` / `Qwen Image 2.1` / `SD / SDXL / Z-Image`
- Selecting `Qwen Image 2.1` reveals its own parameter group (see [Qwen Image 2.1](#qwen-image-21-support))
- Selecting `Qwen Layered` reveals `layers`; latent output is layered (`[1, 16, layers+1, h/8, w/8]`)
- Selecting `Flux2` / `SD / SDXL / Z-Image` only shows the classic `输出宽度/高度` (old behaviour, unchanged)

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
**Outputs**: `CONDITIONING`, `LATENT`, `NEGATIVE` (all images share the same conditioning, latents output separately).
The second output is a ready-made **empty-text negative** encoded from the same CLIP — wire it into the
sampler's negative input. Use it instead of `ConditioningZeroOut` on the positive conditioning: at
CFG = 1.0 both look identical, but as soon as CFG > 1 the zeroed version corrupts the whole frame.
This output exists only on `Ref Image Encode`; for `Ref Independent` / `OneImageMultiPrompt`
with CFG > 1, wire a plain empty `CLIPTextEncode` into the negative input.

**Model type**: `Flux2` / `Qwen Layered` / `Qwen Image 2.1` / `SD / SDXL / Z-Image` / `Krea2`
- `Qwen Layered`: Adds a `layers` parameter; latent output is a layered latent (`[1, 16, layers+1, h/8, w/8]`), directly connectable to Ksampler's latent input (replaces `EmptyQwenImageLayeredLatentImage`)
- `Qwen Image 2.1`: Adds its own parameter group for editing + resolution control (see below)
- `SD / SDXL / Z-Image`: Generic fallback — emits a 4-channel all-zero latent, which core
  `fix_empty_latent_channels` pads to whatever channel count the model needs. **This is the correct
  setting for text-to-image-only models such as Z-Image** (see [Z-Image usage](#z-image-usage)).
  For those models leave every `imageN` input empty — they have no reference-image path and will
  output a blocky mosaic if you connect one.
- `Krea2`: Wan21 latent (16 channels / 8x, `qwen_image_vae`). References go to `reference_latents` only,
  the sampling start is an all-zero latent, and `reference_latents_method=index` is set automatically
  (without it the references are silently ignored). **Deliberately not `index_timestep_zero`** — that
  gives the reference tokens their own t=0 adaLN modulation, which does not match how the krea2_edit
  LoRAs were trained (one shared tvec for the whole sequence). Measured: with `index_timestep_zero` a
  line-art reference gets *drawn into* the frame (contour lines on the face); with `index` it is clean.
  Reference latents are also fitted to the output grid — see the Krea 2 section below.
- **For `MOSS-Image` / `FIBO 2.0`, pick `Flux2`** — all three share the same latent (128 channels / 16x, `flux2-vae`).
  Measured: feeding the pose sheet as a second image does re-pose the subject (MOSS 16.7 s / FIBO 10.6 s,
  no sketch figure left in the frame). What this node does **not** give you is MOSS's `edit_format`
  (three training layouts that must match the LoRA) / `image_strength`, or FIBO's `negative_prompt`.
  For those, use the native encoders `TextEncodeMOSSImageEdit` / `TextEncodeFibo2` instead —
  they take AUTOGROW image inputs, so this node's output still plugs straight in.
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
- `模型类型` — `Flux2` / `Qwen Image 2.1` / `SD / SDXL / Z-Image` / `Krea2`. Selecting `Qwen Image 2.1` adds the
  full resolution parameter group, so one photo can be rendered from multiple viewpoints / edits at once.

**Outputs**: `cond_1` ~ `cond_8`, `latent`

---

#### ToggleSampler — All-in-one Sampler (采样器（一体）)

Collapses the official four-node chain into a single node:

```
RandomNoise + CFGGuider + KSamplerSelect + (BasicScheduler | ManualSigmas)  ->  SamplerCustomAdvanced
```

**Inputs**: `模型` (MODEL), `正面条件` / `负面条件` (CONDITIONING), `Latent图像` (LATENT)
**Parameters** (in on-node order): `⚡预设`, `Sigma 曲线`, `采样器`, `调度器`, `步数`, `CFG`, `降噪`, `噪波随机种`, `自定义Sigma表`
**Outputs**: `Latent`, `降噪Latent`

> Display label and internal name are deliberately separate: `⚡预设` is internally `模型预设`, and
> `Sigma 曲线` is internally `采样方案`. Only the label is changed — `widgets_values_named` and the
> `/prompt` `inputs` are keyed by name, so renaming the name would orphan every saved workflow.

Model / conditioning / latent stay as **sockets on purpose** — the only thing that really differs
between models is the sigma curve, so switching models never needs a new node. `Sigma 曲线` (internal
name `采样方案`) comes in three flavours:

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

#### ⚡预设 (fill in the usual numbers in one click)

The `⚡预设` dropdown at the **top** of the node is a **one-shot filler**: pick a model and it sets
`Sigma 曲线 / 采样器 / 调度器 / 步数 / CFG` in one go. `降噪` and `噪波随机种` are left alone
(they depend on the task, not the model).

It sits at the top because that is the real order of use — pick the model, then fine-tune. The two
dropdowns also used to be easy to mistake for duplicates, so they are named apart now: `⚡预设` covers
a whole parameter set, `Sigma 曲线` only the noise trajectory.

| Preset | Sigma curve | Sampler | Scheduler | Steps | CFG |
|---|---|---|---|---|---|
| Qwen-Image 2.1 (25 steps) | auto | euler | simple | 25 | 1.0 |
| Qwen-Image 2.1 turbo (8 steps, fixed table) | preset table | euler | simple | 8 | 1.0 |
| Krea 2 turbo (8 steps) | auto | euler | simple | 8 | 1.0 |
| Krea 2 turbo · detail (12 steps) | auto | euler | simple | 12 | 1.0 |
| FLUX.2 klein (4 steps · beta) | auto | euler | beta | 4 | 1.0 |
| FLUX.2 klein · upscale refine (4 steps) | auto | euler_ancestral | simple | 4 | 1.0 |
| Z-Image turbo (8 steps) | auto | euler_ancestral | simple | 8 | 1.0 |
| Qwen-Image Layered (9 steps · CFG 2.5) | auto | euler | simple | 9 | 2.5 |
| Qwen-Image Edit 2511 AIO (4 steps) | auto | euler_ancestral | beta | 4 | 1.0 |
| FIBO 2.0 turbo (4 steps) | auto | euler | simple | 4 | 1.0 |
| MOSS-Image (30 steps · CFG 4) | auto | euler | normal | 30 | 4.0 |
| Manual (off) | — | — | — | — | — |

It **fills once, it does not lock**: touch any of those five parameters afterwards and the dropdown
falls back to `手动（不套用）` by itself. The control therefore always reflects the truth — you will
never see "Qwen preset" selected while the node is actually running 40 steps.

The table lives only in `MODEL_PRESETS` inside `sampler.py`; the frontend fetches it from
`GET /toggle_pass/sampler_presets` and keeps **no second copy**, so adding a model touches one file.
When renaming an entry, add an "old → new" pair to `PRESET_ALIASES`, otherwise workflows saved with
the old value show a blank dropdown.

Every row was taken from a workflow that actually runs on this machine (the source file is noted in
the `sampler.py` comments next to each entry) — run it once before changing a number.

---

<a id="pose-reference"></a>
### Pose Reference

`PoseReference` (参考姿势) picks one pose sheet out of a local library and hands it to any editing
model's image input as a plain `IMAGE` — no ControlNet, no extra model.

**Library layout** — the node merges up to three roots and de-duplicates by name. Earlier roots win,
so a sheet of yours with the same name overrides the bundled copy:

| Order | Root | Notes |
|---|---|---|
| 1 | `$TP_POSE_ROOT` | only if you set it; point it at your own collection |
| 2 | `ComfyUI/models/pose_reference/` | recommended home for private sheets — travels with your `models` backup |
| 3 | `custom_nodes/ComfyUI-Toggle-Pass/pose_assets/` | bundled, ships with the plugin |

Every root uses the same layout:

```
<root>\
├─ 01_AI线稿姿势\           lineart set
│  └─ <category>\<group>\<P###_name>\<P###_view>.webp
└─ 02_AI深度姿势库\         depth set (same paths, same filenames)
```

The two sets are path-for-path identical, so the node indexes one and resolves the other by the
`source` switch. Drop a new folder in and it shows up in the dropdowns within ~15 seconds — no restart,
no page refresh.

**Inputs**

| Name | What |
|---|---|
| `category` | 上半身单人 / 全身单人・标准系 / 全身单人・性感系 / 双人缠绵 |
| `group` | pose group, e.g. 站姿 / 坐姿 / 蹲姿 (30 in total) |
| `pose` | `P###_名称`, 288 in total. P-numbers repeat across categories, so the full folder name is the key |
| `view` | 正面 / 侧面 / 斜侧 / 俯视 / 仰视 |
| `source` | `线稿` (default) or `深度` |
| `long_edge` | output long edge, default 1024 — the source sheets are only 300×400. The result is down-aligned to a multiple of 16 (VAE requirement), so the real long edge can be up to 15 px smaller |
| `flip` | mirror horizontally, so you do not need a second sheet for the mirrored pose |

The first three dropdowns cascade: picking a category narrows `group`, picking a group narrows `pose`.
**Changing any dropdown repaints the node in place** — the thumbnail of the selected sheet appears right
below the widgets, no prompt needs to be queued. The node grows itself on first load to make room;
drag its lower-right corner if you want the picture bigger.

**Wiring**

```
[Pose Reference] ──image──▶ [TextEncodeQwenImage21] .images ─┐
                                                             ├─▶ KSampler ─▶ VAEDecode ─▶ SaveImage
[UNet loader]  [CLIP loader]  [VAE loader] ──────────────────┘
```

1. Double-click the canvas and search `Pose Reference` (category `Toggle-Pass`).
2. Pick 类别 → 姿势组 → 姿势 → 视角. The sheet shows up on the node as you click.
3. Wire `image` into the `images` input of your edit encoder (`TextEncodeQwenImage21`,
   `TextEncodeFibo2`, …). The rest of the graph is your usual txt2img / edit graph.
4. `长边` sets the resolution fed to the encoder — 1024 is plenty, the sheets are only 300×400. The output is aligned down to a multiple of 16 so `VAEEncode` never has to pad or crop it (a half-pixel shift is very visible on line art).
5. Set `翻转` to `开` when you need the mirrored version of the same pose.

**⚠️ Editing models (2511 / FLUX.2 / MOSS-Image / FIBO 2.0) need two images**

Wiring a single sheet into these models **runs fine and produces an image, but the pose never changes**.
This is not a compatibility problem, it is semantics: the model treats `image1` of the edit encoder as
"the picture to be modified", so a lineart sheet in `image1` degrades the task into "redraw this lineart
photorealistically" and nothing in the prompt can bring the original subject back.

Use multi-image editing instead: the **source photo goes to `image1`**, the **pose sheet goes to `image2`**.

```
[Load Image] ────image───▶ .image1 ┐
                                   ├─▶ [TextEncodeQwenImageEditPlus] ─▶ KSampler
[Pose Reference] ─image──▶ .image2 ┘   prompt: keep the subject and outfit of image1,
                                                change the pose to the one in image2
```

`image1 / image2 / image3` on `TextEncodeQwenImageEditPlus` are all plain `IMAGE` inputs, so the node
drops straight in with no converter. Verified on both 2511 and FLUX.2 — the subject is re-posed from
the `image2` skeleton.

MOSS-Image and FIBO 2.0 work the same way, only the slots are the auto-growing
`image_0/image_1` (MOSS) and `image_1/image_2` (FIBO):

```
[Load Image] ────image───▶ .image_0 ┐
                                    ├─▶ TextEncodeMOSSImageEdit ─▶ KSampler
[Pose Reference] ─image──▶ .image_1 ┘   edit_format must match the edit LoRA's training format
```

Measured: both turn a standing photo into the seated pose of the sheet (MOSS 20.2 s, FIBO 16.1 s)
while keeping face, hair, outfit and background. ⚠️ MOSS only edits when
`moss_image_edit_lora_bf16` is loaded — without it you get the SFT base and the instruction barely moves.

**Krea 2 — our own nodes can do it; two external packs exist if you need them**

**Start here: no external pack required.** `Ref Image Encode` with `模型类型 = Krea2` reproduces what
`ComfyUI-krea2Edit` does with two nodes, because ComfyUI's native krea2 `_forward` *already has* the
in-context reference path (`ref_latents` → clean tokens at frame 1..N, target at frame 0) that
`Krea2EditModelPatch` rebuilds by hand. Two conditions must hold, and the node now handles both:

1. `reference_latents_method = index` — **not** `index_timestep_zero` (that splits the adaLN
   modulation into two timesteps and the reference gets traced into the frame).
2. Every reference latent is fitted to the output grid before VAE encoding — `h/w` identical to the
   sampling start, so the RoPE positions differ only on the frame axis.

```
[Pose Reference] ─image─▶ .image1 ┐
                                  ├─▶ Ref Image Encode (模型类型 = Krea2) ─cond─▶ ToggleSampler ─▶ VAEDecode
[Load Image] ────image─▶ .image2 ┘                              └latent (all-zero, 16 ch) ┘
prompt: the woman from image 2, kneeling upright leaning back, chest lifted, back arched,
        both hands reaching down and back to touch her heels, three-quarter rear-side view;
        keep face / hair / outfit / background — see the warning below, do NOT shorten this
```

It also has a dedicated `negative` output (empty-text encode from the same CLIP) — wire that into the
sampler's negative input, so raising CFG later never corrupts the frame.

⚠️ **Order is a hard convention: the LAST reference is the subject.** Sheet in `image1`, photo in
`image2`. Swapped, the model renders a line-art mannequin (measured) — the sheet is treated as the
thing to draw rather than the condition. Measured 8 steps at 720×1440: 70 s, seated pose, clean frame,
likeness kept, no external nodes.

⚠️⚠️ **The prompt must describe the pose concretely — this is the easiest trap.**
A vague line like `图二美女参考图一的姿势，重新摆pose` ("the girl in image 2, follow the pose in
image 1, re-pose") does not make the model *read* the sheet. Measured with identical parameters and
seed: it treats the mannequin as a **second subject** and outputs a side-by-side collage of
"real person on the left + line-art mannequin on the right". The pose does not move at all.

Same pose (P068 kneeling, leaning back, hands to heels, three-quarter view), three prompts:

| Prompt | Result |
| --- | --- |
| `图二美女参考图一的姿势，重新摆pose` | ❌ person + mannequin collage, pose unchanged |
| `让图二中的女人摆出图一那个姿势：跪立、身体向后仰、胸部抬起、背部拱起，双手向后下方伸去触摸脚跟，头部微微后仰，采用四分之三侧后方视角。保持她的脸、发型、深蓝色泳装和海滩背景不变。` | ✅ single subject, pose correct |
| Same in English | ✅ single subject, pose correct (hands slightly closer to the heels) |

Three mandatory parts:
1. **Name the subject** — "the woman from image 2", not "image 2's beauty"
2. **Anatomically describe the pose** — torso direction, where each limb goes, where the hands land,
   head tilt, camera angle. "Follow the pose in image 1" alone conveys nothing
3. **List what must stay** — face, hair, outfit, background, item by item

Chinese works fine; you do not have to write English. The point is specificity, not language.

⚠️ Use `DynamicRefImageEncode` (`Ref Image Encode`), not `DynamicRefIndependent`: the latter encodes
each image into its **own** conditioning (that is the design for Qwen 2.1's per-image index planes),
and merging those does not give Krea2 one coherent reference sequence — measured line-art bleed plus a
wrong pose.

**If you do reach for an external pack**, these two are mutually incompatible with each other and with
the two-input semantics above. Mixing them up gives "no error, but the line art gets painted into the
picture" — a wasted run:

| Node pack | Encoder | Patch node | Where the pose sheet goes | Result |
| --- | --- | --- | --- | --- |
| `ComfyUI-Krea2-Ostris-Edit` | `TextEncodeKrea2OstrisEdit` | `Krea2OstrisEditModelPatch` | `image2` (with `image1` = photo) | ✅ skeleton-driven, no line art bleed |
| `ComfyUI-krea2Edit` | `Krea2EditGroundedEncode` | `Krea2EditModelPatch` | `image_b` + `source_latent_b` | ❌ the sheet is treated as a *second subject* and rendered |

**The Ostris pack is the one that takes a skeleton:**

```
[Load Image] ─image─▶ [FluxKontextImageScale] ─▶ .image1 ┐
                                                         ├─▶ TextEncodeKrea2OstrisEdit ─┐
[Pose Reference] ─image─▶ [FluxKontextImageScale] ─▶ .image2 ┘  (one encoder each, pos/neg) │
                                                                                            ▼
[Load Diffusion Model] ─▶ [Krea2OstrisEditModelPatch] ─▶ [Load LoRA] ─▶ KSampler (8 steps, euler/simple, CFG 1)
```

`image1 / image2 / image3` are plain `IMAGE`, so the pose output drops straight into `image2`.
Measured with `krea_outfittransfer` + `kv_cache` on, same beach photo and sheet `P017`: 8 steps in
36.1 s, seated on the sand, **no line art left in frame**, face / hair / swimsuit / background intact.

⚠️ Three things that have to match:
1. **`kv_cache` must match how the LoRA was trained.** LoRAs trained with ai-toolkit's `kv_cache`
   kwarg (e.g. `krea_outfittransfer`) need it on; normally trained edit LoRAs drift when it is on.
2. **The LoRA must match the node pack.** Feeding `krea2_identity_edit_v2` (a krea2Edit-weight) into
   the Ostris nodes also bleeds the sheet into the image — measured; the two use different geometry.
3. **Wrap both conditionings in `FluxKontextMultiReferenceLatentMethod`** (`index_timestep_zero`),
   as the official workflow does.

With only krea2Edit-family LoRAs you can still change the pose, but **by prompt only** — no skeleton image:

```
[Load Image] ─▶ source_latent / image ─▶ Krea2EditModelPatch ─▶ KSampler (8 steps, euler/simple, CFG 1)
prompt: have her sit on the sand, chest lifted and leaning back, hands braced beside her hips
```

Measured: `krea2_identity_edit_v2` took that prompt and turned the standing photo into a seated one,
but wiring the sheet into `image_b` renders the mannequin too. So: **need a skeleton → Ostris pack;
only krea2Edit weights → describe the pose in words.**

**Can krea2Edit take a skeleton at all? Four wirings tested, none of them works**

| Wiring | Pose follows the sheet? | Clean frame? |
|---|---|---|
| Sheet → `image_b` (+ `source_latent_b`) | yes | ❌ a white mannequin / transparent wireframe gets rendered into the shot, worse as `ref_boost` rises |
| `source_latent_b` only (no `image_b`, the TE never sees it) | ❌ no effect at all | yes |
| Sheet as the **main** image, photo as `image_b` (swapped roles) | yes | ❌ outline lines stay on the body |
| Convert the sheet to a **grey silhouette** (PIL) then feed `image_b` | ❌ pose unchanged | yes |

Rows 2 and 4 were control experiments — the pose sentence was deleted from the prompt entirely,
and the output stayed in the photo's standing pose, proving all pose change came from the prompt
and not from the skeleton. Row 4 only fixes the dirty frame, not the driving.

**The likeness difference is measured**: same source photo, same pose target —
`krea2Edit + krea2_identity_edit_v2` keeps the **same face**, while
`Ostris + krea_outfittransfer` clearly swaps the person (that LoRA is for outfit transfer).
So they are not interchangeable:

- **Both at once** — identity kept *and* the pose driven by a sheet → `Ref Image Encode`
  (`模型类型 = Krea2`) exactly as shown at the top of this section. No external pack, no second pass.
- **Identity preserved**, text-only edit (restage, outfit change, local edit) → this plugin's Krea2 path
  or `krea2Edit` + describe the pose in words; both keep the face
- **Hardest possible skeleton lock**, and you can trade likeness → the `Ostris` pack
- Only if you already work in the krea2Edit pack and cannot switch → Ostris for the pose, then one
  `krea2Edit` pass to recover the face

⚠️ `ref_boost` / `grounding_px` are not "higher is better": `ref_boost=1.3` with `grounding_px=1024`
actually replaced the beach background with seaside rocks. Keep 1.0 / 768 and only nudge up if the face drifts.

**Where the sheets live — three layers, merged at runtime**

| Layer | Location | Ships with the plugin |
| --- | --- | --- |
| Built-in | `custom_nodes/ComfyUI-Toggle-Pass/pose_assets/` | yes — 1,530 sheets, only the two non-sensitive categories (`上半身单人`, `全身单人・标准系`) |
| Private | `ComfyUI/models/pose_reference/` | no — recommended home for your own and private sheets; it travels with your `models` backup |
| Custom | the `TP_POSE_ROOT` env var | no — only when you keep them somewhere else entirely |

Lookup order is **`TP_POSE_ROOT` → `models/pose_reference` → built-in**, so a sheet of yours wins over
the built-in one of the same name. Installing the node is enough to browse and generate with the
built-in set; anything you drop into the private folder is picked up automatically:

- **Drop a new pose group into `models/pose_reference` and the dropdown grows within ~15 s** — no page
  reload. Deleting it makes it disappear just as fast (the node polls a cheap fingerprint of the library).
- Need it right now? Right-click the canvas → `🔄 刷新姿势素材库`.
- A root that does not exist is simply skipped: the node reports where it looked instead of failing
  silently.

**The workflow carries the sheet with it.** The selected file is inlined into the node as a data URI
(`properties.tp_pose`), so the graph is self-contained:

- Someone who downloads your workflow **sees the picture and can run it without any local library**;
- Cost is roughly **+8–14 KB per node** (the sheets are 300×400 webp, 5–10 KB each);
- When a local library exists it always wins — the inlined copy is only a fallback;
- If the parameters were changed while the library was missing, the node keeps showing the inlined
  sheet and says so, rather than going blank.

**Output**: `image` (`IMAGE`) — connect straight to the `images` input of `TextEncodeQwenImage21`,
`TextEncodeFibo2`, or any other edit encoder.

A ready-made graph ships as `example_workflows/Pose Reference Editing.json` (Qwen-Image-2.1 turbo,
8 steps). **It carries the selected sheet inside the node** (`properties.tp_pose`, a ~8 KB data URI),
so it opens and generates even on a machine that has no pose library at all. Together with the built-in
`pose_assets/`, a fresh install can browse 153 sheets across 12 groups out of the box.

**Why lineart is the default.** Measured on FIBO 2.0 and Qwen-Image-2.1, one pose, two camera angles:
the depth set fabricated footwear or pads in **3 of 3** runs, the lineart set in **1 of 3**. A depth map
has no boundary line — the sole and the floor sit at nearly the same brightness, so the model fills the
bright area in with an object that is not there. Lineart carries an explicit black contour, and
`lineart → photoreal` is a transform these models saw in training. Depth keeps one advantage: volume,
which disambiguates occlusion when limbs overlap. Switch to it only for tightly intertwined poses.

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

✅ **The negative is already solved — `Ref Image Encode` has a dedicated `negative` output.**
Wire it straight into the sampler's negative input. It is a real empty-text encode from the same CLIP,
so it stays correct at **any** CFG (verified pixel-identical to a plain empty `CLIPTextEncode`).

⚠️ Do **not** zero out the positive conditioning with `ConditioningZeroOut` and use that as the
negative. At CFG = 1.0 the negative is never evaluated, so it looks harmless; raise CFG and the frame
comes out **fully corrupted** (measured: green/purple blotches at 20 steps / CFG 2.5, both fp8 and
int8). Older builds of this node only had two outputs and the example workflow used
`ConditioningZeroOut` — that is exactly what bit people.

**For pose editing, add `VNCCS_QI2_PoseStudioV2`** (`models/loras/Qwen/`, 152 MB, ai-toolkit,
base = `qwen_image_2`; `LoraLoaderModelOnly` is enough — pure `diffusion_model` keys).
Same prompt, across the Qwen 2.1 LoRAs on this machine:

| LoRA | Result |
| --- | --- |
| bare model | works, 15 s at 8 steps |
| `VNCCS_QI2_PoseStudioV2` | ✅ **best**: pose tracked most accurately, richest detail, no line-art bleed |
| `QI2.1_AnyAngle` | ❌ line-art bleed on face/neck (reference gets painted into frame) |
| `qwen_image_2.1_turbo_lora_avg_rank_178` | usable but skin texture degrades; little pose help |

Two verified setups:
- **turbo int8 + 8 steps + CFG 1.0** → 16.7 s, fast, good enough
- **`qwen-image-2.1-UC-fp8` + 20 steps + CFG 2.5** → 43.9 s, full body, best detail (empty-text negative)

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

- **Reference latent size = output size.** References are centre-cropped to the output aspect ratio and
  resized to the exact output pixel grid *before* VAE encoding, so the reference latent matches the
  sampling start dimension-for-dimension and the RoPE positions differ only on the frame axis — which is
  the geometry the krea2_edit LoRAs were trained on. The vision tower still gets a ~384 px thumbnail.
- **The VAE only takes RGB** — alpha is dropped, not composited.
- **Vision placeholders must be written by hand.** With an explicit `llama_template` the Qwen3-VL
  tokenizer does *not* auto-insert them, so the node emits
  `Picture N: <|vision_start|><|image_pad|><|vision_end|>`. Without it the reference image is
  completely invisible to the model.
- **`reference_latents_method` is mandatory, and it must be `index`.** Krea2's `default_ref_method` is
  `None`, so references are *silently ignored* unless the method is set. `index_timestep_zero` runs but
  is wrong for krea2_edit LoRAs: it splits the adaLN modulation into two timesteps (target = current t,
  references = t=0) while training used a single shared tvec — a line-art reference then gets traced
  into the frame. `index` keeps one tvec for the whole sequence and is the one that matches training.
- **The latent output is all-zero** (16 ch / 8x) — same "editing, not img2img" rule as 2.1.
- **Sigma curve:** Krea2 turbo uses the `自动（按步数 + 调度器）` scheme in `采样器（一体）`.
  The `Qwen-Image-2.1 turbo 8步` table is *not* interchangeable with it.

---

<a id="moss-fibo-support"></a>
### MOSS-Image / FIBO 2.0 Support

`ToggleUnifiedLoader` picks both up automatically — `clip_type` now offers `moss_image` and `fibo2`
directly (`auto` also detects them from the UNet). Both are **Flux2-latent** models
(128 channels / 16x, `flux2-vae`), which is why `Ref Image Encode` needs **no extra model type:
just pick `Flux2`**.

Measured with the pose sheet as the second image (standing beach photo → seated sheet):

| Model | Native encoder | `Ref Image Encode` (Flux2) |
|---|---|---|
| MOSS-Image, 20 steps / CFG 4 | 19.6 s — seated, hands on the sand | 16.7 s — seated ✅ |
| FIBO 2.0, 4 steps / CFG 1 | 15.4 s — kneeling | 10.6 s — kneeling ✅ |

No sketch figure leaked into either frame. What you give up by not using the native encoders:

- **MOSS `edit_format`** — the reference method must match how the edit LoRA was trained
  (`ai-toolkit` → `index_timestep_zero_isolated`, `ai-toolkit (kv_cache off)` → `index_timestep_zero`,
  `Moss-Image-Edit` → `index_timestep_zero_text_start`). Picking the wrong one runs fine but edits
  nothing. `Ref Image Encode` sets no method at all.
- **MOSS `image_strength`** and **FIBO `negative_prompt`** — neither is exposed there.
- Both native encoders take **AUTOGROW** image inputs, so a node output still plugs straight in:
  `TextEncodeMOSSImageEdit` → `images.image_0 / image_1 …`, `TextEncodeFibo2` → `images.image_1 … image_16`.

⚠️ `TextEncodeMOSSImageEdit` has a **single** conditioning output — encode the positive and the
negative with two separate nodes (the official template does exactly that). Writing `["node", 1]`
throws `list index out of range`, and the error points at the sampler rather than at the encoder.

Sampler presets: `MOSS-Image（30步·CFG4）` and `FIBO 2.0 turbo（4步）`.

---

<a id="model-type-cheatsheet"></a>
### Which dropdown do I pick? (`模型类型` vs `clip_type`)

Two dropdowns look like they mean the same thing but are not:

- **`模型类型`** lives on the reference-image encoders. It only decides **which latent shape comes out**
  (and, for Krea 2, which `reference_latents_method` is used).
- **`clip_type`** lives on `Toggle Unified Loader`. It decides **how the text encoder is built**.

Getting either one wrong usually fails silently (wrong channel count, wrong conditioning width, or a
clean-looking image with the prompt ignored).

| Loading | `模型类型` (encoder) | `clip_type` (Unified Loader) | VAE |
|---|---|---|---|
| Qwen-Image **Layered** | `Qwen Layered` (+ `图层数`) | `qwen_image` | `qwen_image_layered_vae.safetensors` |
| Qwen-Image **2.1** | `Qwen Image 2.1` | `qwen_image` | `qwen_image_2.1_vae_bf16.safetensors` |
| **Krea 2** | `Krea2` | `krea2` | `qwen_image_vae.safetensors` |
| **FLUX.2 / MOSS-Image / FIBO 2.0** | `Flux2` | `flux2` / `moss_image` / `fibo2` | `flux2-vae.safetensors` |
| **Z-Image** | `SD / SDXL / Z-Image` | `stable_diffusion` (or `auto`) — **never `flux` / `flux2`** | `ae.safetensors` |
| **SD 1.5 / SDXL / Pony** | `SD / SDXL / Z-Image` | `stable_diffusion` | the checkpoint's own VAE |

`SD / SDXL / Z-Image` is the *generic* slot on purpose: whenever the encoder takes an image anyway the
latent comes from `ref_latents[0]`, so this setting behaves the same for SD, SDXL, Pony, Z-Image and
Qwen-Image 1.0. It only means something ("4-channel all-zero latent") when nothing is connected.

**Qwen-Image Layered specifics** (read off the official `image_qwen_image_layered.json`):

- Text encoder is `qwen_2.5_vl_7b_fp8_scaled` — the **same** encoder as Qwen-Image 1.0 ⇒ `clip_type` = `qwen_image`
- VAE is **`qwen_image_layered_vae`**, not `qwen_image_vae`. Both are 16-channel, so a mismatch is
  invisible until `VAEDecode`
- Latent is 5-D: `[B, 16, layers+1, h/8, w/8]` — exactly what `模型类型 = Qwen Layered` emits,
  i.e. it replaces the official `EmptyQwenImageLayeredLatentImage`
- The bundled template actually runs **20 steps / CFG 2.5 / euler / simple / denoise 1** at 640 px with
  `layers = 2`; its on-canvas note says the *original* settings were 50 steps / CFG 4.0 (even slower).
- Two variants ship: one starts from `EmptyQwenImageLayeredLatentImage`, the other from `VAE Encode(photo)`.
  Both use `denoise 1`, so the start latent gets overwritten either way — what actually changes the
  result is the `layers` count (latent dim 2 = `layers + 1`). **Only** when you want partial-denoise
  refinement does the start latent matter, and then the encoder's all-zero latent is not what you want.

**Z-Image warning:** do **not** set `clip_type` to `flux` / `flux2`. Z-Image's TE is Qwen3-4B, and
`comfy/sd.py` routes Qwen3-4B to the Flux encoder when `clip_type` is FLUX/FLUX2 — you get a different
TE class and the prompt is encoded wrong, with no error.

Measured 2026-11-06 (same Z-Image unet, same `qwen_3_4b` + `ae`, only `clip_type` changed):

| `clip_type` | text encoder actually built | |
|---|---|---|
| `stable_diffusion` | `ZImageTEModel_` | ✅ recommended |
| `auto` | `ZImageTEModel_` | ✅ (detects the class as `Lumina2`) |
| `qwen_image` | `ZImageTEModel_` | ⚠️ works by luck — Qwen3-4B is dispatched by TE type, not by this value |
| `flux` | `Flux2TEModel_` | ❌ wrong encoder class, silently bad prompt encoding |

So `qwen_image` will *not* break Z-Image, but pick `stable_diffusion` (or `auto`) so the setting means
what it says.

<a id="auto-clip-type-en"></a>
### Is `clip_type = auto` reliable?

**All 5 local models verified correct by real loading; 106 of 108 model classes agree in a static sweep.**
`auto` does not guess:

1. It **actually loads the UNet** (not a header sniff) and reads the real class name — Qwen-Layered
   comes out as `QwenImage`, Z-Image as its parent class `Lumina2`;
2. It resolves `CLIPType` in three layers — **exact table → MRO (base classes) → prefix rules**:
   - the exact table only lists models where `clip_type` **actually changes the outcome** (table below);
   - MRO catches subclasses: `FluxSchnell → Flux`, `KOALA_1B → SDXL`, `ZImagePixelSpace → ZImage`;
   - prefix rules catch variants: `WAN21_I2V` / `WAN22_S2V` / `WAN_Animate2` … 16 WAN classes → `wan` (2 more are in the exact table);
3. Anything left falls back to `stable_diffusion` — **which is not a wrong guess**, because for that
   third of the model set ComfyUI never looks at `clip_type` (the TE weights themselves already
   determine which encoder gets built).

**`clip_type` only matters when one TE weight file can go several ways.** Reading
`load_text_encoder_state_dicts` in `comfy/sd.py`, only these families are affected:

| TE weights | Needs `clip_type` to distinguish | What you get if it's wrong |
|---|---|---|
| T5-XXL | SD3 / LTXV / WAN / CHROMA / PIXART / COGVIDEOX / MOCHI | falls into the `else` branch → **Mochi** TE |
| Qwen3-VL-8B | QWEN_IMAGE / IDEOGRAM4 / BOOGU / JOYIMAGE | generic `Qwen3VLTEModel_`; Qwen-Image 2.1 loses `image_slots` |
| Qwen3-VL-4B | KREA2 / FIBO2 / FLUX3 / MAGE / MINIMAX | same, generic Qwen3-VL |
| Qwen3-4B | FLUX / FLUX2 | Flux-family `Flux2TEModel_` (this is the Z-Image trap) |
| CLIP-G | SD3 / STABLE_CASCADE / HIDREAM | `SDXLRefinerClipModel` |
| Qwen2.5-7B | HUNYUAN_IMAGE / LONGCAT_IMAGE | the `qwen_image` TE |

Everything else (Anima / AuraFlow / Cosmos / Lens / OmniGen2 / StableAudio / SAM / the 3D ones)
behaves identically whatever you pass, so the `auto` fallback is harmless there.

**Measured 2026-11-06 (`clip_type = auto`, real loading):**

| Model | What `auto` decided | TE actually built | |
|---|---|---|---|
| Qwen-Image Layered | exact `QwenImage` → `QWEN_IMAGE` | `QwenImageTEModel_` | ✅ |
| Z-Image | exact `Lumina2` → `STABLE_DIFFUSION` | `ZImageTEModel_` | ✅ |
| Krea2 | exact `Krea2` → `KREA2` | `Krea2TEModel_` | ✅ |
| FIBO 2.0 | exact `Fibo2` → `FIBO2` | `Fibo2TEModel_` | ✅ |
| MOSS-Image | exact `MOSSImage` → `MOSS_IMAGE` | `MOSSImageTEModel_` | ✅ |

**Second safety net: the TE is validated right after loading.** If `auto` ever decides wrong (or
upstream adds a model class), it will not fail silently — the loader asks the model itself which
encoder it wants (`model_config.clip_target()`; answerable for 106 of 108 classes) and compares that
with the class actually built:

```
[ToggleUnifiedLoader] ⚠️ CLIP 校验失败：模型是 Krea2，但文本编码器建成了 Qwen3VLTEModel_
（预期 Krea2TEModel，依据 手工表）。...
```

That check is not decoration: when `auto` gets it wrong, you see it **immediately**, instead of
discovering later that prompts "just don't work".

**When not to use `auto`:** only if you deliberately want to pair a model with a mismatched encoder
for testing. In normal use `auto` beats hand-picking, which requires memorising the six rows above.


---

<a id="z-image-usage"></a>
### Z-Image: text-to-image only — pick `SD / SDXL / Z-Image`, never connect a reference image

⚠️ Bottom line: **Z-Image has no reference-image capability. Leave `image1`–`image10` empty.**

Evidence (measured, not guessed):

- Of the five official `z_image` templates, `image_z_image` / `_int8` / `_turbo` / `_turbo_int8`
  contain **no `LoadImage` at all** — pure text-to-image. The only one taking an image,
  `image_z_image_turbo_fun_union_controlnet`, drives it through **ControlNet (Canny 0.1 / 0.32)**,
  a line-art conditioning path completely different from reference-image editing.
- Z-Image is Lumina2 / NextDiT based and was never trained on reference tokens. If you do connect
  `image1`, `reference_latents` is still injected into the conditioning, but the model has no matching
  `reference_latents_text_embeds`, and the output becomes **a full frame of blocky mosaic** —
  same result across seeds, size buckets and sampling start latents.

**Correct usage:** `模型类型` = `SD / SDXL / Z-Image`, `image1` empty.

This is not a workaround. With no reference images that branch emits a 4-channel all-zero
latent, which the core `fix_empty_latent_channels` pads to 16 channels — exactly the empty start Z-Image
needs. At a fixed seed it is pixel-identical to the native
`UNETLoader + CLIPLoader + VAELoader` graph (all four metrics equal: 51.5 / 214.5 / 46.9).

**If you want Z-Image img2img:** use the native `LoadImage → VAE Encode → sampler (denoise < 1)`
instead. Prompt and denoise control the amount of change; the photo is the starting latent.

**Reminder built in:** wire it wrong and the log says so (informational only, nothing is changed):

```
[Toggle-Pass][Ref Image Encode] ⚠️ 文本编码器 = ZImageTEModel_，已接入 1 张参考图，
但这个底座没有参考图通路。
```

Z-Image has no separate entry in the `模型类型` dropdown by design — its behaviour is identical to the
generic `SD / SDXL` one, so the two were merged into the single name `SD / SDXL / Z-Image` instead of
adding an entry that would imply "pick this one and you can attach images".

> Renamed 2026-11-06: the old value was `SD / SDXL`. Saved workflows are migrated automatically on
> load (front-end rewrites the widget value, back end also normalises the alias), so old graphs keep
> working unchanged.

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
| `Pose Reference Editing.json` | `PoseReference` feeding a Qwen-Image-2.1 turbo edit graph (8 steps). **The selected sheet is embedded in the node**, so it opens and runs with no pose library installed. | — |
| `Krea2 Pose Editing.json` | 9 nodes, **7 of them from this plugin and zero external packs**: `ToggleUnifiedLoader` (UNet + CLIP + VAE + `krea2_identity_edit_v2` LoRA in one node) + `ToggleLoadImage` + `PoseReference` → `Ref Image Encode` (`模型类型 = Krea2`; pose sheet into `image1`, photo into `image2`, latent and negative both taken from its own outputs) → `ToggleSampler` on the `Krea 2 turbo（8步）` preset → `ToggleImageCompare` / `SaveLoadImage`. Measured 8 steps / 720×1440: ~70 s, standing → seated, no line-art bleed, likeness kept. | none |
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
  - 现已支持 `fibo2` / `moss_image`（按 UNet 类名 `Fibo2` / `MOSSImage` 自动识别）。
    这两个和 `krea2` **共用同一批权重文件**（FIBO 2.0 用 Qwen3-VL-4B，MOSS-Image 用 Qwen3.5-**9B**），
    但**取层方式完全不同** —— 选错不是「效果差一点」，而是 conditioning 维度对不上。
    加载器同时校验文本编码器类名（`Fibo2TEModel_` / `MOSSImageTEModel_`）和 VAE
    （两者都走 Flux2 latent，必须用 `flux2-vae*`，不能用任何 qwen VAE）。
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
- **会被接上的槽位会「点亮」**：这些口还是空的（没有真实连线），官方按「未连接」画成空心圈，
  所以广播开着时会给它们补一个**实心点**，颜色就是该槽位类型的官方配色 —— 和手动连线后的观感一致，
  一眼就能看出「哪些口会被自动接上」、哪些本来就连好了。关掉开关就恢复空心
- **曲线和圆点都从节点背后穿过**：画在节点下层，节点之间的空白处正常显示，穿过节点的地方（含端点圆点
  被节点压住的那半边）被节点自然遮住，所以永远不会盖住节点标题和参数，也不会在你拿节点当遮罩时透出来
  （节点排得密时可见部分会少一些，这是刻意的取舍）
  - 想回到「圆点永远画在最上层」的旧观感：控制台执行 `localStorage.tp_dots_layer = "front"` 再刷新
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
- **`latent类型`** — 通道数与空间压缩比，必须和底模的 `latent_format` 对齐：
  | 选项 | 通道 | 压缩比 | 适用模型 |
  |---|---|---|---|
  | `SD / SDXL（4 通道 · 8×）` | 4 | 8× | SD 1.5 / SDXL / Pony |
  | `SD3 / Flux / Krea 2（16 通道 · 8×）` | 16 | 8× | SD3、Flux.1、**Krea 2**（走 Wan21 格式，`latent_dimensions=3`）|
  | `Qwen-Image 2.1（64 通道 · 16×）` | 64 | 16× | Qwen-Image 2.1 |
  | `Flux2（128 通道 · 16×）` | 128 | 16× | FLUX.2 |

  默认是 `SD / SDXL`，老工作流行为不变。选错**不会报错** —— K采样器发现 latent 全零时
  会用 `fix_empty_latent_channels` 悄悄补齐通道，但绕过采样器直接用 latent 的节点拿到的形状就是错的。
  选对时输出与官方 `EmptySD3LatentImage` 完全一致（实测 shape、dtype、`downscale_ratio_spacial` 全等，张量差为 0）。

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

**模型类型**：`Flux2` / `Qwen Layered` / `Qwen Image 2.1` / `SD / SDXL / Z-Image`
- 选择 `Qwen Image 2.1` 会展开 2.1 专属参数组（见 [Qwen Image 2.1 支持](#qwen-image-21-支持)）
- 选择 `Qwen Layered` 会展开「图层数」
- `SD / SDXL / Z-Image` 是通用档；**纯文生图模型（如 Z-Image）用它，且参考图槽别接**（见 [Z-Image 用法](#z-image-用法)）
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
**输出**：`CONDITIONING`, `LATENT`, `NEGATIVE`（所有图共享同一份 conditioning，分别输出 latent）。
第二个输出是**现成的空文本负条件**（用同一个 CLIP 编码），直接接采样器的「负面条件」即可。
用它替代「把正面条件 `ConditioningZeroOut` 清零当负面」：CFG=1.0 时两者完全一样，
但 CFG 一超过 1，清零版会把整张图弄花。
这个输出只在 `Ref Image Encode` 上有；`Ref Independent` / `一图多视角` 要用 CFG>1 时，
请自己接一个空文本的 `CLIPTextEncode` 到负面。

**模型类型**：`Flux2` / `Qwen Layered` / `Qwen Image 2.1` / `SD / SDXL / Z-Image` / `Krea2`
- `SD / SDXL / Z-Image`：通用档，输出 4 通道全零 latent，由官方 `fix_empty_latent_channels` 补到模型需要的
  通道数。**纯文生图模型（如 Z-Image）就用这个档，参考图槽一个都别接** —— Z-Image 没有参考图通路，
  接上必出方块马赛克，详见 [Z-Image 用法](#z-image-用法)
- `Qwen Layered`：增加「图层数」参数；输出的 latent 为分层格式（`[1, 16, layers+1, h/8, w/8]`），可直接接到 K采样器的 latent 输入（省掉 `EmptyQwenImageLayeredLatentImage` 节点）
- `Qwen Image 2.1`：增加 2.1 专属的分辨率参数组（详见下方小节）
- `Krea2`：latent 走 Wan21（16 通道 / 8x，VAE 是 `qwen_image_vae`）；参考图只进 `reference_latents`，
  采样起点是全零 latent，并自动补 `reference_latents_method=index`（不给就会被静默忽略）。
  **故意不用 `index_timestep_zero`** —— 那会给参考图单独一套 t=0 的 adaLN 调制，与 krea2_edit 系 LoRA
  的训练方式（全序列共用一个 tvec）不符。实测：用 `index_timestep_zero` 时参考线稿会被「描」进画面
  （脸上出现轮廓线），用 `index` 则干净。参考图的 latent 还会 fit 到出图网格，详见下方 Krea 2 小节
- **`MOSS-Image` / `FIBO 2.0` 请直接选 `Flux2`** —— 三者 latent 完全同族（128 通道 / 16x，都用 `flux2-vae`）。
  实测把参考姿势节点接成第二张图能正常改姿势（MOSS 16.7s / FIBO 10.6s，画面内无线稿残留）。
  但 MOSS 的 `edit_format`（三档训练格式，必须与 LoRA 配对）、`image_strength`，
  以及 FIBO 的 `negative_prompt` 本节点都不提供 —— 需要精确控制这三项时，
  请改用官方编码器 `TextEncodeMOSSImageEdit` / `TextEncodeFibo2`（它们是多图 AUTOGROW，本节点接哪个都能直接插）
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
- `模型类型` — `Flux2` / `Qwen Image 2.1` / `SD / SDXL / Z-Image` / `Krea2`。选 `Qwen Image 2.1` 会展开完整的分辨率参数组，
  适合「一张图出多个视角 / 多种编辑」。纯文生图模型（如 Z-Image）选 `SD / SDXL / Z-Image` 且不接参考图，
  见 [Z-Image 用法](#z-image-用法)。

**输出**：`cond_1` ~ `cond_8`、`latent`

---

#### ToggleSampler — 采样器（一体）

把官方四件套收进一个节点：

```
随机噪波 + CFG引导器 + K采样器选择 + (基础调度器 | 手动Sigmas)  ->  SamplerCustomAdvanced
```

**输入**：`模型`（MODEL）、`正面条件` / `负面条件`（CONDITIONING）、`Latent图像`（LATENT）
**参数**（按节点上的显示顺序）：`⚡预设`、`Sigma 曲线`、`采样器`、`调度器`、`步数`、`CFG`、`降噪`、`噪波随机种`、`自定义Sigma表`
**输出**：`Latent`、`降噪Latent`

> 控件的**显示名**和内部参数名是分开的：`⚡预设` 的内部名是 `模型预设`，`Sigma 曲线` 的内部名是
> `采样方案`。之所以只改 label 不改 name —— 存档的 `widgets_values_named` 和 `/prompt` 的 `inputs`
> 都按 name 走，改 name 等于让所有已存工作流失联。

模型 / 条件 / Latent **故意保留成插槽**——真正随模型变的只有 sigma 曲线，所以换模型不用换节点。
`Sigma 曲线` 分三类：

| 方案 | 作用 | 生效参数 |
|---|---|---|
| `自动（按步数 + 调度器）` | 现场算 sigma，与官方 `BasicScheduler` 数值完全一致 | `步数` + `调度器` |
| 预置表：`Qwen-Image-2.1 turbo 8步`、`LTX-2 视频 8步（蒸馏）`、`LTX-2 视频 3步（低噪）` | 蒸馏模型专用的固定轨迹 | 无——步数已写进表里 |
| `自定义表` | 手填一串 sigma | `自定义Sigma表` |

sigma 表规则：逗号分隔、**严格递减**、**末值必须是 0**、`N` 个点 = `N-1` 步（9 个点 = 8 步）。

选了预置表之后失效的参数会自动变灰**并锁住**：`步数` 会跳到该表真实的步数（看得见但改不动），
切回 `自动` 会还回你自己设的步数。`降噪` < 1.0 会裁掉表的尾部，所以预置表也能做低降噪细化。

蒸馏 turbo 模型推荐 `采样器` = `euler`、`CFG` = `1.0`。

#### ⚡预设（一键填好常用参数）

节点**最上面**的 `⚡预设` 是一个快捷填充：选中某个模型，它会把
`Sigma 曲线 / 采样器 / 调度器 / 步数 / CFG` 五项一次性改好，不用每次手动调。
`降噪` 和 `噪波随机种` 不归它管（那两项取决于任务，不是模型）。

放在最上面而不是最下面，是因为真实顺序就是「先定模型、再微调」；两个下拉挨着也容易
被误认为重复，所以名字也分开了：`⚡预设` 管一整套参数，`Sigma 曲线` 只管噪声轨迹。

| 预设 | Sigma 曲线 | 采样器 | 调度器 | 步数 | CFG |
|---|---|---|---|---|---|
| Qwen-Image 2.1（25步） | 自动 | euler | simple | 25 | 1.0 |
| Qwen-Image 2.1 turbo（8步·固定表） | 预置表 | euler | simple | 8 | 1.0 |
| Krea 2 turbo（8步） | 自动 | euler | simple | 8 | 1.0 |
| Krea 2 turbo・细节增强（12步） | 自动 | euler | simple | 12 | 1.0 |
| FLUX.2 klein（4步·beta） | 自动 | euler | beta | 4 | 1.0 |
| FLUX.2 klein・高清修复（4步） | 自动 | euler_ancestral | simple | 4 | 1.0 |
| Z-Image turbo（8步） | 自动 | euler_ancestral | simple | 8 | 1.0 |
| Qwen-Image Layered（9步·CFG2.5） | 自动 | euler | simple | 9 | 2.5 |
| Qwen-Image Edit 2511 AIO（4步） | 自动 | euler_ancestral | beta | 4 | 1.0 |
| FIBO 2.0 turbo（4步） | 自动 | euler | simple | 4 | 1.0 |
| MOSS-Image（30步·CFG4） | 自动 | euler | normal | 30 | 4.0 |
| 手动（不套用） | — | — | — | — | — |

**语义是「一键填充」，不是「持续锁定」**：套完预设后你手动改这五项里的任何一个，
下拉会自己退回 `手动（不套用）`——所以控件显示的永远是真实状态，
不会出现「写着 Qwen 预设、其实在跑 40 步」。

预设表只写在 `sampler.py` 的 `MODEL_PRESETS` 里，前端通过
`GET /toggle_pass/sampler_presets` 拉取，**不在 JS 里另抄一份**；加模型只改 Python 一处。
改名时请在 `PRESET_ALIASES` 里补一条「旧名 → 新名」，否则已经存过旧值的存档会显示空白。

数值全部取自本机 `user/default/workflows/` 里实际跑通的工作流（每个预设的上游文件
写在 `sampler.py` 的注释里），改之前请先跑一遍再回头调这张表。

---

<a id="pose-reference-zh"></a>
### 参考姿势（Pose Reference）

`PoseReference` 从本地姿势素材库里挑一张参考图，以普通 `IMAGE` 的形式交给任意编辑模型的图像输入——
不需要 ControlNet，也不需要额外模型。

**素材目录结构**——节点会合并最多三个根目录，按名字去重，同名以靠前的为准：

| 顺序 | 根目录 | 说明 |
|---|---|---|
| 1 | `TP_POSE_ROOT` 环境变量 | 只有你设了才生效，指向完全自定义的位置 |
| 2 | `ComfyUI/models/pose_reference/` | 推荐放自己的和私密素材——备份 `models` 时会一起带走 |
| 3 | `custom_nodes/ComfyUI-Toggle-Pass/pose_assets/` | 插件自带，随插件分发 |

每个根目录内部结构一样：

```
<根目录>\
├─ 01_AI线稿姿势\           线稿套
│  └─ <大类>\<姿势组>\<P###_名称>\<P###_视角>.webp
└─ 02_AI深度姿势库\         深度套（路径、文件名与线稿套一一对应）
```

两套完全对应，所以节点只索一套，取图时再按 `源` 决定去哪个根目录拿。
丢一个新目录进去，约 15 秒内下拉里就会自己出现——不用重启，也不用刷新页面。

**输入**

| 参数 | 说明 |
|---|---|
| `类别` | 上半身单人 / 全身单人・标准系 / 全身单人・性感系 / 双人缠绵 |
| `姿势组` | 站姿 / 坐姿 / 蹲姿 等，共 30 组 |
| `姿势` | `P###_名称`，共 288 个。编号在不同大类里会重复，所以以完整目录名为准 |
| `视角` | 正面 / 侧面 / 斜侧 / 俯视 / 仰视 |
| `源` | `线稿`（默认）或 `深度` |
| `长边` | 输出图长边，默认 1024——素材原始只有 300×400。缩放后会向下对齐到 **16 的倍数**（VAE 下采样要求），所以实际长边可能比设定值小最多 15px |
| `翻转` | 水平镜像，左右相反的姿势不用另找素材 |

前三个下拉是联动的：选了大类只列该类下的姿势组，选了组只列该组下的姿势。
**任意一个下拉一改，节点下半部分立刻重画**——选中的那张素材直接显示在参数下面，不用先执行工作流。
节点首次加载时会自动撑高给图片腾位置；想看得更大就把节点右下角往下拉。

**怎么接**

```
[参考姿势 Pose Reference] ──image──▶ [文本编码器 Qwen Image 2.1] .images ─┐
                                                                          ├─▶ K采样器 ─▶ VAE解码 ─▶ 保存图像
[UNet 加载器]  [CLIP 加载器]  [VAE 加载器] ────────────────────────────────┘
```

1. 画布空白处双击，搜 `Pose Reference`（分类 `Toggle-Pass`），或用右键菜单 新建节点 → Toggle-Pass → 参考姿势。
2. 依次选 `类别` → `姿势组` → `姿势` → `视角`，每选一次节点上的图就跟着换，选到满意为止。
3. 把 `image` 输出接到编辑编码器（`TextEncodeQwenImage21`、`TextEncodeFibo2` 等）的 `images` 输入，
   其余节点跟你平时的文生图/图编辑工作流完全一样。
4. `长边` 决定送进编码器的分辨率，1024 足够（素材本身只有 300×400）。输出会自动向下对齐到 16 的倍数，这样 `VAEEncode` 不需要自己 pad/crop——线稿对半像素位移特别敏感，错一点整个人就歪了。
5. 需要左右镜像的同一姿势，把 `翻转` 设成 `开`，不用另找素材。

**⚠️ 接「编辑模型」（2511 / FLUX.2 / MOSS-Image / FIBO 2.0）必须接两张图**

单张接法在这些模型上**不报错、能出图，但人物姿势一点都不变**——这跟兼容性无关，是语义问题：
编辑编码器的 `image1` 被模型当成「这张就是要被修改的原图」，你把线稿接到 `image1`，
任务就退化成「把这张线稿重绘成真人」，提示词里再怎么描述动作都没用。

正确画法是**多图编辑**：待修改的原图接 `image1`，参考姿势接 `image2`。

```
[加载图像] ────image───▶ .image1 ┐
                                 ├─▶ [文本编码器 Qwen Image Edit 2511] ─▶ K采样器
[参考姿势] ────image───▶ .image2 ┘       提示词：保持 image1 的人物和服装，把姿势改成 image2 的姿势
```

`TextEncodeQwenImageEditPlus` 的 `image1 / image2 / image3` 都是 `IMAGE` 类型，本节点输出可以直接接，
不用加任何转换节点。实测 2511 与 FLUX.2 在多图接法下都会按 `image2` 的骨架重摆人物。

MOSS-Image 与 FIBO 2.0 同理，只是插槽叫自动增长的 `image_0/image_1`、`image_1/image_2`：

```
[加载图像] ──▶ .image_0 ┐
                        ├─▶ TextEncodeMOSSImageEdit ─▶ K采样器
[参考姿势] ──▶ .image_1 ┘   edit_format 必须与 edit LoRA 的训练格式一致
```

实测这两个模型都能把一张站姿照片改成素材里的坐姿（MOSS 20.2s / FIBO 16.1s），
人脸、发型、服装、背景均保持不变。⚠️ MOSS 的编辑能力来自 `moss_image_edit_lora_bf16`，
不加载它就只有 SFT 底座，指令基本不生效。

**Krea 2：先看本插件的节点；装了两套外部节点包的话再往下看**

**本插件自己的节点就够了，不需要任何外部插件。** `Ref Image Encode` 把「模型类型」选成 `Krea2`，
就能复现 `ComfyUI-krea2Edit` 两个节点做的事 —— 因为 ComfyUI 原生 krea2 的 `_forward` **本来就有**
这条 in-context 参考通路（`ref_latents` → 干净 tokens 放 frame 1..N，target 放 frame 0），
`Krea2EditModelPatch` 只是手工把它重建了一遍。两个前提，节点现在都替你处理了：

1. `reference_latents_method = index`，**不是** `index_timestep_zero`（后者把 adaLN 调制拆成两个
   时间步，参考线稿会被描进画面）；
2. 每张参考图的 latent 在 VAE 编码前先 fit 到出图网格 —— `h/w` 与采样起点逐维相同，
   RoPE 位置只在 frame 轴上不同。

```
[参考姿势] ─image─▶ .image1 ┐
                            ├─▶ [Ref Image Encode（模型类型 = Krea2）] ─条件─▶ [采样器（一体）] ─▶ [VAE解码]
[加载图像] ────image─▶ .image2 ┘                          └latent（全零 16 通道）┘
```

它还有一个专门的 `negative` 输出（用同一个 CLIP 编出来的空文本条件）—— 接到采样器的「负面条件」，
这样以后想把 CFG 提上去也不会花屏。

⚠️ **顺序是硬约定：最后一个参考图 = 主体。** 姿势线稿放 `image1`、原照片放 `image2`。
反过来会直接渲成一个线稿人偶（实测）—— 因为模型会把线稿当成「要画的东西」而不是「条件」。
实测 8 步 720×1440：70s 出图，坐姿正确、画面干净、人物一致性保持，全程不用外部节点。

⚠️⚠️ **提示词必须把姿势写具体，这是最容易踩的坑。**
只写「图二美女参考图一的姿势，重新摆pose」这种笼统句子（同参数、同 seed 实测）——
模型不会去「理解」线稿，而是把线稿人偶当成画面里的**第二个主体**，直接输出
「左边真人 + 右边线稿人偶」的并排拼贴图。姿势一个字都不会动。

同一个姿势（P068 跪立后仰・手触脚跟 / 斜侧），三种写法实测：

| 提示词 | 结果 |
| --- | --- |
| `图二美女参考图一的姿势，重新摆pose` | ❌ 左人＋右线稿人偶的拼贴，姿势未变 |
| `让图二中的女人摆出图一那个姿势：跪立、身体向后仰、胸部抬起、背部拱起，双手向后下方伸去触摸脚跟，头部微微后仰，采用四分之三侧后方视角。保持她的脸、发型、深蓝色泳装和海滩背景不变。` | ✅ 单人物，姿势到位 |
| 同上的英文版 | ✅ 单人物，姿势到位（手更贴脚跟一点） |

写提示词的三个必填项：
1. **主体指认** —— 明确「图二中的女人」（不是「图二美女」）
2. **姿势的解剖描述** —— 躯干方向、四肢位置、手放哪里、头朝哪、机位角度。
   光说「参考图一的姿势」等于没说
3. **保持不变的东西** —— 脸/发型/服装/背景逐项列出

中文可用，不必强行写英文；但**姿势动作词越具体越准**。

⚠️ 请用 `DynamicRefImageEncode`（即 `Ref Image Encode`），不要用 `DynamicRefIndependent`：
后者把每张图编进**各自独立**的 conditioning（那是为 Qwen 2.1 的每图独立 index 平面设计的），
合并起来给不了 Krea2 一条连贯的参考序列 —— 实测会线稿残留 + 姿势跑偏。

**如果你要用外部节点包**，本机这两套**互不兼容**，插槽语义完全不同，
混用会得到「不报错、但线稿被画进画面」的结果。选错节点包 ≈ 白跑：

| 节点包 | 编码器 | patch 节点 | 参考姿势该接哪 | 结果 |
| --- | --- | --- | --- | --- |
| `ComfyUI-Krea2-Ostris-Edit` | `TextEncodeKrea2OstrisEdit` | `Krea2OstrisEditModelPatch` | `image2`（配 `image1`=原图） | ✅ 骨架驱动，线稿不进画面 |
| `ComfyUI-krea2Edit` | `Krea2EditGroundedEncode` | `Krea2EditModelPatch` | `image_b` + `source_latent_b` | ❌ 线稿被当成「第二个主体」画进画面 |

**能用骨架图的是 Ostris 那套**：

```
[加载图像] ─image─▶ [FluxKontextImageScale] ─▶ .image1 ┐
                                                      ├─▶ TextEncodeKrea2OstrisEdit ─┐
[参考姿势] ─image─▶ [FluxKontextImageScale] ─▶ .image2 ┘   （正/负各一个编码器）   │
                                                                                  ▼
[加载扩散模型] ─▶ [Krea2OstrisEditModelPatch] ─▶ [加载 LoRA] ─▶ K采样器（8步 euler simple CFG1）
```

`TextEncodeKrea2OstrisEdit` 的 `image1 / image2 / image3` 都是 `IMAGE`，本节点输出直插 `image2`。
实测（同一张海边站姿照片 + 素材 `P017_正坐・挺胸后仰`）：`krea_outfittransfer` + `kv_cache=开`，
8 步 36.1s 变成沙滩坐姿，**画面里没有线稿残留**，脸/发型/比基尼/背景均保持。

⚠️ 三个必须配对的点：
1. **`kv_cache` 必须跟 LoRA 的训练方式一致**。ai-toolkit 用 `kv_cache` 训练的（如
   `krea_outfittransfer`）要开；普通训练的编辑 LoRA 开了会跑偏。
2. **LoRA 必须和节点包配套**。把 `krea2_identity_edit_v2`（krea2Edit 系）接到 Ostris 节点上，
   线稿同样会被当成主体贴上去——实测过，两者几何不一致。
3. **条件上要包一层 `FluxKontextMultiReferenceLatentMethod`**（`index_timestep_zero`），
   正负各一份，官方工作流就是这么接的。

只有 krea2Edit 系 LoRA 时也能改姿势，但只能**用文字描述**，不能给骨架图：

```
[加载图像] ─▶ source_latent / image ─▶ Krea2EditModelPatch ─▶ K采样器（8步 euler simple CFG1）
提示词：让她坐在沙滩上，挺胸后仰，双手撑在身侧
```

实测 `krea2_identity_edit_v2` 靠这句文字把站姿改成了跪坐/坐姿，但把线稿接到 `image_b`
就会连人偶一起画出来。所以：**只有 krea2Edit 那套节点时，姿势只能写字描述；
用本插件的 `Ref Image Encode` 就能直接吃骨架图。**

**krea2Edit 到底能不能吃骨架图：四条路都试过了，都不能**

| 接法 | 姿势跟着骨架变？ | 画面干净？ |
|---|---|---|
| 线稿 → `image_b`（+ `source_latent_b`） | 是 | ❌ 白色人偶 / 透明线框被实打实画进画面，`ref_boost` 越高越明显 |
| 只接 `source_latent_b`（不给 `image_b`，TE 不看它） | ❌ 完全不生效 | 是 |
| 骨架当**主图**、原图当 `image_b`（方向对调） | 是 | ❌ 轮廓线残留在人物身上 |
| 先用 PIL 把线稿做成**灰度剪影**再喂 `image_b` | ❌ 姿势不动 | 是 |

第 2、4 条都做了控制实验（把提示词里的姿势描述整段删掉）：结果图仍然是原图的站姿，
说明姿势变化全部来自提示词，骨架本身没起作用。第 4 条只解决"脏画面"，不解决"驱动"。

**一致性的差异是实测的**：同一张原图、同一个姿势目标，`krea2Edit + krea2_identity_edit_v2`
出来是**同一张脸**；`Ostris + krea_outfittransfer` 出来的脸明显换人（那张 LoRA 是换装用途）。
所以两者不是"谁替代谁"：

- **两者都要**（人物一致 + 骨架图驱动姿势）→ 本插件 `Ref Image Encode`（模型类型 = Krea2），
  顶部那条接法就是，一个节点搞定、不用外部插件、也不用二次回收
- 要**人物一致**、纯文字改图（换姿势/换装/局部改）→ 本插件 Krea2 通路，或 `krea2Edit` + 文字描述
- 要**极限锁骨架**、可以接受脸飘 → `Ostris` 那套
- 已经在 krea2Edit 那套里出不了坑 → 先 Ostris 定姿势，再用 `krea2Edit` 做一次身份回收

⚠️ `ref_boost` / `grounding_px` 不是"越高越像"：实测 `ref_boost=1.3` + `grounding_px=1024`
反而把背景从海边换成了礁石。建议先保持 1.0 / 768，只在掉脸时小步上调。

**素材放哪：分三层，运行时合并**

| 层 | 位置 | 是否随插件分发 |
| --- | --- | --- |
| 插件自带 | `custom_nodes/ComfyUI-Toggle-Pass/pose_assets/` | 是 —— 1530 张，只含两个非敏感大类（`上半身单人`、`全身单人・标准系`） |
| 本地私有 | `ComfyUI/models/pose_reference/` | 否 —— 推荐放自己的和私密素材，跟着 `models` 备份走 |
| 自定义 | `TP_POSE_ROOT` 环境变量 | 否 —— 只有你把素材放到别处时才用 |

查找顺序是 **`TP_POSE_ROOT` → `models/pose_reference` → 插件自带**，同名素材以靠前的为准。
所以**只装节点就能用**，往私有目录里丢东西也会自己长出来：

- **把新的姿势组丢进 `models/pose_reference`，约 15 秒内下拉里自动出现**，不用刷新页面；删掉同样会
  自己消失（节点会轮询一个很轻的素材指纹）。
- 想立刻生效：画布右键 → `🔄 刷新姿势素材库`。
- 不存在的那一层直接跳过，不会因此报错；真找不到素材时，报错里会列出都搜过哪些路径。

**工作流自带参考图，可以直接分享。** 选中的素材会以 data URI 写进节点属性（`properties.tp_pose`），
跟着工作流一起走：

- 别人下载你的工作流，**本机完全没有素材库也能看到这张图，也能直接出图**；
- 代价约 **+8~14KB/节点**（素材本身就是 300×400 的 webp，单张 5~10KB）；
- 本机素材库存在时永远优先读素材库，内嵌数据只做兜底；
- 如果素材库不在了、参数又被改过，节点会继续显示内嵌的那张并给出提示，不会变成空白。

**输出**：`image`（`IMAGE`）——直接接 `TextEncodeQwenImage21`、`TextEncodeFibo2` 或任何编辑编码器的
`images` 输入。

现成的工作流在 `example_workflows/Pose Reference Editing.json`（Qwen-Image-2.1 turbo，8 步）。
**素材是跟着节点走的**（`properties.tp_pose`，约 8KB data URI）：别人下载后在**完全没有姿势素材库**
的机器上也能看到图、也能出图。再加上插件自带的 `pose_assets/`，全新安装就能直接浏览
两个大类共 153 个姿势 / 12 个组。

**为什么默认线稿。** 用 FIBO 2.0 和 Qwen-Image-2.1 各跑两组对照（同一姿势、同一指令、不同视角）：
深度套 **3/3** 都自己补出了不存在的鞋或护具，线稿套只有 **1/3** 出现小瑕疵。原因是深度图没有边界线，
脚底和地面亮度几乎相同，模型就把亮部填成了一个物件；线稿有一圈明确黑线，而且「线稿 → 真人」这个变换
在这类模型的训练数据里大量存在。深度唯一的优势是有体积感，肢体交叠时能分清前后遮挡关系，所以只在
复杂缠绕姿势时切过去。

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

✅ **负面条件已经解决了 —— `Ref Image Encode` 现在有专门的 `negative` 输出**，
直接连到采样器的「负面条件」即可。它是用同一个 CLIP 编出来的真·空文本条件，
所以**任何 CFG 下都正确**（实测与手接一个空 `CLIPTextEncode` 逐像素相同）。

⚠️ **不要**再用 `ConditioningZeroOut` 把正面条件清零当负面。CFG = 1.0 时负面根本不参与计算，
所以看着没事；一提高 CFG 出图就**整张花屏**（实测 fp8 / int8、20 步、CFG 2.5、挂姿势 LoRA，
绿紫斑块）。以前的版本这个节点只有两个输出、示例工作流接的正是 `ConditioningZeroOut` ——
坑就是从这里来的。

**姿势编辑推荐挂 `VNCCS_QI2_PoseStudioV2`**（`models/loras/Qwen/`，152 MB，
ai-toolkit 训练、base = `qwen_image_2`，`LoraLoaderModelOnly` 即可，纯 `diffusion_model` 键）。
同一句提示词下实测这批 Qwen 2.1 LoRA：

| LoRA | 结果 |
| --- | --- |
| 裸模型 | 可用，8 步 15 s |
| `VNCCS_QI2_PoseStudioV2` | ✅ **最好**：姿势跟得最准、画面最细腻、无线稿残留 |
| `QI2.1_AnyAngle` | ❌ 脸上/脖子出现线稿残留（参考图内容被「描」进画面） |
| `qwen_image_2.1_turbo_lora_avg_rank_178` | 可用但皮肤质感变糙，姿势帮助不明显 |

两种跑法都验证过：
- **turbo int8 + 8 步 + CFG 1.0** → 16.7 s，快，画质够用
- **`qwen-image-2.1-UC-fp8` + 20 步 + CFG 2.5** → 43.9 s，全身完整、细节最好（负面用空文本）

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

- **参考图 latent 尺寸 = 出图尺寸。** 参考图先中心裁到出图宽高比、再缩到出图像素网格，
  **然后**才进 VAE。这样参考图 latent 与采样起点逐维相等，RoPE 位置只在 frame 轴上不同 ——
  正是 krea2_edit 系 LoRA 的训练几何。视觉塔仍只吃约 384 px 的缩略图。
- **VAE 只吃 RGB** —— alpha 是丢掉，不是合成。
- **视觉占位符必须手写。** 传了显式 `llama_template` 时 Qwen3-VL 的 tokenizer **不会**自动插占位符，
  节点会自己拼 `Picture N: <|vision_start|><|image_pad|><|vision_end|>`；
  漏了就相当于参考图对模型完全不可见。
- **`reference_latents_method` 必须显式给，而且必须是 `index`。** Krea2 的 `default_ref_method`
  是 `None`，不设方法时参考图会被**静默忽略**（不报错，只是没效果）。
  `index_timestep_zero` 能跑但是错的：它把 adaLN 调制拆成两个时间步（target 用当前 t、参考图用 t=0），
  而训练时全序列共用一个 tvec —— 结果参考线稿会被**描进画面**（脸上出现轮廓线）。
  `index` 全序列统一 tvec，才对得上训练。
- **latent 输出是全零**（16 通道 / 8x）——和 2.1 一样是「编辑而不是 img2img」。
- **sigma 曲线：** Krea2 turbo 在 `采样器（一体）` 里用 `自动（按步数 + 调度器）` 方案，
  `Qwen-Image-2.1 turbo 8步` 那张表不能套过来用。

---

<a id="moss-fibo-支持"></a>
### MOSS-Image / FIBO 2.0 支持

`ToggleUnifiedLoader`（统一加载器）会自动识别这两个模型——`CLIP 类型` 里已经能直接选
`moss_image` / `fibo2`（选 `auto` 也能从 UNet 认出来）。
两者都是 **Flux2 latent**（128 通道 / 16x，`flux2-vae`），所以 `Ref Image Encode`（参考图编码）
**不需要新增模型类型，直接选 `Flux2` 就行**。

实测（同一张海边站姿照 + `P017_正坐・挺胸后仰` 线稿作为第二张图）：

| 模型 | 官方编码器 | `Ref Image Encode`（选 Flux2） |
|---|---|---|
| MOSS-Image，20 步 / CFG 4 | 19.6s — 坐姿、手撑沙滩 | 16.7s — 坐姿 ✅ |
| FIBO 2.0，4 步 / CFG 1 | 15.4s — 跪坐 | 10.6s — 跪坐 ✅ |

两组画面里都没有线稿残留。不换成官方编码器的代价是这几点：

- **MOSS 的 `edit_format`** —— 参考方法必须与编辑 LoRA 的训练格式配对
  （`ai-toolkit` → `index_timestep_zero_isolated`、`ai-toolkit (kv_cache off)` → `index_timestep_zero`、
  `Moss-Image-Edit` → `index_timestep_zero_text_start`）。选错照样出图，但指令基本不生效。
  `Ref Image Encode` 完全不设这个字段。
- **MOSS 的 `image_strength`** 和 **FIBO 的 `negative_prompt`** 它也没有。
- 两个官方编码器的图片输入都是 **AUTOGROW**，所以本节点的输出照样能直插：
  `TextEncodeMOSSImageEdit` → `images.image_0 / image_1 …`，`TextEncodeFibo2` → `images.image_1 … image_16`。

⚠️ `TextEncodeMOSSImageEdit` 只有**一个** conditioning 输出，正负条件必须用**两个节点**分别编码
（官方模板就是两个）。写成 `["节点", 1]` 会报 `list index out of range`，
而且报错位置会指向采样器、不是编码器。

采样器预设：`MOSS-Image（30步·CFG4）`、`FIBO 2.0 turbo（4步）`。

---

<a id="模型类型对照表"></a>
### 该选哪个？`模型类型` 和 `clip_type` 不是一回事

两个下拉长得像，作用完全不同：

- **`模型类型`**（在参考图编码器上）只决定**输出什么形状的 latent**（以及 Krea2 走哪种
  `reference_latents_method`）。
- **`clip_type`**（在 `Toggle Unified Loader` 上）决定**文本编码器怎么建**。

选错通常**不报错**：要么通道数不对、要么 conditioning 宽度不对、要么图看着挺干净但提示词没生效。

| 要加载的模型 | `模型类型`（编码器） | `clip_type`（统一加载器） | VAE |
|---|---|---|---|
| Qwen-Image **Layered** | `Qwen Layered`（+ `图层数`） | `qwen_image` | `qwen_image_layered_vae.safetensors` |
| Qwen-Image **2.1** | `Qwen Image 2.1` | `qwen_image` | `qwen_image_2.1_vae_bf16.safetensors` |
| **Krea 2** | `Krea2` | `krea2` | `qwen_image_vae.safetensors` |
| **FLUX.2 / MOSS-Image / FIBO 2.0** | `Flux2` | `flux2` / `moss_image` / `fibo2` | `flux2-vae.safetensors` |
| **Z-Image** | `SD / SDXL / Z-Image` | `stable_diffusion`（或 `auto`）—— **千万别选 `flux` / `flux2`** | `ae.safetensors` |
| **SD 1.5 / SDXL / Pony** | `SD / SDXL / Z-Image` | `stable_diffusion` | 用 checkpoint 自带的 |

`SD / SDXL / Z-Image` 是**故意做成通用档**的：只要真接了参考图，latent 就来自 `ref_latents[0]`，
所以这个设置在 SD / SDXL / Pony / Z-Image / Qwen-Image 1.0 上表现一致；只有当**一张图都不接**时，
它才具体意味着「4 通道全零 latent」。

**Qwen-Image Layered 的具体参数**（照官方 `image_qwen_image_layered.json` 抄的）：

- 文本编码器是 `qwen_2.5_vl_7b_fp8_scaled` —— 和 Qwen-Image 1.0 **同一个**编码器 ⇒ `clip_type` 选 `qwen_image`
- VAE 是 **`qwen_image_layered_vae`**，不是 `qwen_image_vae`。两者都是 16 通道，选错了要等到
  `VAEDecode` 才炸
- latent 是 5 维：`[B, 16, layers+1, h/8, w/8]` —— `模型类型 = Qwen Layered` 输出的就是它，
  等价于官方的 `EmptyQwenImageLayeredLatentImage`
- 官方模板里实际跑的是 **20 步 / CFG 2.5 / euler / simple / denoise 1**，640 px，`layers = 2`；
  画布上那段 Note 说的 50 步 / CFG 4.0 是「原始设置」（更慢）
- 模板给了两条支路：一条从 `EmptyQwenImageLayeredLatentImage` 起步，一条从 `VAE 编码(照片)` 起步。
  两者都是 `denoise 1`，起点会被完全覆盖 ⇒ 真正决定结果的是 `layers`（latent 第 3 维 = `layers+1`）。
  **只有**想做「低 denoise 精修」时起点才重要，那时编码器给的全零 latent 就不是你要的

**Z-Image 特别提醒**：`clip_type` **别选 `flux` / `flux2`**。Z-Image 的 TE 是 Qwen3-4B，而
`comfy/sd.py` 在 `clip_type` 为 FLUX/FLUX2 时会把 Qwen3-4B 建成 Flux 系的编码器 ——
类都不一样，提示词编码全变，而且不报错。

2026-11-06 实测（同一个 Z-Image unet、同样 `qwen_3_4b` + `ae`，**只改 `clip_type`**）：

| `clip_type` | 实际建出的文本编码器 | |
|---|---|---|
| `stable_diffusion` | `ZImageTEModel_` | ✅ 推荐 |
| `auto` | `ZImageTEModel_` | ✅（模型类识别成 `Lumina2`，走同一档） |
| `qwen_image` | `ZImageTEModel_` | ⚠️ 撞对的 —— ComfyUI 是按 TE 类型分派，跟这个值无关 |
| `flux` | `Flux2TEModel_` | ❌ 编码器类不对，提示词静默失效 |

<a id="auto-clip-type"></a>
### `clip_type = auto` 到底准不准

**本地 5 个模型实测全对，108 个模型类静态核对 106 个一致。** auto 不是瞎猜，它做的是：

1. **真加载 UNet**（不是读 header 猜），拿模型对象的真实类名 —— Qwen-Layered 加载出来是
   `QwenImage`，Z-Image 是父类 `Lumina2`；
2. 按「**精确表 → 继承链 → 前缀规则**」三层查 `CLIPType`：
   - 精确表只登记「`clip_type` 真的改变结果」的模型（见下表）；
   - 继承链兜子类：`FluxSchnell → Flux`、`KOALA_1B → SDXL`、`ZImagePixelSpace → ZImage`；
   - 前缀规则兜变体：`WAN21_I2V` / `WAN22_S2V` / `WAN_Animate2` … 16 个 WAN 类 → `wan`（另有 2 个在精确表）；
3. 剩下的用 `stable_diffusion` 兜底 —— **这不算猜错**，因为那三分之一的模型 ComfyUI 压根
   不看 `clip_type`（TE 权重本身就唯一确定了是哪种编码器）。

**`clip_type` 只在「同一个 TE 权重能走多条路」时才真正起作用。** 读 `comfy/sd.py` 的
`load_text_encoder_state_dicts` 可以确认只有这几族：

| TE 权重 | 需要 `clip_type` 区分 | 选错的下场 |
|---|---|---|
| T5-XXL | SD3 / LTXV / WAN / CHROMA / PIXART / COGVIDEOX / MOCHI | 掉进 `else` 建成 **Mochi** 的 TE |
| Qwen3-VL-8B | QWEN_IMAGE / IDEOGRAM4 / BOOGU / JOYIMAGE | 建成通用 `Qwen3VLTEModel_`，Qwen-Image 2.1 的 `image_slots` 丢失 |
| Qwen3-VL-4B | KREA2 / FIBO2 / FLUX3 / MAGE / MINIMAX | 同上，通用 Qwen3-VL |
| Qwen3-4B | FLUX / FLUX2 | 建成 Flux 系 `Flux2TEModel_`（Z-Image 就踩这个） |
| CLIP-G | SD3 / STABLE_CASCADE / HIDREAM | 建成 `SDXLRefinerClipModel` |
| Qwen2.5-7B | HUNYUAN_IMAGE / LONGCAT_IMAGE | 建成 `qwen_image` 的 TE |

其余模型（Anima / AuraFlow / Cosmos / Lens / OmniGen2 / StableAudio / SAM / 3D 那些）
`clip_type` 传什么都一样，auto 用兜底值无害。

**实测（2026-11-06，`clip_type = auto`，真加载）**：

| 模型 | auto 判定 | 建出的文本编码器 | |
|---|---|---|---|
| Qwen-Image Layered | 精确匹配 `QwenImage` → `QWEN_IMAGE` | `QwenImageTEModel_` | ✅ |
| Z-Image | 精确匹配 `Lumina2` → `STABLE_DIFFUSION` | `ZImageTEModel_` | ✅ |
| Krea2 | 精确匹配 `Krea2` → `KREA2` | `Krea2TEModel_` | ✅ |
| FIBO 2.0 | 精确匹配 `Fibo2` → `FIBO2` | `Fibo2TEModel_` | ✅ |
| MOSS-Image | 精确匹配 `MOSSImage` → `MOSS_IMAGE` | `MOSSImageTEModel_` | ✅ |

**双保险：加载完立刻校验 TE。** auto 万一判错（或上游加了新模型类），不会静默 ——
加载器会向模型自己要「我该配哪个编码器」（`model_config.clip_target()`，108 个类里 106 个问得到），
跟实际建出来的类名比对，不一致就打印：

```
[ToggleUnifiedLoader] ⚠️ CLIP 校验失败：模型是 Krea2，但文本编码器建成了 Qwen3VLTEModel_
（预期 Krea2TEModel，依据 手工表）。这个 CLIP 文件与模型不配套 → 提示词会被错误编码
（跑得通但什么都不生效）。请更换 CLIP 文件，或检查『CLIP 类型』是否选对。
```

这条校验不是装饰：auto 判错时它会**当场**报出来，而不是等你出图发现「提示词不生效」再回头排查。

**什么时候别用 auto**：只有一种情况 —— 你要故意手选一个与模型不匹配的编码器做实验。
正常使用 `auto` 比手选更靠谱，因为手选需要记住上表 6 行。


所以 `qwen_image` 不会把 Z-Image 弄坏，但还是选 `stable_diffusion`（或 `auto`），让设置名副其实。

---

<a id="z-image-用法"></a>
### Z-Image：纯文生图，模型类型选 `SD / SDXL / Z-Image`，不要接参考图

⚠️ 先说结论：**Z-Image 没有参考图编辑能力，`image1`~`image10` 一个都别接。**

依据（实测，不是猜的）：

- 官方 5 个 `z_image` 模板里，`image_z_image` / `_int8` / `_turbo` / `_turbo_int8` **全都没有
  `LoadImage`**，是纯文生图；唯一带图输入的 `image_z_image_turbo_fun_union_controlnet` 走的是
  **ControlNet（Canny 0.1 / 0.32）**，属于"线条控图"，和参考图编辑是两条完全不同的通路。
- Z-Image 是 Lumina2 / NextDiT 系，训练时没有参考图 token。真接了 `image1` 之后，
  `reference_latents` 照样会进 conditioning，但模型缺配套的 `reference_latents_text_embeds`
  ⇒ 实测出图是**满屏方块马赛克**。换 seed、换尺寸桶、换采样起点都一样。

**正确用法**：`模型类型` 选 `SD / SDXL / Z-Image`，`image1` 空着。

这不是"凑合"。不接图时这个分支输出的就是 4 通道全零 latent，再由官方
`fix_empty_latent_channels` 补到 16 通道，正是 Z-Image 需要的空起点。同 seed 下与官方
`UNETLoader + CLIPLoader + VAELoader` 原生链路**逐像素一致**（51.5 / 214.5 / 46.9 四项全等）。

**想要 Z-Image 的图生图**：别用这个节点，走官方的
`加载图像 → VAE 编码 → 采样器(denoise < 1)`。提示词 + denoise 控制改动力度，照片当采样起点。

**防忘机制**：接反了会在日志里打一条警告（只提示，不改任何行为）：

```
[Toggle-Pass][Ref Image Encode] ⚠️ 文本编码器 = ZImageTEModel_，已接入 1 张参考图，
但这个底座没有参考图通路。
```

`模型类型` 下拉里**没有单独的 Z-Image 项** —— 它的行为和通用档 `SD / SDXL` 完全一样，所以两项
直接合并成一个名字 `SD / SDXL / Z-Image`，而不是再加一项让人误以为"选了它就能接图"。

> 2026-11-06 改名：旧值是 `SD / SDXL`。老工作流**加载时自动迁移**（前端直接改写 widget 值，
> 后端收到旧别名也会归一），存过的图不用手动改。

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
| `Pose Reference Editing.json` | `PoseReference` 接 Qwen-Image-2.1 turbo 编辑（8 步）。**选中的素材已内嵌在节点里**，没装姿势素材库也能打开、也能直接跑。 | 无 |
| `Krea2 Pose Editing.json` | 9 个节点，**7 个是本插件的，外部插件 0 个**：`统一加载器`（UNet + CLIP + VAE + `krea2_identity_edit_v2` LoRA 一个节点搞定）+ `加载图像` + `参考姿势` → `Ref Image Encode`（模型类型 = Krea2；姿势线稿接 `image1`、原照片接 `image2`，latent 和 negative 都直接取它自己的输出）→ `采样器（一体）` 选 `Krea 2 turbo（8步）` → `图像对比` / `保存图像`。实测 720×1440、8 步、70s，站姿改坐姿，线稿不进画面，人物一致性保持。 | 无 |
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

### 2026-11-07

- **🏷️ 起版本号：`v1.0.0`**。之前一直没有版本标识，用户装了哪一版只能靠 commit 猜。
  现在三处对齐：`pyproject.toml` 的 `[project].version`（ComfyUI-Manager / Comfy Registry 认这个）、
  `__init__.py` 的 `__version__`、README 顶部。启动日志会打一行
  `[Toggle-Pass] v1.0.0 loaded — 13 nodes`，排查「装的是不是新版」一眼就能确认。
  后续按语义化版本：加功能进 minor，只修 bug 进 patch。
- **🧹 移除示例 `Krea2 Pose Editing (Ostris).json`**。它硬依赖外部节点包
  `ComfyUI-Krea2-Ostris-Edit`，而那套接法**会换人**（`krea_outfittransfer` 本质是换装 LoRA）。
  留着容易让人误以为这是推荐路线。骨架驱动的技术说明仍保留在上面的对照表里，要复现照链路自己接；
  常态需求用 `Krea2 Pose Editing.json`（零外部依赖，人物一致性保持得住）。

### 2026-11-06

- **🔀 `Ref Image Encode` 输出口顺序调整：`negative` 挪到 `latent` 上面**
  （顺序变为 `conditioning` / `negative` / `latent`）。
  - **老工作流自动迁移**：加载时前端按「连线的类型」把线重新归位 ——
    `LATENT` 的线接到 `latent` 口、`CONDITIONING` 的线接到 `negative` 口，
    **已存的工作流不用手动改线**。实测两个老样本（2 输出时代的 `All-in-One Demo`、
    3 输出旧布局的 `Krea2 Pose Editing`）加载后：正面→0、负面→1、latent→2 全部正确，
    且「保存后重新加载」不会被二次交换。
  - 迁移**幂等**：靠 link 的类型判断，不依赖存盘标记，加载几次结果都一样。
  - **连线归位要等 `graph.links` 建好，所以走阶梯重试**：ComfyUI 加载完成后 `graph.links`
    要几百毫秒才填满（实测 200ms 时还是空表）。改名可以同步做（抢在渲染连线之前），
    但搬线不能 —— 早期版本只等一帧就搬，结果「槽位名字换了、线没跟着走」，
    画布上看着就像 `negative` 口插着 `latent` 的线。现在改名同步执行，连线归位按
    0/50/120/260/550/1000/1800/3000ms 阶梯重试，一旦「0 条需要改」立刻收手，
    不会干扰你之后的手动接线。
  - ⚠️ 走 **API / 手写 JSON** 的调用（不经过前端）不会自动迁移 —— 这类调用要把
    `latent` 从 `["节点", 1]` 改成 `["节点", 2]`、`negative` 从 `2` 改成 `1`。
- **🎯 `clip_type = auto` 重做，不再靠一张追不上的手工表**。原来 auto 只认 20 个模型类名字面量，
  ComfyUI 的 `supported_models` 一共有 **108** 个类，没认出来的会静默回落 `stable_diffusion` ——
  其中 WAN 全系变体（16 个走前缀、2 个在精确表）、Chroma、CogVideoX 正好都在「会建错 TE」那一族里
  （T5-XXL 的 `else` 分支是 **Mochi** 的编码器）。现在改成三层：
  - **精确表 → 继承链 → 前缀规则**。精确表只登记「`clip_type` 真的改变结果」的歧义模型；
    子类走 MRO（`FluxSchnell → Flux`、`KOALA_1B → SDXL`）；WAN 的 17 个变体走前缀规则。
    静态核对 108 个类：精确 42 / 继承链 17 / 前缀 16 / 通用兜底 33（这 33 个 `clip_type`
    本来就不参与判断，兜底无害）。
  - **`auto` 现在会真加载 UNet 拿真实类名**（`load_unet` 返回 `ModelPatcher`，真实模型在
    `.model` 里；直接 `type(model)` 只会拿到 `ModelPatcher`，实测会让所有模型都推不出来）。
- **🛡️ CLIP 校验加固：手工表没登记的模型，直接问模型自己要答案**。以前只按 8 条手工前缀表
  校验，没登记的模型一律「宁可漏报」跳过；现在先查手工表（经过实测，优先），查不到就用
  `model_config.clip_target()` 反查「这个模型该配哪个编码器」——108 个类里 **106 个问得到**，
  等于给全部模型类都上了校验。
  - 实测价值：改代码时一次回归让 auto 全线退化成 `stable_diffusion`，
    Krea2 / FIBO / MOSS 三个都被这条校验**当场**抓住，没有一个静默出错。
  - 校验失败的日志会带上「依据 手工表 / 模型自述」，便于区分是表不准还是文件选错。
- **🔤 `模型类型` 改名：`SD / SDXL` → `SD / SDXL / Z-Image`**。两者 latent 行为完全一样
  （不接参考图时都输出 4 通道全零 latent，交给官方 `fix_empty_latent_channels` 补通道），
  合成一个名字省得再开一项，也省得每次去想「Z-Image 到底选哪个」。
  - 老工作流**自动迁移**：加载时前端直接把控件值从旧名字改成新名字（控制台会打一行
    `模型类型 已迁移`）；后端也认旧别名，第三方节点转存 / 手改 JSON 一样能走对分支。
  - 三个编码节点（`Ref Image Encode` / `一图多Prompt` / `Ref Independent`）统一生效。
  - `ToggleEmptyLatent` 的 `latent类型` **没改**（那个本来就把通道数写在名字里），Z-Image 用
    `SD / SDXL（4 通道 · 8×）` 那一档即可。
- **➕ 统一加载器的 `clip_type` 下拉补齐**：原来只登记了 14 项，现在把 ComfyUI 支持的其它类型
  全追加在末尾（`hunyuan_video` / `lumina2` / `chroma` / `ideogram4` / `flux3` 等 26 项）。
  用 `getattr` 取枚举，旧版 ComfyUI 少哪个成员就跳过哪个，不会把插件带崩；已有项位置不动，
  老工作流位置序列化不受影响。
  - 顺带补了 Z-Image 的自动识别（`ZImage → stable_diffusion` + TE 前缀 `ZImageTEModel`），
    `clip_type = auto` 时不会再打「未登记映射」的告警。
- **📋 README 新增「该选哪个？」对照表**（`模型类型` vs `clip_type`），把 Qwen-Image Layered /
  2.1 / Krea2 / Flux2 系 / Z-Image / SD 各自选什么、配哪个 VAE 一张表列全。
  见 [模型类型对照表](#模型类型对照表) / [cheat sheet](#model-type-cheatsheet)。
  - **Qwen-Image Layered → `clip_type` 选 `qwen_image`**：它的 TE 和 Qwen-Image 1.0 是同一个
    `qwen_2.5_vl_7b_fp8_scaled`，VAE 必须是 `qwen_image_layered_vae`（同为 16 通道，选错要到
    `VAEDecode` 才炸）；latent 5 维 `[B,16,layers+1,h/8,w/8]` 正好等于 `模型类型 = Qwen Layered`。
  - **Z-Image → 别选 `flux` / `flux2`**：`comfy/sd.py` 在 FLUX/FLUX2 下会把 Qwen3-4B 建成 Flux
    Klein 的编码器，类都不一样，提示词全废且不报错。
- **⚠️ 接错参考图会报警了：Z-Image / Lumina2 系没有参考图通路**。三个编码节点一旦检测到
  文本编码器是 `ZImageTEModel_` **且**接了 `image1`，日志里会打一条明确警告（含正确做法），
  **只打印，不改任何参数和接线**。同一个（节点 + 编码器）每次启动只打一次，不会刷日志。
  - Z-Image 是**纯文生图**模型：官方 5 个 `z_image` 模板里 4 个连 `LoadImage` 都没有，
    唯一带图的 `fun_union_controlnet` 走的是 **ControlNet**，不是参考图编辑。
  - 硬接 `image1` 的后果实测是**满屏方块马赛克**（换 seed / 尺寸桶 / 采样起点都一样）。
  - 正确用法：`模型类型` 选 `SD / SDXL / Z-Image`、`image1` 空着 —— 空 latent 会自动补到 16 通道，
    同 seed 下与官方原生链路逐像素一致。要图生图请用 `VAE 编码 + 采样器 denoise < 1`。
  - 下拉里**不单独设 Z-Image 项**（行为和通用档完全一样），已合并进 `SD / SDXL / Z-Image`。
    详见 [Z-Image 用法](#z-image-用法)。
- **💡 广播打开时，会被自动接上的槽位小点会「点亮」**（补成实心、用该槽位类型的官方配色，
  和手动连线后的样子一致）。以前只有紫线画过去、槽位却还是空心圈 —— 因为广播是纯预览，
  提交前不建真实连线，官方就一直按「未连接」渲染。
  - 只点亮**空着的**槽位；本来就有真实连线的口不重复画（官方自己就是实心）。
  - 会被**后绘制的节点压住**的槽位不点亮（按 `graph._nodes` 绘制顺序判断），
    所以拿节点当遮罩盖内容时不会再有假点透出来。
  - 节点折叠、槽位位置未确定（`boundingRect` 无效）时跳过。
  - 实测（无头 Edge，`probe_slot_lit_guard.mjs` 5/5）：点亮后槽位中心色 `255,213,0`
    **与手动真连线完全相同**；被节点盖住时 `102,85,51`（不点亮）；关掉开关回到 `193,192,0`（空心）。
- **🐛 修掉「一根紫线往空白处伸出去就断掉」**。原因：广播线的端点优先取槽位的
  `boundingRect`（官方渲染时算出来的真实盒子），但**节点只要不在可视区内、从没被渲染过**，
  这个盒子就是 `[0,0,0,0]`，旧代码对零尺寸照样取中心 ⇒ 端点被算成**图坐标原点**，
  线就画到画布原点那片空白里，看着像一根悬空紫线。
  - 触发条件：目标节点被拖到视野外（尤其画布上方 `y<0` 那种「半个节点探出去」的情况）。
    实测 `Toggle-Pass-Test.json` 里的 `VAE解码`（pos.y = -66）就踩中。
  - 修法：零尺寸一律视为「未布局」，退回 `getConnectionPos` 估算 —— 端点从 `(0,0)`
    变成真实槽位位置（实测 `(0,0)` → `(1362,-32)`、`(0,0)` → `(955,-52)`，都落回节点内）。
  - 有 `boundingRect` 的正常槽位行为完全不变（同图另外两条线端点一字未动）。
  - 纯前端改动，**不用重启**，`Ctrl+F5` 即可。
- **➕ 新增诊断命令 `__tpAudit()`**（控制台执行）：把当前每一根广播线的**两端坐标 /
  归属节点 / 是否落在自己节点范围内 / 目标槽 boundingRect** 打成表格，悬空端点会红字警告。
  以后再遇到「线跑到奇怪的地方」，先跑这个，一眼看出是哪条 pair 算错。
- **🔧 广播预览的端点圆点改成和线同层（节点能盖住了）**。以前圆点画在 `draw()` 末尾 = 全画布最上层，
  所以把节点拖到线上当遮罩时，一串紫点会穿出节点浮在上面（一列三颗、看着像脏点）。
  现在圆点和线一起画进背景层（`bgcanvas`），**节点盖住线的同时把点一起盖住**，观感统一成
  「线从节点边缘伸出来」，和官方连线一个样子。
  - 视觉代价：槽位点本身压在节点边线上，所以露在外面的只剩半个圆点（另一半被节点吃掉）。
  - 想回到旧观感：`localStorage.tp_dots_layer = "front"` 再刷新；删掉这个键就恢复默认。
  - 纯前端改动，**不用重启**，`Ctrl+F5` 即可。
  - 实测（无头 Edge 像素级）：同一布局下节点框内新增紫色像素 —— 旧行为 39 px（复现问题）、
    新默认 **0 px**；bgcanvas 里圆点仍在（两个端点各 20 px）；节点之间空白处的线 200 px 不变。

### 2026-11-05

- **✅ `Ref Image Encode` 新增第三个输出 `negative`（自动生成，不用再接 `ConditioningZeroOut`）**。
  它是用同一个 CLIP 编码出来的真·空文本负条件，**CFG 调多高都正确**。
  - 怎么用：`Ref Image Encode` 的 `negative` 口 → 采样器「负面条件」，完事。
  - 为什么加：之前示例工作流用 `ConditioningZeroOut` 把正面清零当负面，CFG=1.0 时看不出问题，
    **CFG>1 就整张花屏**（绿紫斑块）。
  - 兼容：第三个口是**追加在末尾**的，旧工作流的 `conditioning` / `latent` 两个口完全不受影响。
  - 实测：与手接空 `CLIPTextEncode` **逐像素完全相同**（Qwen 2.1 fp8 / 20 步 / CFG 2.5，max diff 0）；
    Krea 2 CFG 1.0 下新旧接法差异落在模型自身的重跑随机范围内（同配置重跑 max 142 vs 新旧 139）。
  - `example_workflows/Krea2 Pose Editing.json` 已改成这个接法（节点数 10 → 9）。
- **⚠️ CFG > 1 时负面条件不要接 `ConditioningZeroOut`，会整张花屏**。实测（fp8 / int8、20 步、
  CFG 2.5、挂姿势 LoRA）：把正面条件清零当负面 ⇒ 出图绿紫斑块、完全不可用；改成空文本
  `CLIPTextEncode` 就正常。CFG 1.0 时负面不参与计算，所以 turbo 8 步的示例一直没暴露这个坑。
  → 现在直接用 `Ref Image Encode` 的 `negative` 输出即可。
- **Qwen 2.1 姿势编辑推荐挂 `VNCCS_QI2_PoseStudioV2`**（`models/loras/Qwen/`，152 MB，
  ai-toolkit 训练、base = `qwen_image_2`，`LoraLoaderModelOnly` 即可）。同 prompt 实测：
  它姿势跟得最准、画面最细腻、无线稿残留；`QI2.1_AnyAngle` 反而在脸上/脖子画出线稿残留；
  `qwen_image_2.1_turbo_lora` 皮肤变糙、姿势帮助不大。两种跑法：turbo int8 8 步 16.7s；
  `UC-fp8` 20 步 CFG 2.5 43.9s（全身最完整）。
- **⚠️ 提示词必须写具体姿势，否则 Krea 2 会把线稿人偶画进画面**。这是今天实测出来的第二大坑：
  同参数、同 seed，只写「图二美女参考图一的姿势，重新摆pose」时，模型不读线稿，而是把线稿人偶
  当成**第二个主体**，直接输出「左边真人 + 右边线稿人偶」的并排拼贴，姿势一点不动。
  提示词换成「让图二中的女人摆出图一那个姿势：跪立、身体向后仰、胸部抬起、背部拱起，
  双手向后下方伸去触摸脚跟，头部微微后仰，采用四分之三侧后方视角。保持脸/发型/服装/背景不变」
  就正常了。**中文完全可用**，关键是三段：主体指认 + 姿势解剖描述 + 保持不变的内容。
  → README 中英各加一节「提示词怎么写」，并修掉原来那句会误导人的简短示例。
- **Krea 2 编辑不用再装 `ComfyUI-krea2Edit` 了**：`Ref Image Encode` 把「模型类型」选成 `Krea2`，
  就能直接做「保身份 + 换姿势」，姿势线稿接 `image1`、原照片接 `image2`。
  原因是 ComfyUI 原生 krea2 的 `_forward` 本来就有 in-context 参考通路（`ref_latents`），
  `Krea2EditModelPatch` 只是手工重建了同一件事。实测 8 步 720×1440：70s 出图，坐姿正确、
  画面干净、人物一致性保持。
  → 新增示例 `example_workflows/Krea2 Pose Editing.json`（10 节点，**外部插件 0 个**）；
  原来的 Ostris 版改名为 `Krea2 Pose Editing (Ostris).json`，用途变成「极限锁骨架」。
- **修 `reference_latents_method`：`index_timestep_zero` → `index`**（Krea2 三处编码节点全改）。
  `index_timestep_zero` 会给参考图单独一套 **t=0 的 adaLN 调制**，而 krea2_edit 系 LoRA 训练时
  全序列共用一个 tvec ⇒ 参考线稿会被**「描」进画面**（实测：脸上出现轮廓线和腰线，
  换 `index` 后完全干净）。这个坑很隐蔽：不报错、能出图、姿势也对，只有画面脏。
- **Krea2 参考图 latent 改为 fit 到出图网格**：原来是缩到约 1 MP 保持原比例，
  于是 ref latent 的 `h/w` 与采样起点不同 ⇒ 模型把参考图当「另一块画布」，边缘特征会渗进画面。
  现在先中心裁到出图宽高比、再 bicubic（**antialias**）缩到出图像素尺寸，
  ref latent 与零 latent 逐维相等，RoPE 位置只差 frame 轴 —— 与训练几何一致。
- **★ 顺序是硬约定：最后一个参考图 = 主体。** 姿势线稿放 `image1`、原照片放 `image2`；
  反过来会渲成一个线稿人偶（实测）。提示词里按 `image 1 / image 2` 指代即可。
- **`DynamicRefIndependent` 不适合 Krea2**：它把每张图编进各自独立的 conditioning
  （那是 Qwen 2.1 每图独立 index 平面的设计），合并后给不了 Krea2 一条连贯的参考序列 ——
  实测线稿残留 + 姿势跑偏。Krea2 请用 `Ref Image Encode`（`DynamicRefImageEncode`）。

### 2026-11-04

- **`空 Latent` 新增 `latent类型`（4 档通道 / 压缩比）**：原来写死 4 通道 · 8×，
  接 Krea 2（Wan21，16 通道）或 Flux2（128 通道 · 16×）只能靠 K采样器的
  `fix_empty_latent_channels` 隐式补通道。现在可选 `SD / SDXL`、`SD3 / Flux / Krea 2`、
  `Qwen-Image 2.1`、`Flux2`，默认仍是 4 通道（老工作流不变）。
  选对时与官方 `EmptySD3LatentImage` 输出完全一致（实测 shape / dtype /
  `downscale_ratio_spacial` 全等，张量差 = 0）。
- **示例 `Krea2 Pose Editing (Ostris).json` 重做为「本插件节点为主」**：16 个节点里 7 个是本插件的
  （`统一加载器` / `读图` / `参考姿势` / `空 Latent` / `采样器（一体）` / `图像对比` / `存图`），
  余下 6 个是 ComfyUI 内置（`VAEDecode`、`FluxKontextImageScale`、`FluxKontextMultiReferenceLatentMethod`），
  只有 3 个来自外部插件 `ComfyUI-Krea2-Ostris-Edit`。画布内新增 `Note` 节点，
  写明「用到了哪个插件、三个必须配对的条件」，打开就知道缺什么。
  原版本是从官方模板改的，19 个节点里只有 1 个是本插件的，已作废。
- **`Ref Image Encode` 接 MOSS-Image / FIBO 2.0：模型类型选 `Flux2`（下拉未新增）**。
  两者 latent 与 Flux2 同族（128 通道 / 16x，都用 `flux2-vae`），实测参考图能真正生效：
  MOSS 20 步 16.7s / FIBO 4 步 10.6s 都能把站姿改成素材里的坐姿，画面无线稿残留
  （对照组用官方编码器分别是 19.6s / 15.4s）。不新增专用类型的理由：MOSS 要 `edit_format`
  （三档训练格式）+ `image_strength`、FIBO 要 `negative_prompt`，塞进一个类型会变成一半参数无效；
  需要精确控制这些时直接用 `TextEncodeMOSSImageEdit` / `TextEncodeFibo2`。
- **修正三处 Flux2 空 latent 的通道 / 尺寸**（`Ref Image Encode`、`OneImageMultiPrompt`、`Ref Independent`）：
  - `Ref Image Encode` 和 `OneImageMultiPrompt` 的「纯文生图」分支原来写死 4 通道（SD 的 latent），
    Flux2 实际是 128 通道。走 KSampler 时 `fix_empty_latent_channels` 会自动补齐
    （4→128 平铺 + 8x→16x 缩放），所以**出图结果完全一致（实测 max abs diff = 0）**；
    但这是隐式兜底，不经过 KSampler 的场景不会修。
  - `Ref Independent` 的「空槽兜底」原来是 `torch.zeros(1, 4, 1, 1)`，这是**真的会出问题**：
    auto-fix 只补通道、不改尺寸，采样照常跑完，最后解码出一张 **16×16 的废图**（不报错，很难查）。
    已改为按模型类型给正确的通道与尺寸 —— 实测与官方 `EmptyFlux2LatentImage` 逐像素一致
    （max abs diff = 0），出图从 16×16 恢复成 512×1024。
- **`参考姿势` 已确认可驱动 Krea 2 编辑（骨架驱动）**，但**只有 Ostris 那套节点能吃骨架图**：
  `TextEncodeKrea2OstrisEdit` 的 `image1/2/3` 都是 `IMAGE`，原图接 `image1`、参考姿势接 `image2`
  即可，线稿不会被画进画面。实测 `krea_outfittransfer` + `kv_cache=开`、8 步 euler/simple CFG1，
  36.1s 把站姿改成素材里的坐姿，脸/发型/服装/背景不变。
  ⚠️ 另一套 `ComfyUI-krea2Edit`（`Krea2EditGroundedEncode` / `Krea2EditModelPatch`）的
  `image_b` / `source_latent_b` 语义是「**第二个主体，要放进画面**」，接参考姿势会把人偶一起画出来
  （实测）；它只能靠文字描述改姿势。**两套节点包不能混用**：把 krea2Edit 系 LoRA
  （`krea2_identity_edit_v2`）接到 Ostris 节点上同样会贴线稿，几何不一致。
  另：`kv_cache` 必须与 LoRA 训练方式一致，条件上要包 `FluxKontextMultiReferenceLatentMethod`。
  当时附过示例 `Krea2 Pose Editing (Ostris).json`（实测 8 步出图，首次含模型加载约 86s），
  但它对外部节点包有硬依赖、而且会换人，**已在 2026-11-06 移除**。要复现请照上面的链路自己接；
  常态需求建议直接用 `Krea2 Pose Editing.json`（零外部依赖，人物一致性保持得住）。
- **`统一加载器` 加载 Krea 2 编辑链已实测**：`clip_type=auto` 正确识别 `Krea2 → CLIPType.KREA2`，
  TE 建成 `Krea2TEModel_`、VAE 校验 16 通道 / 3 维，LoRA 槽可直接加载 `krea_outfittransfer` 等编辑 LoRA
  （256 个 patch）。与原生 `UNETLoader + LoraLoaderModelOnly` 对比：**无 LoRA 时逐像素一致（max 0）**；
  带 LoRA 时 LoRA 影响幅度一致（平均差 60.66 vs 60.69），仅 4.6% 像素有细微差异，画面等效。
- **`统一加载器` 支持 FIBO 2.0 与 MOSS-Image**：`CLIP 类型` 新增 `fibo2`、`moss_image`，
  auto 模式按 UNet 类名（`Fibo2` / `MOSSImage`）自动识别。这两个和 `krea2` 共用权重文件，
  但取层方式完全不同（`fibo2` 取 15 层中段 → 6×7680；`moss_image` 用 Qwen3.5-9B 的 last hidden state），
  所以选错不是画质问题，是 conditioning 维度直接对不上。加载器同时校验 TE 类名
  （`Fibo2TEModel_` / `MOSSImageTEModel_`）与 VAE（都走 Flux2 latent，必须 `flux2-vae*`）。
  实测：同一 seed 下，统一加载器 vs 原生 `UNETLoader + CLIPLoader + VAELoader`
  **逐像素完全一致**（max abs diff = 0，fibo2 与 moss-image 各一组，moss 的 edit LoRA 走加载器 LoRA 槽同样一致）。
- **`采样器（一体）` 预设新增两条**：`FIBO 2.0 turbo（4步）`（euler/simple/CFG1）、
  `MOSS-Image（30步·CFG4）`（euler/normal/CFG4）。FIBO 是 4 步蒸馏、给大反而崩；
  MOSS 是 SFT 不是蒸馏，30 步 + CFG4 才是训练配置，降到 4 步会糊。数值取自
  `FIBO2-文生图+图编辑.json` 与 `image_moss_image_edit.json`。
- **`参考姿势` 已确认可驱动 MOSS-Image / FIBO 2.0 编辑**：这两个编码器的 `images` 都是
  自动增长输入（MOSS `image_0..image_9`、FIBO `image_1..image_16`），
  接法和 2511 一样——**原图接第一张、参考姿势接第二张**。实测两个模型都能把站姿照片改成素材里的坐姿，
  人脸/发型/服装/背景保持不变（MOSS 30 步 20.2s、FIBO 4 步 16.1s）。
  ⚠️ MOSS 的编辑能力来自 `moss_image_edit_lora_bf16`，且 `edit_format` 必须与 LoRA 训练格式配对
  （`Moss-Image-Edit` / `ai-toolkit` / `ai-toolkit (kv_cache off)`），选错同样「出图但没改」。
- **`参考姿势` 接 2511 / FLUX.2 这类编辑模型改为「多图编辑」接法**（README 补说明，代码无改动）：
  之前单张接 `image1` 时**不报错、能出图，但人物姿势完全不变**——编辑模型把 `image1` 当作
  「待修改的原图」，线稿进了 `image1` 就等于让它「重绘这张线稿」，提示词失效。
  现在明确写清：原图接 `image1`、参考姿势接 `image2`，提示词写「保持 image1 的人物，姿势改成 image2」。
  实测 2511 与 FLUX.2 在多图接法下都能按骨架重摆人物，**不需要 ControlNet，也不需要额外模型**。
- **`参考姿势` 输出尺寸强制对齐 16 的倍数**：原来只按长边等比缩放，遇到异形比例（如
  `1234×1000` → `1024×830`）会得到非 16 倍数的宽高，`VAEEncode` 只能自己 pad/crop，
  边缘产生半像素位移——线稿和深度图对这种位移特别敏感，表现成「人物整体歪了一点」。
  现在缩放后统一向下对齐到 16 的倍数（宁可少 15px 也不超出设定长边），用缩放而不是裁切，
  避免切掉脚尖或手指。
  实测现有 2878 张素材在 512/768/1024/1536 四个档位下**原本就全部对齐**，所以这一条对存量
  素材没有任何变化，纯粹是给以后自己塞异形比例的图兜底。

### 2026-11-03

- **`采样器（一体）` 新增「⚡预设」下拉**（当天晚些时候由「模型预设」改名并挪到第一行，见下条）：
  选中模型就把 `Sigma 曲线 / 采样器 / 调度器 / 步数 / CFG` 五项一次填好，不用每次手调。
  当时 9 个预设：`Qwen-Image 2.1（25步）`、`Qwen-Image 2.1 turbo（8步·固定表）`、`Krea 2 turbo（8步）`、
  `Krea 2 turbo・细节增强（12步）`、`FLUX.2 klein（4步·beta）`、`FLUX.2 klein・高清修复（4步）`、`Z-Image turbo（8步）`、
  `Qwen-Image Layered（9步·CFG2.5）`、`Qwen-Image Edit 2511 AIO（4步）`，外加一个 `手动（不套用）`。
  `降噪` 与 `噪波随机种` 不受预设影响 —— 那两项取决于任务而不是模型。
- **预设是「一键填充」不是「持续锁定」**：套完预设后手改这五项里的任何一个，下拉会自动退回
  `手动（不套用）`。这样控件显示永远是真实状态，不会出现「写着 Qwen 预设、其实在跑 40 步」。
- **预设表只有一份**：写在 `sampler.py` 的 `MODEL_PRESETS`，前端通过
  `GET /toggle_pass/sampler_presets` 拉取，不在 JS 里另抄一份，以后加模型只改 Python。
  每一条的数值都来自本机 `user/default/workflows/` 里实际跑通的工作流，来源文件写在
  `sampler.py` 的注释里。
- **`⚡预设` 挪到参数控件第一行，并和 `Sigma 曲线` 分了名**：原来叫「模型预设」、排在最后一位，
  结果两个问题叠在一起 —— 一是名字太长，窄节点上左边的标题被右边的值整个盖住，
  看着像个无名下拉；二是紧挨着的 `采样方案` 选项也全是「模型名 + 步数」，两个下拉极易被
  当成重复。现在改名为 `⚡预设` / `Sigma 曲线`（**只改 label，内部 name 一个都没动**），
  位置换到所有参数控件的最前面。
- **预设名保持完整模型名，靠节点宽度让标题露出来**：名字一旦缩成 `2511 AIO · 4步` 这种，
  模型一多就分不清谁是谁，所以预设仍用 `Qwen-Image Edit 2511 AIO（4步）` 这类全名。
  实测最长一条 `Qwen-Image Layered（9步·CFG2.5）` 占 238px，加上左侧 47px 的 `⚡预设`，
  节点至少要 350px 宽才不会重叠 ⇒ 新建节点宽度 350，老存档（280/300/340）加载时自动补到 350
  （只加宽不缩窄）。宽度不够时 litegraph 的值是右对齐画的，会把标题整个盖掉，这正是当初
  「看着像没有名字」的真正原因。
- **挪位置不迁移老存档也安全**：1.57 的存档带 `widgets_values_named`（按名字恢复，与顺序无关）；
  更早的纯位置存档交给 `nodeData.fallbackWidgetsValuesNames` 按老顺序重新对号；万一还是有错位，
  加载时发现「模型预设」拿到了采样方案的值会自动退回 `手动（不套用）`。
  已实测四种存档（新建 / 带名字 / 纯位置 10 项 / 纯位置 9 项），七个参数全部各就各位。
  预设改名同样有 `PRESET_ALIASES` 兜底（现在方向是「中途那版短名 → 当前全名」，
  权威副本在 `sampler.py`，由接口下发，前端只留一份启动兜底），存过短名的工作流会自动换回全名。

### 2026-11-02

- **新增节点 `PoseReference`（参考姿势）**：从姿势素材库里选一张参考图，输出标准 `IMAGE`，
  直接接任意编辑模型的 `images` 输入。素材根目录支持三层合并（`TP_POSE_ROOT` 环境变量 →
  `models/pose_reference` → 插件自带 `pose_assets`），同名以靠前的为准。
  `类别 / 姿势组 / 姿势` 三级联动下拉（4 大类、30 组、288 个姿势、5 个视角），
  `源` 可在线稿与深度两套之间切换，`长边` 默认把 300×400 的素材放大到 1024，
  `翻转` 做水平镜像。
- **节点内缩略图（不用执行就能看图）**：任意下拉一改，节点下半部分立刻换成新的姿势图——
  `类别/姿势组/姿势/视角/源/翻转` 六个参数都会触发，120ms 防抖，切得快也不会卡。
  首次加载自动把节点撑高到够放下整张图，之后随节点大小自适应缩放。
  图由新增的 `GET /toggle_pass/pose_image` 路由按参数实时渲染（带浏览器缓存），
  不走 `node.imgs`，因此不依赖前端内部绘制逻辑，换 ComfyUI 版本也不会失效。
- **工作流自带参考图**：选中的素材以 data URI 内嵌进 `properties.tp_pose`，随工作流保存。
  别人下载后即使没有 `D:\pose`，也能看到图并直接出图（后端在素材库取图失败时用
  `extra_pnginfo` 读回内嵌数据）。代价约 +8~14KB/节点；本机素材库存在时优先读素材库。
  缩略图同时改走 `raw=1` 返回素材原文件，单次 6KB（原先渲染成 512 PNG 要 80KB）。
- **示例工作流改为随插件分发**：`example_workflows/Pose Reference Editing.json`。因为素材已经内嵌，
  它不再依赖 `D:\pose`，可直接拖进画布跑通；原先那句「故意不放进 example_workflows」的说法作废。
  注意：内嵌数据只在**保存工作流**时落盘，改动前保存的旧工作流打开后会自动补上，但需要再存一次。
- **素材分成两层，插件自带一份可以直接分发**：新增 `pose_assets/`（1530 张 / 9.6MB），只放
  `上半身单人`、`全身单人・标准系` 两个大类；私密或自建素材留在私有目录。运行时合并成一个索引，
  查找顺序是 **`TP_POSE_ROOT` → `models/pose_reference` → 插件自带**，同名以靠前的为准。
  别人装完节点就有 153 个姿势可用，不需要额外下载任何东西。
- **素材统一收进 `models/pose_reference`**：原先放在 `D:\pose` 的
  `全身单人・性感系`、`双人缠绵` 两个大类（1348 张 / 8.9MB）迁到
  `ComfyUI/models/pose_reference/`，与插件自带的两个大类正好互补、互不重叠，
  合并后仍是 4 类 30 组 288 姿势。这样素材跟着 `models` 备份走，`D:\pose` 不再需要。
- **素材热更新**：新增 `GET /toggle_pass/pose_stamp` 轻量指纹接口，前端每 15 秒比对一次
  （画布上没有本节点时直接跳过）。往 `models/pose_reference` 里丢新姿势组，**约 15 秒内下拉自动出现**，
  删掉同样自动消失，全程不用刷新页面；画布右键另加了 `🔄 刷新姿势素材库` 手动兜底。
  指纹扫到「大类/姿势组」这一层，只看根目录 mtime 是发现不了往已有大类里加新组的。
- **修复「素材更新后下拉切不动、必须重启」**：下拉回调原来在挂载时闭包捕获了当时的素材树，
  素材库热更新后 `node._tpPoseSync` 换了新树，回调却还在用旧的 —— 新增的类别/组切不过去，
  切走再切回会跳回旧内容。改成回调里每次现取 `node._tpPoseSync`。
- **修复「换了素材图不变」**：`pose_image` 原来发 `Cache-Control: public, max-age=86400` 且无
  ETag，浏览器 24 小时内不回源，同名替换素材后永远显示旧图。改成 `no-cache` + `ETag`
  （mtime+size+参数），没变返回 304，变了立刻拿到新内容；同时刷新素材库时会清掉前端的
  URL 去重，让图真的重取。
- **修复「拉目录树失败一次就永久没有联动」**：`fetchTree()` 的 Promise 在失败时会把 `null`
  缓存住，之后所有新建节点都拿这个 `null`，只能刷新页面才恢复。改成失败不留在缓存里，
  下一次自动重试；取图失败时也不再锁住 URL，后端恢复后切回同一姿势会重新请求。
- **修复「生图一开始节点就再也切不动」**：ComfyUI 1.57 前端看到节点有 `node.imgs`，
  就会自动挂一个 `$$canvas-image-preview` 的官方预览 widget —— 它占掉节点底部一行，
  并把执行输出的那张 PNG **画在节点预览区上面**。于是从第一次生成开始，节点下部就被
  一张定死的图盖住：下拉照点、节点自己画的预览在背面也确实换了，但画面上永远不动，
  看着就是"卡死了，只能重启"。现在 `load()` 不再返回 `ui.images`（从根上不产生 `node.imgs`），
  前端另外在 `onExecuted` 和 300ms 巡检里把已挂上的官方预览摘掉，
  已经跑过的工作流不用重建节点也会自己恢复。
- **修复「切下拉图不换，要重启才变」**：以前预览图只靠下拉的 `callback` 通知刷新，
  一旦这条通知漏掉（第三方扩展重写回调、程序化改值、前端版本差异），节点就永远停在上一张图上。
  现在加了两道不依赖回调的自检：绘制时比对参数、以及每 300ms 一次的轻量巡检，
  参数和已加载的图对不上就自己重取。不管是点下拉、拖参数、加载工作流还是脚本改值，图都会跟上。
- **修复「取不到图时假装没事」**：以前任何一次取图失败都会静默退回内嵌图，看起来就是"点了没反应"。
  现在只有内嵌的那张**正好等于当前所选**时才用它兜底，否则节点上直接显示
  `这张没取到（素材库缺失）`，控制台同步打一条 `[PoseReference] 取图失败`，一眼看出卡在哪。
- **排查入口**：浏览器控制台敲 `__tpPoseDiag()`，用表格打印每个节点的选中值、上次请求的 URL、
  已加载图的尺寸、是否来自网络、错误信息。
- 素材库不存在时不再报一句含糊的错：`build_path` 逐根查找，失败信息会列出每个搜过的路径
  以及具体原因（没有该套 / 没有该视角），换机器排查快得多。
- **默认选线稿**：FIBO 2.0 / Qwen-Image-2.1 各两组对照，深度套 3/3 都会自己补出不存在的鞋或护具
  （深度图没有边界线，脚底与地面亮度太接近），线稿套只有 1/3 出现小瑕疵。
- 素材索引带 mtime 缓存，首次扫描约 10ms、之后 0.1ms，增删素材会自动重建。

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
