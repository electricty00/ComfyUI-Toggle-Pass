/**
 * ComfyUI-Toggle-Pass 前端扩展
 * 支持动态输入/输出槽：
 *   - DynamicRefLatentInput:  动态 LATENT 输入槽
 *   - ImageBatcher:           动态 IMAGE 输入槽
 *   - DynamicRefImageEncode:  动态 IMAGE 输入槽
 *   - DynamicRefIndependent:  四项同步增删（IMAGE + prompt + cond + latent）
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXT_NAME = "ComfyUI-Toggle-Pass";

/* ============ 通用节点 ============ */

const DYNAMIC_NODES = {
    "DynamicRefLatentInput":  { widget: "num_latents", inputType: "LATENT", max: 10, prefix: "latent" },
    "ImageBatcher":           { widget: "num_images",  inputType: "IMAGE",  max: 10, prefix: "image"  },
    "DynamicRefImageEncode":  { widget: "num_images",  inputType: "IMAGE",  max: 10, prefix: "image"  },
};

/* ---- 按「模型类型」显示/隐藏相关参数 ---- */
// 只有 Qwen Image 2.1 用得到的一组分辨率参数；选其他模型时全部藏起来
const RES21_WIDGETS = ["宽高比", "百万像素", "倍数", "参考图分辨率", "尺寸适配"];
const MANUAL_RATIO = "自定义（用输出宽度/高度）";

/* ---- 参数自愈：旧工作流按位置回填导致错位时自动归位 ----
 * 成因：ComfyUI 的 widgets_values 是「按位置」存的。给节点新增/调整参数后，
 * 旧工作流的值会被回填到错误的位置，于是出现「尺寸适配 = 32」「倍数 = NaN」
 * 「百万像素 = 1024.0」这类脏值（枚举值不在选项内 / 数值 NaN 或越界）。
 * 这里在节点创建与加载时逐项校验，非法即恢复为安全默认值。
 */
const SIZE_PARAM_DEFAULTS = {
    "输出宽度": 1024,
    "输出高度": 1024,
    "尺寸适配": "参考图保比例",
    "图层数": 3,
    "宽高比": "1:1 (Square)",
    "百万像素": 1.0,
    "倍数": 32,
    "参考图分辨率": 1024,
};

function isSaneValue(name, v, w) {
    const opts = w?.options || {};
    let values = opts.values;
    if (typeof values === "function") {
        try { values = values(w); } catch (e) { values = null; }
    }
    if (Array.isArray(values) && values.length) {
        // 枚举型：值必须真的出现在下拉选项里
        const flat = values.map(o => (o && typeof o === "object") ? o.value : o);
        return flat.includes(v);
    }
    // 数值型：必须有限、且在 min/max 内
    const n = Number(v);
    if (!isFinite(n)) return false;
    if (opts.min != null && n < opts.min) return false;
    if (opts.max != null && n > opts.max) return false;
    // 参考图分辨率：0 = 保持原尺寸，其余必须 >= 256（低于此只可能是错位残留）
    if (name === "参考图分辨率") return n === 0 || n >= 256;
    return true;
}

function sanitizeSizeParams(node) {
    let changed = false;
    for (const [name, def] of Object.entries(SIZE_PARAM_DEFAULTS)) {
        const w = (node.widgets || []).find(x => x.name === name);
        if (!w) continue;
        if (!isSaneValue(name, w.value, w)) {
            w.value = def;
            changed = true;
        }
    }
    return changed;
}

function refreshNodeSize(node) {
    const s = node.computeSize();
    const min = node._tpMinSize || [0, 0];
    node.setSize([Math.max(s[0], min[0]), Math.max(s[1], min[1])]);
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const s2 = node.computeSize();
            node.setSize([Math.max(s2[0], min[0]), Math.max(s2[1], min[1])]);
            app.graph.change();
        });
    });
}

function applyModelVisibility(node) {
    const get = n => (node.widgets || []).find(w => w.name === n);
    const mw = get("模型类型");
    const model = mw ? mw.value : null;
    const is21 = model === "Qwen Image 2.1";
    const isLayered = model === "Qwen Layered";

    // 2.1 专属参数：只在选 Qwen Image 2.1 时露出
    for (const n of RES21_WIDGETS) {
        const w = get(n);
        if (w) w.hidden = !is21;
    }
    // 图层数：只在 Qwen Layered 时露出
    const layer = get("图层数");
    if (layer) layer.hidden = !isLayered;
    // 输出宽度/高度：2.1 下只有在「自定义」宽高比时才需要，其他模型一直显示
    const ar = get("宽高比");
    const needManual = is21 && ar && ar.value === MANUAL_RATIO;
    for (const n of ["输出宽度", "输出高度"]) {
        const w = get(n);
        if (w) w.hidden = is21 && !needManual;
    }
    refreshNodeSize(node);
}

function bindModelVisibility(node) {
    for (const n of ["模型类型", "宽高比"]) {
        const w = (node.widgets || []).find(x => x.name === n);
        if (w && !w._tpVisBound) {
            w._tpVisBound = true;
            const prev = w.callback;
            w.callback = function (v) {
                if (prev) prev.call(this, v);
                applyModelVisibility(node);
            };
        }
    }
}

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
                // 恢复「按模型类型显隐」状态（加载旧工作流后也要正确）
                if (nodeData.name === "DynamicRefImageEncode") {
                    // 先修脏值（旧工作流参数错位会留下 NaN / 越界 / 非法枚举），再定显隐
                    sanitizeSizeParams(this);
                    applyModelVisibility(this);
                    bindModelVisibility(this);
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
                // 按「模型类型」控制参数显隐（2.1 才显示分辨率那组，Layered 才显示图层数）
                sanitizeSizeParams(this);
                applyModelVisibility(this);
                bindModelVisibility(this);
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
                sanitizeSizeParams(this);
                applyModelVisibility(this);
                bindModelVisibility(this);
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
            // 按「模型类型」控制参数显隐
            sanitizeSizeParams(this);
            applyModelVisibility(this);
            bindModelVisibility(this);
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

/* ============ One Image Multi Prompt（一图多视角）============ */

app.registerExtension({
    name: EXT_NAME + "-oneimg",
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "OneImageMultiPrompt") return;

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                const w = this.widgets?.find(x => x.name === "prompt数量");
                if (w) applyOneImgPrompts(this, Math.max(2, Math.min(8, w.value || 2)));
                sanitizeSizeParams(this);       // 旧工作流错位留下的脏值先归位
                applyModelVisibility(this);     // 再按模型类型定显隐
                bindModelVisibility(this);
                bindPromptCount(this);
            });
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpOneImg) return;
            this._tpOneImg = true;
            const w = this.widgets?.find(x => x.name === "prompt数量");
            if (!w) return;
            applyOneImgPrompts(this, Math.max(2, Math.min(8, w.value || 2)));
            this._tpMinSize = [300, 310];
            sanitizeSizeParams(this);
            applyModelVisibility(this);
            bindModelVisibility(this);
            bindPromptCount(this);
        };
    },
});

function applyOneImgPrompts(node, n) {
    for (const w of (node.widgets || [])) {
        // 只匹配 prompt1~prompt8，不匹配「prompt数量」
        if (w.name && /^prompt\d+$/.test(w.name)) {
            const num = parseInt(w.name.replace("prompt", ""), 10);
            w.hidden = num > n;
        }
    }
}

function bindPromptCount(node) {
    const w = (node.widgets || []).find(x => x.name === "prompt数量");
    if (!w || w._tpCountBound) return;
    w._tpCountBound = true;
    const prev = w.callback;
    w.callback = function (v) {
        if (prev) prev.call(this, v);
        const n = this._node || this;
        applyOneImgPrompts(n, Math.max(2, Math.min(8, v || 2)));
        refreshNodeSize(n);
    };
}

/* ============ Unified Loader（按钮逐个添加 LoRA）============ */

