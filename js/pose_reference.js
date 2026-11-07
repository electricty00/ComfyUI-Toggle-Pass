/**
 * ComfyUI-Toggle-Pass: 参考姿势（PoseReference）— 三级联动 + 节点内缩略图
 *
 * Python 端把全部选项平铺给出（大类 4 / 姿势组 26 / 姿势 288 / 视角 5），
 * 不联动也能用。这里做三件事：
 *   1. 选了大类就把「姿势组」收窄到该类下的组，选了组再把「姿势」收窄到该组下的，
 *      切完顺手把画布重绘一次，免得下拉还显示旧选项。
 *   2. 任何下拉一变（大类/组/姿势/视角/线稿深度/翻转）就去 /toggle_pass/pose_image
 *      取一张缩略图，直接画在节点下半部分 —— 不用执行工作流就能看到选的是哪张。
 *   3. 图进来了按比例把节点撑高，保证图不会被挤成一条缝。
 *
 * 图片走自绘（onDrawForeground）而不是 node.imgs：后者需要 HTMLImage 对象、
 * 还依赖前端内部绘制逻辑，跨版本不稳。自绘只依赖 LiteGraph 的公开钩子。
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "PoseReference";
const TREE_API = "/toggle_pass/pose_tree";
const IMAGE_API = "/toggle_pass/pose_image";
const STAMP_API = "/toggle_pass/pose_stamp";

const PAD = 10;
const DEBOUNCE_MS = 120;
// 素材指纹轮询间隔：往本机素材目录里丢新姿势，不用刷新浏览器，最多等这么久自己就出现
const POLL_MS = 15000;
// 会改变「该显示哪张图」的六个下拉
const WATCHED = ["category", "group", "pose", "view", "source", "flip"];
// 1.57 前端给「有 imgs 的节点」自动挂的官方画布预览 widget
const PREVIEW_WIDGET = "$$canvas-image-preview";

let treePromise = null;

function fetchTree(force) {
    if (force) treePromise = null; // 强制重扫：走 ?refresh=1 让后端丢掉缓存
    if (!treePromise) {
        treePromise = api
            .fetchApi(TREE_API + (force ? "?refresh=1" : ""))
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                // 失败/空结果不能留在缓存里：否则后面所有节点都拿这个 null，
                // 联动永远建不起来，只有刷新页面（清掉模块状态）才恢复。
                if (!d || !d.tree) treePromise = null;
                return d;
            })
            .catch(() => {
                treePromise = null;
                return null;
            });
    }
    return treePromise;
}

function widget(node, name) {
    return (node.widgets || []).find((w) => w.name === name);
}

function val(node, name, fallback) {
    const w = widget(node, name);
    return w && w.value !== undefined && w.value !== null ? w.value : fallback;
}

/**
 * 换一套选项。keep=true 时保留当前值（加载工作流用，避免把用户存的姿势改掉）。
 * 返回是否真的变了，用于决定要不要重绘。
 */
function setValues(w, values, keep) {
    if (!w || !Array.isArray(values) || values.length === 0) return false;
    w.options = w.options || {};
    const old = w.options.values;
    const same =
        Array.isArray(old) &&
        old.length === values.length &&
        old.every((v, i) => v === values[i]);
    if (same) return false;

    w.options.values = values.slice();
    if (!keep && !values.includes(w.value)) w.value = values[0];
    return true;
}

