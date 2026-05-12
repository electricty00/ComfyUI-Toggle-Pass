/**
 * ComfyUI-Toggle-Pass 前端扩展
 * 支持动态输入/输出槽：
 *   - DynamicRefLatentInput:  动态 LATENT 输入槽
 *   - ImageBatcher:           动态 IMAGE 输入槽
 *   - DynamicRefImageEncode:  动态 IMAGE 输入槽
 *   - DynamicRefIndependent:  四项同步增删（IMAGE + prompt + cond + latent）
 */

import { app } from "../../scripts/app.js";

const EXT_NAME = "ComfyUI-Toggle-Pass";

/* ============ 通用节点 ============ */

const DYNAMIC_NODES = {
    "DynamicRefLatentInput":  { widget: "num_latents", inputType: "LATENT", max: 10, prefix: "latent" },
    "ImageBatcher":           { widget: "num_images",  inputType: "IMAGE",  max: 10, prefix: "image"  },
    "DynamicRefImageEncode":  { widget: "num_images",  inputType: "IMAGE",  max: 10, prefix: "image"  },
};

app.registerExtension({
    name: EXT_NAME + "-generic",
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        const cfg = DYNAMIC_NODES[nodeData.name];
        if (!cfg) return;

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                const w = this.widgets?.find(w => w.name === cfg.widget);
                if (w) syncInputs(this, cfg, Math.max(1, Math.min(cfg.max, w.value || 1)));
                // 恢复「图层数」显隐状态
                if (nodeData.name === "DynamicRefImageEncode") {
                    const modelW = this.widgets?.find(w => w.name === "模型类型");
                    const layerW = this.widgets?.find(w => w.name === "图层数");
                    if (modelW && layerW) {
                        layerW.hidden = modelW.value !== "Qwen Layered";
                    }
                }
            });
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpInit) return;
            this._tpInit = true;
            const w = this.widgets?.find(w => w.name === cfg.widget);
            if (!w) return;
            syncInputs(this, cfg, Math.max(1, Math.min(cfg.max, w.value || 1)));
            const prev = w.callback;
            w.callback = function (v) {
                if (prev) prev.call(this, v);
                syncInputs(this._node || this, cfg, Math.max(1, Math.min(cfg.max, v || 1)));
            };
            // 为 DynamicRefImageEncode 设置最小尺寸 + 模型类型联动
            if (nodeData.name === "DynamicRefImageEncode") {
                this._tpMinSize = [270, 310];
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        this.setSize([270, 310]);
                        app.graph.change();
                    });
                });
                // 监听「模型类型」下拉，控制「图层数」显隐
                const modelW = this.widgets?.find(w => w.name === "模型类型");
                const layerW = this.widgets?.find(w => w.name === "图层数");
                if (modelW && layerW) {
                    layerW.hidden = modelW.value !== "Qwen Layered";
                    if (!modelW._tpBound) {
                        modelW._tpBound = true;
                        const prevModel = modelW.callback;
                        modelW.callback = function (v) {
                            if (prevModel) prevModel.call(this, v);
                            layerW.hidden = v !== "Qwen Layered";
                            // 用最小尺寸约束刷新
                            const s = (this._node || this).computeSize();
                            const min = (this._node || this)._tpMinSize || [0, 0];
                            (this._node || this).setSize([Math.max(s[0], min[0]), Math.max(s[1], min[1])]);
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => {
                                    const s2 = (this._node || this).computeSize();
                                    (this._node || this).setSize([Math.max(s2[0], min[0]), Math.max(s2[1], min[1])]);
                                    app.graph.change();
                                });
                            });
                        };
                    }
                }
            }
        };
    },
});

