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
import { api } from "../../scripts/api.js";

const NODE_NAME = "ToggleSampler";
const SCHEME_AUTO = "自动（按步数 + 调度器）";
const SCHEME_CUSTOM = "自定义表";

/* 节点宽度。预设用的是完整模型名，最长一条实测 240px（"Qwen-Image Layered（9步·CFG 2.5）"），
   加上左侧 47px 的「⚡预设」和两侧留白，340 就会开始重叠 ⇒ 取 350。

   ⚠️ 宽度不够时 combo 的值是右对齐画的，会把左边的标题整个盖住，
      看起来就成了「一个没有名字的下拉框」—— 这正是之前被误认成"重复控件"的原因。
      ⇒ 老工作流里存的是 300/340，加载时若不够就补到 PRESET_FIT_WIDTH（只加不缩）。 */
const INITIAL_WIDTH = 350;
const PRESET_FIT_WIDTH = 350;

/* node.size 是"类数组对象"（Array.isArray 恒为 false），取值必须逐下标。 */
function sizeAt(node, i) {
    const s = node && node.size;
    if (!s) return 0;
    const v = typeof s[i] === "number" ? s[i] : s[String(i)];
    return typeof v === "number" ? v : 0;
}

/** 节点太窄就把标题挤没了，补到能放下最长预设名的宽度。只加宽，不缩窄。 */
function ensureWidthForPreset(node) {
    const w = sizeAt(node, 0);
    if (!w || w >= PRESET_FIT_WIDTH) return false;
    try {
        node.size[0] = PRESET_FIT_WIDTH;      // 逐下标赋值，整体赋值会被类数组吞掉
        node.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
        return true;
    } catch (e) {
        return false;
    }
}

/* 控件上显示的名字。**内部 name 一律不改** —— widgets_values_named 和 /prompt 的
   inputs 都按 name 走，改 name 等于让所有已存工作流失联。改 label 才是安全的。 */
const LABEL_SCHEME = "Sigma 曲线";   // 原名「采样方案」：它只管噪声曲线，容易和「预设」混
const LABEL_PRESET = "⚡预设";       // 原名「模型预设」：四个字太长，窄节点上会没地方显示

/* 各预置表对应的真实步数（= 表点数 - 1）。
   与 sampler.py 的 SIGMA_PRESETS 保持一致；只用于把「步数」显示得跟实际一致，
   不参与任何计算 —— 后端永远按表跑。 */
const PRESET_STEPS = {
    "Qwen-Image-2.1 turbo 8步": 8,
    "LTX-2 视频 8步（蒸馏）": 8,
    "LTX-2 视频 3步（低噪）": 3,
};

const W_SCHEME = "采样方案";
const W_SAMPLER = "采样器";
const W_SCHEDULER = "调度器";
const W_STEPS = "步数";
const W_CFG = "CFG";
const W_CUSTOM = "自定义Sigma表";
const W_MODEL_PRESET = "模型预设";

/* ==================== 模型预设 ====================
 *
 * 预设表只存在后端（sampler.py 的 MODEL_PRESETS），这里通过
 * /toggle_pass/sampler_presets 拉回来，**不在 JS 里再抄一份**，
 * 免得以后加模型时两边对不上。
 *
 * 语义是「一键填充」而不是「持续锁定」：选完预设后，只要用户手动改了
 * 采样方案/采样器/调度器/步数/CFG 中的任何一个，下拉就自己退回「手动」——
 * 这样控件显示的永远是真实状态，不会出现「写着 Qwen 预设、其实在跑 40 步」。
 */

const PRESET_NONE = "手动（不套用）";
const PRESET_API = "/toggle_pass/sampler_presets";
// 预设会写到的五个参数（降噪和随机种不归预设管，改它们不该影响预设显示）
const PRESET_KEYS = [W_SCHEME, W_SAMPLER, W_SCHEDULER, W_STEPS, W_CFG];

/* 「模型预设」挪到最前面之前的控件顺序（与 sampler.py 的 LEGACY_WIDGET_ORDER 同步）。
   1.57 的存档会额外写一份 widgets_values_named（按名字恢复，位置无关），但更早的
   纯位置存档只能按顺序对号；把这张表交给 nodeData.fallbackWidgetsValuesNames，
   老存档就会按名字重新落到正确控件上，而不是整体错一位。 */
const LEGACY_WIDGET_ORDER = [
    W_SCHEME, W_SAMPLER, W_SCHEDULER, W_STEPS, W_CFG, "降噪",
    "噪波随机种", "control_after_generate", W_CUSTOM, W_MODEL_PRESET,
];

/* 旧预设名 → 当前预设名。权威副本在 sampler.py 的 PRESET_ALIASES，由
   /toggle_pass/sampler_presets 下发；这里初始只放一份兜底，fetch 成功后会被覆盖。

   为什么需要兜底：加载工作流（onConfigure）可能发生在接口返回之前，那一刻
   如果表是空的，旧短名就翻译不出来，下拉会停在 `Layered · 9步` 这种已不存在的值上。
   fetch 完成后 retroFixPresets() 会对画布上已有节点再补一次。 */