app.registerExtension({
    name: EXT_NAME + "-unified",
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ToggleUnifiedLoader") return;

        const MAX = 10;

        /* ---- 加载模式：一体包 vs 分离组件，按模式只显示用得上的参数 ---- */
        const MODE_SPLIT = "分离组件 (UNet+CLIP+VAE)";
        const MODE_CKPT = "Checkpoint 一体包";
        const SPLIT_WIDGETS = ["unet_name", "clip_name", "vae_name", "clip_type"];
        const CKPT_WIDGETS = ["ckpt_name"];

        /* ---- 加载模式：画成一个 UNet / Checkpoint 分段开关 ----
         * 为什么是「改造原 combo」而不是「再新增一个开关控件」：
         *   widgets_values 是按位置存的，多一个 widget 会让旧工作流整体串位；前端也不允许用
         *   serialize:false 来"删参数"（同样会让值整体前移）。所以这里 widget 对象、名字、
         *   值域、在列表里的位置全都不动，只把它的 draw / mouse 换成自绘开关 ——
         *   序列化与旧工作流兼容性零影响，自绘失败还会回落成原生下拉。
         *   点击哪一段就把 combo 的值改成那一段对应的枚举字符串（不硬编码文案）。 */
        const MODE_TEXT = ["UNet", "Checkpoint"];
        /* 量不到字体宽度时的估算用：最长标签的字符数（配合平均字宽 0.545em） */
        const MODE_MAX_CHARS = MODE_TEXT.reduce((a, t) => Math.max(a, String(t).length), 0);
        const MODE_TIP = "加载模式：UNet = 分离组件（UNet + CLIP + VAE 各一个文件）/ Checkpoint = 一体包";
        const TG_PAD_Y = 3;   // 胶囊在插槽行内的上下留白（左右对齐交给 tpWidgetMargin()）
        /* 滑块相对轨道的内缩量。轨道净高 = 行高 - TG_PAD_Y*2 = 14（行高 20 时）；
         * 滑块高 = 14 - 内缩*2 = 12，半高 6 —— 得装得下「上沿/2 + 下沿」：
         * 文字按视觉盒居中（基线 = 胶囊中心 + 上沿/2，见 tpTextBaselineY），降部落到基线下方一个「下沿」。
         * ⚠️ 这个约束必须用**真机主画布 ctx**（Arial 口径）量：11px "Checkpoint" 上沿 8 / 下沿 2
         *   ⇒ 需要 4 + 2 = 6，滑块半高 6 —— 正好贴边、不溢出。
         *   若拿游离 canvas 的偏大口径（9 / 3 ⇒ 7.5）算，就会被误判成放不下而**把胶囊撑高**
         *   （2026-10-10.5 正是这么误加的：轨道 16 / 滑块 14，用户反馈「胶囊变粗了」）。
         *   ⇒ 以后要动这两个常量，先用 probe_main_ctx_metrics.mjs 量准，别凭感觉。 */
        const MODE_KNOB_INSET = 1;
        /* 文字相对「理想视觉居中位」的垂直微调（负 = 往上，正 = 往下）。
         * 理想位（0）：基线 = 胶囊中心 + 上沿/2 —— 此时「字母顶沿到滑块顶」与「基线到滑块底」相等。
         * 用户实测微调旋钮：-1 = 整体上移 1px（降部跟着上移，上边留白更少）。 */
        const MODE_TEXT_DY = -1;
        const TG_TRACK = "rgba(126,138,156,0.30)";
        const TG_LINE = "rgba(126,138,156,0.55)";
        const TG_KNOB = "rgba(58,150,243,0.95)";
        const TG_HOVER = "rgba(126,138,156,0.22)";
        const TG_TEXT_ON = "#ffffff";
        const TG_TEXT_OFF = "rgba(155,163,175,1)";
        const CKPT_RE = /checkpoint|一体/i;
        /* 构建标记：改造生效时会在控制台打一行，方便一眼确认前端加载的是不是新版（没这行 = 没刷新） */
        const TP_MODE_BUILD = "2026-10-10.8";

        /* ⚠️ 踩过的真坑（本机前端 1.53.10 实测）：新版 node.size / node.pos 是**类数组对象**，
         * JSON 出来是 {"0":270,"1":220}，`Array.isArray(node.size)` 恒为 false。
         * 拿它算宽度会得到 0 → 开关/命中判定直接罢工（症状就是「点了没反应」）。
         * 所以一律按下标取数：typeof v[0] === "number" 才算有效。 */
        function numAt(v, i) {
            const x = v?.[i];
            return (typeof x === "number" && isFinite(x)) ? x : null;
        }

        /** combo 的真实选项列表（备选项可能是 {value,text} 对象） */
        function modeRawValues(w) {
            let v = w?.options?.values;
            if (typeof v === "function") { try { v = v(w); } catch (e) { v = null; } }
            if (!Array.isArray(v)) return [];
            return v.map(o => (o && typeof o === "object") ? o.value : o)
                .filter(x => typeof x === "string");
        }

        /** 0 = UNet（分离组件）/ 1 = Checkpoint（一体包） */
        function modeIndexOf(value) { return CKPT_RE.test(String(value ?? "")) ? 1 : 0; }

        /** 取第 idx 档在 Python 枚举里的真实字符串（文案改了也不会崩） */
        function modeValueFor(w, idx) {
            const vals = modeRawValues(w);
            const ck = vals.findIndex(v => CKPT_RE.test(v));
            if (ck >= 0 && vals.length >= 2) {
                return idx === 1 ? vals[ck] : vals[ck === 0 ? 1 : 0];
            }
            return idx === 1 ? MODE_CKPT : MODE_SPLIT;
        }

        function modeWidget(node) { return (node.widgets || []).find(w => w.name === "加载模式"); }
        function getModeIndex(node) { return modeIndexOf(modeWidget(node)?.value); }

        /** 切档：改值 + 走原有回调链（bindLoaderMode 的包装在里面 → 自动重排显隐） */
        function setModeIndex(node, idx, opts) {
            const w = modeWidget(node);
            if (!w) return;
            const v = modeValueFor(w, idx);
            const o = opts || { e: null, node, canvas: app.canvas };
            if (w.value === v) {
                node.setDirtyCanvas?.(true, true);
                return;
            }
            try {
                /* 新版前端：走官方 setValue（内部会调 callback、并通知图已变更）；
                 * 老版没有 setValue，就自己改值 + 手动跑回调。 */
                if (typeof w.setValue === "function") {
                    w.setValue(v, o);
                } else {
                    w.value = v;
                    w.callback?.(v, app.canvas, node, [0, 0], null);
                }
            } catch (e) {
                console.warn("[Toggle-Pass] 加载模式切换失败，直接改值兜底", e);
                w.value = v;
                try { w.callback?.(v, app.canvas, node, [0, 0], null); } catch (e2) { /* 兜底也失败就只改值 */ }
            }
            app.graph?.change?.();
            node.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
        }

        function tpRoundRect(ctx, x, y, w, h, r) {
            const rr = Math.max(0, Math.min(r, h / 2, w / 2));
            ctx.beginPath();
            ctx.moveTo(x + rr, y);
            ctx.lineTo(x + w - rr, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
            ctx.lineTo(x + w, y + h - rr);
            ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
            ctx.lineTo(x + rr, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
            ctx.lineTo(x, y + rr);
            ctx.quadraticCurveTo(x, y, x + rr, y);
            ctx.closePath();
        }

        /* 与原生 widget 的左边缘对齐。
         * 前端 widgets/BaseWidget.ts 里 `static margin = 15`（注释：From node edge to widget edge），
         * widget 外框画在 `roundRect(margin, y, width - margin*2, height)` —— 所以下面所有下拉框
         * 的左边缘都在节点内 x=15。我们的开关要跟它们齐平，就取这个值。
         * 运行时 BaseWidget 未必挂在全局（实测本机 window.BaseWidget 为 null），拿不到就按 15 兜底。 */
        function tpWidgetMargin() {
            const m = globalThis.BaseWidget?.margin;
            return (typeof m === "number" && m >= 0 && m <= 40) ? m : 15;
        }

        /* 量「两段标签的并集字形盒」（相对字母基线）：{ w 最大宽, up 上沿, dn 下沿 }。
         * 两段取并集是为了共用一条基线 —— 否则 "UNet"（无降部）会比 "Checkpoint" 浮高一截。
         * ⚠️ actualBoundingBox* 的语义**跟随 textBaseline**（实测确认），所以量之前必须切回 alphabetic。
         * ⚠️⚠️ 必须用**真正绘制的那个 ctx** 量：真机实测同一个 "600 11px sans-serif"，
         *   app.canvas.ctx（挂在 DOM 上的画布）→ Arial 口径（上沿 8 / 下沿 2 / 宽 59.89），
         *   而 document.createElement('canvas')（游离画布）→ 另一套（上沿 9 / 下沿 3 / 宽 62.64）。
         *   拿游离 canvas 量会偏大一号 ⇒ 字号被误判成放不下而白缩一级。
         * 量不到（老环境 / 被 mock）就按 Arial 口径兜底：0.73 / 0.20 倍字号、平均字宽 0.545 倍。 */
        function tpGlyphBox(ctx, fs) {
            let w = 0, up = 0, dn = 0, got = false;
            try {
                if (typeof ctx?.measureText === "function") {
                    const prev = ctx.textBaseline;
                    ctx.textBaseline = "alphabetic";
                    ctx.font = `600 ${fs}px sans-serif`;
                    for (let i = 0; i < MODE_TEXT.length; i++) {
                        const m = ctx.measureText(MODE_TEXT[i]);
                        if (!m) continue;
                        if (typeof m.width === "number" && isFinite(m.width)) w = Math.max(w, m.width);
                        const u = m.actualBoundingBoxAscent, d = m.actualBoundingBoxDescent;
                        if (typeof u === "number" && isFinite(u)) { up = Math.max(up, u); got = true; }
                        if (typeof d === "number" && isFinite(d)) dn = Math.max(dn, d);
                    }
                    ctx.textBaseline = prev;
                }
            } catch (e) { /* 落到比例兜底 */ }
            if (!got) { up = fs * 0.73; dn = fs * 0.20; }
            if (!(w > 0)) w = fs * 0.545 * MODE_MAX_CHARS;   // 连宽度都量不到 → 按平均字宽估
            return { w, up, dn };
        }

        /* 文字基线：让文字**看着居中**于胶囊 —— 按「视觉盒」居中（大写字母顶沿与基线对称），
         * 而不是按「含降部的字形盒」居中。
         * 为什么：按字形盒居中时，"Checkpoint" 的 p 降部把整个盒子往下拽，为了让它不掉出去，
         * 大写字母只好整体上移 —— 肉眼就是「上面空得少、下面空得多」（用户报的就是这个）。
         * 用户要的是字母居中 ⇒ 基线 = cy + 上沿/2（上沿取两段并集，共用一条基线）。
         * 前提：滑块得装得下「上沿/2 + 下沿」，由调用方按这个约束挑字号（见 drawModeToggle）。
         * 最后再叠加 MODE_TEXT_DY（用户实测微调，负 = 往上）。 */
        function tpTextBaselineY(ctx, cy, fs) {
            return cy + tpGlyphBox(ctx, fs).up / 2 + MODE_TEXT_DY;
        }

        /* 自绘：一条胶囊轨道 + 当前档的高亮滑块 + 两段文字（不画 label，整行都是开关）
         * 参数：bw = 胶囊宽（不是整行宽）；x0 = 胶囊左端（节点内坐标，取 tpWidgetMargin() 与上面下拉框对齐） */
        function drawModeToggle(ctx, w, bw, y, H, x0) {
            const h = H || 22;
            const left = (typeof x0 === "number" && x0 >= 0) ? x0 : tpWidgetMargin();
            const y0 = y + TG_PAD_Y;
            const bh = h - TG_PAD_Y * 2;
            if (bw < 24 || bh < 8) return;
            const idx = modeIndexOf(w.value);
            const seg = bw / 2;
            ctx.save();
            tpRoundRect(ctx, left, y0, bw, bh, bh / 2);
            ctx.fillStyle = TG_TRACK;
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = TG_LINE;
            ctx.stroke();
            // 悬停的那一段（非当前档）给一点反馈
            const hv = w._tpHover;
            if ((hv === 0 || hv === 1) && hv !== idx) {
                tpRoundRect(ctx, left + hv * seg + MODE_KNOB_INSET, y0 + MODE_KNOB_INSET,
                    seg - MODE_KNOB_INSET * 2, bh - MODE_KNOB_INSET * 2, (bh - MODE_KNOB_INSET * 2) / 2);
                ctx.fillStyle = TG_HOVER;
                ctx.fill();
            }
            // 当前档的滑块。
            // ⚠️ 内缩量决定滑块高度，滑块得装得下「基线以上的字母 + 基线以下的降部」：
            // 文字按视觉盒居中后，降部落在基线下方整一个「下沿」。
            // 真机 Arial 口径 11px "Checkpoint"：上沿 8 / 下沿 2 ⇒ 需 4 + 2 = 6；
            // 轨道净高 bh=14、内缩 1 → 滑块 12（半高 6）⇒ 正好贴边，降部不戳出。
            // （轨道/滑块尺寸维持原样，不加高 —— 用户明确不要「更粗的胶囊」。）
            tpRoundRect(ctx, left + idx * seg + MODE_KNOB_INSET, y0 + MODE_KNOB_INSET,
                seg - MODE_KNOB_INSET * 2, bh - MODE_KNOB_INSET * 2, (bh - MODE_KNOB_INSET * 2) / 2);
            ctx.fillStyle = TG_KNOB;
            ctx.fill();
            // 两段文字：字号要同时满足「宽度放得下最长那段」和「高度装得下含降部的字形盒」
            // · 宽度：实测 600 11px 下 "Checkpoint" = 59.9px，胶囊一缩水就不够，硬画会截成 "Checkp…"
            // · 高度：基线改成「按视觉盒居中」后，降部要从基线往下吃掉半个滑块
            ctx.textAlign = "center";
            const knobH = bh - MODE_KNOB_INSET * 2;
            const limitW = seg - 10;         // 每段两侧各留 5px
            const fits = (size) => {
                const g = tpGlyphBox(ctx, size);
                return g.w <= limitW && (g.up / 2 + g.dn) <= knobH / 2;
            };
            let fs = Math.min(13, Math.max(9, Math.round(bh * 0.85)));
            while (fs > 9 && !fits(fs)) fs -= 1;
            ctx.font = `600 ${fs}px sans-serif`;
            // 基线 = 胶囊中心 + 上沿/2 ⇒「大写字母顶沿到滑块顶」= 「基线到滑块底」= 看着居中
            ctx.textBaseline = "alphabetic";
            const ty = tpTextBaselineY(ctx, y0 + bh / 2, fs);
            for (let i = 0; i < 2; i++) {
                ctx.fillStyle = i === idx ? TG_TEXT_ON : TG_TEXT_OFF;
                ctx.fillText(MODE_TEXT[i], left + seg * i + seg / 2, ty);
            }
            ctx.restore();
        }

        /* 回落方案（widget 内自绘）里「胶囊」的真实范围：
         * widget 占整行，但胶囊只在 `左边距 .. (行宽 - 左边距)` 之内、且宽度封顶 MODE_ROW_MAX。
         * ★ 命中判定必须和绘制共用这一套几何，否则分界会跟眼睛看到的不一致 ——
         *   例：节点宽 270 → 胶囊只有 147（15..162），左右分界在 88.5；
         *   若按「整行宽的一半」(135) 判档，点在 88.5~135 之间就会切错档。
         * （宽度来源：绘制传进来的行宽；命中判定时退到 node.size[0]） */
        function widgetCapsule(node, width) {
            const ww = (typeof width === "number" && width > 0) ? width : (numAt(node?.size, 0) || 0);
            const m = tpWidgetMargin();
            return { x: m, w: Math.min(MODE_ROW_MAX, Math.max(0, ww - m * 2)) };
        }

        /* 点击位置换算成节点内坐标。
         * 不同前端版本传给 widget.mouse 的 pos 有的是节点内坐标、有的是画布坐标，
         * 这里按「值明显超出节点宽度」来判别并兜底换算。 */
        function toggleLocalX(node, pos, event) {
            const ew = numAt(node?.size, 0) || 0;
            const x = numAt(pos, 0);
            if (x !== null && (ew <= 0 || (x >= 0 && x <= ew + 2))) return x;
            if (typeof event?.canvasX === "number") return event.canvasX - (node?.pos?.[0] || 0);
            return x === null ? 0 : x;
        }

        /* ★ 首选点击入口（onPointerDown）的坐标换算：
         * 前端 processWidgetClick() 里对自定义 widget 的第一优先分支就是
         *   if (typeof widget.onPointerDown === 'function') { if (widget.onPointerDown(pointer, node, canvas)) return }
         * —— 比 onClick / mouse 都早，返回真值即吃掉本次点击，原生下拉不会弹。
         * 该回调拿到的是 CanvasPointer（本身没有 canvasX 字段），所以坐标优先取 canvas.graph_mouse
         * （前端自己算点击落点时用的也是它），兜底再从 pointer.eDown / eUp / eMove 取 canvasX。
         * 解析不出来返回 null：宁可不响应，也不要乱跳档（跳错档会让整条加载链错位）。 */
        function modeLocalXFromPointer(pointer, node, canvas) {
            const px = node?.pos?.[0] || 0;
            const gx = numAt(canvas?.graph_mouse, 0);
            if (gx !== null) return gx - px;
            const ev = pointer?.eDown || pointer?.eUp || pointer?.eMove || pointer?.e;
            if (ev && typeof ev.canvasX === "number") return ev.canvasX - px;
            return null;
        }

        /* 从两种回调签名里解析「点到哪一档」
         *   新版：onClick({ e, node, canvas }) —— 只有 e.canvasX（画布坐标），自己减 node.pos
         *   老版：mouse(e, [x, y], node) / onClick(e, pos, node) —— 直接给节点内坐标
         * 解析不出来返回 null：宁可不响应，也不要乱跳档（跳错档会让整条加载链错位）。 */
        function resolveToggleHit(node, w, a, b, c) {
            let n = node, e = null, pos = null;
            if (a && typeof a === "object" && !Array.isArray(a) && (a.node || a.canvas)) {
                n = a.node || node;
                e = a.e || null;
            } else if (numAt(b, 0) !== null) {
                e = a; pos = b; n = c || node;
            } else {
                e = a; n = c || node;
            }
            const cap = widgetCapsule(n, w?.width);
            if (!(cap.w > 0)) return null;
            let x = NaN;
            if (pos) x = toggleLocalX(n, pos, e);
            else if (e && typeof e.canvasX === "number") x = e.canvasX - (n?.pos?.[0] || 0);
            if (!isFinite(x)) return null;
            /* 点在胶囊外 → 不算命中：既不吞事件（原生下拉/节点拖动照旧），也不误切档。
             * 分界用胶囊自己的中心（与绘制一致），不是整行中心。 */
            if (x < cap.x || x > cap.x + cap.w) return null;
            return { node: n, e, idx: x < cap.x + cap.w / 2 ? 0 : 1 };
        }

        /* ---- 开关摆放位置：节点顶部第一行（与输出插槽「模型 / MODEL」同行）----
         * 为什么不用 widget 承载：widget 的 y 由前端布局算（本地 y = 插槽区之下），
         * 而用户要的位置是「插槽行左侧那块空白」→ 只能自己画。
         * 做法：
         *   1) 把「加载模式」widget 置 hidden —— 前端 isWidgetVisible()/getLayoutWidgets()
         *      会跳过它（不绘制、不参与尺寸计算），但它**仍然在 node.widgets 数组里**，
         *      序列化 widgets_values / 提交 / API 参数完全不受影响；
         *   2) 改由节点级钩子接管：
         *      · node.onDrawForeground(ctx, canvas, canvasEl) → 自绘。
         *        它在 drawNode 里位于「插槽绘制之前」（LGraphCanvas.ts:5843），不会被插槽盖住；
         *      · node.onMouseDown(e, pos, canvas) → 命中即切档并 return true 吃掉事件
         *        （不返回真值会被当成「点节点空白」→ 触发拖动）。
         * Vue 节点模式（前端「现代节点设计」）不走这两个钩子 → 回落到 widget 自绘方案。 */
        /* 开关尺寸与摆放（x/w 指「胶囊本身」的范围，左右端点都在节点内坐标）
         * · 左端 = tpWidgetMargin()，与下面所有下拉框的左边缘严格对齐；
         * · MODE_ROW_MAX = 147 —— 旧版胶囊可见宽 184px 的 80%（用户要求「再缩小 20%」）；
         *   固定值而非百分比：两档宽度完全一致，切档时开关不会再跳；
         * · MODE_ROW_GAP = 45 —— 胶囊右端到节点右边至少留这么多。插槽标签「模型」是
         *   textAlign=right 画在 nw-10、实测 14px 字体下宽 28px（NodeSlot.draw: pos[0]-10），
         *   即标签左边界 ≈ nw-38，再给圆点留一点，取 45 是安全线；
         * · MODE_ROW_MIN = 120 —— 节点被手动拉得极窄时的兜底。 */
        const MODE_ROW_GAP = 45;
        const MODE_ROW_MIN = 120;
        const MODE_ROW_MAX = 147;

        /** 开关在节点本地坐标里的位置与尺寸（x/w 都是「胶囊本身」的范围） */
        function modeRowGeom(node) {
            const SH = Number(globalThis.LiteGraph?.NODE_SLOT_HEIGHT) || 20;
            const nw = numAt(node?.size, 0) || 0;
            const left = tpWidgetMargin();   // 与下方下拉框左边缘对齐（前端 BaseWidget.margin = 15）
            /* 宽度固定 MODE_ROW_MAX：不随节点变宽而拉长（两档一致，切档不跳），
             * 只在节点被拉得比「左边距 + 胶囊 + 右侧安全距离」还窄时才收缩。 */
            let w = nw > 0 ? nw - left - MODE_ROW_GAP : MODE_ROW_MAX;
            w = Math.min(MODE_ROW_MAX, Math.max(0, w));
            if (w < MODE_ROW_MIN) {
                // 节点极窄：兜底到 MIN，但绝不超出节点自身（否则胶囊会画到节点外）
                w = nw > 0 ? Math.min(MODE_ROW_MIN, Math.max(0, nw - left)) : MODE_ROW_MIN;
            }
            /* 第一行插槽的纵向范围：优先按 getOutputPos(0) 反推（不同主题/版本行高不同），
             * 拿不到再用 NODE_SLOT_HEIGHT 的默认值兜底。 */
            let top = Math.round(SH * 0.2);
            try {
                const cy = numAt(node?.getOutputPos?.(0), 1);
                const py = numAt(node?.pos, 1);
                if (cy !== null && py !== null) {
                    top = Math.max(0, Math.round(cy - py - SH / 2));
                }
            } catch (e) { /* 用兜底值 */ }
            return { x: left, y: top, w, h: SH };
        }

        /** 把开关搬到节点顶部第一行；成功接管返回 true（Vue 节点模式返回 false → 回落 widget 方案） */
        function attachModeRowToggle(node) {
            const w = modeWidget(node);
            if (!w) return false;
            if (w._tpModeRow) return true;
            // 「现代节点设计」（Vue 节点）不经过 canvas 绘制，这些钩子不生效 → 保持 widget 方案
            if (globalThis.LiteGraph?.vueNodesMode) return false;

            w._tpModeRow = true;
            w.hidden = true;           // 只影响绘制/布局，不参与序列化过滤
            node._tpModeW = w;

            /* ⚠️ 这两个钩子是**实例属性**，直接赋值会顶掉基类（或别的插件）已挂的同名钩子。
             * 实测：LiteGraph 给节点原型挂了 onDrawForeground（ComfyUI 用它做节点级装饰），
             * 无条件覆盖等于把它吞掉。所以先存旧引用、链式调用（旧钩子抛错也不影响自绘）。 */
            const prevDraw = typeof node.onDrawForeground === "function" ? node.onDrawForeground : null;
            const prevDown = typeof node.onMouseDown === "function" ? node.onMouseDown : null;

            node.onDrawForeground = function (ctx, ...rest) {
                if (prevDraw) {
                    try { prevDraw.call(this, ctx, ...rest); } catch (e) { /* 旧钩子出错不影响开关 */ }
                }
                const mw = this._tpModeW;
                if (!mw || this.flags?.collapsed) return;
                const g = modeRowGeom(this);
                try {
                    drawModeToggle(ctx, mw, g.w, g.y, g.h, g.x);
                } catch (e) {
                    /* 自绘失败就留空：绝不能抛出去，否则整块画布的绘制会中断 */
                }
            };

            node.onMouseDown = function (e, pos, canvas) {
                const mw = this._tpModeW;
                if (mw && !this.flags?.collapsed) {
                    const x = numAt(pos, 0), y = numAt(pos, 1);
                    if (x !== null && y !== null) {
                        const g = modeRowGeom(this);
                        if (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) {
                            setModeIndex(this, x < g.x + g.w / 2 ? 0 : 1,
                                { e, node: this, canvas: canvas || app.canvas });
                            return true;           // 吃掉本次点击，避免变成「拖动节点」
                        }
                    }
                }
                // 没点中开关 → 交还给原来的钩子（没有就返回 falsy）
                return prevDown ? (prevDown.call(this, e, pos, canvas) || false) : false;
            };

            /* 只打一次：控制台有这行 = 前端确实加载了新版 js；没有 = 页面还没刷新（缓存） */
            if (globalThis.__tpModeToggleBuild !== TP_MODE_BUILD) {
                globalThis.__tpModeToggleBuild = TP_MODE_BUILD;
                console.log(`[Toggle-Pass] 加载模式 → 顶部开关已接管 (build ${TP_MODE_BUILD})`);
            }
            refreshSize(node);
            return true;
        }

        /** 把「加载模式」的 combo 换成开关（幂等，重复调用只生效一次）
         *  首选搬到节点顶部第一行；不支持的场景回落成 widget 自绘。 */
        function styleModeToggle(node) {
            if (attachModeRowToggle(node)) return;
            styleModeToggleInWidget(node);
        }

        /** 回落方案：原地替换 combo 的绘制与点击入口（widget 仍占一行） */
        function styleModeToggleInWidget(node) {
            const w = modeWidget(node);
            if (!w || w._tpModeStyled) return;
            w._tpModeStyled = true;
            /* 只打一次：控制台有这行 = 前端确实加载了新版 js；没有 = 页面还没刷新（缓存） */
            if (globalThis.__tpModeToggleBuild !== TP_MODE_BUILD) {
                globalThis.__tpModeToggleBuild = TP_MODE_BUILD;
                console.log(`[Toggle-Pass] 加载模式 → 分段开关已接管(回落) (build ${TP_MODE_BUILD})`);
            }
            w._tpOrigDraw = w.draw;    // 原生绘制（前端逻辑：widget.draw 是函数就用它）
            w._tpHover = -1;
            w.label = "";              // 开关文字已说明含义，不再另画 label
            w.tooltip = MODE_TIP;

            w.draw = function (ctx, nodeArg, width, y, H) {
                try {
                    /* 回落方案里 widget 占整行，原生 widget 外框在 margin..width-margin，
                     * 所以左端取同一个 margin、宽度也封到 MODE_ROW_MAX —— 与主方案视觉一致。
                     * ★ 几何统一由 widgetCapsule() 给，命中判定用的是同一套（分界才不会错位）。 */
                    const cap = widgetCapsule(nodeArg, width);
                    drawModeToggle(ctx, this, cap.w, y, H, cap.x);
                } catch (e) {
                    // 自绘失败就退回原生下拉：宁可丑，也别留一个白框
                    if (typeof this._tpOrigDraw === "function") {
                        this._tpOrigDraw.call(this, ctx, nodeArg, width, y, H);
                    }
                }
            };

            /* ⚠️ 点击必须接上「三个」入口，少接一个就会「点了没反应」：
             *   1) onPointerDown(pointer, node, canvas) —— ★ 前端 processWidgetClick 的**第一优先**分支，
             *      返回真值就直接吃掉本次点击。只接 onClick 不够：widget 一旦被前端提升成
             *      ComboWidget 实例，挂在它身上的 onClick（普通函数属性）会在 adoptConcreteWidget 里
             *      被同名的原型方法顶掉，点击落到 ComboWidget.onClick（弹原生下拉 / 边缘加减档），
             *      开关自然没反应。BaseWidget 原型上没有 onPointerDown，所以这条最稳。
             *   2) onClick({ e, node, canvas }) —— 稍旧的新版前端走这条，e 是 CanvasPointerEvent（有 canvasX）；
             *   3) mouse(e, [x, y], node) —— 更老的版本。
             * 三条都接上，原生下拉就此被左右两档取代。 */
            w.onPointerDown = function (pointer, nodeArg, canvas) {
                const n = nodeArg || node;
                const x = modeLocalXFromPointer(pointer, n, canvas);
                if (x === null) return false;                  // 拿不到坐标 → 不吞事件，留给后面的分支兜底
                const cap = widgetCapsule(n, this.width);
                if (!(cap.w > 0)) return false;
                if (x < cap.x || x > cap.x + cap.w) return false;   // 点在胶囊外 → 不吞事件
                setModeIndex(n, x < cap.x + cap.w / 2 ? 0 : 1,
                    { e: pointer?.eDown || pointer?.e, node: n, canvas: canvas || app.canvas });
                return true;                                   // 已处理 → 不再注册 onClick，原生下拉不会弹
            };
            w.onClick = function (a, b, c) {
                const hit = resolveToggleHit(node, w, a, b, c);
                if (hit) setModeIndex(hit.node, hit.idx, { e: hit.e, node: hit.node, canvas: app.canvas });
            };
            w.mouse = function (event, pos, nodeArg) {
                const t = String(event?.type || "");
                const n = nodeArg || node;
                if (t === "pointerdown" || t === "mousedown") {
                    const hit = resolveToggleHit(node, this, event, pos, n);
                    if (hit) setModeIndex(hit.node, hit.idx, { e: event, node: hit.node, canvas: app.canvas });
                    return true;
                }
                if (t === "pointermove" || t === "mousemove") {
                    const hit = resolveToggleHit(node, this, event, pos, n);
                    const hIdx = hit ? hit.idx : -1;       // 移出胶囊 → -1，把悬停高亮清掉
                    if (this._tpHover !== hIdx) {
                        this._tpHover = hIdx;
                        n?.setDirtyCanvas?.(true);
                    }
                }
            };
        }

        /* ---- 参数显示顺序：模型放最前 ----
         * Python 侧 INPUT_TYPES 的顺序**故意保持不动**（它是 widgets_values 的位置基准），
         * 这里只改画面上 widget 的先后 —— 而显示顺序 = node.widgets 顺序 = 序列化顺序，
         * 所以调顺序必须配一次「旧文件 → 新顺序」的值迁移，见 migrateWidgetValues()。
         * 一体包模式下 unet/clip/vae/clip_type 是隐藏的，所以第一眼看到的就是模型行。 */
        const WIDGET_ORDER = [
            "ckpt_name", "unet_name",             // 模型（一体包 / 分离组件）
            "clip_name", "vae_name", "clip_type", // 分离组件的另外三项
            "加载模式",
        ];
        const LORA_SUFFIX = ["name", "strength_model", "strength_clip"];
        const LORA_RE = /^lora_(name|strength_model|strength_clip)_(\d+)$/;

        /** 排序权重：模型参数 → 加载模式 → LoRA 组（组内 name/强度 次序不变）→ 按钮 */
        function widgetRank(name) {
            const i = WIDGET_ORDER.indexOf(name);
            if (i >= 0) return i;
            const m = LORA_RE.exec(String(name ?? ""));
            if (m) return 100 + (parseInt(m[2], 10) - 1) * 3 + LORA_SUFFIX.indexOf(m[1]);
            return 9999;   // 按钮等：排最后，保持原有相对次序
        }

        /** 原地调整 node.widgets 的顺序。用原下标兜底，保证未知项的相对次序稳定 */
        function reorderWidgets(node) {
            const ws = node.widgets;
            if (!Array.isArray(ws) || ws.length < 2) return;
            const old = new Map(ws.map((w, i) => [w, i]));
            ws.sort((a, b) => {
                const d = widgetRank(a && a.name) - widgetRank(b && b.name);
                return d !== 0 ? d : (old.get(a) - old.get(b));
            });
        }

        /* ---- 旧工作流的参数迁移 ----
         * 旧文件的 widgets_values 是「按位置」存的，位置表是改动前的：
         *   0-3   unet_name / clip_name / vae_name / clip_type
         *   4-33  10 组 LoRA（name / strength_model / strength_clip）
         *   34-35 加载模式 / ckpt_name   ← 只有「已经带加载模式」的那批文件才有这两项
         *   36-37 两个按钮（值恒为 null，跳过）
         * 改了顺序后前端会按新位置回填 → 参数整体串位，所以这里按名字对回去。
         * 若文件里有 widgets_values_named（新版前端会写，键=参数名）就直接按名取，与顺序无关；
         * 新存的工作流不会走错分支（named 与位置表都已同步，结果一致）。 */
        const LEGACY_HEAD = ["unet_name", "clip_name", "vae_name", "clip_type"];
        const LEGACY_TAIL = ["加载模式", "ckpt_name"];
        const LEGACY_LORA_COUNT = 10;
        const LEGACY_LORA_END = LEGACY_HEAD.length + LEGACY_LORA_COUNT * 3;
        const LEGACY_MIN_LEN = LEGACY_LORA_END + LEGACY_TAIL.length + 2;  // 含两个按钮

        function legacyNameAt(i) {
            if (i < LEGACY_HEAD.length) return LEGACY_HEAD[i];
            if (i < LEGACY_LORA_END) {
                const k = Math.floor((i - LEGACY_HEAD.length) / 3);
                return `lora_${LORA_SUFFIX[(i - LEGACY_HEAD.length) % 3]}_${k + 1}`;
            }
            if (i < LEGACY_LORA_END + LEGACY_TAIL.length) return LEGACY_TAIL[i - LEGACY_LORA_END];
            return null;
        }

        function migrateWidgetValues(node, info) {
            if (!info || !Array.isArray(node.widgets)) return;
            const pos = Array.isArray(info.widgets_values) ? info.widgets_values : null;
            const named = (info.widgets_values_named && typeof info.widgets_values_named === "object")
                ? info.widgets_values_named : null;
            if (!pos && !named) return;

            const byName = {};
            if (named) {
                Object.assign(byName, named);
            } else {
                for (let i = 0; i < pos.length; i++) {
                    const n = legacyNameAt(i);
                    /* 老文件没有「加载模式 / ckpt_name」两项时，34/35 号位置放的是按钮的 null，
                     * 不判长度会把 null 写进加载模式 —— 必须挡一下 */
                    if (!n || (i >= LEGACY_LORA_END && pos.length < LEGACY_MIN_LEN)) continue;
                    byName[n] = pos[i];
                }
            }

            let fixed = 0;
            for (const [name, v] of Object.entries(byName)) {
                if (v === null || v === undefined) continue;
                const w = node.widgets.find(x => x && x.name === name);
                if (!w || w.value === v) continue;
                w.value = v;
                fixed++;
            }
            if (fixed) {
                console.log(`[Toggle-Pass] 顺序迁移：按参数名对回 ${fixed} 项（旧工作流的位置表已变更）`);
            }
        }

        /* ---- LoRA 强度：界面上只保留一个滑块 ----
         * 底层其实有两个参数：lora_strength_model_i / lora_strength_clip_i。
         * 参数一个都不能删（删了会让 widgets_values 按位置回填时整体串位），
         * 所以做法是：clip 滑块隐藏、值跟随 model，model 滑块换个显示名。
         * 只改显示文本（widget.label），widget.name 不动 → 提交与序列化完全不受影响。 */
        const LORA_STRENGTH_LABEL = "强度";

        /** 把 model 强度同步给隐藏的 clip 强度，保证「看到的强度 = 实际生效强度」 */
        function syncClip(g) {
            if (!g.model || !g.clip) return;
            const v = parseFloat(g.model.value);
            g.clip.value = isFinite(v) ? v : 1.0;
        }

        /** 拖动强度滑块时同步 clip 并刷新按钮提示 */
        function bindStrengthSync(node, g) {
            if (!g.model || g.model._tpStrengthBound) return;
            g.model._tpStrengthBound = true;
            const prev = g.model.callback;
            g.model.callback = function (v) {
                if (prev) prev.call(this, v);
                if (g.clip) {
                    const nv = parseFloat(v);
                    g.clip.value = isFinite(nv) ? nv : 1.0;
                }
                updateLabels(node);
            };
        }

        function applyLoaderMode(node) {
            const isCkpt = getModeIndex(node) === 1;
            for (const n of SPLIT_WIDGETS) {
                const w = (node.widgets || []).find(x => x.name === n);
                if (w) w.hidden = isCkpt;      // 一体包模式下不需要单独指定
            }
            for (const n of CKPT_WIDGETS) {
                const w = (node.widgets || []).find(x => x.name === n);
                if (w) w.hidden = !isCkpt;     // 只有一体包模式才显示
            }
            refreshSize(node);
        }

        function bindLoaderMode(node) {
            const w = (node.widgets || []).find(x => x.name === "加载模式");
            if (!w || w._tpModeBound) return;
            w._tpModeBound = true;
            const prev = w.callback;
            w.callback = function (v) {
                if (prev) prev.call(this, v);
                applyLoaderMode(node);
            };
        }

        function getGroup(node, i) {
            const s = String(i);
            return {
                name:  node.widgets.find(w => w.name === `lora_name_${s}`),
                model: node.widgets.find(w => w.name === `lora_strength_model_${s}`),
                clip:  node.widgets.find(w => w.name === `lora_strength_clip_${s}`),
            };
        }

        /* 刷新节点尺寸。
         * 顺序很讲究：setSize(computeSize()) 只按当前可见的 widget 算高度，
         * 之后再 fitButtonWidth 把长文案撑开，否则按钮文字会画到节点外面。
         * 连做两帧是因为 widget 显隐后前端有一帧的延迟，单帧会算到旧高度。 */
        function refreshSize(node) {
            const apply = () => {
                node.setSize(node.computeSize());
                fitButtonWidth(node);
            };
            apply();
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    apply();
                    app.graph.change();
                });
            });
        }

        /* 按钮文案比节点还宽时会溢出到节点外面（computeSize 的宽度不含按钮文字）。
         * 这里按实测文本宽度把节点撑宽一点，只涨不缩，且设上限避免被超长文案拉爆。 */
        function fitButtonWidth(node) {
            const add = node.widgets?.find(w => w.name === "_tp_add_lora_btn");
            const text = add?.label;
            if (!text || typeof node.setSize !== "function" || numAt(node.size, 0) === null) return;
            let w = 0;
            try {
                const LG = globalThis.LiteGraph;
                const measure = LG && LG.LGraphCanvas && LG.LGraphCanvas._measureText;
                if (typeof measure === "function") w = measure(text) || 0;
                if (!w) {
                    const ctx = app?.canvas?.ctx;
                    if (ctx && ctx.measureText) {
                        ctx.save();
                        ctx.font = "14px sans-serif";
                        w = ctx.measureText(text).width;
                        ctx.restore();
                    }
                }
            } catch (e) { /* 量不到就按字符数估 */ }
            if (!w) w = text.length * 9;
            const need = Math.min(Math.round(w) + 46, 430);
            if (numAt(node.size, 0) < need) node.setSize([need, numAt(node.size, 1) || 0]);
        }

        function showGroup(node, i) {
            const g = getGroup(node, i);
            if (!g.name) return;
            g.name.hidden = false;
            const active = g.name.value !== "none";
            if (g.model) {
                g.model.hidden = !active;
                g.model.label = LORA_STRENGTH_LABEL;   // 只改显示名，参数名保持 lora_strength_model_i
                bindStrengthSync(node, g);
            }
            if (g.clip) g.clip.hidden = true;          // clip 强度滑块不再单独展示
            syncClip(g);                               // 取值跟随 model，避免残留旧值
            if (!g.name._tpBound) {
                g.name._tpBound = true;
                const prev = g.name.callback;
                g.name.callback = function (v) {
                    if (prev) prev.call(this, v);
                    const a = v !== "none";
                    if (g.model) g.model.hidden = !a;
                    if (g.clip)  g.clip.hidden  = true;
                    syncClip(g);
                    node._tpLoraStatus = null;   // 换了 LoRA，上一次的 patch 统计已过期
                    updateLabels(node);
                    refreshSize(node);
                };
            }
            refreshSize(node);
        }

        /* ⚠️ 关键：隐藏 widget 后必须重算节点高度。
         * computeSize() 会跳过隐藏的 widget，Node.setSize 又只按传入值赋值，
         * 所以「只隐藏不 setSize」会留下一大片空白（把 10 组 LoRA 移除后就变成长条空框）。
         * 批量隐藏时传 refresh=false，循环结束后统一 refreshSize 一次即可。 */
        function hideGroup(node, i, refresh = true) {
            const g = getGroup(node, i);
            if (!g.name) return;
            g.name.hidden  = true;
            if (g.model) g.model.hidden = true;
            if (g.clip)  g.clip.hidden  = true;
            if (refresh) refreshSize(node);
        }

        function countVisible(node) {
            let c = 0;
            for (let i = 1; i <= MAX; i++) {
                const g = getGroup(node, i);
                if (g.name && !g.name.hidden) c++;
            }
            return c;
        }

        /** 真正会被提交上去的 LoRA 数量（name 不是 none） */
        function countEnabled(node) {
            let c = 0;
            for (let i = 1; i <= MAX; i++) {
                const g = getGroup(node, i);
                if (g.name && g.name.value && g.name.value !== "none") c++;
            }
            return c;
        }

        /** 已选 LoRA 中强度为 0 / 非法 的数量 —— 这种 LoRA 等于没生效 */
        function countZeroStrength(node) {
            let c = 0;
            for (let i = 1; i <= MAX; i++) {
                const g = getGroup(node, i);
                if (!g.name || !g.name.value || g.name.value === "none") continue;
                const v = parseFloat(g.model ? g.model.value : 1.0);
                if (!isFinite(v) || v === 0) c++;
            }
            return c;
        }

        /* ---- LoRA 生效状态回传 ----
         * 后端把「每个 LoRA 实际写入了多少个 patch」发过来，这里直接写进按钮文案。
         * 再也不用猜「到底生效了没」：patch=0 → 没写进去；有数字 → Python 侧确实加了。
         * 注意：这只反映「patch 有没有写进模型」，不代表画面上一定看得出来
         * （量化底座、参考图主导等情况会让效果变弱）。 */
        const LORA_STATUS_EVENT = "toggle-pass-lora-status";
        try {
            api.addEventListener(LORA_STATUS_EVENT, (ev) => {
                try {
                    const d = ev?.detail || {};
                    const id = parseInt(d.node, 10);
                    const n = (app.graph && (app.graph.getNodeById?.(id) || app.graph._nodes_by_id?.[id]))
                        || (app.graph?.nodes || []).find(x => String(x.id) === String(d.node));
                    if (!n) return;
                    n._tpLoraStatus = d;
                    if (typeof updateLabels === "function") updateLabels(n);
                    n.setDirtyCanvas?.(true, true);
                    app.graph?.setDirtyCanvas?.(true, true);
                } catch (e) {
                    console.warn("[Toggle-Pass] LoRA 状态回传处理失败", e);
                }
            });
        } catch (e) {
            console.warn("[Toggle-Pass] 无法监听 LoRA 状态事件", e);
        }

        /** 后端回传的状态 -> 按钮文案尾巴（尽量短，长文案会把窄节点撑爆） */
        function statusSuffix(node) {
            const st = node?._tpLoraStatus;
            if (!st) return "";
            const items = Array.isArray(st.items) ? st.items : [];
            // 两种失败要分开说：文件没找到（跳过） vs 键名一个都没匹配上（写入 0 个）
            const skipped = items.filter(it => it.error).length;
            const noMatch = items.filter(it => !it.error && (it.patches | 0) <= 0).length;
            const total = st.total_patches | 0;
            /* 覆盖率：LoRA 一共多少模块 / 实际落下多少 patch。
             * 一体化包被 repack 过时会有个别层挂不上（如 img_mlp.gate_layer 被融进 gate_up），
             * 这时显示 `192/224p`，一眼能看出「不是没加载，是底座少了几层」。 */
            const cov = st.coverage || null;
            const modTotal = cov ? (cov.modules | 0) : 0;
            let s;
            if (total > 0 && modTotal > total) s = ` · ${total}/${modTotal}p`;
            else if (total > 0) s = ` · ${total}p`;
            else s = " · ⚠️未写入";
            if (noMatch > 0) s += ` · ⚠️${noMatch}不匹配`;
            if (skipped > 0) s += ` · ⚠️${skipped}跳过`;
            if (st.clip && st.clip.ok === false) s += " · ⚠️CLIP不符";
            return s;
        }

        /** 完整信息挂在 tooltip 上，鼠标悬停可见（按钮上只放短标签） */
        function statusTooltip(node) {
            const st = node?._tpLoraStatus;
            if (!st) return undefined;
            const items = Array.isArray(st.items) ? st.items : [];
            const lines = [`上次运行：合计写入 ${st.total_patches | 0} 个 patch`];
            /* 模块覆盖率（分母 = LoRA 自己的模块数），用来解释「为什么只挂了一部分」 */
            const cov = st.coverage || null;
            if (cov && (cov.modules | 0) > 0) {
                const mt = cov.modules | 0, mp = cov.patches | 0;
                lines.push(mt > mp
                    ? `模块覆盖 ${mp}/${mt}：有 ${mt - mp} 个模块没落到层上（多为一体化包 repack 融合，属底座差异，非节点问题）`
                    : `模块覆盖 ${mp}/${mt}：全部挂上`);
            }
            /* CLIP 校验：分体模式选错 CLIP 文件时会建出错误的文本编码器，跑得通但提示词全废 */
            if (st.clip && st.clip.ok === false) {
                lines.push(`⚠️ CLIP 不符：文本编码器 = ${st.clip.te}，预期 ${st.clip.expect}`);
                lines.push("   → 请更换 CLIP 文件，或检查「CLIP 类型」是否选对");
            } else if (st.clip && st.clip.te) {
                lines.push(`CLIP 校验通过：${st.clip.te}`);
            }
            if (st.quantized) lines.push("底座是量化模型（INT8/FP8）——LoRA 仍会写入，只是效果更『糊』");
            for (const it of items) {
                const nm = String(it.name || "").split(/[\\/]/).pop();
                const mods = it.modules ? `/${it.modules}` : "";
                lines.push(it.error
                    ? `#${it.slot} ${nm}：跳过（${it.error}）`
                    : `#${it.slot} ${nm}：${it.patches | 0}${mods} 个 patch`);
            }
            return lines.join("\n");
        }

        /** 把「已启用几个 / 有几个强度为 0」写进按钮文字，一眼能看出 LoRA 是否真的生效 */
        function updateLabels(n) {
            const add = n.widgets?.find(w => w.name === "_tp_add_lora_btn");
            const rm = n.widgets?.find(w => w.name === "_tp_rm_lora_btn");
            const visible = countVisible(n);
            const enabled = countEnabled(n);
            const zero = countZeroStrength(n);
            const warn = zero > 0 ? ` ⚠️${zero}个强度0` : "";
            const st = statusSuffix(n);
            if (add) {
                add.label = visible >= MAX
                    ? `（已到上限 10）· 已启用 ${enabled}${warn}${st}`
                    : `+ 添加 LoRA · 已启用 ${enabled}${warn}${st}`;
                add.tooltip = statusTooltip(n);
                fitButtonWidth(n);
            }
            if (rm) rm.label = visible <= 0 ? "（没有可移除的）" : "- 移除 LoRA";
        }

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origConfigure?.apply(this, arguments);
            /* ⚠️ 必须同步做、且在下面 rAF 里那套「按值显隐」之前：
             * 旧工作流的位置表与现在不同，先把值按参数名对回去，
             * 否则下面的显隐、强度同步、按钮统计全部跟着错。 */
            migrateWidgetValues(this, arguments[0]);
            styleModeToggle(this);          // 加载模式 → 分段开关（幂等）
            requestAnimationFrame(() => {
                // 恢复加载模式的显隐（加载旧工作流后也要正确）
                applyLoaderMode(this);
                bindLoaderMode(this);
                // 隐藏全部（批量操作，循环内不逐个刷新尺寸）
                for (let i = 1; i <= MAX; i++) hideGroup(this, i, false);
                // 恢复：maxActive 之前的所有组都显示
                let maxActive = 0;
                for (let i = 1; i <= MAX; i++) {
                    const g = getGroup(this, i);
                    if (g.name && g.name.value !== "none") maxActive = i;
                }
                for (let i = 1; i <= maxActive; i++) showGroup(this, i);
                // 上一次运行的状态不跨工作流沿用
                this._tpLoraStatus = null;
                updateLabels(this);
                // 无条件收一次尺寸：maxActive 为 0（一个 LoRA 都没用）时，
                // 旧工作流里存的高尺寸否则会原样保留 → 一大片空白
                refreshSize(this);
            });
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpUnified) return;
            this._tpUnified = true;

            const node = this;  // 闭包捕获，确保回调里 this 正确

            // 初始按加载模式显隐（默认分离组件）
            applyLoaderMode(node);
            bindLoaderMode(node);
            styleModeToggle(node);

            // 初始隐藏全部 LoRA 组（批量隐藏后统一收尺寸，别逐个 setSize）
            for (let i = 1; i <= MAX; i++) hideGroup(node, i, false);

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
                let hit = false;
                for (let i = MAX; i >= 1; i--) {
                    const g = getGroup(node, i);
                    if (g.name && !g.name.hidden) {
                        hideGroup(node, i, false);   // 循环内先不刷新，最后统一收
                        g.name.value = "none";  // 重置选择
                        // ⚠️ 强度必须回到默认 1.0，不能设成 0：
                        // 设 0 后再「+ 添加 LoRA」复用的还是这一组，滑块停在 0
                        // → LoRA 加载了但强度为 0，表现就是「完全没效果」
                        if (g.model) g.model.value = 1.0;
                        if (g.clip) g.clip.value = 1.0;
                        hit = true;
                        break;
                    }
                }
                if (hit) node._tpLoraStatus = null;   // 配置变了，旧状态不再代表本次出图
                updateLabels(node);
                // ⚠️ 关键：隐藏后必须收一次高度，否则节点留下一大片空白
                refreshSize(node);
            });
            rmBtn.name = "_tp_rm_lora_btn";
            rmBtn.label = "- 移除 LoRA";

            // 参数显示顺序：模型放最前（按钮已建好，一起参与排序）
            reorderWidgets(node);
            updateLabels(node);

            // 设置初始尺寸 宽270,高220
            node.setSize([270, 220]);
            app.graph.change();
        };
    },
});

