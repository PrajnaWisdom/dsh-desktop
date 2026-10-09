#!/usr/bin/env python3
"""生成应用图标源图 (1024x1024 RGBA PNG)。

配色：白底 + 黑色符号（黑白单色）。
白色圆角底（带一道极淡的灰描边，避免在白背景上「消失」），符号为近黑渐变。

支持的符号方案（--variant <name>，或 --all 全部输出到 .iconpreview/）：

    horse-ai    整匹马（AI 生成剪影，默认；素材 assets/horse-silhouette.png）
    horse-full  整匹马（纯手拼图元，已弃用，保留作对照）
    horse       马（头部侧面剪影，光颈）
    horse-mane  马（头部侧面剪影，颈脊带鬃毛）
    owl         猫头鹰（正面）
    fox         狐狸（正面）
    prompt      终端提示符  >_
    link        相扣双环

其他模式：
    --mark-png  同时导出控制台页 logo 用的 public/app-mark.png（256px）

依赖：Pillow（仅使用 ImageDraw 基础 API，兼容较旧版本，不依赖
rounded_rectangle 等新特性）。
输出：assets/app-icon.png（默认方案）
"""

import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageOps

SIZE = 1024
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "app-icon.png")
PREVIEW_DIR = os.path.join(ROOT, ".iconpreview")

# ---- 配色：白底黑图 ----
TILE_TOP = (255, 255, 255)
TILE_BOTTOM = (241, 243, 248)
HAIRLINE = (223, 227, 236)       # 圆角底外沿的极淡描边
INK_TOP = (16, 17, 22)           # 符号：近黑
INK_BOTTOM = (44, 46, 56)

# ---- 几何 ----
MARGIN = 32                      # 圆角底外边距
RADIUS = 232                     # 圆角底半径

VARIANTS = ("horse-ai", "horse-full", "horse", "horse-mane", "owl", "fox", "prompt", "link")
DEFAULT_VARIANT = "horse-ai"


# ---------- 基础工具 ----------

def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


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


def rounded_mask(box, radius):
    """L 通道的圆角矩形蒙版。"""
    mask = Image.new("L", (SIZE, SIZE), 0)
    rounded_rect(ImageDraw.Draw(mask), box, radius, 255)
    return mask


def ellipse_mask(cx, cy, rx, ry):
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=255)
    return mask


def slanted_ellipse(cx, cy, rx, ry, angle):
    """斜置椭圆（用于眼睛、鼻孔）。"""
    return ellipse_mask(cx, cy, rx, ry).rotate(angle, resample=Image.BICUBIC, center=(cx, cy))


def annulus(cx, cy, r, w):
    """圆环蒙版（外半径 r，环宽 w）。"""
    mask = Image.new("L", (SIZE, SIZE), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    draw.ellipse((cx - r + w, cy - r + w, cx + r - w, cy + r - w), fill=0)
    return mask


def vertical_gradient(c0, c1):
    """竖向线性渐变（c0 顶部 -> c1 底部）。"""
    img = Image.new("RGB", (1, SIZE))
    px = img.load()
    for y in range(SIZE):
        px[0, y] = lerp(c0, c1, y / (SIZE - 1))
    return img.resize((SIZE, SIZE), Image.BILINEAR)


def quad(p0, p1, p2, steps=40):
    """二次贝塞尔取样（p1 为控制点）。"""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
        pts.append((int(round(x)), int(round(y))))
    return pts


def cubic(p0, p1, p2, p3, steps=48):
    """三次贝塞尔取样（p1/p2 为控制点）。"""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1 - t
        x = mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0]
        y = mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1]
        pts.append((int(round(x)), int(round(y))))
    return pts


def fill_polygon(points):
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask


def scallop(anchors, bulge):
    """把折线改成向外鼓起的波浪边（用于马的鬃毛）。"""
    pts = [anchors[0]]
    for (x0, y0), (x1, y1) in zip(anchors, anchors[1:]):
        mid_x, mid_y = (x0 + x1) / 2, (y0 + y1) / 2
        pts += quad((x0, y0), (mid_x + bulge, mid_y), (x1, y1), 12)
    return pts


# ---------- 符号：马（侧面剪影）----------

