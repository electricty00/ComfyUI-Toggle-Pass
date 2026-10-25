/**
 * ComfyUI-Toggle-Pass: ToggleUnifiedLoader —「全局广播」开关（自带，不依赖 cg-use-everywhere）
 *
 * 作用：节点上多一个「开 / 关」开关。
 *   开 -> 运行（以及导出 API）时，把 MODEL / CLIP / VAE 自动接到图里**所有空着的同类型输入**上，
 *         不用再一根根拉线；画布上不会留下这些线（提交时临时连、提交完立刻拆）。
 *         同时画布上会用**紫色曲线**把「将会自动接上的线」画出来，方便核对。
 *   关 -> 完全保持原样，自己拉线（默认）。
 *
 * 为什么不用 cg-use-everywhere 的 `properties.ue_convert`：
 *   那是它的私有机制，装了才有、卸载就没了，而且只在它自己的 queuePrompt 钩子下生效。
 *   这里自己实现一份最小广播：零依赖、导出 API 也照样带线。
 *
 * ⚠️ 序列化安全（这个节点最贵的教训，改动前务必读完）：
 *   - 开关用 `addWidget("toggle", ...)` **追加在 widget 列表最末尾**，并且 `serialize:false`。
 *     `widgets_values` 是按位置存的；它既然不进 widgets_values，旧工作流的每一项位置都不动。
 *     —— 绝不能插在中间，也不能把一个已有参数标成 serialize:false（那样后面的值会整体前移）。
 *   - 开关的状态存在 `node.properties.tp_broadcast`（LiteGraph 原生字段，随工作流保存），
 *     不占用 widgets_values。
 *   - 不动 Python 的 INPUT_TYPES，所以这个特性**不需要重启 ComfyUI**，Ctrl+F5 就行。
 *
 * ⚠️ 只在「前端」提交时生效：用 /prompt 接口直接 POST 原始 API 格式 JSON 时没有前端参与，
 *   广播自然不会发生（想让它生效就先在界面里「导出 API」，导出的 JSON 已经带好线了）。
 */

import { app } from "../../scripts/app.js";

const EXT_NAME = "Toggle-Pass.broadcast";
const NODE_NAME = "ToggleUnifiedLoader";
const WIDGET_NAME = "全局广播";
const PROP = "tp_broadcast";
const BTN_ON = "开";
const BTN_OFF = "关";

/* 顶部自绘开关的几何常量 —— 必须与 multi_ref_encode.js 里「加载模式胶囊」那套保持一致，
 * 否则开关会跟上面的 UNet/Checkpoint 胶囊对不齐（两套常量各改各的很容易漂）。 */
const ROW_SLOT_H = 20;        // 兜底行高（真值优先取 LiteGraph.NODE_SLOT_HEIGHT）
const ROW_CAP_MAX = 147;      // 胶囊可见宽上限（= multi_ref_encode.js 的 MODE_ROW_MAX）
const ROW_CAP_MIN = 120;      // 节点极窄时的兜底宽
const ROW_GAP_RIGHT = 45;     // 胶囊右端到节点右边的最小留白
const BC_MIN_W = 66;          // 开关自身不窄于此（再窄「广播」+轨道就放不下了）
const BC_PAD_Y = 3;           // 上下留白 —— 与 multi_ref_encode.js 的 TG_PAD_Y 同值，
                              // 这样开关高度 = 胶囊高度（都是 行高 - 3*2 = 14）

/* ------------------------------------------------------------------ *
 * 一、节点上的开关
 * ------------------------------------------------------------------ */

function isBroadcastOn(node) {
    const w = (node.widgets || []).find((x) => x && x.name === WIDGET_NAME);
    if (w) return !!w.value;
    return !!(node.properties && node.properties[PROP]);
}

function numAt(v, i) {
    const x = v?.[i];
    return typeof x === "number" && isFinite(x) ? x : null;
}

