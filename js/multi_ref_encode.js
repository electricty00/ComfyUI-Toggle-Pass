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
const FIXED_WIDTH = 300;

/* ============ 通用节点（DynamicRefLatentInput / ImageBatcher / DynamicRefImageEncode）============ */

const DYNAMIC_NODES = {
    "DynamicRefLatentInput":  { widget: "num_latents", inputType: "LATENT", max: 10, prefix: "latent" },
    "ImageBatcher":           { widget: "num_images",  inputType: "IMAGE",  max: 10, prefix: "image"  },
    "DynamicRefImageEncode":  { widget: "num_images",  inputType: "IMAGE",  max: 10, prefix: "image"  },
};

/**
 * 对指定节点启动宽度锁定：
 *   - 劫持 setSize（处理数组和双参数两种调用形式）
 *   - 重写 computeSize 返回固定宽度
 *   - setInterval 每 100ms 强制校正 node.size[0]
 *   - onRemove 时清理 interval
 */
function startWidthLock(node) {
    console.log(`[Toggle-Pass] startWidthLock on ${node.type} #${node.id}`);

    // 1. 劫持 setSize（处理两种调用形式）
    if (!node._tpSetSizeHijacked) {
        node._tpSetSizeHijacked = true;
        const origSetSize = node.setSize;
        node.setSize = function (a, b) {
            if (Array.isArray(a)) {
                a = [FIXED_WIDTH, a[1]];
                return origSetSize.call(this, a);
            } else if (typeof a === "number" && typeof b === "number") {
                return origSetSize.call(this, FIXED_WIDTH, b);
            } else {
                return origSetSize.call(this, a, b);
            }
        };
    }

    // 2. 重写 computeSize
    if (!node._tpComputeSizeHijacked) {
        node._tpComputeSizeHijacked = true;
        const origComputeSize = node.computeSize;
        node.computeSize = function () {
            const s = origComputeSize ? origComputeSize.call(this) : [FIXED_WIDTH, 100];
            if (Array.isArray(s)) {
                return [FIXED_WIDTH, s[1]];
            }
            return [FIXED_WIDTH, s];
        };
    }

    // 3. 立即设置一次
    node.size[0] = FIXED_WIDTH;
    node.setSize(node.size[0], node.size[1]);

    // 4. setInterval 持续校正（每 100ms）
    if (!node._tpIntervalId) {
        node._tpIntervalId = setInterval(() => {
            if (node.size && node.size[0] !== FIXED_WIDTH) {
                console.log(`[Toggle-Pass] correcting width: ${node.size[0]} -> ${FIXED_WIDTH}`);
                node.size[0] = FIXED_WIDTH;
            }
        }, 100);

        // 5. onRemove 时清理 interval
        const origOnRemoved = node.onRemoved;
        node.onRemoved = function () {
            if (node._tpIntervalId) {
                clearInterval(node._tpIntervalId);
                node._tpIntervalId = null;
            }
            origOnRemoved?.apply(this, arguments);
        };
    }
}

app.registerExtension({
    name: EXT_NAME + "-generic",
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        const cfg = DYNAMIC_NODES[nodeData.name];
        if (!cfg) return;

        // onConfigure：从 JSON 恢复后触发
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                const w = this.widgets?.find(w => w.name === cfg.widget);
                if (w) syncInputs(this, cfg, Math.max(1, Math.min(cfg.max, w.value || 1)));
                startWidthLock(this);
            });
        };

        // onNodeCreated：新拖入的节点
        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpInit) return;
            this._tpInit = true;
            const w = this.widgets?.find(w => w.name === cfg.widget);
            if (!w) return;
            syncInputs(this, cfg, Math.max(1, Math.min(cfg.max, w.value || 1)));
            startWidthLock(this);
            const prev = w.callback;
            w.callback = function (v) {
                if (prev) prev.call(this, v);
                syncInputs(this._node || this, cfg, Math.max(1, Math.min(cfg.max, v || 1)));
                startWidthLock(this._node || this);
            };
        };
    },
});

function syncInputs(node, cfg, target) {
    const inputs = node.inputs || [];
    let count = 0;
    for (const inp of inputs) if (inp.type === cfg.inputType) count++;
    if (count === target) { startWidthLock(node); return; }

    if (count < target) {
        for (let i = count + 1; i <= target; i++) node.addInput(`${cfg.prefix}${i}`, cfg.inputType);
    } else {
        const idx = [];
        for (let i = 0; i < inputs.length; i++) if (inputs[i].type === cfg.inputType) idx.push(i);
        for (let i = 0; i < count - target; i++) node.removeInput(idx[idx.length - 1 - i]);
    }
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            node.setSize(node.size[0], node.computeSize()[1]);
            startWidthLock(node);
            app.graph.change();
        });
    });
}

/* ============ Ref Independent（四项同步增删）============ */

app.registerExtension({
    name: EXT_NAME + "-refind",
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "DynamicRefIndependent") return;

        // onConfigure：从 JSON 恢复后触发
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                const w = this.widgets?.find(w => w.name === "num_images");
                if (!w) return;
                const n = Math.max(1, Math.min(10, w.value || 1));
                applyRefInd(this, n);
                startWidthLock(this);
            });
        };

        // onNodeCreated：新拖入的节点
        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpRefInd) return;
            this._tpRefInd = true;
            startWidthLock(this);
            const w = this.widgets?.find(w => w.name === "num_images");
            if (!w) return;
            const n = Math.max(1, Math.min(10, w.value || 1));
            applyRefInd(this, n);
            const prev = w.callback;
            w.callback = function (v) {
                if (prev) prev.call(this, v);
                applyRefInd(this._node || this, Math.max(1, Math.min(10, v || 1)));
                startWidthLock(this._node || this);
            };
        };
    },
});

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
            node.setSize(node.size[0], node.computeSize()[1]);
            startWidthLock(node);
            app.graph.change();
        });
    });
}