const PRESET_ALIASES = {
    "Qwen 2.1 · 25步": "Qwen-Image 2.1（25步）",
    "Qwen 2.1 turbo · 8步表": "Qwen-Image 2.1 turbo（8步·固定表）",
    "Krea2 turbo · 8步": "Krea 2 turbo（8步）",
    "Krea2 细节 · 12步": "Krea 2 turbo・细节增强（12步）",
    "FLUX2 klein · 4步": "FLUX.2 klein（4步·beta）",
    "FLUX2 高清 · 4步": "FLUX.2 klein・高清修复（4步）",
    "Z-Image turbo · 8步": "Z-Image turbo（8步）",
    "Layered · 9步": "Qwen-Image Layered（9步·CFG2.5）",
    "2511 AIO · 4步": "Qwen-Image Edit 2511 AIO（4步）",
};

let presetPromise = null;

/** 别名到齐后，把画布上已经加载完的节点再修一遍（加载早于接口返回的情况）。 */
function retroFixPresets() {
    const nodes = (app.graph && app.graph._nodes) || [];
    for (const n of nodes) {
        if (!n || n.type !== NODE_NAME) continue;
        try {
            if (fixPresetValue(n)) n.setDirtyCanvas?.(true, true);
        } catch (e) {
            /* 单个节点异常不影响其余 */
        }
    }
}

function fetchPresets() {
    if (!presetPromise) {
        presetPromise = api
            .fetchApi(PRESET_API)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                // 失败不要缓存 null，否则这个页面里永远拿不到预设
                if (!d || !d.presets) {
                    presetPromise = null;
                    return d;
                }
                if (d.aliases) {
                    Object.assign(PRESET_ALIASES, d.aliases);
                    retroFixPresets();
                }
                return d;
            })
            .catch(() => {
                presetPromise = null;
                return null;
            });
    }
    return presetPromise;
}

const findW = (node, name) => node.widgets && node.widgets.find((w) => w.name === name);

/** 只在值真的不同、且该值确实在下拉可选项里时才写 —— 免得把 widget 写成一个非法值。 */
function setValue(w, v) {
    if (!w || v === undefined || v === null) return false;
    const vals = w.options && w.options.values;
    if (Array.isArray(vals) && !vals.includes(v)) {
        console.warn("[Toggle-Pass] 预设值不在可选项里，跳过:", w.name, v);
        return false;
    }
    if (w.value === v) return false;
    w.value = v; // 直接赋值不触发 callback，正是我们要的
    return true;
}

/**
 * 把某个预设套到节点上。
 *
 * 顺序很关键：先换「采样方案」并立刻跑一次 applySchemeState —— 因为调度器/步数
 * 会随方案被解锁或锁死（锁死时 options.min=max=当前值，这时再写就写不进去了）。
 * 解锁之后再填其余四项，最后再跑一次让锁定状态和步数显示对齐。
 */
async function applyPreset(node, name) {
    if (!name || name === PRESET_NONE) return;
    if (!node.__tpPresets) {
        const d = await fetchPresets();
        if (d && d.presets) node.__tpPresets = d.presets;
    }
    const conf = node.__tpPresets && node.__tpPresets[name];
    if (!conf) {
        console.warn("[Toggle-Pass] 找不到预设:", name);
        return;
    }
    if (node.__tpApplying) return;
    node.__tpApplying = true;
    try {
        setValue(findW(node, W_SCHEME), conf.scheme);
        applySchemeState(node);
        setValue(findW(node, W_SAMPLER), conf.sampler);
        setValue(findW(node, W_SCHEDULER), conf.scheduler);
        setValue(findW(node, W_STEPS), conf.steps);
        setValue(findW(node, W_CFG), conf.cfg);
    } finally {
        node.__tpApplying = false;
    }
    applySchemeState(node);
    node.setDirtyCanvas(true, true);
    if (node.graph && node.graph.setDirtyCanvas) node.graph.setDirtyCanvas(true, false);
}

/** 用户手改了预设管辖的参数 —— 把下拉退回「手动」，别让它说谎。 */
function markManual(node) {
    if (node.__tpApplying) return; // 预设自己填的值不算
    const w = findW(node, W_MODEL_PRESET);
    if (!w || w.value === PRESET_NONE) return;
    w.value = PRESET_NONE;
    node.setDirtyCanvas(true, true);
}

/**
 * 这个值是不是「采样方案」的取值？
 *
 * 用来识别一种错位：老工作流没有 widgets_values_named，只能按位置恢复，而
 * 「模型预设」被挪到了第一位 —— 于是它拿到的其实是老位置 0 的采样方案值。
 * 采样方案和模型预设的取值集合完全不重叠，所以这里可以可靠地区分。
 */