def horse_outline(mane=False):
    """马头侧面剪影的闭合轮廓点（已做视觉居中）。"""
    dx = -25   # 视觉居中微调
    pts = []
    # 吻部前缘（下 -> 上）：圆钝的马鼻，避免尖喙感
    pts += cubic((290, 726), (256, 706), (246, 656), (262, 604), 28)
    # 鼻梁 -> 额头 -> 前耳根
    pts += cubic((262, 604), (300, 500), (400, 350), (540, 252), 56)
    # 前耳：左缘 -> 尖 -> 右缘
    pts += quad((540, 252), (548, 176), (580, 122), 20)
    pts += quad((580, 122), (610, 186), (616, 260), 20)
    # 两耳之间的凹陷
    pts += quad((616, 260), (640, 268), (656, 276), 12)
    # 后耳
    pts += quad((656, 276), (652, 200), (668, 134), 20)
    pts += quad((668, 134), (700, 196), (716, 292), 20)
    # 颈脊向下：mane=True 时用波浪边表现鬃毛
    if mane:
        pts += scallop(
            [(716, 292), (752, 402), (786, 512), (820, 640), (846, 742)],
            bulge=16,
        )
    else:
        pts += cubic((716, 292), (792, 500), (838, 700), (846, 792), 56)
    # 颈根加宽成肩胸，圆弧自然收口（不再平切，避免「被裁掉」的观感）
    pts += cubic((846, 792), (812, 882), (690, 906), (560, 862), 40)
    # 喉部向上
    pts += cubic((560, 862), (520, 796), (522, 712), (566, 646), 36)
    # 下颌 -> 下巴
    pts += cubic((566, 646), (470, 700), (360, 728), (290, 726), 40)
    return [(x + dx, y) for x, y in pts]


# 马脸上的镂空细节（眼 / 鼻孔），SVG 与控制台页 logo 共用同一组参数。
# 嘴缝刻意不做：在 1024 下会留下一条过细的「下唇」，缩小后更是完全糊掉。
HORSE_EYE = (437, 442, 44, 30, -20)
HORSE_NOSTRIL = (293, 636, 30, 22, -26)


def horse_mask(mane=False):
    body = fill_polygon(horse_outline(mane))
    eye = HORSE_EYE
    body = ImageChops.subtract(body, slanted_ellipse(eye[0], eye[1], eye[2], eye[3], eye[4]))
    nos = HORSE_NOSTRIL
    return ImageChops.subtract(
        body, slanted_ellipse(nos[0], nos[1], nos[2], nos[3], nos[4])
    )


# ---------- 符号：猫头鹰 ----------

def owl_mask():
    pts = []
    pts += quad((268, 350), (258, 232), (326, 192), 24)      # 左耳外缘
    pts += quad((326, 192), (346, 246), (412, 302), 24)      # 左耳内缘
    pts += cubic((412, 302), (452, 266), (572, 266), (612, 302), 32)   # 头顶
    pts += quad((612, 302), (678, 246), (698, 192), 24)      # 右耳内缘
    pts += quad((698, 192), (766, 232), (756, 350), 24)      # 右耳外缘
    pts += cubic((756, 350), (772, 540), (742, 716), (654, 772), 40)
    pts += cubic((654, 772), (596, 810), (428, 810), (370, 772), 40)
    pts += cubic((370, 772), (282, 716), (252, 540), (268, 350), 40)

    body = fill_polygon(pts)
    eyes = ImageChops.lighter(ellipse_mask(416, 462, 90, 90), ellipse_mask(608, 462, 90, 90))
    body = ImageChops.subtract(body, eyes)
    body = ImageChops.subtract(body, fill_polygon([(474, 570), (550, 570), (512, 654)]))
    pupils = ImageChops.lighter(ellipse_mask(416, 462, 36, 36), ellipse_mask(608, 462, 36, 36))
    return ImageChops.lighter(body, pupils)


# ---------- 符号：狐狸 ----------

def fox_mask():
    pts = []
    pts += quad((252, 392), (216, 240), (286, 176), 24)       # 左耳外缘
    pts += quad((286, 176), (320, 236), (418, 310), 24)       # 左耳内缘
    pts += cubic((418, 310), (456, 280), (568, 280), (606, 310), 32)   # 额头
    pts += quad((606, 310), (704, 236), (738, 176), 24)       # 右耳内缘
    pts += quad((738, 176), (808, 240), (772, 392), 24)       # 右耳外缘
    pts += cubic((772, 392), (800, 552), (648, 736), (512, 792), 44)
    pts += cubic((512, 792), (376, 736), (224, 552), (252, 392), 44)

    body = fill_polygon(pts)
    eyes = ImageChops.lighter(
        slanted_ellipse(406, 468, 76, 52, -16),
        slanted_ellipse(618, 468, 76, 52, 16),
    )
    body = ImageChops.subtract(body, eyes)
    return ImageChops.subtract(body, ellipse_mask(512, 726, 44, 30))


