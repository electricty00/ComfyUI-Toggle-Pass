/**
 * ComfyUI-Toggle-Pass 画布菜单（Canvas Menu）
 *
 * 在 ComfyUI 的画布菜单里加一个「🔄 Toggle-Pass」子菜单，
 * 点开即可一键添加本插件的任意节点（和 KJNodes / rgthree 的菜单项同理）。
 *
 * 实现方式对齐官方扩展点 getCanvasMenuItems（参考 comfyui-kjnodes 的 setgetnodes.js）。
 * 节点列表是**运行时自动收集**的：凡是 category 属于 Toggle-Pass 的节点都会出现，
 * 以后新增节点无需再改这个文件。
 */

import { app } from "../../scripts/app.js";

const EXT_NAME = "ComfyUI-Toggle-Pass";
const CATEGORY = "Toggle-Pass";
const MENU_LABEL = "🔄 Toggle-Pass";

function litegraph() {
    return window.LiteGraph || globalThis.LiteGraph || null;
}

/** 收集所有属于 Toggle-Pass 分类的已注册节点（按显示名排序） */
function collectTogglePassNodes() {
    const out = [];
    const g = litegraph();
    if (!g || !g.registered_node_types) return out;
    for (const type of Object.keys(g.registered_node_types)) {
        const def = g.registered_node_types[type];
        const cat = (def && def.category) || "";
        if (cat === CATEGORY || cat.startsWith(CATEGORY + "/")) {
            out.push({ type, title: (def && (def.title || def.display_name)) || type });
        }
    }
    out.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return out;
}

/** 画布可视区域尺寸（CSS 像素）。
 *  必须用 clientWidth/clientHeight，不能用 canvas.width：后者可能带 devicePixelRatio，
 *  而 ds.offset 是 CSS 像素，两者混用会让坐标整体偏移（节点跑到看不见的地方）。
 */
function canvasViewportSize() {
    const el = app.canvas && app.canvas.canvas;
    if (!el) return null;
    const w = el.clientWidth || 0;
    const h = el.clientHeight || 0;
    if (w > 0 && h > 0) return [w, h];
    return el.width && el.height ? [el.width, el.height] : null;
}

/** 新建节点放在哪儿（画布坐标系）。
 *  菜单是「在鼠标处右键」呼出的，所以节点就该落在鼠标那儿，而不是画布正中。
 */
function spawnPosition() {
    const canvas = app.canvas;
    // 1) 鼠标最后所在的画布坐标（打开菜单时鼠标停在哪就是哪）
    const gm = canvas && canvas.graph_mouse;
    if (gm && Number.isFinite(gm[0]) && Number.isFinite(gm[1])) {
        return [gm[0], gm[1]];
    }
    // 2) 取不到才退回画布可视中心
    const ds = canvas && canvas.ds;
    const size = canvasViewportSize();
    if (ds && size) {
        return [
            (size[0] * 0.5 - ds.offset[0]) / ds.scale,
            (size[1] * 0.5 - ds.offset[1]) / ds.scale,
        ];
    }
    return [0, 0];
}

/** 在鼠标位置添加一个节点（节点中心对齐落点） */
function addNodeAtPointer(type) {
    try {
        const g = litegraph();
        if (!g || !g.createNode) return null;
        const node = g.createNode(type);
        if (!node) return null;

        const canvas = app.canvas;
        const graph = (canvas && canvas.graph) || app.graph;
        const [x, y] = spawnPosition();
        node.pos = [
            x - (node.size ? node.size[0] : 200) * 0.5,
            y - (node.size ? node.size[1] : 100) * 0.5,
        ];
        graph.add(node);
        if (canvas && canvas.selectNode) canvas.selectNode(node, false);
        if (graph.change) graph.change();
        if (canvas && canvas.setDirty) canvas.setDirty(true, true);
        return node;
    } catch (err) {
        console.error("[Toggle-Pass] 添加节点失败:", type, err);
        return null;
    }
}

app.registerExtension({
    name: EXT_NAME + "-canvas-menu",

    getCanvasMenuItems() {
        try {
            const nodes = collectTogglePassNodes();
            if (!nodes.length) return [];
            return [
                {
                    content: MENU_LABEL,
                    has_submenu: true,
                    submenu: {
                        options: nodes.map((n) => ({
                            content: n.title,
                            callback: () => { addNodeAtPointer(n.type); },
                        })),
                    },
                },
            ];
        } catch (err) {
            console.error("[Toggle-Pass] getCanvasMenuItems failed:", err);
            return [];
        }
    },
});