function looksLikeScheme(v) {
    if (typeof v !== "string") return false;
    return v === SCHEME_AUTO || v === SCHEME_CUSTOM
        || Object.prototype.hasOwnProperty.call(PRESET_STEPS, v);
}

/**
 * 把「模型预设」的值修成合法的：
 *   · 旧长名 -> 新短名（改过名的老存档）
 *   · 拿到采样方案的值 -> 退回「手动」（纯位置存档的错位）
 * 返回是否改动过。
 */
function fixPresetValue(node) {
    const w = findW(node, W_MODEL_PRESET);
    if (!w || typeof w.value !== "string") return false;
    if (Object.prototype.hasOwnProperty.call(PRESET_ALIASES, w.value)) {
        w.value = PRESET_ALIASES[w.value];
        return true;
    }
    if (looksLikeScheme(w.value)) {
        // 位置错位：这一格拿到的是「采样方案」的值，退回手动
        w.value = PRESET_NONE;
        return true;
    }
    // 剩下的可能是个已废弃的旧名：别名表没覆盖时留在控件上会显示成一个不存在的值，
    // 退回「手动」更诚实 —— 真正的采样参数还在，只是不再声称套着某个预设。
    const vals = w.options && w.options.values;
    if (Array.isArray(vals) && vals.length && !vals.includes(w.value)) {
        console.warn("[Toggle-Pass] 未知预设名，已退回手动:", w.value);
        w.value = PRESET_NONE;
        return true;
    }
    return false;
}


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

        /* 老存档兜底：1.57 之前的存档只有按位置的 widgets_values。
           「模型预设」从末尾挪到了第一位，纯位置恢复会整体错一位 —— 把老顺序
           交给前端，它就会按 widget 名字重新对号。（新版存档有 widgets_values_named，
           本来就不受位置影响，这里只是补上更早的那批。） */
        nodeData.fallbackWidgetsValuesNames = LEGACY_WIDGET_ORDER;

        // ---- 新建节点 ----
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const node = this;

            const wScheme = node.widgets && node.widgets.find((w) => w.name === W_SCHEME);
            if (!wScheme) return r;

            wScheme.label = LABEL_SCHEME;
            const wPresetInit = node.widgets.find((w) => w.name === W_MODEL_PRESET);
            if (wPresetInit) wPresetInit.label = LABEL_PRESET;

            // 拦截方案切换（用户点下拉时走 callback）
            const origCb = wScheme.callback;
            wScheme.callback = function () {
                const out = origCb ? origCb.apply(this, arguments) : undefined;
                try {
                    applySchemeState(node);
                    markManual(node);
                } catch (e) {
                    console.warn("[Toggle-Pass] 采样方案联动失败:", e);
                }
                return out;
            };

            // 预设表提前拉好，等用户点下拉时基本已经到位
            fetchPresets().then((d) => {
                if (d && d.presets) node.__tpPresets = d.presets;
            });

            // 「模型预设」：选中就把五项参数一次性填好
            const wPreset = node.widgets.find((w) => w.name === W_MODEL_PRESET);
            if (wPreset) {
                const origPresetCb = wPreset.callback;
                wPreset.callback = function () {
                    const out = origPresetCb ? origPresetCb.apply(this, arguments) : undefined;
                    try {
                        applyPreset(node, wPreset.value);
                    } catch (e) {
                        console.warn("[Toggle-Pass] 套用模型预设失败:", e);
                    }
                    return out;
                };
            }

            // 其余四个参数：用户一动就说明偏离预设了，把下拉退回「手动」
            PRESET_KEYS.forEach((name) => {
                if (name === W_SCHEME) return; // 方案上面已经包过
                const w = node.widgets.find((x) => x.name === name);
                if (!w || w.__tpManualHooked) return;
                w.__tpManualHooked = true;
                const orig = w.callback;
                w.callback = function () {
                    const out = orig ? orig.apply(this, arguments) : undefined;
                    try {
                        markManual(node);
                    } catch (e) {
                        /* 标记失败不影响参数本身 */
                    }
                    return out;
                };
            });

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
                // label 不是存档内容，但某些路径会重建 widget，这里补一遍最稳
                const ws = findW(this, W_SCHEME);
                if (ws) ws.label = LABEL_SCHEME;
                const wp = findW(this, W_MODEL_PRESET);
                if (wp) wp.label = LABEL_PRESET;

                // 先把预设值修成合法的（旧长名 / 位置错位），再对方案做联动
                fixPresetValue(this);

                this.__tpPrevScheme = undefined;   // 加载时不还原历史步数，按存档来
                applySchemeState(this);
                this.__tpPrevScheme = this.widgets?.find((w) => w.name === W_SCHEME)?.value;

                // 老存档里节点可能只有 300 宽，全名会把「⚡预设」压在下面看不见
                ensureWidthForPreset(this);
            } catch (e) {
                console.warn("[Toggle-Pass] 采样器参数联动失败:", e);
            }
            return r;
        };
    },
});