/* ============ Image Compare（图片对比）============ */
/* 两组动态输入：source1..source10（原图）+ result1..result10（结果）。
 * 两个组各自用 num_sources / num_results 控制数量；槽位顺序固定为「原图在前、结果在后」，
 * 所以重建时会**按名字保存已连的线，重建后再接回去**，避免中间插入把连线弄乱。
 */

const COMPARE_SLOT_RE = /^(source|result)(\d+)$/;
const COMPARE_MAX = 10;

function clampInt(v, lo, hi) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
}

// 显示名一律中文；内部 name（source1… / result1…）保持英文，
// 否则会连累「按名字存线 / 重建后接回」的逻辑与已保存工作流。
const COMPARE_SLOT_PREFIX = { source: "原图", result: "结果" };

function compareSlotLabel(name) {
    const m = /^(source|result)(\d+)$/.exec(name);
    return m ? COMPARE_SLOT_PREFIX[m[1]] + m[2] : name;
}

function applyCompareLabels(node) {
    for (const inp of (node.inputs || [])) {
        if (!COMPARE_SLOT_RE.test(inp.name)) continue;
        const lb = compareSlotLabel(inp.name);
        if (inp.label !== lb) inp.label = lb;
    }
}

function syncCompareInputs(node) {
    const ws = node.widgets?.find((w) => w.name === "num_sources");
    const wr = node.widgets?.find((w) => w.name === "num_results");
    if (ws && ws.label !== "原图数") ws.label = "原图数";
    if (wr && wr.label !== "结果数") wr.label = "结果数";
    const ns = clampInt(ws ? ws.value : 2, 1, COMPARE_MAX);
    const nr = clampInt(wr ? wr.value : 2, 1, COMPARE_MAX);

    const want = [];
    for (let i = 1; i <= ns; i++) want.push(`source${i}`);
    for (let i = 1; i <= nr; i++) want.push(`result${i}`);

    const cur = (node.inputs || []).map((i) => i.name);
    if (cur.length === want.length && want.every((n, i) => cur[i] === n)) {
        applyCompareLabels(node);
        return;
    }

    // 1) 记下现有连线（按槽名）
    const graph = node.graph || app.graph;
    const saved = {};
    for (const inp of (node.inputs || [])) {
        if (inp.link == null || !COMPARE_SLOT_RE.test(inp.name)) continue;
        const l = graph?.links?.[inp.link];
        if (l) saved[inp.name] = { origin_id: l.origin_id, origin_slot: l.origin_slot };
    }

    // 2) 清掉旧的动态槽（从后往前，避免索引错位）
    for (let i = (node.inputs || []).length - 1; i >= 0; i--) {
        if (COMPARE_SLOT_RE.test(node.inputs[i].name)) node.removeInput(i);
    }

    // 3) 按「原图在前、结果在后」重建
    for (const nm of want) node.addInput(nm, "IMAGE");
    applyCompareLabels(node);

    // 4) 把连线接回去
    for (let i = 0; i < (node.inputs || []).length; i++) {
        const s = saved[node.inputs[i].name];
        if (!s) continue;
        const origin = graph?.getNodeById?.(s.origin_id);
        if (origin) {
            try { origin.connect(s.origin_slot, node, i); } catch (e) { /* 接不回就算了 */ }
        }
    }

    // 5) 尺寸
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const sz = node.computeSize();
            node.setSize([Math.max(sz[0], 260), Math.max(sz[1], 120)]);
            app.graph.change();
        });
    });
}

app.registerExtension({
    name: EXT_NAME + "-compare",
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ToggleImageCompare") return;

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origConfigure?.apply(this, arguments);
            requestAnimationFrame(() => syncCompareInputs(this));
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            if (this._tpCmpInit) return;
            this._tpCmpInit = true;
            syncCompareInputs(this);
            for (const nm of ["num_sources", "num_results"]) {
                const w = this.widgets?.find((x) => x.name === nm);
                if (!w) continue;
                const prev = w.callback;
                w.callback = function (v) {
                    if (prev) prev.call(this, v);
                    syncCompareInputs(this._node || this);
                };
            }
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const sz = this.computeSize();
                    this.setSize([Math.max(sz[0], 260), Math.max(sz[1], 120)]);
                    app.graph.change();
                });
            });
        };
    },
});
