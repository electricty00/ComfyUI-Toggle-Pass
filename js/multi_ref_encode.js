/**
 * ComfyUI-Toggle-Pass 前端扩展
 * 支持动态输入/输出槽：
 *   - DynamicRefLatentInput:  动态 LATENT 输入槽
 *   - ImageBatcher:           动态 IMAGE 输入槽
 *   - DynamicRefImageEncode:  动态 IMAGE 输入槽
 *   - DynamicRefIndependent:  四项同步增删（IMAGE + prompt + cond + latent）
 *
 * 架构说明：
 *   使用 beforeRegisterNodeDef + onConfigure/onNodeCreated 模式，
 *   而非 nodeCreated/nodeAdded + setTimeout。
 *   原因：nodeCreated/nodeAdded 触发时 widget 值可能尚未从 JSON 恢复，
 *   setTimeout 无法可靠保证时序，且切页面时可能与 onConfigure 打架。
 *   onConfigure 在 widget 值恢复之后触发，可安全读取 w.value。
 */

import { app } from "../../scripts/app.js";

const EXT_NAME = "ComfyUI-Toggle-Pass";

/* ============ 通用节点（DynamicRefLatentInput / ImageBatcher / DynamicRefImageEncode）============ */

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

        // 强制固定宽度 300，高度自适应
        const FIXED_WIDTH = 300;
        const origComputeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function () {
            const s = origComputeSize ? origComputeSize.call(this) : [FIXED_WIDTH, 100];
            return [FIXED_WIDTH, Array.isArray(s) ? s[1] : s];
        };

        // onConfigure：从 JSON 恢复后触发，widget 值已正确
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                const w = this.widgets?.find(w => w.name === cfg.widget);
                if (w) syncInputs(this, cfg, Math.max(1, Math.min(cfg.max, w.value || 1)));
            });
        };

        // onNodeCreated：新拖入的节点（无 JSON 恢复），用默认值初始化
        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpInit) return;
            this._tpInit = true;
            this.setSize([FIXED_WIDTH, this.computeSize()[1]]);
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
    // 固定宽度，只调高度，避免 computeSize 返回的宽高比丑
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const s = node.computeSize();
            node.setSize([300, s[1]]);
            app.graph.change();
        });
    });
}

/* ============ Ref Independent（四项同步增删）============ */

app.registerExtension({
    name: EXT_NAME + "-refind",
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "DynamicRefIndependent") return;

        // 强制固定宽度 300，高度自适应
        const FIXED_WIDTH = 300;
        const origComputeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function () {
            const s = origComputeSize ? origComputeSize.call(this) : [FIXED_WIDTH, 100];
            return [FIXED_WIDTH, Array.isArray(s) ? s[1] : s];
        };

        // onConfigure：从 JSON 恢复后触发，此时 widget 值已正确，输出槽为后端全量（20个）
        // 用 w.value 裁剪到 N*2 个
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

        // onNodeCreated：新拖入的节点（首次创建，无 JSON 恢复）
        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpRefInd) return;
            this._tpRefInd = true;
            this.setSize([FIXED_WIDTH, this.computeSize()[1]]);
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

/**
 * Ref Independent：同步增删
 *   1. IMAGE 输入槽：image1 ~ imageN（增删）
 *   2. prompt 控件：prompt1 ~ promptN（hidden 显示/隐藏）
 *   3. 输出槽：cond_1, latent1, cond_2, latent2, ..., cond_N, latentN（增删，交替排列）
 *
 * 关键：输出顺序必须和后端 RETURN_TYPES 交替排列一致：
 *   RETURN_TYPES = (CONDITIONING, LATENT, CONDITIONING, LATENT, ...)
 *   后端固定 20 个输出，前端通过 removeOutput 裁剪到 N*2 个
 *   裁剪时从末尾移除，保留前 N*2 个（index 0~2N-1），这样已有连线不受影响
 */
function applyRefInd(node, n) {
    // ---- 1. 增删 IMAGE 输入槽 ----
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

    // ---- 2. 隐藏/显示 prompt 控件 ----
    for (const w of (node.widgets || [])) {
        if (w.name && w.name.startsWith("prompt")) {
            const num = parseInt(w.name.replace("prompt", ""), 10);
            w.hidden = num > n;
        }
    }

    // ---- 3. 调整输出槽 ----
    // 后端固定 20 个输出（10 对 cond_X/latentX），需要裁剪到 N*2 个
    // 策略：只从末尾 removeOutput，不重建前面的，保护已有连线
    const expectedCount = n * 2;
    while (node.outputs && node.outputs.length > expectedCount) {
        node.removeOutput(node.outputs.length - 1);
    }
    // 如果不够（理论上不应该发生，除非后端定义改了），补齐
    while (node.outputs && node.outputs.length < expectedCount) {
        const i = Math.floor(node.outputs.length / 2) + 1;
        if (node.outputs.length % 2 === 0) {
            node.addOutput(`cond_${i}`, "CONDITIONING");
        } else {
            node.addOutput(`latent${i}`, "LATENT");
        }
    }

    // 固定宽度 300，只调高度
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const s = node.computeSize();
            node.setSize([300, s[1]]);
            app.graph.change();
        });
    });
}
