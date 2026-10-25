/**
 * 选择框位置修正 —— 绕过 ComfyUI 前端（1.57.x）的一个裁剪 bug。
 *
 * 现象：在画布**上半部分**按住鼠标拖框，框却从画面中下部出现；或者干脆整块不见了，
 *       看起来像「鼠标在左上角拉、框跑到中间」。框的左右位置往往是对的，**只有上下不对**。
 *
 * 根因（读前端源码 + 实测确认，不是猜的）：
 *   `SelectionRectangle` 组件（GraphView-*.js）拿 `pointer.eDown/eMove.safeOffsetX/Y`
 *   算出框的矩形后，还要跟 `panelEl` 的矩形**求交集**再渲染：
 *       const { left, top, right, bottom } = i ? intersect(rect, i) : rect;
 *   而 `panelEl` 绑的是 `.graph-canvas-panel`，实测这个容器并不等于整个画布：
 *       画布 canvas         = [0, 0, 1600, 852]
 *       .graph-canvas-panel = [64, 488, 1528, 356]   ← 只覆盖画布右下部
 *   于是在 y < 488 的位置拖框时，交集把框的 top 强行抬到 488、bottom 却还小于 488，
 *   高度被压成 0 —— 框就「消失」或「跳到下面」了。
 *   （实测 1300x700 / 1600x900 / 1920x1080 / 2560x1400 四种窗口都一样；
 *     拦截全部自定义扩展后也一样 ⇒ 与任何插件无关，是前端自身的问题。）
 *
 * 修法：不改任何布局，只在这条框元素上，把 left/top/width/height 按 `pointer.eDown/eMove`
 *   的**真实按下点 / 当前点**重写一遍。纯显示层覆盖，不碰画布状态、不影响选中逻辑。
 *
 * ⚠️ 为什么用 MutationObserver 而不是逐帧 requestAnimationFrame：
 *   前端也是在渲染帧/微任务里改这条框的 style。rAF 回调按**注册顺序**执行，
 *   本文件的循环是最早注册的那批，永远排在 Vue 写 style **之前** ⇒ 写了也立刻被覆盖
 *   （实测：补丁写入 37 次/轮，框的位置一次都没变）。MutationObserver 的回调排在
 *   DOM 变更**之后**，才能真正盖住它。
 *
 * 停用：控制台执行 `localStorage.setItem("tp_selrect_fix", "off")` 后刷新；
 *       恢复用 `localStorage.removeItem("tp_selrect_fix")`。
 */

const SEL_KEY = "tp_selrect_fix";
const SEL_SELECTOR = '[data-testid="selection-rectangle"]';

function selRectFixEnabled() {
    try {
        return localStorage.getItem(SEL_KEY) !== "off";
    } catch (e) {
        return true;
    }
}

function installSelectionRectFix() {
    if (typeof window === "undefined" || window.__tpSelRectFix) return;
    if (!selRectFixEnabled()) return;
    window.__tpSelRectFix = true;

    let target = null;
    let observer = null;

    /** 按真实按下点/当前点写回框的位置；返回 true 表示写过 */
    function apply() {
        const cv = typeof app !== "undefined" ? app && app.canvas : window.app && window.app.canvas;
        /* 非拖动期不介入（这一步也保证不会跟官方的显隐逻辑打架） */
        if (!cv || !cv.dragging_rectangle || !target) return false;
        const p = cv.pointer;
        if (!p || !p.eDown || !p.eMove) return false;
        const x0 = p.eDown.safeOffsetX;
        const y0 = p.eDown.safeOffsetY;
        const x1 = p.eMove.safeOffsetX;
        const y1 = p.eMove.safeOffsetY;
        if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) return false;

        const s = target.style;
        const L = Math.min(x0, x1);
        const T = Math.min(y0, y1);
        const W = Math.abs(x1 - x0);
        const H = Math.abs(y1 - y0);
        /* 必须「值不同才写」：无条件写会和 MutationObserver 形成自激循环 */
        if (s.left !== L + "px") s.left = L + "px";
        if (s.top !== T + "px") s.top = T + "px";
        if (s.width !== W + "px") s.width = W + "px";
        if (s.height !== H + "px") s.height = H + "px";
        /* 官方用 v-show 控制显隐；框本该显示却因被裁成 0 高而隐藏时，恢复可见 */
        if (s.display === "none") s.display = "";
        return true;
    }

    /** 盯住那条框元素（v-show 只切 display，元素本身常驻，通常一次就绑上） */
    function attach() {
        const el = document.querySelector(SEL_SELECTOR);
        if (!el || el === target) return;
        if (observer) observer.disconnect();
        target = el;
        observer = new MutationObserver(() => {
            try {
                apply();
            } catch (e) {
                /* 修正失败不影响任何功能 */
            }
        });
        observer.observe(el, { attributes: true, attributeFilter: ["style"] });
    }

    attach();
    /* 兜底：万一前端重建了这条元素（换工作流 / 重挂载），重新绑一次。
     * 每 2 秒一次 `document.contains` 的开销可以忽略。 */
    setInterval(() => {
        if (!target || !document.contains(target)) attach();
    }, 2000);

    /* 拖动起手时也主动补一次：首帧的 MutationObserver 可能还没轮到，
     * 用 setTimeout(0) 排在当前微任务之后执行（不要用 rAF，理由见文件头）。 */
    document.addEventListener(
        "pointerdown",
        () => {
            setTimeout(() => {
                try {
                    apply();
                } catch (e) {
                    /* ignore */
                }
            }, 0);
        },
        true,
    );
}

installSelectionRectFix();
