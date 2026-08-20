#!/usr/bin/env python3
"""生成 DSH Desktop 应用图标源图 (1024x1024 RGBA PNG)。

仅使用 PIL 基础绘图 API（兼容旧版本 Pillow），
不依赖圆角矩形等新特性，手动绘制圆角。
输出: assets/app-icon.png
"""

import os

from PIL import Image, ImageDraw

SIZE = 1024
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "app-icon.png")

BG = (11, 16, 32, 255)          # 深蓝黑背景
SCREEN = (18, 27, 46, 255)      # 内屏
ACCENT = (34, 211, 238, 255)    # 青色 (#22d3ee)


def rounded_rect(draw, box, radius, fill):
    """手动绘制圆角矩形（兼容无 rounded_rectangle 的旧版 Pillow）。"""
    x0, y0, x1, y1 = box
    r = min(radius, (x1 - x0) // 2, (y1 - y0) // 2)
    draw.rectangle((x0 + r, y0, x1 - r, y1), fill=fill)
    draw.rectangle((x0, y0 + r, x1, y1 - r), fill=fill)
    draw.pieslice((x0, y0, x0 + 2 * r, y0 + 2 * r), 180, 270, fill=fill)
    draw.pieslice((x1 - 2 * r, y0, x1, y0 + 2 * r), 270, 360, fill=fill)
    draw.pieslice((x0, y1 - 2 * r, x0 + 2 * r, y1), 90, 180, fill=fill)
    draw.pieslice((x1 - 2 * r, y1 - 2 * r, x1, y1), 0, 90, fill=fill)


def main():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 外圆角底
    rounded_rect(draw, (16, 16, SIZE - 16, SIZE - 16), 210, BG)

    # 内屏圆角
    pad = 130
    rounded_rect(draw, (pad, pad, SIZE - pad, SIZE - pad), 120, SCREEN)

    # 终端提示符 ">_" 造型
    # 粗 ">" 箭头（多边形描带）
    chevron = [
        (300, 340), (620, 512), (300, 684),
        (400, 684), (720, 512), (400, 340),
    ]
    draw.polygon(chevron, fill=ACCENT)

    # 光标条
    rounded_rect(draw, (756, 448, 976, 576), 60, ACCENT)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT)
    print(f"图标已生成: {OUT}")


if __name__ == "__main__":
    main()
