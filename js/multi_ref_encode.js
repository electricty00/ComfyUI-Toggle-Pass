/**
 * ComfyUI-Toggle-Pass 前端扩展
 * 支持动态输入/输出槽：
 *   - DynamicRefLatentInput:  动态 LATENT 输入槽
 *   - ImageBatcher:           动态 IMAGE 输入槽
 *   - DynamicRefImageEncode:  动态 IMAGE 输入槽
 *   - DynamicRefIndependent:  四项同步增删（IMAGE + prompt + cond + latent）
 */

import { app } from "../../scripts/app.js";

console.log("[Toggle-Pass] JS file loaded, app =", typeof app);

const EXT_NAME = "ComfyUI-Toggle-Pass";
const FIXED_WIDTH = 300;

const DYNAMIC_NODES = {
    "DynamicRefLatentInput":  { widget: "num_latents", inputType: "LATENT", max: 10, prefix: "latent" },
    "ImageBatcher":           { widget: "num_images",  inputType: "IMAGE",  max: 10, prefix: "image"  },
    "DynamicRefImageEncode":  { widget: "num_images",  inputType: "IMAGE",  max: 10, prefix: "image"  },
};

function fixWidth(node) {
    node.size[0] = FIXED_WIDTH;
}

app.registerExtension({
    name: EXT_NAME + "-generic",
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        const cfg = DYNAMIC_NODES[nodeData.name];
        if (!cfg) return;
        console.log("[Toggle-Pass] Registering:", nodeData.name);

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                const w = this.widgets?.find(w => w.name === cfg.widget);
                if (w) {
                    const target = Math.max(1, Math.min(cfg.max, w.value || 1));
                    syncInputs(this, cfg, target);
                }
            });
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpInit) return;
            this._tpInit = true;
            console.log("[Toggle-Pass] onNodeCreated:", nodeData.name);
            const w = this.widgets?.find(w => w.name === cfg.widget);
            if (!w) return;
            syncInputs(this, cfg, Math.max(1, Math.min(cfg.max, w.value || 1)));
            const prev = w.callback;
            w.callback = function (v) {
                if (prev) prev.call(this, v);
                syncInputs(this._node || this, cfg, Math.max(1, Math.min(cfg.max, v || 1)));
            };
        };
    },
});

function syncInputs(node, cfg, target) {
    console.log("[Toggle-Pass] syncInputs:", node.type, "target =", target);
    const inputs = node.inputs || [];
    let count = 0;
    for (const inp of inputs) if (inp.type === cfg.inputType) count++;
    if (count === target) { fixWidth(node); return; }

    if (count < target) {
        for (let i = count + 1; i <= target; i++) node.addInput(`${cfg.prefix}${i}`, cfg.inputType);
    } else {
        const idx = [];
        for (let i = 0; i < inputs.length; i++) if (inputs[i].type === cfg.inputType) idx.push(i);
        for (let i = 0; i < count - target; i++) node.removeInput(idx[idx.length - 1 - i]);
    }
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            fixWidth(node);
            app.graph.change();
        });
    });
}

app.registerExtension({
    name: EXT_NAME + "-refind",
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "DynamicRefIndependent") return;
        console.log("[Toggle-Pass] Registering DynamicRefIndependent");

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                const w = this.widgets?.find(w => w.name === "num_images");
                if (!w) return;
                const n = Math.max(1, Math.min(10, w.value || 1));
                applyRefInd(this, n);
            });
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpRefInd) return;
            this._tpRefInd = true;
            console.log("[Toggle-Pass] onNodeCreated DynamicRefIndependent");
            const w = this.widgets?.find(w => w.name === "num_images");
            if (!w) return;
            const n = Math.max(1, Math.min(10, w.value || 1));
            applyRefInd(this, n);
            const prev = w.callback;
            w.callback = function (v) {
                if (prev) prev.call(this, v);
                applyRefInd(this._node || this, Math.max(1, Math.min(10, v || 1)));
            };
        };
    },
});

function applyRefInd(node, n) {
    console.log("[Toggle-Pass] applyRefInd, n =", n);
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

    const expectedCount = n * 2;
    while (node.outputs && node.outputs.length > expectedCount) {
        node.removeOutput(node.outputs.length - 1);
    }
    while (node.outputs && node.outputs.length < expectedCount) {
        const i = Math.floor(node.outputs.length / 2) + 1;
        if (node.outputs.length % 2 === 0) {
            node.addOutput(`cond_${i}`, "CONDITIONING");
        } else {
            node.addOutput(`latent${i}`, "LATENT");
        }
    }

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            fixWidth(node);
            app.graph.change();
        });
    });
}