function buildSync(node, tree) {
    const wCat = widget(node, "category");
    const wGroup = widget(node, "group");
    const wPose = widget(node, "pose");
    if (!wCat || !wGroup || !wPose) return null;

    const groupsOf = (cat) => Object.keys((tree && tree[cat]) || {});
    const posesOf = (cat, grp) => Object.keys(((tree && tree[cat]) || {})[grp] || {});

    return function sync(keep) {
        let dirty = false;
        dirty = setValues(wGroup, groupsOf(wCat.value), keep) || dirty;
        dirty = setValues(wPose, posesOf(wCat.value, wGroup.value), keep) || dirty;
        if (dirty) {
            node.setDirtyCanvas(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
        }
        return dirty;
    };
}

// ---------------- 工作流内嵌 ----------------
// 选中的素材原文件（webp 约 5KB）以 data URI 存进 node.properties.tp_pose，
// 跟着工作流一起走：别人下载后既能看到图，素材库不在时后端也能拿它出图。
// 后端从 extra_pnginfo 里按 id 找 properties，所以 key 必须和 Python 的 embed_key 拼法一致。

function embedKey(node) {
    return [
        val(node, "category", ""),
        val(node, "group", ""),
        val(node, "pose", ""),
        val(node, "view", ""),
        val(node, "source", "线稿"),
    ]
        .map((x) => String(x))
        .join("|");
}

function flipOn(node) {
    return val(node, "flip", "关") === "开";
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
    });
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("image decode failed"));
        img.src = src;
    });
}

function storeEmbed(node, dataUrl) {
    const key = embedKey(node);
    node.properties = node.properties || {};
    const cur = node.properties.tp_pose;
    if (cur && cur.key === key && cur.img === dataUrl) return;
    node.properties.tp_pose = { key, img: dataUrl };
}

/** 兜底显示：素材库取不到时，先用工作流里带的那张。 */
function showEmbedded(node) {
    const emb = node.properties && node.properties.tp_pose;
    if (!emb || !emb.img) return false;
    loadImage(emb.img)
        .then((img) => {
            if (node._tpPoseFromNet) return; // 真图已经到了，不自找麻烦
            node._tpPoseImg = img;
            node._tpPoseFlip = flipOn(node);
            node._tpPoseErr = emb.key === embedKey(node) ? null : "素材库缺失，显示内嵌旧图";
            fitNode(node, img);
            node.setDirtyCanvas(true, true);
        })
        .catch(() => {});
    return true;
}

// ---------------- 缩略图 ----------------

function previewUrl(node) {
    // raw=1：直接返回素材原文件（webp 约 5KB），不缩放不翻转 —— 既当缩略图又当内嵌源
    const q = new URLSearchParams({
        category: String(val(node, "category", "")),
        group: String(val(node, "group", "")),
        pose: String(val(node, "pose", "")),
        view: String(val(node, "view", "")),
        source: String(val(node, "source", "线稿")),
        raw: "1",
    });
    return `${IMAGE_API}?${q.toString()}`;
}

/** 所有 widget 画完后的底部 y（节点 body 坐标系，原点在标题栏下沿）。 */
function widgetsBottom(node) {
    let bottom = 0;
    const ws = node.widgets || [];
    for (let i = 0; i < ws.length; i++) {
        const w = ws[i];
        let y = typeof w.last_y === "number" ? w.last_y : 4 + i * 28;
        let h = 20;
        if (typeof w.height === "number" && w.height > 0) {
            h = w.height;
        } else if (typeof w.computeSize === "function") {
            try {
                const s = w.computeSize(node.size[0]);
                if (Array.isArray(s) && s.length > 1) h = s[1];
            } catch (e) {
                /* 忽略：拿不到就用默认行高 */
            }
        }
        bottom = Math.max(bottom, y + h);
    }
    return bottom;
}

function fitNode(node, img) {
    const top = widgetsBottom(node);
    const availW = Math.max(80, node.size[0] - PAD * 2);
    // 按图比例算一个「看得清又不占满屏」的高度，限制在 190~300
    const wanted = Math.round(Math.min(300, Math.max(190, (availW * img.height) / img.width * 0.72)));
    const need = Math.ceil(top + 6 + wanted + PAD);
    if (node.size[1] < need) {
        node.size[1] = need; // size 是类数组对象，整块赋值会被吞，逐下标写
        node.setDirtyCanvas(true, true);
    }
}