function syncInputs(node, cfg, target) {
    const inputs = node.inputs || [];
    let count = 0;
    for (const inp of inputs) if (inp.type === cfg.inputType) count++;
    if (count === target) return;
    if (count < target) {
        for (let i = count + 1; i <= target; i++) node.addInput(`${cfg.prefix}${i}`, cfg.inputType);
    } else {
        const idx = [];
        for (let i = 0; i < inputs.length; i++) if (inputs[i].type === cfg.inputType) idx.push(i);
        for (let i = 0; i < count - target; i++) node.removeInput(idx[idx.length - 1 - i]);
    }
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            // 用最小尺寸约束，而非固定尺寸
            const s = node.computeSize();
            const min = node._tpMinSize || [0, 0];
            node.setSize([Math.max(s[0], min[0]), Math.max(s[1], min[1])]);
            app.graph.change();
        });
    });
}

/* ============ Ref Independent ============ */

app.registerExtension({
    name: EXT_NAME + "-refind",
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "DynamicRefIndependent") return;

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                const w = this.widgets?.find(w => w.name === "num_images");
                if (!w) return;
                applyRefInd(this, Math.max(1, Math.min(10, w.value || 1)));
            });
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpRefInd) return;
            this._tpRefInd = true;
            const w = this.widgets?.find(w => w.name === "num_images");
            if (!w) return;
            applyRefInd(this, Math.max(1, Math.min(10, w.value || 1)));
            const prev = w.callback;
            w.callback = function (v) {
                if (prev) prev.call(this, v);
                applyRefInd(this._node || this, Math.max(1, Math.min(10, v || 1)));
            };
            // 为 DynamicRefIndependent 设置最小尺寸（宽270, 高310）
            this._tpMinSize = [270, 310];
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.setSize([270, 310]);
                    app.graph.change();
                });
            });
        };
    },
});

function applyRefInd(node, n) {
    const inputs = node.inputs || [];
    let imgCount = 0;
    for (const inp of inputs) if (inp.type === "IMAGE") imgCount++;
    if (imgCount < n) {
        for (let i = imgCount + 1; i <= n; i++) node.addInput(`image${i}`, "IMAGE");
    } else if (imgCount > n) {
        const idx = [];
        for (let i = 0; i < inputs.length; i++) if (inputs[i].type === "IMAGE") idx.push(i);
        for (let i = 0; i < imgCount - n; i++) node.removeInput(idx[idx.length - 1 - i]);
    }
    for (const w of (node.widgets || [])) {
        if (w.name && w.name.startsWith("prompt")) {
            const num = parseInt(w.name.replace("prompt", ""), 10);
            w.hidden = num > n;
        }
    }
    const expected = n * 2;
    while (node.outputs && node.outputs.length > expected) {
        node.removeOutput(node.outputs.length - 1);
    }
    while (node.outputs && node.outputs.length < expected) {
        const i = Math.floor(node.outputs.length / 2) + 1;
        if (node.outputs.length % 2 === 0) {
            node.addOutput(`cond_${i}`, "CONDITIONING");
        } else {
            node.addOutput(`latent${i}`, "LATENT");
        }
    }
    // 用最小尺寸约束，而非固定尺寸
    const min = node._tpMinSize || [0, 0];
    const s = node.computeSize();
    node.setSize([Math.max(s[0], min[0]), Math.max(s[1], min[1])]);
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const s2 = node.computeSize();
            node.setSize([Math.max(s2[0], min[0]), Math.max(s2[1], min[1])]);
            app.graph.change();
        });
    });
}

/* ============ Unified Loader（按钮逐个添加 LoRA）============ */

