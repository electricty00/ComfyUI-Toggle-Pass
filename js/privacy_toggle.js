/**
 * Privacy Toggle - 隐私遮罩（Toggle-Pass 图片节点）
 *
 * 适用于 SaveLoadImage、ToggleLoadImage、TogglePreviewImage
 * 核心思路：用 Object.defineProperty 在实例上拦截 imgs 的读写
 * 隐私开启时，任何代码读 this.imgs 都返回 []，写操作保存到 _hiddenImgs
 * 标题栏按钮切换，不影响节点尺寸
 *
 * 按钮含义：
 *   👁 = 显示图片（隐私关闭）
 *   🫣 = 隐藏图片（隐私开启）
 */

import { app } from "../../scripts/app.js";

const PRIVACY_KEY = "privacy_hidden";
const TARGET_NODES = ["SaveLoadImage", "ToggleLoadImage", "TogglePreviewImage"];
const BTN_SIZE = 14;
const BTN_MARGIN = 6;

/** 开启隐私：拦截实例的 imgs 属性 */
function enablePrivacy(node) {
    // 保存真实图片
    if (node.imgs && node.imgs.length > 0) {
        node._hiddenImgs = node.imgs;
    }

    // 在实例上定义 imgs，拦截所有读写
    Object.defineProperty(node, 'imgs', {
        get() { return []; },
        set(val) {
            // 写入时保存到 _hiddenImgs，但不让外部读到
            if (val && val.length > 0) {
                this._hiddenImgs = val;
            }
        },
        configurable: true,
        enumerable: true,
    });

    node[PRIVACY_KEY] = true;
}

/** 关闭隐私：删除实例拦截，恢复正常 */
function disablePrivacy(node) {
    // 删除实例上的拦截，让 imgs 回到正常行为
    delete node.imgs;

    // 恢复图片
    if (node._hiddenImgs && node._hiddenImgs.length > 0) {
        node.imgs = node._hiddenImgs;
    }

    node[PRIVACY_KEY] = false;
    node._hiddenImgs = null;
}

app.registerExtension({
    name: "ComfyUI-Toggle-Pass-privacy",

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (!TARGET_NODES.includes(nodeData.name)) return;

        // ===== 序列化 =====
        const origSerialize = nodeType.prototype.serialize;
        nodeType.prototype.serialize = function () {
            const data = origSerialize ? origSerialize.apply(this, arguments) : {};
            if (this[PRIVACY_KEY]) data[PRIVACY_KEY] = true;
            return data;
        };

        // ===== 反序列化 =====
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origConfigure?.apply(this, arguments);
            if (info?.[PRIVACY_KEY]) {
                this[PRIVACY_KEY] = true;
                enablePrivacy(this);
            }
        };

        // ===== onExecuted：执行后若隐私开启则拦截 =====
        const origExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            origExecuted?.apply(this, arguments);
            if (this[PRIVACY_KEY]) {
                // 已经在 enablePrivacy 里拦截了，这里不需要再做任何事
                // 因为 set imgs 会被拦截，图片自动保存到 _hiddenImgs
            } else {
                this._hiddenImgs = [];
            }
            app.graph.change();
        };

        // ===== onDrawForeground：只负责绘制标题栏图标 =====
        const origDrawFg = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            origDrawFg?.apply(this, arguments);

            // ===== 绘制标题栏图标 =====
            const [w] = this.size;
            const titleH = LiteGraph.NODE_TITLE_HEIGHT || 30;
            const icon = this[PRIVACY_KEY] ? "🫣" : "👁";

            let iconX;
            if (this.flags?.collapsed) {
                const textW = ctx.measureText(this.title || "").width;
                iconX = textW + 30 - BTN_MARGIN;
            } else {
                iconX = w - BTN_MARGIN;
            }
            this._privacyBtnRight = iconX;

            ctx.save();
            ctx.font = `${BTN_SIZE}px Arial`;
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillText(icon, iconX, -titleH / 2);
            ctx.restore();
        };

        // ===== 点击标题栏图标切换 =====
        const origMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (e, pos, canvas) {
            const titleH = LiteGraph.NODE_TITLE_HEIGHT || 30;
            const iconRight = this._privacyBtnRight || this.size[0];

            if (
                pos[1] >= -titleH &&
                pos[1] <= 0 &&
                pos[0] >= iconRight - 28 &&
                pos[0] <= iconRight
            ) {
                if (this[PRIVACY_KEY]) {
                    disablePrivacy(this);
                } else {
                    enablePrivacy(this);
                }
                this.setDirtyCanvas(true, true);
                app.graph.change();
                return true;
            }

            return origMouseDown?.apply(this, arguments);
        };
    },
});
