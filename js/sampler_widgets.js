/**
 * ComfyUI-Toggle-Pass: 采样器（一体）— 参数联动
 *
 * 「采样方案」决定哪些参数真正生效，把不生效的灰掉并锁住，避免
 * 「步数写着 20、其实按 8 步的表在跑」这种误导。
 *
 *   自动（按步数 + 调度器）-> 步数 / 调度器 可用；自定义表灰
 *   预置表（turbo 等）      -> 步数 / 调度器 / 自定义表 全灰，步数显示成表真实步数
 *   自定义表                -> 自定义表可用；步数 / 调度器 灰
 *
 * 只动 widget.disabled + options 的 min/max/values + DOM readOnly，
 * **不碰 serialize**，所以 widgets_values 的位置与顺序完全不变，老工作流不受影响。
 */

import { app } from "../../scripts/app.js";

const NODE_NAME = "ToggleSampler";
const SCHEME_AUTO = "自动（按步数 + 调度器）";
const SCHEME_CUSTOM = "自定义表";

/* 新建节点时的初始宽度（高度用 computeSize 的默认值，不加高）。
   仅在 onNodeCreated 生效，不影响已保存的工作流尺寸。 */
const INITIAL_WIDTH = 300;

/* 各预置表对应的真实步数（= 表点数 - 1）。
   与 sampler.py 的 SIGMA_PRESETS 保持一致；只用于把「步数」显示得跟实际一致，
   不参与任何计算 —— 后端永远按表跑。 */
const PRESET_STEPS = {
    "Qwen-Image-2.1 turbo 8步": 8,
    "LTX-2 视频 8步（蒸馏）": 8,
    "LTX-2 视频 3步（低噪）": 3,
};

const W_SCHEME = "采样方案";
const W_SCHEDULER = "调度器";
const W_STEPS = "步数";
const W_CUSTOM = "自定义Sigma表";

/** 从手填的 sigma 表里数步数（N 个点 = N-1 步；解析不出来就返回 0） */
function countSigmaSteps(text) {
    if (!text) return 0;
    const nums = String(text)
        .replace(/[\n;\t]/g, ",")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && Number.isFinite(Number(s)));
    return nums.length >= 2 ? nums.length - 1 : 0;
}

/**
 * 让灰掉的控件仍然显示数值。
 *
 * ⚠️ 前端 BaseWidget 里写死了：
 *     get _displayValue() { return this.computedDisabled ? '' : String(this.value) }
 * 也就是 disabled 时数值会被画成空 —— 光灰化会让「步数」变成一条空白，
 * 反而看不出实际在跑几步。这里在实例上覆盖该 getter 把值保住。
 * 属于私有 API，若某天前端改掉，最坏结果只是退回「空白显示」，不会报错。
 */
function keepValueVisible(widget) {
    if (widget.__tpKeepValue) return;
    widget.__tpKeepValue = true;
    try {
        Object.defineProperty(widget, "_displayValue", {
            configurable: true,
            get() { return String(this.value); },
        });
    } catch (e) { /* 忽略 */ }
}

/**
 * 灰掉 + 锁住一个控件。
 *
 * disabled 本身只管渲染（前端源码注释：Disabled widgets are rendered at half opacity），
 * 所以还要从数据层断掉交互：
 *   · 数字控件 -> 把 min/max 压成当前值，怎么拖都变不了
 *   · 下拉控件 -> values 只留当前项
 *   · 多行文本框 -> DOM readOnly
 * 原值都记在 widget.__tp* 上，恢复时还原。
 */