app.registerExtension({
    name: EXT_NAME + "-unified",
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ToggleUnifiedLoader") return;

        const MAX = 10;

        function getGroup(node, i) {
            const s = String(i);
            return {
                name:  node.widgets.find(w => w.name === `lora_name_${s}`),
                model: node.widgets.find(w => w.name === `lora_strength_model_${s}`),
                clip:  node.widgets.find(w => w.name === `lora_strength_clip_${s}`),
            };
        }

        function refreshSize(node) {
            node.setSize(node.computeSize());
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    node.setSize(node.computeSize());
                    app.graph.change();
                });
            });
        }

        function showGroup(node, i) {
            const g = getGroup(node, i);
            if (!g.name) return;
            g.name.hidden = false;
            const active = g.name.value !== "none";
            if (g.model) g.model.hidden = !active;
            if (g.clip)  g.clip.hidden  = !active;
            if (!g.name._tpBound) {
                g.name._tpBound = true;
                const prev = g.name.callback;
                g.name.callback = function (v) {
                    if (prev) prev.call(this, v);
                    const a = v !== "none";
                    if (g.model) g.model.hidden = !a;
                    if (g.clip)  g.clip.hidden  = !a;
                    refreshSize(node);
                };
            }
            refreshSize(node);
        }

        function hideGroup(node, i) {
            const g = getGroup(node, i);
            if (!g.name) return;
            g.name.hidden  = true;
            if (g.model) g.model.hidden = true;
            if (g.clip)  g.clip.hidden  = true;
        }

        function countVisible(node) {
            let c = 0;
            for (let i = 1; i <= MAX; i++) {
                const g = getGroup(node, i);
                if (g.name && !g.name.hidden) c++;
            }
            return c;
        }

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                // 隐藏全部
                for (let i = 1; i <= MAX; i++) hideGroup(this, i);
                // 恢复：maxActive 之前的所有组都显示
                let maxActive = 0;
                for (let i = 1; i <= MAX; i++) {
                    const g = getGroup(this, i);
                    if (g.name && g.name.value !== "none") maxActive = i;
                }
                for (let i = 1; i <= maxActive; i++) showGroup(this, i);
                // 更新按钮文字
                const addBtn = this.widgets?.find(w => w.name === "_tp_add_lora_btn");
                const rmBtn = this.widgets?.find(w => w.name === "_tp_rm_lora_btn");
                const visible = countVisible(this);
                if (addBtn) addBtn.label = visible >= MAX ? "（已到上限 10）" : "+ 添加 LoRA";
                if (rmBtn) rmBtn.label = visible <= 0 ? "（没有可移除的）" : "- 移除 LoRA";
            });
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpUnified) return;
            this._tpUnified = true;

            const node = this;  // 闭包捕获，确保回调里 this 正确

            // 初始隐藏全部 LoRA 组
            for (let i = 1; i <= MAX; i++) hideGroup(node, i);

            // 添加按钮 widget
            const btn = node.addWidget("button", "+ 添加 LoRA", null, () => {
                for (let i = 1; i <= MAX; i++) {
                    const g = getGroup(node, i);
                    if (g.name && g.name.hidden) {
                        showGroup(node, i);
                        break;
                    }
                }
                updateLabels(node);
            });
            btn.name = "_tp_add_lora_btn";
            btn.label = "+ 添加 LoRA";

            // 移除按钮 widget
            const rmBtn = node.addWidget("button", "- 移除 LoRA", null, () => {
                // 从最后一组开始移除
                for (let i = MAX; i >= 1; i--) {
                    const g = getGroup(node, i);
                    if (g.name && !g.name.hidden) {
                        hideGroup(node, i);
                        g.name.value = "none";  // 重置选择
                        if (g.model) g.model.value = 0;
                        if (g.clip) g.clip.value = 0;
                        break;
                    }
                }
                updateLabels(node);
            });
            rmBtn.name = "_tp_rm_lora_btn";
            rmBtn.label = "- 移除 LoRA";

            function updateLabels(n) {
                const add = n.widgets?.find(w => w.name === "_tp_add_lora_btn");
                const rm = n.widgets?.find(w => w.name === "_tp_rm_lora_btn");
                const visible = countVisible(n);
                if (add) add.label = visible >= MAX ? "（已到上限 10）" : "+ 添加 LoRA";
                if (rm) rm.label = visible <= 0 ? "（没有可移除的）" : "- 移除 LoRA";
            }

            // 设置初始尺寸 宽270,高220
            node.setSize([270, 220]);
            app.graph.change();
        };
    },
});