function refreshPreview(node) {
    const url = previewUrl(node);
    // flip 不参与 URL（拿的是未翻转的原文件），所以单独同步，不能跟着 URL 早退
    const f = flipOn(node);
    if (node._tpPoseFlip !== f) {
        node._tpPoseFlip = f;
        node.setDirtyCanvas(true, true);
    }
    // 已经有这张图就不重复取；但图对象丢了（出错被清、加载中新节点）还是要重取
    if (node._tpPoseUrl === url && node._tpPoseImg) return;
    node._tpPoseUrl = url;
    const keyAtRequest = embedKey(node);

    (async () => {
        try {
            const res = await api.fetchApi(url);
            if (!res.ok) throw new Error("HTTP " + res.status);
            const blob = await res.blob();
            const dataUrl = await blobToDataUrl(blob);
            if (node._tpPoseUrl !== url) return; // 期间又切了别的，丢弃
            const img = await loadImage(dataUrl);
            if (node._tpPoseUrl !== url) return;
            node._tpPoseImg = img;
            node._tpPoseFlip = flipOn(node);
            node._tpPoseErr = null;
            node._tpPoseFromNet = true;
            // 只有参数没在旁边被改过才内嵌，避免把 A 的图写进 B 的设置
            if (embedKey(node) === keyAtRequest) storeEmbed(node, dataUrl);
            fitNode(node, img);
            node.setDirtyCanvas(true, true);
            // litegraph 0.4 里单个节点的 dirty 标记不一定能把画布叫醒，
            // 图换了却停在旧画面，看着就是「点了没反应」。图是重点，再踹一脚整图。
            app.graph?.setDirtyCanvas?.(true, true);
            app.canvas?.setDirty?.(true, true);
        } catch (e) {
            if (node._tpPoseUrl !== url) return;
            // 失败时解锁，否则这个参数组合会被永久判成「已请求过」，
            // 后端恢复后切回来也不重试。
            node._tpPoseUrl = null;
            node._tpPoseFromNet = false;
            const emb = node.properties && node.properties.tp_pose;
            const curKey = embedKey(node);
            // 只有内嵌的那张「正好就是当前选的」才能顶上去。
            // 以前不管三七二十一都拿内嵌图兜底，结果切到别的姿势时画面还是老图，
            // 用户看到的是「点了没反应」，还把真正的取图失败藏得干干净净。
            if (emb && emb.img && emb.key === curKey) {
                try {
                    const img = await loadImage(emb.img);
                    node._tpPoseImg = img;
                    node._tpPoseFlip = flipOn(node);
                    node._tpPoseErr = null;
                    fitNode(node, img);
                    node.setDirtyCanvas(true, true);
                    return;
                } catch (e2) {
                    /* 解码也失败，走下面统一报错 */
                }
            }
            node._tpPoseImg = null;
            node._tpPoseErr = emb && emb.img ? "这张没取到（素材库缺失）" : "素材库缺失";
            node.setDirtyCanvas(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
            console.warn("[PoseReference] 取图失败:", url, e && e.message);
        }
    })();
}

function schedulePreview(node) {
    if (node._tpPoseTimer) clearTimeout(node._tpPoseTimer);
    node._tpPoseTimer = setTimeout(() => {
        node._tpPoseTimer = null;
        try {
            refreshPreview(node);
        } catch (e) {
            console.warn("[PoseReference] 预览刷新失败", e);
        }
    }, DEBOUNCE_MS);
}

/**
 * 参数自检：当前六个下拉的取值，和「上一次送去取图的那套参数」不一致就重取。
 *
 * 这个检查放在绘制里每帧跑，是刻意不依赖 widget.callback 的。实测（1.57 /
 * litegraph 0.4）下拉选完只有 callback 一条通知路径，而 callback 可能被第三方
 * 扩展重写、被旧版本闭包吃掉，或者干脆不触发 —— 一旦漏掉，节点就会永远停在
 * 上一张图上，看起来像「切换不了，得重启」。绘制路径只要画布在动就一定跑，
 * 拿它当兜底，任何漏通知的情况都能自己补上。
 */
function watchParams(node) {
    const key = embedKey(node);
    if (node._tpPoseKey === key) return;
    node._tpPoseKey = key;
    schedulePreview(node);
}

function drawPreview(node, ctx) {
    watchParams(node); // 先自检：参数变了但没人通知，这里补一次
    const top = widgetsBottom(node);
    const x0 = PAD;
    const y0 = top + 6;
    const w0 = node.size[0] - PAD * 2;
    const h0 = node.size[1] - y0 - PAD;
    if (w0 < 40 || h0 < 30) return;

    ctx.save();
    try {
        // 底衬：避免透明网格/深色背景上白线稿看不清边界
        ctx.fillStyle = "#1b1b1b";
        ctx.fillRect(x0, y0, w0, h0);

        const img = node._tpPoseImg;
        if (!img) {
            ctx.fillStyle = "#7a7a7a";
            ctx.font = "12px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(node._tpPoseErr || "加载中…", x0 + w0 / 2, y0 + h0 / 2);
            return;
        }

        const scale = Math.min(w0 / img.width, h0 / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        const dx = x0 + (w0 - dw) / 2;
        const dy = y0 + (h0 - dh) / 2;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        if (node._tpPoseFlip) {
            // 缩略图取的是素材原文件（未翻转），翻转在这里镜像
            ctx.save();
            try {
                ctx.translate(dx + dw, dy);
                ctx.scale(-1, 1);
                ctx.drawImage(img, 0, 0, dw, dh);
            } finally {
                ctx.restore();
            }
        } else {
            ctx.drawImage(img, dx, dy, dw, dh);
        }

        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.lineWidth = 1;
        ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
    } finally {
        ctx.restore();
    }
}

function hookCallback(w, node) {
    if (!w || w._tpPoseHooked) return;
    w._tpPoseHooked = true;
    const orig = w.callback;
    w.callback = function (...args) {
        const ret = orig ? orig.apply(this, args) : undefined;
        // 联动和取图分开 try：联动抛异常不能把取图一起带走，
        // 否则下拉值变了、图却停在上一张。
        try {
            // 必须每次现取 node._tpPoseSync：素材库热更新会换上新树的闭包，
            // 如果在这里闭包捕获旧 sync，下拉永远按旧树联动 —— 新增的类别/组
            // 切不过去，只有重启（重新挂钩）才恢复。
            if (typeof node._tpPoseSync === "function") node._tpPoseSync(false);
        } catch (e) {
            console.warn("[PoseReference] 联动失败", e);
        }
        try {
            schedulePreview(node);
        } catch (e) {
            console.warn("[PoseReference] 预览排队失败", e);
        }
        return ret;
    };
}

function attach(node, tree) {
    const sync = buildSync(node, tree);
    if (sync) node._tpPoseSync = sync;
    // 六个下拉都要挂：前三个带联动，后三个只触发换图
    WATCHED.forEach((name) => {
        hookCallback(widget(node, name), node);
    });
    if (sync) sync(true);
    showEmbedded(node);
    schedulePreview(node);
}

// ---------------- 素材库热更新 ----------------
// 素材分两层：插件自带 pose_assets/（随插件分发、只放非敏感大类）+ 本机外挂
// （D:\pose 或 TP_POSE_ROOT，敏感/自建素材放这里）。往本机目录里丢新姿势后，
// 后端指纹会变，这里自动把下拉重建一遍 —— 不用刷新浏览器。

function poseNodes() {
    return (app.graph?._nodes || []).filter((n) => n.type === NODE_NAME);
}

async function refreshAll(reason) {
    const nodes = poseNodes();
    if (!nodes.length) return 0;
    const data = await fetchTree(true);
    if (!data || !data.tree) return 0;
    for (const n of nodes) {
        try {
            attach(n, data.tree); // 换上新的素材树
            // 新树里可能没有当前选中的组/姿势了（素材被删或改名），这里校正一次，
            // 否则下拉会显示一个不存在的值、点别的又对不上。
            if (typeof n._tpPoseSync === "function") n._tpPoseSync(false);
            // 素材可能被同名替换了内容，URL 却一模一样，不清掉就永远不会重取。
            n._tpPoseUrl = null;
            n._tpPoseFromNet = false;
            schedulePreview(n);
        } catch (e) {
            console.warn("[PoseReference] 重建下拉失败", e);
        }
    }
    console.log(`[PoseReference] 素材库已刷新（${reason}）：${nodes.length} 个节点`);
    return nodes.length;
}

let lastStamp = null;
let pollStarted = false;

function startStampPoll() {
    if (pollStarted) return;
    pollStarted = true;

    const tick = async () => {
        if (!poseNodes().length) return; // 画布上没有本节点就不打扰后端
        try {
            const r = await api.fetchApi(STAMP_API);
            if (!r.ok) return;
            const d = await r.json();
            if (!d || !d.stamp) return;
            if (lastStamp === null) {
                lastStamp = d.stamp; // 首次只记基准，不触发重建
                return;
            }
            if (d.stamp === lastStamp) return;
            lastStamp = d.stamp;
            await refreshAll("指纹变化");
        } catch (e) {
            /* 网络抖动忽略，下一轮再说 */
        }
    };

    // 立刻记一次基准（和画布上有没有节点无关），不能等第一个 interval ——
    // 否则「打开页面后 15 秒内放进去的素材」会被当成基准吞掉，指纹再也不变，永远不刷新。
    (async () => {
        try {
            const r = await api.fetchApi(STAMP_API);
            if (!r.ok) return;
            const d = await r.json();
            if (d && d.stamp) lastStamp = d.stamp;
        } catch (e) {
            /* 拿不到就退化成 tick 里首次记录基准 */
        }
    })();
    setInterval(tick, POLL_MS);
}

/**
 * 摘掉 ComfyUI 1.57 自动挂的官方画布预览 widget。
 *
 * 前端 `useNodeCanvasImagePreview` 的规则很简单：只要节点有 `node.imgs`，
 * 就 `addCustomWidget("$$canvas-image-preview")`。这个 widget 会占掉节点底部
 * 一行，并把执行输出的那张 PNG 画在节点下部 —— 正好压在我们的预览区上面。
 *
 * 于是「生图一开始」就等于给节点盖了一张定死的图：下拉照点、我们的图在背面
 * 其实也换了，但画面上永远停着那张执行结果，看起来就是再也切不动。
 * 本节点的图完全由 onDrawForeground 自己画，不需要官方这一份，直接摘掉；
 * 同时清空 `node.imgs`，否则它下次判断又会把 widget 挂回来。
 */
function stripOfficialPreview(node) {
    if (!node || !node.widgets) return false;
    let hit = false;
    for (let i = node.widgets.length - 1; i >= 0; i--) {
        const w = node.widgets[i];
        if (String((w && w.name) || "") !== PREVIEW_WIDGET) continue;
        if (typeof w.onRemove === "function") {
            try {
                w.onRemove();
            } catch (e) {
                /* 清理回调失败也要把 widget 摘掉 */
            }
        }
        node.widgets.splice(i, 1);
        hit = true;
    }
    if (hit) {
        node.imgs = null;
        node.setDirtyCanvas(true, true);
    }
    return hit;
}

/**
 * 参数巡检：300ms 扫一遍画布上的本节点，参数变了就补一次取图。
 *
 * 绘制里已经有一道同样的检查，但节点被折叠、画布静止不重绘时绘制不一定会跑。
 * 这里只读六个 widget 的 value 拼个字符串，画布上没有本节点时直接返回，
 * 开销可以忽略，换来的是「不管通知从哪条路径丢了，图都能自己跟上」。
 *
 * 顺便每轮摘一次官方预览 widget（见 stripOfficialPreview）。
 */
function startParamWatch() {
    setInterval(() => {
        for (const n of poseNodes()) {
            try {
                stripOfficialPreview(n);
                watchParams(n);
            } catch (e) {
                /* 单个节点异常不能拖垮整轮巡检 */
            }
        }
    }, 300);
}

// 画布右键菜单「刷新姿势素材库」通过这个全局调用（canvas_menu.js 里引用）
window.__tpRefreshPoses = () => refreshAll("手动");

/**
 * 排查用：在浏览器控制台敲 __tpPoseDiag()，打印画布上每个本节点的
 * 选项值 / 已加载图 / 上次请求的 URL / 错误信息。出问题时一眼看出卡在哪一步。
 */
window.__tpPoseDiag = () => {
    const rows = poseNodes().map((n) => ({
        选中: WATCHED.map((k) => val(n, k, "")).join(" / "),
        上次请求: decodeURIComponent((n._tpPoseUrl || "").split("?")[1] || "（无）"),
        已加载图: n._tpPoseImg ? `${n._tpPoseImg.naturalWidth}x${n._tpPoseImg.naturalHeight}` : "（无）",
        来自网络: !!n._tpPoseFromNet,
        错误: n._tpPoseErr || "",
    }));
    console.table(rows);
    return rows;
};

app.registerExtension({
    name: "TogglePass.PoseReference",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        // ---- 节点内缩略图（自绘，链式调用宿主钩子）----
        const origDraw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            const ret = origDraw ? origDraw.apply(this, arguments) : undefined;
            if (ctx) {
                try {
                    drawPreview(this, ctx);
                } catch (e) {
                    console.warn("[PoseReference] 绘制失败", e);
                }
            }
            return ret;
        };

        // ---- 创建节点：拉目录树、挂联动、取首张预览 ----
        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const ret = origCreated ? origCreated.apply(this, arguments) : undefined;
            const node = this;

            // size 是类数组对象，整块赋值会被忽略，必须逐下标写
            if (node.size && node.size[0] < 320) {
                node.size[0] = 340;
            }

            fetchTree().then((data) => {
                if (!data || !data.tree) {
                    schedulePreview(node); // 树拉不到也先把图取上
                    return;
                }
                attach(node, data.tree);
            });
            return ret;
        };

        // ---- 加载工作流：选项可能和存的不一致，刷新一次但保留原值 ----
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const ret = origConfigure ? origConfigure.apply(this, arguments) : undefined;
            const node = this;
            // 换了工作流：上一张的 URL / 来源标记作废，先把内嵌图顶上去再拉本机的
            node._tpPoseUrl = null;
            node._tpPoseFromNet = false;
            node._tpPoseKey = null; // 让绘制自检也认为「参数刚变过」
            showEmbedded(node);
            fetchTree().then((data) => {
                if (!data || !data.tree) {
                    schedulePreview(node);
                    return;
                }
                attach(node, data.tree);
            });
            return ret;
        };

        // ---- 执行完：立刻摘掉官方预览 widget，别让它盖住预览区 ----
        // 这是「生图一开始就再也切不动」的元凶：节点返回 ui.images 后前端会给它
        // 挂一个固定显示执行结果的预览 widget，正好压在预览区上。
        const origExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function () {
            const ret = origExecuted ? origExecuted.apply(this, arguments) : undefined;
            try {
                this.imgs = null; // 官方预览靠它判断要不要挂
                stripOfficialPreview(this);
                schedulePreview(this); // 执行结束是「该重画」的信号，顺手对齐一次
            } catch (e) {
                console.warn("[PoseReference] 清理官方预览失败", e);
            }
            return ret;
        };
    },

    setup() {
        // 前端就绪后开始轮询素材指纹（每 POLL_MS 一次，画布没本节点时直接跳过）
        startStampPoll();
        // 参数巡检：回调漏通知时靠它把图补上
        startParamWatch();
    },
});