function setEnabled(widget, enabled) {
    if (!widget) return;
    const lock = !enabled;
    if (widget.disabled === lock) return;
    widget.disabled = lock;

    if (lock) keepValueVisible(widget);

    const opts = widget.options || {};

    // 数字控件：压扁区间
    if (typeof opts.min === "number" && typeof opts.max === "number") {
        if (widget.__tpMin === undefined) {
            widget.__tpMin = opts.min;
            widget.__tpMax = opts.max;
        }
        if (lock) {
            opts.min = widget.value;
            opts.max = widget.value;
        } else {
            opts.min = widget.__tpMin;
            opts.max = widget.__tpMax;
        }
    }

    // 下拉控件：只留当前值（恢复时必须还原成同一个数组引用）
    if (Array.isArray(opts.values) && !Array.isArray(widget.__tpValues)) {
        widget.__tpValues = opts.values;
        if (lock) opts.values = [widget.value];
    } else if (Array.isArray(widget.__tpValues)) {
        opts.values = lock ? [widget.value] : widget.__tpValues;
    }

    // 多行文本框是真 DOM（textarea），widget.disabled 不会让它变灰
    const el = widget.element || widget.inputEl;
    if (el) {
        try {
            el.readOnly = lock;
            el.style.opacity = lock ? "0.45" : "";
        } catch (e) { /* 忽略 */ }
    }
}

function applySchemeState(node) {
    const find = (name) => node.widgets && node.widgets.find((w) => w.name === name);

    const wScheme = find(W_SCHEME);
    if (!wScheme) return;

    const scheme = wScheme.value;
    const isAuto = scheme === SCHEME_AUTO;
    const isCustom = scheme === SCHEME_CUSTOM;

    const wSteps = find(W_STEPS);
    const prev = node.__tpPrevScheme;

    // 1) 离开「自动」档之前，先把用户自己的步数记下来（必须在改值之前！）
    if (prev === SCHEME_AUTO && !isAuto && wSteps) {
        node.__tpAutoSteps = wSteps.value;
    }
    // 2) 回到「自动」档时还给他
    if (isAuto && prev !== undefined && prev !== SCHEME_AUTO && node.__tpAutoSteps != null && wSteps) {
        wSteps.value = node.__tpAutoSteps;
        node.__tpAutoSteps = undefined;
    }
    // 3) 选预置表时把「步数」显示成实际步数（上锁时 min/max 取的是当前 value）
    const presetSteps = PRESET_STEPS[scheme];
    if (presetSteps && wSteps && wSteps.value !== presetSteps) {
        wSteps.value = presetSteps;   // 直接赋值不触发 callback
    }

    // 3b) 自定义表档：按表里的点数算步数（N 点 = N-1 步），免得「20 步」跟表对不上
    if (isCustom && wSteps) {
        const wCustom = find(W_CUSTOM);
        const n = countSigmaSteps(wCustom && wCustom.value);
        if (n && wSteps.value !== n) wSteps.value = n;
    }

    node.__tpPrevScheme = scheme;

    // 4) 上锁
    setEnabled(wSteps, isAuto);
    setEnabled(find(W_SCHEDULER), isAuto);
    setEnabled(find(W_CUSTOM), isCustom);

    if (node.graph && node.graph.setDirtyCanvas) node.graph.setDirtyCanvas(true, false);
    app.canvas?.setDirty?.(true, true);
}

app.registerExtension({
    name: "ComfyUI-Toggle-Pass.sampler-widgets",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        // ---- 新建节点 ----
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const node = this;

            const wScheme = node.widgets && node.widgets.find((w) => w.name === W_SCHEME);
            if (!wScheme) return r;

            // 拦截方案切换（用户点下拉时走 callback）
            const origCb = wScheme.callback;
            wScheme.callback = function () {
                const out = origCb ? origCb.apply(this, arguments) : undefined;
                applySchemeState(node);
                return out;
            };

            applySchemeState(node);

            /* 初始尺寸：只加宽，高度沿用 computeSize 算出的默认值。
               ⚠️ 只在这里设 —— onConfigure 之后会恢复用户自己存的 size，
                  所以老工作流的尺寸不会被这条改掉。 */
            try {
                node.setSize([INITIAL_WIDTH, node.computeSize()[1]]);
            } catch (e) { /* 忽略 */ }

            return r;
        };

        // ---- 加载工作流：configure 会覆盖 widget 值，之后必须再套一次 ----
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            try {
                this.__tpPrevScheme = undefined;   // 加载时不还原历史步数，按存档来
                applySchemeState(this);
                this.__tpPrevScheme = this.widgets?.find((w) => w.name === W_SCHEME)?.value;
            } catch (e) {
                console.warn("[Toggle-Pass] 采样器参数联动失败:", e);
            }
            return r;
        };
    },
});