function addBroadcastWidget(node) {
    if ((node.widgets || []).some((x) => x && x.name === WIDGET_NAME)) return;

    const on = !!(node.properties && node.properties[PROP]);

    /* 原生 toggle：本机前端 1.53.10 的 widget 工厂支持 "toggle"，
     * {on, off} 决定两侧文案（ComfyUI 自己的 BOOLEAN 输入就是这么建的）。 */
    let w = null;
    try {
        w = node.addWidget("toggle", WIDGET_NAME, on, (v) => {
            try {
                node.properties = node.properties || {};
                /* 原生 toggle 会把新值当第一个参数传进来；拿不到才回落读 w.value
                 * （别只读 w.value：某些路径上 callback 先于 value 赋值，会写反） */
                node.properties[PROP] = typeof v === "boolean" ? v : !!w.value;
            } catch (e) {
                console.warn("[Toggle-Pass] 广播开关状态写入 properties 失败", e);
            }
            app.graph?.setDirtyCanvas?.(true, true);
            node.setDirtyCanvas?.(true, true);
        }, { on: BTN_ON, off: BTN_OFF });
    } catch (e) {
        console.warn("[Toggle-Pass] 原生 toggle 控件不可用，跳过广播开关", e);
        return;
    }
    if (!w) return;

    /* 不进 widgets_values / 不进 prompt：旧工作流的位置表一项都不动 */
    w.options = w.options || {};
    w.options.serialize = false;
    w.serialize = false;
    w.tooltip =
        "全局广播：开启后运行时把 MODEL / CLIP / VAE 自动接到图里所有空着的同类型输入上，不用拉线。" +
        "开启时画布上会用紫色曲线画出「将自动接上的线」，方便核对（曲线只是预览，不是真实连线、不会被保存）。" +
        "关闭则照旧手动连线。";
    w.label = WIDGET_NAME;

    /* ★ 2026-10-24：开关从「widget 列表末尾的一整行」搬到「顶部胶囊下面」。
     * 做法：原生 widget 只当**状态容器**（值 / properties / 序列化全部原样不动），
     *      用 hidden 让它不参与布局与绘制，再自己画一个小开关上去。
     * 为什么 hidden 是安全的：widgets_values 是按「参与序列化的 widget」顺序存的，
     *      这个 toggle 本来就是 serialize:false（不进 widgets_values），
     *      藏起来既不增也不减参与序列化的项 ⇒ 旧工作流的位置表一项都不动。
     * 顺带的好处：节点底部少了一整行，不再挤在「移除 LoRA」下面。 */
    w.hidden = true;
    node._tpBcW = w;
    attachBroadcastRow(node);
}

/* ------------------------------------------------------------------ *
 * 一之二、顶部自绘小开关（在 UNet / Checkpoint 胶囊的下一行、左半边）
 *
 * 为什么不用 widget 承载：widget 的 y 由前端布局算死（插槽区之下、按列表顺序往下排），
 *   想放到「第一行插槽左侧的下方」这种位置，只能自己画。
 * 这里复用的是「加载模式」开关同一套打法（见 multi_ref_encode.js 的 attachModeRowToggle）：
 *   · 位置：第 1 行插槽的正下方（= 第 2 行插槽那一行的左半边，右侧 CLIP 标签不受影响）
 *   · 宽度：胶囊的一半（用户要求「一半位置就行」）
 *   · 绘制：node.onDrawForeground；命中：node.onMouseDown（返回真值吃掉事件，避免变成拖动节点）
 * ⚠️ 这两个钩子是**实例属性**，必须存旧引用链式调用 —— 直接赋值会吞掉
 *   multi_ref_encode.js 挂的「加载模式」开关（两边都挂同一对钩子）。
 * ------------------------------------------------------------------ */

/** 与 multi_ref_encode.js 的 tpWidgetMargin() 同源：BaseWidget.margin 默认 15 */
function bcMargin() {
    const m = globalThis.BaseWidget?.margin;
    return (typeof m === "number" && m >= 0 && m <= 40) ? m : 15;
}