# ---------- 符号：终端提示符 >_ ----------

def prompt_mask():
    x0, xt, yc, half, tw = 208, 514, 512, 150, 64
    inset = round(tw * (xt - x0) / (yc - (yc - half)))
    chevron = [
        (x0, yc - half),
        (xt, yc),
        (x0, yc + half),
        (x0, yc + half - tw),
        (xt - inset, yc),
        (x0, yc - half + tw),
    ]
    mask = fill_polygon(chevron)
    draw = ImageDraw.Draw(mask)
    rounded_rect(draw, (594, 598, 814, 662), 32, 255)   # 光标条
    return mask


# ---------- 符号：相扣双环 ----------

def link_mask():
    a = annulus(424, 430, 186, 66)
    b = annulus(600, 594, 186, 66)
    a = ImageChops.subtract(a, b)   # 交叠处让 B 压过 A
    return ImageChops.lighter(a, b)


# ---------- 符号：整匹马（站立侧影）----------

# 整匹马的构图参数：马头复用 horse_outline 的胸像几何，缩放后接到躯干上
FULL_HEAD_SCALE = 0.38
FULL_HEAD_ANCHOR = (700, 870)   # 胸像中「颈部底端」的参考点
FULL_BODY_ANCHOR = (420, 520)   # 该点落到躯干的位置


def horse_full_mask():
    mask = Image.new("L", (SIZE, SIZE), 0)

    # 1) 躯干：桶身 + 前胸 + 后臀（三个椭圆并集）
    for box in ((345, 452, 748, 676), (290, 470, 510, 700), (592, 458, 834, 712)):
        layer = Image.new("L", (SIZE, SIZE), 0)
        ImageDraw.Draw(layer).ellipse(box, fill=255)
        mask = ImageChops.lighter(mask, layer)

    # 2) 四条腿：向下收细；后腿在飞节处折一下，避免「桌腿」感。
    #    前腿整体右移，让前胸盖过腿根，形成肩部而不是一根柱子的直角接缝。
    legs = [
        [(330, 630), (404, 630), (392, 884), (336, 884)],                          # 前·近
        [(452, 638), (526, 638), (516, 884), (460, 884)],                          # 前·远
        [(620, 648), (694, 648), (708, 726), (712, 884), (656, 884), (646, 726)],  # 后·近
        [(730, 655), (804, 655), (818, 732), (822, 884), (766, 884), (756, 732)],  # 后·远
    ]
    for pts in legs:
        mask = ImageChops.lighter(mask, fill_polygon(pts))

    # 3) 尾巴：自臀部垂下，中段饱满、末端收尖
    tail = quad((812, 456), (900, 660), (884, 800), 24)
    tail += quad((884, 800), (826, 660), (752, 486), 24)[1:]
    mask = ImageChops.lighter(mask, fill_polygon(tail))

    # 4) 头 + 颈：复用胸像几何，等比缩放后接到躯干前上方
    bust = horse_mask(mane=False)
    box = bust.getbbox()
    scaled = bust.crop(box).resize(
        (
            max(1, int(round((box[2] - box[0]) * FULL_HEAD_SCALE))),
            max(1, int(round((box[3] - box[1]) * FULL_HEAD_SCALE))),
        ),
        Image.LANCZOS,
    ).point(lambda v: 255 if v > 127 else 0)   # 缩放后二值化，保住清晰边缘

    head = Image.new("L", (SIZE, SIZE), 0)
    head.paste(
        scaled,
        (
            FULL_BODY_ANCHOR[0] - int(round((FULL_HEAD_ANCHOR[0] - box[0]) * FULL_HEAD_SCALE)),
            FULL_BODY_ANCHOR[1] - int(round((FULL_HEAD_ANCHOR[1] - box[1]) * FULL_HEAD_SCALE)),
        ),
    )
    mask = ImageChops.lighter(mask, head)

    # 5) 视觉居中
    left, top, right, bottom = mask.getbbox()
    dx = int(round(512 - (left + right) / 2))
    dy = int(round(512 - (top + bottom) / 2))
    return ImageChops.offset(mask, dx, dy)


# ---------- 符号：整匹马（AI 剪影，推荐）----------

