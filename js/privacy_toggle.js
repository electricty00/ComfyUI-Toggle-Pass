/**
 * Privacy Toggle - 隐私遮罩（Toggle-Pass 图片节点）
 *
 * 适用于 SaveLoadImage、ToggleLoadImage、TogglePreviewImage
 * 拦截 onExecuted，隐私模式时清空 node.imgs 阻止渲染
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

app.registerExtension({
    name: "ComfyUI-Toggle-Pass-privacy",

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (!TARGET_NODES.includes(nodeData.name)) return;

        // 序列化
        const origSerialize = nodeType.prototype.serialize;
        nodeType.prototype.serialize = function () {
            const data = origSerialize ? origSerialize.apply(this, arguments) : {};
            if (this[PRIVACY_KEY]) data[PRIVACY_KEY] = true;
            return data;
        };

        // 反序列化
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origConfigure?.apply(this, arguments);
            if (info?.[PRIVACY_KEY]) {
                this[PRIVACY_KEY] = true;
                this._hiddenImgs = this.imgs;
                this.imgs = [];
            }
        };

        // 拦截 onExecuted：隐私模式时清空图片
        const origExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            origExecuted?.apply(this, arguments);
            if (this[PRIVACY_KEY]) {
                this._hiddenImgs = this.imgs;
                this.imgs = [];
            } else {
                this._hiddenImgs = [];
            }
            app.graph.change();
        };

        // 绘制标题栏图标
        const origDrawFg = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            origDrawFg?.apply(this, arguments);

            const [w] = this.size;
            const titleH = LiteGraph.NODE_TITLE_HEIGHT || 30;
            const icon = this[PRIVACY_KEY] ? "🫣" : "👁";

            // 折叠时标题栏视觉宽度 ≠ this.size[0]，用标题文字宽度 + padding 估算
            let iconX;
            if (this.flags?.collapsed) {
                const textW = ctx.measureText(this.title || "").width;
                const barW = textW + 30; // 左侧padding(8) + 右侧padding(8) + 预留空间
                iconX = barW - BTN_MARGIN;
            } else {
                iconX = w - BTN_MARGIN;
            }
            // 缓存，供 onMouseDown 使用
            this._privacyBtnRight = iconX;

            ctx.save();
            ctx.font = `${BTN_SIZE}px Arial`;
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillText(icon, iconX, -titleH / 2);
            ctx.restore();
        };

        // 点击标题栏图标切换
        const origMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (e, pos, canvas) {
            const titleH = LiteGraph.NODE_TITLE_HEIGHT || 30;
            const iconRight = this._privacyBtnRight || this.size[0];

            if (pos[1] >= -titleH && pos[1] <= 0 && pos[0] >= iconRight - 28 && pos[0] <= iconRight) {
                this[PRIVACY_KEY] = !this[PRIVACY_KEY];
                if (this[PRIVACY_KEY]) {
                    this._hiddenImgs = this.imgs;
                    this.imgs = [];
                } else {
                    this.imgs = this._hiddenImgs || [];
                    this._hiddenImgs = [];
                }
                this.setDirtyCanvas(true, false);
                app.graph.change();
                return true;
            }

            return origMouseDown?.apply(this, arguments);
        };
    },
});