function bcRoundRect(ctx, x, y, w, h, r) {
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

/** 开关在节点本地坐标里的位置与尺寸（x/w 是我们自己这一块的范围，不含右侧留白） */
function bcRowGeom(node) {
    const SH = Number(globalThis.LiteGraph?.NODE_SLOT_HEIGHT) || ROW_SLOT_H;
    const nw = numAt(node?.size, 0) || 0;
    const left = bcMargin();
    /* 先按「加载模式胶囊」的宽度算（保证和上面的胶囊左右端点对得上） */
    let capW = nw > 0 ? nw - left - ROW_GAP_RIGHT : ROW_CAP_MAX;
    capW = Math.min(ROW_CAP_MAX, Math.max(0, capW));
    if (capW < ROW_CAP_MIN) capW = nw > 0 ? Math.min(ROW_CAP_MIN, Math.max(0, nw - left)) : ROW_CAP_MIN;
    /* 用户要求：占胶囊的一半（红框圈的就是胶囊前一半的宽度） */
    const w = Math.max(BC_MIN_W, Math.round(capW / 2));

    /* 第一行插槽的纵向位置（与加载模式胶囊同一套反推），再往下挪一行 = 胶囊正下方 */
    let top = Math.round(SH * 0.2);
    try {
        const cy = numAt(node?.getOutputPos?.(0), 1);
        const py = numAt(node?.pos, 1);
        if (cy !== null && py !== null) top = Math.max(0, Math.round(cy - py - SH / 2));
    } catch (e) { /* 用兜底值 */ }
    return { x: left, y: top + SH, w, h: SH };
}

/** 自绘：一个完整的小胶囊控件 —— 淡底色托底，左边 label、右边开关轨道。
 *  为什么要有底色：节点里其它控件（下拉框、UNet/Checkpoint 胶囊）都有底色，
 *  只画「裸文字 + 轨道」会显得浮在空白上，跟整体设计语言脱节。
 *  ★ 关键是「托底要淡、轨道要细」：
 *    第一版给外框加了 1px 亮描边，结果和下边框围成**两层框**（外框 + 内轨道），
 *    比上面那条单层胶囊笨重得多。现在外框只有一层很淡的填充、默认无描边，
 *    视觉上退成「一块底色」而不是「一个框」，轨道才是主角。
 *  配色对齐节点现有控件：下拉框底色 / 高亮蓝 #3a96f3。 */
function drawBroadcastRow(ctx, node, on, hover) {
    const g = bcRowGeom(node);
    const cy = g.y + g.h / 2;
    /* 高度与上面的 UNet/Checkpoint 胶囊完全一致：行高 - BC_PAD_Y*2 = 14
     * （胶囊那边是 TG_PAD_Y=3、净高 14 —— 两个常量必须同步改，否则一高一矮） */
    const bh = g.h - BC_PAD_Y * 2;
    const r = bh / 2;
    const bx = g.x, bw = g.w;

    try {
        ctx.save();

        /* ---- 托底：一层淡填充，只在开启/悬停时略提亮 ---- */
        bcRoundRect(ctx, bx, g.y + BC_PAD_Y, bw, bh, r);
        if (on) ctx.fillStyle = hover ? "rgba(58,150,243,0.24)" : "rgba(58,150,243,0.13)";
        else ctx.fillStyle = hover ? "rgba(255,255,255,0.105)" : "rgba(255,255,255,0.06)";
        ctx.fill();
        /* 悬停加一道极淡描边：明确「这里能点」，又不会变成第二个框 */
        if (hover) {
            ctx.lineWidth = 1;
            ctx.strokeStyle = on ? "rgba(58,150,243,0.45)" : "rgba(255,255,255,0.12)";
            ctx.stroke();
        }

        /* ---- 内容整体居中：先量文字宽，再把「文字 + 间隙 + 轨道」作为一条内容居中摆放 ----
         * 之前是「文字贴左 8px、轨道贴右 7px」，两边留白各算各的 ⇒ 一宽一窄，看着偏向一边。
         * 现在统一算 padX，左右留白严格相等。 */
        const label = "广播";
        ctx.textAlign = "left";
        ctx.font = "600 10px sans-serif";     // 用户要求：11px → 10px（小 10%）
        let tw = 20;                          // 10px「广播」约 20px，量不到时兜底
        try {
            const lm = ctx.measureText(label);
            if (lm && typeof lm.width === "number" && isFinite(lm.width) && lm.width > 0) tw = lm.width;
        } catch (e) { /* 用兜底 */ }

        const trackW = 24, GAP = 8;
        const contentW = tw + GAP + trackW;
        const padX = Math.max(5, (bw - contentW) / 2);   // 左右留白相等 ⇒ 整条内容居中
        const lx = bx + padX;
        const tx = lx + tw + GAP;

        /* ---- label：按视觉盒垂直居中 ----
         * 不用 textBaseline="middle"：Canvas 的 middle 按 (ascent+descent)/2 排，
         * 对没有降部的中文会整体偏上。改成量出真实上沿、基线放到 cy + 上沿/2，
         * 这样字形上下留白相等 —— 实测这样仍会低约半个像素，再补 0.5 的视觉修正。 */
        ctx.fillStyle = on ? "rgba(230,238,250,1)" : "rgba(174,182,196,1)";
        let asc = 7.3;   // 10px 中文的兜底上沿（量不到时用）
        try {
            const lm = ctx.measureText(label);
            const a = lm && lm.actualBoundingBoxAscent;
            if (typeof a === "number" && isFinite(a) && a > 0) asc = a;
        } catch (e) { /* 用兜底 */ }
        ctx.textBaseline = "alphabetic";
        ctx.fillText(label, lx, cy + asc / 2 - 0.5);

        /* ---- 右侧开关：细轨道 + 小滑块（位置 tx 已在上面按居中算好） ---- */
        const th = 10;
        const ty = cy - th / 2;
        bcRoundRect(ctx, tx, ty, trackW, th, th / 2);
        if (on) {
            const grad = ctx.createLinearGradient(tx, ty, tx, ty + th);
            grad.addColorStop(0, "#4aa5ff");
            grad.addColorStop(1, "#2f86e8");
            ctx.fillStyle = grad;
        } else {
            ctx.fillStyle = "rgba(255,255,255,0.13)";
        }
        ctx.fill();
        /* 关闭态补一道内沿，让轨道看起来是「凹槽」而不是一块平色 */
        if (!on) {
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(0,0,0,0.18)";
            ctx.stroke();
        }

        /* ---- 滑块：一点点投影，让它「浮」在轨道上 ---- */
        const kr = 4;
        const kx = on ? tx + trackW - 1 - kr : tx + 1 + kr;
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.30)";
        ctx.shadowBlur = 2;
        ctx.shadowOffsetY = 0.5;
        ctx.beginPath();
        ctx.arc(kx, cy, kr, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.restore();
    } finally {
        /* ★ 必须 try/finally：漏 restore 会让整个画布的变换永久跑偏（踩过） */
        try { ctx.restore(); } catch (e) { /* ignore */ }
    }
}

function isBroadcastOnNode(node) {
    const w = node?._tpBcW || (node?.widgets || []).find((x) => x && x.name === WIDGET_NAME);
    if (w && typeof w.value === "boolean") return w.value;
    return !!(node?.properties && node.properties[PROP]);
}

/** 切开关：真源写 properties，再同步给（隐藏的）原生 widget，前端才知道图被改了 */
function setBroadcast(node, on) {
    const v = !!on;
    try {
        node.properties = node.properties || {};
        node.properties[PROP] = v;
    } catch (e) { /* ignore */ }
    const w = node._tpBcW || (node.widgets || []).find((x) => x && x.name === WIDGET_NAME);
    if (w) {
        try {
            if (typeof w.setValue === "function") w.setValue(v);
            else w.value = v;
        } catch (e) {
            w.value = v;
        }
    }
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.graph?.change?.();
}

/** 把自绘开关挂到节点上（幂等） */
function attachBroadcastRow(node) {
    if (node._tpBcRow) return;
    /* 「现代节点设计」（Vue 节点）不走 canvas 绘制钩子 → 保持原生 widget 可见的回落 */
    if (globalThis.LiteGraph?.vueNodesMode) {
        const w = node._tpBcW;
        if (w) w.hidden = false;
        return;
    }
    node._tpBcRow = true;

    const prevDraw = typeof node.onDrawForeground === "function" ? node.onDrawForeground : null;
    const prevDown = typeof node.onMouseDown === "function" ? node.onMouseDown : null;
    const prevMove = typeof node.onMouseMove === "function" ? node.onMouseMove : null;

    node.onDrawForeground = function (ctx, ...rest) {
        if (prevDraw) {
            try { prevDraw.call(this, ctx, ...rest); } catch (e) { /* 旧钩子出错不影响开关 */ }
        }
        if (!this._tpBcW || this.flags?.collapsed) return;
        try {
            drawBroadcastRow(ctx, this, isBroadcastOnNode(this), !!this._tpBcHover);
        } catch (e) {
            /* 自绘失败就留空，绝不能抛出去（会中断整块画布绘制） */
        }
    };

    /* 悬停高亮：只在「进入/离开」时刷新一次画布，不做逐像素重绘 */
    node.onMouseMove = function (e, pos, canvas) {
        if (this._tpBcW && !this.flags?.collapsed) {
            const x = numAt(pos, 0), y = numAt(pos, 1);
            let hv = false;
            if (x !== null && y !== null) {
                const g = bcRowGeom(this);
                hv = x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h;
            }
            if (this._tpBcHover !== hv) {
                this._tpBcHover = hv;
                this.setDirtyCanvas?.(true, true);
            }
        }
        return prevMove ? prevMove.call(this, e, pos, canvas) : false;
    };

    /* ⚠️ 光有 onMouseMove 不够：鼠标一移出节点，前端就不再给它派发 move，
     *   高亮会**永久卡在亮着**的状态（实测：移开画布后 _tpBcHover 仍是 true）。
     *   所以补一个离开钩子复位。 */
    const prevLeave = typeof node.onMouseLeave === "function" ? node.onMouseLeave : null;
    node.onMouseLeave = function (...args) {
        if (this._tpBcHover) {
            this._tpBcHover = false;
            this.setDirtyCanvas?.(true, true);
        }
        return prevLeave ? prevLeave.apply(this, args) : undefined;
    };

    node.onMouseDown = function (e, pos, canvas) {
        if (this._tpBcW && !this.flags?.collapsed) {
            const x = numAt(pos, 0), y = numAt(pos, 1);
            if (x !== null && y !== null) {
                const g = bcRowGeom(this);
                if (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) {
                    setBroadcast(this, !isBroadcastOnNode(this));
                    return true;    // 吃掉点击，避免变成拖动节点
                }
            }
        }
        return prevDown ? (prevDown.call(this, e, pos, canvas) || false) : false;
    };
}

/* 注：原 growToFit()（给追加的那行 widget 补节点高度）已随「开关搬到顶部」一起删除 ——
 * 开关不再占用 widget 布局，节点高度不需要额外补。 */

function syncBroadcastWidget(node) {
    const w = (node.widgets || []).find((x) => x && x.name === WIDGET_NAME);
    if (!w) return;
    const v = !!(node.properties && node.properties[PROP]);
    if (!!w.value !== v) w.value = v;
    /* 保险：极端情况下（前端没走 onNodeCreated 就直接 configure）自绘钩子可能还没挂 */
    if (w.hidden) {
        node._tpBcW = w;
        attachBroadcastRow(node);
    }
}

/* ------------------------------------------------------------------ *
 * 二、提交时临时连线（最小广播实现）
 * ------------------------------------------------------------------ */

/** 输入类型与输出类型是否匹配（兼容 "MODEL" / "A,B" / "*" 这几种写法） */
function typeMatch(inputType, outputType) {
    const a = String(inputType ?? "");
    const b = String(outputType ?? "");
    if (!a || !b) return false;
    if (a === b) return true;
    if (a === "*" || b === "*") return true;
    return a.split(",").some((s) => s.trim() === b);
}

/**
 * 计算「广播计划」：哪些空着的输入会被接到哪个输出。
 *
 * ⚠️ 真接线（inflate）和画布上的曲线预览（computeShapes）**必须共用这一份**，
 *    否则会出现「画的线」和「真接的线」不一致 —— 那种 bug 用户根本没法自查。
 */
function planBroadcast(graph) {
    const pairs = [];
    const ambiguous = new Set();
    if (!graph || !Array.isArray(graph._nodes)) return { pairs, ambiguous };

    /* 每个类型只认一个广播源：多个加载器都开广播时取第一个，并提示一次 */
    const srcByType = new Map();
    for (const n of graph._nodes) {
        if (!n || n.type !== NODE_NAME || !isBroadcastOn(n)) continue;
        const outs = n.outputs || [];
        for (let i = 0; i < outs.length; i++) {
            const t = outs[i] && outs[i].type;
            if (!t || t === "*") continue;
            if (srcByType.has(t)) {
                ambiguous.add(t);
                continue;
            }
            srcByType.set(t, { node: n, slot: i });
        }
    }
    if (!srcByType.size) return { pairs, ambiguous };

    for (const [t, src] of srcByType) {
        for (const target of graph._nodes) {
            /* 加载器自己不算，避免自己接自己 */
            if (!target || target === src.node || target.type === NODE_NAME) continue;
            const inputs = target.inputs || [];
            for (let idx = 0; idx < inputs.length; idx++) {
                const inp = inputs[idx];
                /* 已经接了线的一律不动 —— 广播只补空位，绝不覆盖用户手连的线 */
                if (!inp || inp.link != null) continue;
                if (!typeMatch(inp.type, t)) continue;
                pairs.push({ srcNode: src.node, srcSlot: src.slot, srcType: t, dstNode: target, dstSlot: idx });
            }
        }
    }
    return { pairs, ambiguous };
}

/**
 * 把「开着广播」的加载器的三个输出，临时接到所有空着的同类型输入上。
 * 返回一个还原函数；调用它会把临时连线全部拆掉。
 */
function inflate(appRef) {
    const graph = appRef.rootGraph || appRef.graph;
    const { pairs, ambiguous } = planBroadcast(graph);
    if (ambiguous.size) {
        console.warn(
            "[Toggle-Pass] 有多个加载器开着「全局广播」，同类型输出只取第一个：",
            Array.from(ambiguous).join(", "),
        );
    }
    const undo = [];

    for (const p of pairs) {
        try {
            p.srcNode.connect(p.srcSlot, p.dstNode, p.dstSlot);
        } catch (e) {
            continue;
        }
        /* connect 失败时不会抛，只表现为 link 仍为空 */
        if (p.dstNode.inputs?.[p.dstSlot] && p.dstNode.inputs[p.dstSlot].link != null) {
            const { dstNode, dstSlot } = p;
            undo.push(() => {
                try {
                    dstNode.disconnectInput(dstSlot);
                } catch (e) {
                    /* 目标节点已被删掉之类，忽略 */
                }
            });
        }
    }

    return () => {
        for (let i = undo.length - 1; i >= 0; i--) undo[i]();
        try {
            appRef.graph?.setDirtyCanvas?.(true, true);
        } catch (e) {
            /* 无画布环境（导出脚本）忽略 */
        }
    };
}

/* ------------------------------------------------------------------ *
 * 三、画布上的预览曲线（只画，不建真实 link）
 * ------------------------------------------------------------------ */

/* 观感对齐 cg-use-everywhere：紫罗兰实线 + 一层柔光，比青色虚线耐看，
 * 也不会被误当成「报错警告线」。 */
const PREVIEW_COLOR = "#a78bfa";
const PREVIEW_GLOW = "#7c5cff";

/** 从槽位的 boundingRect（官方渲染算出来的真实盒子）取中心点，图坐标 */
function rectCenter(r) {
    if (!r) return null;
    if (Array.isArray(r) || typeof r[0] === "number") {
        const x = numAt(r, 0);
        const y = numAt(r, 1);
        if (x == null || y == null) return null;
        return [x + (numAt(r, 2) || 0) / 2, y + (numAt(r, 3) || 0) / 2];
    }
    const x = typeof r.x === "number" ? r.x : r.left;
    const y = typeof r.y === "number" ? r.y : r.top;
    if (typeof x !== "number" || typeof y !== "number") return null;
    const w = r.width ?? r.w ?? 0;
    const h = r.height ?? r.h ?? 0;
    return [x + w / 2, y + h / 2];
}

/**
 * 槽位中心（图坐标）。
 *
 * ⚠️ 优先 `boundingRect`，不要只信 `getConnectionPos`：
 *   本机前端里槽位的 `pos` 字段**经常是 null**（只有走 widget 布局的那几个才被填），
 *   而 `pos` 为 null 时 getConnectionPos 会退化成「按输入顺序估算」的公式
 *   (`node.pos + (index+0.7)*NODE_SLOT_HEIGHT`) —— 一旦节点里有 widget 夹在输入之间，
 *   估出来的位置就和实际渲染对不上，线看起来就是「错位」。
 *   `boundingRect` 是渲染时算出来的真实盒子，节点一移动它就跟着更新。
 */
function slotPoint(node, isInput, idx) {
    const list = isInput ? node?.inputs : node?.outputs;
    const s = list && list[idx];
    if (!s) return null;
    const c = rectCenter(s.boundingRect);
    if (c) return c;
    try {
        const p = node.getConnectionPos(isInput, idx);
        if (p && isFinite(p[0]) && isFinite(p[1])) return [p[0], p[1]];
    } catch (e) {
        /* 节点被删/布局未完成 */
    }
    return null;
}

/**
 * 把「运行时会自动接上的线」算成屏幕坐标下的贝塞尔。
 * 不创建任何 link ⇒ 不进工作流、不影响保存，纯视觉提示。
 *
 * 坐标链路：槽位（图坐标）→ `ds.convertOffsetToCanvas` → 屏幕坐标，
 * 然后 setTransform 到 dpr，直接按屏幕坐标画。
 * ⚠️ 不要自己手搓 `(p + offset) * scale`：那是在赌前端内部变换的实现细节。
 */
function computeShapes(canvas) {
    /* ⚠️ 必须和 inflate() 用**同一张图**（rootGraph 优先）：
     *   广播接哪张图，就画哪张图。两边取不同引用（canvas.graph / app.graph）
     *   在切换工作流或进子图的瞬间会不一致，线就会指向图里已不存在的位置。 */
    const g = (app && (app.rootGraph || app.graph)) || (canvas && canvas.graph);
    const ds = canvas && canvas.ds;
    if (!g || !ds) return null;

    const { pairs } = planBroadcast(g);
    if (!pairs.length) return null;

    const scale = ds.scale || 1;
    let dpr = canvas.dpr;
    if (!dpr) {
        const r = canvas.canvas?.getBoundingClientRect?.();
        dpr = r && r.width > 0 ? canvas.canvas.width / r.width : 1;
    }
    const off = ds.offset || [0, 0];
    const toScreen = (p) => {
        try {
            const r = ds.convertOffsetToCanvas?.([p[0], p[1]]);
            if (r && isFinite(r[0]) && isFinite(r[1])) return [r[0], r[1]];
        } catch (e) {
            /* 兜底走下面的手算 */
        }
        return [(p[0] + (off[0] || 0)) * scale, (p[1] + (off[1] || 0)) * scale];
    };

    const items = [];
    for (const p of pairs) {
        const aG = slotPoint(p.srcNode, false, p.srcSlot);
        const bG = slotPoint(p.dstNode, true, p.dstSlot);
        if (!aG || !bG) continue;
        const a = toScreen(aG);
        const b = toScreen(bG);
        if (!isFinite(a[0]) || !isFinite(b[0])) continue;
        /* 控制点跟官方 Spline 连线同一套：取两点距离的 3 成（不小于 40 图单位），
         * 起点往右甩、终点从左边进 —— 收口方向和真实连线一致，
         * 一眼就能看出线是从哪个口出来的。 */
        const dist = Math.hypot(bG[0] - aG[0], bG[1] - aG[1]);
        const d = Math.max(40, dist * 0.3) * scale;
        items.push({
            aG,
            bG,
            a,
            b,
            c1: [a[0] + d, a[1]],
            c2: [b[0] - d, b[1]],
        });
    }
    if (!items.length) return null;
    return { items, scale, dpr };
}

/**
 * 取「背景层」的 ctx。
 *
 * ⚠️⚠️ 这里是最容易白忙一场的地方：新版前端把背景画在**离屏** canvas 上
 *   （`this.bgcanvas`），画完之后才 `ctx.drawImage(bgcanvas, ...)` 贴到主画布，
 *   再在主画布上画节点。所以往主 ctx 上画背景层的内容 —— 会立刻被那张贴图盖掉，
 *   代码跑了、坐标也对，就是看不见（实测一个紫色像素都没有）。
 *   必须画进 bgcanvas 自己的 ctx，贴图时才会把它一起带上来，节点再盖在上面。
 *   老架构没有 bgcanvas（背景直接画在主 ctx 上），此时退回主 ctx。
 */
function bgCtx(canvas) {
    const bg = canvas && canvas.bgcanvas;
    if (bg && typeof bg.getContext === "function") {
        if (!canvas.__tpBgCtx || canvas.__tpBgCtx.canvas !== bg) canvas.__tpBgCtx = bg.getContext("2d");
        return canvas.__tpBgCtx;
    }
    return canvas && canvas.ctx;
}

/**
 * 线本体 —— 画在**节点下层**（背景层 ctx，交付 `drawBackCanvas` 之后）。
 * 所以线穿过节点时会被节点自然遮住，跟真实连线一个观感：
 * 该露的缝隙里露出来，节点上干干净净，不挡标题也不挡参数。
 */
function drawBroadcastLines(ctx, canvas) {
    const plan = computeShapes(canvas);
    if (!plan || !ctx) return;
    const { items, scale, dpr } = plan;

    ctx.save();
    /* ⚠️ save / restore 必须用 try/finally 包住：
     *   中间任何一次 `it.a` 取值、bezier 计算出问题抛异常，若跳过 restore，
     *   这个 ctx 就会**永久**留在 `dpr + translate + scale` 变换下 ——
     *   之后所有绘制（包括官方的选择框、节点）都会整体偏移、放大，
     *   而且看起来跟本插件毫无关系，极难排查。宁可少画一帧，也不能漏 restore。 */
    try {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        for (const it of items) {
            const trace = () => {
                ctx.beginPath();
                ctx.moveTo(it.a[0], it.a[1]);
                ctx.bezierCurveTo(it.c1[0], it.c1[1], it.c2[0], it.c2[1], it.b[0], it.b[1]);
            };

            /* 一层柔光底：深色画布上紫线才不会是「一根生硬的细线」 */
            ctx.globalAlpha = 0.16;
            ctx.strokeStyle = PREVIEW_GLOW;
            ctx.lineWidth = Math.max(5, 7 * scale);
            trace();
            ctx.stroke();

            /* 主线 */
            ctx.globalAlpha = 0.95;
            ctx.strokeStyle = PREVIEW_COLOR;
            ctx.lineWidth = Math.max(1.8, 2.2 * scale);
            trace();
            ctx.stroke();
        }
    } finally {
        ctx.restore();
    }

    if (typeof window !== "undefined") {
        window.__tpLastDraw = items.map((it) => ({
            a: [Math.round(it.aG[0]), Math.round(it.aG[1])],
            b: [Math.round(it.bG[0]), Math.round(it.bG[1])],
            aS: [Math.round(it.a[0]), Math.round(it.a[1])],
            bS: [Math.round(it.b[0]), Math.round(it.b[1])],
            bend: 0,
        }));
    }
}

/**
 * 端点小圆点 —— 画在**节点上层**。
 * 槽位本身就压在节点边线上，放下层会被节点整个盖掉，线头看着像断的；
 * 两颗 3px 的点不挡任何文字，却能把「接在哪」钉死。
 */
function drawBroadcastDots(ctx, canvas) {
    const plan = computeShapes(canvas);
    if (!plan || !ctx) return;
    const { items, scale, dpr } = plan;

    ctx.save();
    /* 同 drawBroadcastLines：restore 必须兜底，否则整个画布的变换会被带偏 */
    try {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = PREVIEW_COLOR;
        const r = Math.max(2.2, 2.6 * scale);
        for (const it of items) {
            for (const pt of [it.a, it.b]) {
                ctx.beginPath();
                ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    } finally {
        ctx.restore();
    }
}

/**
 * 装配两处钩子：
 *   ① `drawBackCanvas` **之后** → 线（画进 bgcanvas，节点下层）
 *   ② `draw()` 末尾        → 端点圆点（主 ctx，节点上层）
 *
 * ⚠️ 为什么不用 `onDrawForeground`（踩过的坑）：
 *   ComfyUI 前端用 `watch(() => app.canvas, e => e.onDrawForeground = chain(...))`
 *   维护画布钩子，那个 watch 会在我们之后重新赋值 —— 包装被整个替换掉，
 *   实测 hookLen 变成了别人的 88 字符函数，绘制一次都没执行。
 */
function installPreviewPainter(appRef) {
    const canvas = appRef.canvas;
    if (!canvas || typeof canvas.draw !== "function") return;
    if (canvas.__tpDrawPatched) return;
    canvas.__tpDrawPatched = true;

    /* ⚠️ 为什么挂在 `drawBackCanvas` **之后**（踩过的坑）：
     *   一开始插在 `drawFrontCanvas` **之前**，结果一个像素都看不到 ——
     *   drawFrontCanvas 内部会把前景层重绘一遍，我们画的东西被它盖掉了。
     *   画在 drawBackCanvas 之后：背景和真实连线都画完了，节点还没画 ⇒
     *   线正好落在「节点下层」，节点一盖就自然遮住，节点之间的空白处保留。
     *
     * ⚠️ 只用 `this.ctx` / `this`，**不看入参**：实测 drawBackCanvas 的实参
     *   既不是 ctx 也不是 canvas（另一个入口报过 `ctx.save is not a function`），
     *   照它取坐标系会一条线都算不出来。参数原样透传，绝不改写。 */
    const wrapBack = (cv) => {
        const inner = cv.drawBackCanvas;
        if (typeof inner !== "function" || inner.__tpPainter) return;
        const wrapped = function (...args) {
            const r = inner.apply(this, args);
            try {
                drawBroadcastLines(bgCtx(this), this);
            } catch (e) {
                if (typeof window !== "undefined") window.__tpDrawErr = "line:" + String((e && e.message) || e);
            }
            return r;
        };
        wrapped.__tpPainter = true;
        cv.drawBackCanvas = wrapped;
    };

    wrapBack(canvas);

    const origDraw = canvas.draw;
    canvas.draw = function (...args) {
        /* 前端某些路径会重新赋值 drawBackCanvas（拖拽中断时见过），
         * 每帧开头兜一次，发现被换掉就重包 —— 成本是一次属性读。 */
        if (!this.drawBackCanvas || !this.drawBackCanvas.__tpPainter) wrapBack(this);
        let r;
        try {
            r = origDraw.apply(this, args);
        } finally {
            try {
                drawBroadcastDots(this.ctx, this);
            } catch (e) {
                if (typeof window !== "undefined") window.__tpDrawErr = "dot:" + String((e && e.message) || e);
            }
        }
        return r;
    };
}

function patchGraphToPrompt(appRef) {
    if (appRef.__tpBroadcastPatched) return;

    /* ⚠️ 必须**两层都包**，只包 graphToPrompt 会漏：
     *   cg-use-everywhere 在它自己的 setup() 里就把**当时的** app.graphToPrompt 存成变量，
     *   点「运行」时它走 queuePrompt → 用存下来的原函数（可能绕过我们这一层）→ 广播静默失效。
     *   包住 queuePrompt 就能兜住这条路径：不管里面谁调谁，临时线在我们这一层就已经接好了。
     *   用 depth 计数保证「只广播一次」：外层已经接过，内层直接透传、不要重复接、更不要提前拆。 */
    let depth = 0;

    function around(fn) {
        if (depth > 0) return fn();
        depth += 1;
        const restore = inflate(appRef);
        const done = () => {
            depth -= 1;
            restore();
        };
        let ret;
        try {
            ret = fn();
        } catch (e) {
            done();
            throw e;
        }
        if (ret && typeof ret.then === "function") {
            return ret.then(
                (v) => {
                    done();
                    return v;
                },
                (e) => {
                    done();
                    throw e;
                },
            );
        }
        done();
        return ret;
    }

    const origPrompt = appRef.graphToPrompt;
    if (typeof origPrompt === "function") {
        appRef.graphToPrompt = function (...args) {
            return around(() => origPrompt.apply(this, args));
        };
    }

    const origQueue = appRef.queuePrompt;
    if (typeof origQueue === "function") {
        appRef.queuePrompt = function (...args) {
            return around(() => origQueue.apply(this, args));
        };
    }

    appRef.__tpBroadcastPatched = true;
    /* 给自检脚本用：直接在「广播生效」上下文里跑一段同步/异步逻辑 */
    appRef.__tpBroadcastAround = (fn) => around(fn);
    /* 给自检脚本用：列出当前会广播哪些线（只算不接） */
    appRef.__tpBroadcastPlan = () =>
        planBroadcast(appRef.graph).pairs.map(
            (p) => `${p.dstNode.id}:${p.dstNode.inputs?.[p.dstSlot]?.name}<-${p.srcNode.id}:${p.srcSlot}`,
        );
}

/* ------------------------------------------------------------------ *
 * 三、注册
 * ------------------------------------------------------------------ */

app.registerExtension({
    name: EXT_NAME,
    async setup() {
        patchGraphToPrompt(app);
        installPreviewPainter(app);
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origCreated ? origCreated.apply(this, arguments) : undefined;
            const node = this;
            /* 加载器自己的 onNodeCreated 末尾会 setSize([270,220])，
             * 所以这里必须排在它之后加控件、再补高度 */
            addBroadcastWidget(node);
            /* 前端重建过画布实例的话，钩子会挂在新实例上缺失——这里顺手兜一次 */
            try {
                installPreviewPainter(app);
            } catch (e) {
                /* 装不上不影响功能 */
            }
            return r;
        };

        /* 读档时 properties 已经恢复，把开关同步成存档里的状态 */
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
            syncBroadcastWidget(this);
            return r;
        };
    },
});
