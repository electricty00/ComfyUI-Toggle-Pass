# ComfyUI-Toggle-Pass

DynamicRef 系列节点——多参考图动态编码，支持 1~10 张参考图，每张图独立编码输出。

---

## 节点说明

### DynamicRefIndependent — 多参考图独立编码（核心节点）

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

### DynamicRefImageEncode — 动态参考图编码

单张 prompt 控制，动态增删参考图输入槽。

**输入**：`clip`, `num_images`, `prompt`, `image1` ~ `imageN`
**输出**：`CONDITIONING`, `LATENT`（所有图共享同一份 conditioning，分别输出 latent）

---

### DynamicRefLatentInput — 动态 Latent 输入

动态增删 LATENT 输入槽，配合 DynamicRef 系列使用。

---

### ImageBatcher — 图像批处理

动态增删 IMAGE 输入槽，将多张图打包成批次。

---

### OneImageMultiPrompt — 单图多提示词

一张参考图对应多个提示词，分别输出 conditioning。

---

## 注意事项

- `num_images` 调整时，输入/输出槽会自动增减，**已有连线不会被断开**
- 切换页面再回来，节点会自动恢复到正确的槽位数量
- 需要 Qwen2.5-VL 或兼容的 CLIP 模型支持
- 默认 instruction 适用于 Qwen-Image-Edit 类模型，可按需修改

---

## 安装

将本文件夹放到 `ComfyUI/custom_nodes/` 下，重启 ComfyUI 即可。