# 由文生图产出的马剪影（assets/horse-silhouette.png），二值化后作为图标主体。
# 之所以不再手工拼椭圆：手拼的躯干是几个椭圆相并，接缝处必然有鼓包，腿根也会出现直角。
SILHOUETTE_SRC = os.path.join(ROOT, "assets", "horse-silhouette.png")
SILHOUETTE_BOX = 748      # 剪影在 1024 画布中占据的边长


def horse_ai_mask():
    if not os.path.isfile(SILHOUETTE_SRC):
        raise SystemExit(f"缺少剪影素材: {SILHOUETTE_SRC}（应由 assets/horse-silhouette.png 提供）")
    src = Image.open(SILHOUETTE_SRC).convert("L")
    # 白底黑马：反相后即为蒙版。再拉一条对比曲线——
    # 接近白（背景 + 鬃毛处的浅灰噪点）压成 0，深黑（马身）推成 255，
    # 中间那段留给轮廓做抗锯齿（直接用硬阈值会在边上留锯齿）。
    mask = ImageOps.invert(src).point(
        lambda v: 0 if v < 80 else (255 if v > 140 else int((v - 80) * 255 / 60))
    )
    mask = mask.crop(mask.getbbox())

    scale = SILHOUETTE_BOX / max(mask.width, mask.height)
    size = (
        max(1, int(round(mask.width * scale))),
        max(1, int(round(mask.height * scale))),
    )
    mask = mask.resize(size, Image.LANCZOS)

    out = Image.new("L", (SIZE, SIZE), 0)
    out.paste(mask, ((SIZE - size[0]) // 2, (SIZE - size[1]) // 2))
    return out


def symbol_mask(variant):
    if variant == "horse-ai":
        return horse_ai_mask()
    if variant == "horse":
        return horse_mask(mane=False)
    if variant == "horse-mane":
        return horse_mask(mane=True)
    if variant == "horse-full":
        return horse_full_mask()
    if variant == "owl":
        return owl_mask()
    if variant == "fox":
        return fox_mask()
    if variant == "prompt":
        return prompt_mask()
    if variant == "link":
        return link_mask()
    raise SystemExit(f"未知方案: {variant}")


# ---------- 渲染 ----------

def render(variant):
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # 1) 白色圆角底：极淡的竖向渐变
    base_mask = rounded_mask((MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN), RADIUS)
    canvas.paste(vertical_gradient(TILE_TOP, TILE_BOTTOM).convert("RGBA"), (0, 0), base_mask)

    # 2) 外沿发丝描边：白底图标放在白背景上也能看见边界
    inner_mask = rounded_mask(
        (MARGIN + 3, MARGIN + 3, SIZE - MARGIN - 3, SIZE - MARGIN - 3), RADIUS - 3
    )
    line = Image.new("RGBA", (SIZE, SIZE), (*HAIRLINE, 0))
    line.putalpha(ImageChops.subtract(base_mask, inner_mask).point(lambda v: 255 if v > 0 else 0))
    canvas.alpha_composite(line)

    # 3) 黑色符号
    canvas.paste(
        vertical_gradient(INK_TOP, INK_BOTTOM).convert("RGBA"), (0, 0), symbol_mask(variant)
    )
    return canvas


# ---------- 控制台页用的位图标识 ----------

def write_mark_png(path, size=256, variant=None):
    """导出控制台页 logo 用的圆形底位图。

    整匹马是「多个图元并集」的复合图形，没法像单条轮廓那样直接导出成
    SVG path，所以控制台页统一用 PNG（图标本身仍是可复现的向量管线生成）。
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    render(variant or DEFAULT_VARIANT).resize((size, size), Image.LANCZOS).save(path)
    return path


def main():
    args = sys.argv[1:]

    if "--mark-png" in args:
        print(f"标识已生成: {write_mark_png(os.path.join(ROOT, 'public', 'app-mark.png'))}")
        return

    if "--all" in args:
        os.makedirs(PREVIEW_DIR, exist_ok=True)
        for variant in VARIANTS:
            render(variant).save(os.path.join(PREVIEW_DIR, f"{variant}.png"))
            print(f"预览已生成: .iconpreview/{variant}.png")
        return

    variant = DEFAULT_VARIANT
    if "--variant" in args:
        variant = args[args.index("--variant") + 1]

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    render(variant).save(OUT)
    print(f"图标已生成: {OUT}  ({SIZE}x{SIZE}, 方案 {variant})")


if __name__ == "__main__":
    main()
