#!/usr/bin/env python3
"""生成 Meshbot 桌面应用图标（白色 logo + 橙色背景，macOS 风格内缩圆角方形）。

依赖：macOS `qlmanage`（把仓库里的矢量 logo.svg 清晰栅格化）+ Python `Pillow`、`iconutil`。
来源：apps/web-agent/public/logo.svg（橙色 #FA771C 的 [·] 标志）。
产物：build/icon.icns（mac）/ icon.ico（win）/ icon.png（linux & 开发期 dock）。

重新生成：在 apps/desktop/build 目录执行 `python3 generate-icons.py`。
"""

import glob
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO_SVG = os.path.normpath(
    os.path.join(HERE, "..", "..", "web-agent", "public", "logo.svg")
)

ORANGE = (250, 119, 28)  # #FA771C，与 logo 同色
CANVAS = 1024            # 主图尺寸
SS = 4                   # 圆角超采样倍率（抗锯齿）
MARGIN = 100             # macOS Big Sur 网格：824x824 内容区 → 每侧留 100
RADIUS = 185             # 圆角半径（≈ 0.2237 * 824）
LOGO_LONGEST = 500       # 白色 logo 最长边目标像素（留足内边距）

# —— 立体感参数（凸起玻璃面：近纯色底 + 左上/右下对角高光 + 白标投影；无底部阴影）——
GRAD_TOP = tuple(round(c + (255 - c) * 0.08) for c in ORANGE)  # 顶部轻微提亮（仅一点点光感）
GRAD_BOTTOM = ORANGE                                           # 底部不压暗 → 去掉底部阴影
RIM_D = 16                # 对角高光带平移量/厚度（px@1024）
RIM_BLUR = 6              # 高光柔化半径（更柔 → 像光不像描边）
RIM_ALPHA_TL = 130        # 左上高光强度（主光）
RIM_ALPHA_BR = 105        # 右下高光强度（对角反光，略弱）
HL_SPAN = 1.0             # 每条对角高光从角部沿边覆盖的边长比例（≈100%，之后渐隐归零）
SHADOW_COLOR = (60, 22, 0, 90)   # 暖色投影（让白标浮起）
SHADOW_DY = round(CANVAS * 0.009)  # 投影下移量 ≈ 9px
SHADOW_BLUR = CANVAS * 0.011       # 投影模糊半径 ≈ 11px


def vertical_gradient(size: int, top, bottom) -> Image.Image:
    """生成竖直线性渐变（上 top → 下 bottom）。"""
    strip = Image.new("RGB", (1, size))
    px = strip.load()
    for y in range(size):
        t = y / (size - 1)
        px[0, y] = tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
    return strip.resize((size, size))


def render_logo_alpha() -> Image.Image:
    """用 qlmanage 把橙色 SVG 渲成 1024 白底图，反推出抗锯齿的 logo alpha 蒙版。"""
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            ["qlmanage", "-t", "-s", str(CANVAS), "-o", tmp, LOGO_SVG],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        png = glob.glob(os.path.join(tmp, "*.png"))[0]
        rgb = Image.open(png).convert("RGB")

    # 背景纯白(B=255)、logo 纯橙(B=28)；蓝通道线性反推覆盖度 → 抗锯齿 alpha。
    blue = rgb.split()[2]
    alpha = blue.point(lambda b: max(0, min(255, round((255 - b) * 255 / (255 - 28)))))
    white = Image.new("RGBA", rgb.size, (255, 255, 255, 0))
    white.putalpha(alpha)
    return white.crop(alpha.getbbox())


def build_master() -> Image.Image:
    """白色 logo 居中叠加到橙色内缩圆角方形上，加渐变/高光/投影得到有立体感的 1024 主图。"""
    # 超采样画圆角蒙版再缩回，得到平滑边缘
    mask_ss = Image.new("L", (CANVAS * SS, CANVAS * SS), 0)
    ImageDraw.Draw(mask_ss).rounded_rectangle(
        [MARGIN * SS, MARGIN * SS, (CANVAS - MARGIN) * SS, (CANVAS - MARGIN) * SS],
        radius=RADIUS * SS,
        fill=255,
    )
    mask = mask_ss.resize((CANVAS, CANVAS), Image.LANCZOS)

    base = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

    # 1) 近纯色橙底（仅极轻竖直渐变，不做整体渐变）
    grad = vertical_gradient(CANVAS, GRAD_TOP, GRAD_BOTTOM).convert("RGBA")
    base.paste(grad, (0, 0), mask)

    # 2) 玻璃面对角高光：左上 + 右下两条贴边亮带，各自只覆盖角部约 HL_SPAN 的边长
    #    （仿 iTerm 等终端图标的对角打光）；不再画底缘暗带（去掉底部阴影）
    content = CANVAS - 2 * MARGIN
    # 横向归一化斜坡（内容区 0→255，左→右）；竖直斜坡由其顺时针旋转得到（上→下 0→255）
    xr = Image.new("L", (CANVAS, 1))
    xpx = xr.load()
    for x in range(CANVAS):
        xpx[x, 0] = max(0, min(255, round((x - MARGIN) / content * 255)))
    xr = xr.resize((CANVAS, CANVAS))
    yr = xr.rotate(-90)

    # 角部窗口：值随「离该角的最大轴向距离」线性衰减，到 HL_SPAN 处归零 → 高亮只占角部约 60%
    def corner_window(xramp: Image.Image, yramp: Image.Image) -> Image.Image:
        far = ImageChops.lighter(xramp, yramp)  # max(x, y)
        return far.point(lambda v: max(0, min(255, round(255 - v / HL_SPAN))))

    win_tl = corner_window(xr, yr)  # 左上角
    win_br = corner_window(ImageChops.invert(xr), ImageChops.invert(yr))  # 右下角

    def edge_rim(dx: int, dy: int, alpha: int, window: Image.Image) -> Image.Image:
        # mask 减去其平移版 → 背光侧紧贴边缘的一条带；再乘角部窗口收成 ~60% 边长
        shifted = Image.new("L", (CANVAS, CANVAS), 0)
        shifted.paste(mask, (dx, dy))
        rim = ImageChops.subtract(mask, shifted).filter(
            ImageFilter.GaussianBlur(RIM_BLUR)
        )
        rim = ImageChops.multiply(rim, mask)
        rim = ImageChops.multiply(rim, window)
        return rim.point(lambda v: round(v / 255 * alpha))

    rim_alpha = ImageChops.add(
        edge_rim(RIM_D, RIM_D, RIM_ALPHA_TL, win_tl),  # 顶+左缘，集中在左上角
        edge_rim(-RIM_D, -RIM_D, RIM_ALPHA_BR, win_br),  # 底+右缘，集中在右下角
    )
    highlight = Image.new("RGBA", (CANVAS, CANVAS), (255, 255, 255, 0))
    highlight.putalpha(rim_alpha)
    base = Image.alpha_composite(base, highlight)

    logo = render_logo_alpha()
    scale = LOGO_LONGEST / max(logo.size)
    logo = logo.resize(
        (round(logo.width * scale), round(logo.height * scale)), Image.LANCZOS
    )
    pos = ((CANVAS - logo.width) // 2, (CANVAS - logo.height) // 2)

    # 3) logo 投影（下移 + 模糊 → 白标浮起），裁进圆角内
    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow.paste(
        Image.new("RGBA", logo.size, SHADOW_COLOR),
        (pos[0], pos[1] + SHADOW_DY),
        logo.split()[3],
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(SHADOW_BLUR))
    shadow.putalpha(ImageChops.multiply(shadow.split()[3], mask))
    base = Image.alpha_composite(base, shadow)

    # 4) 白色 logo
    base.paste(logo, pos, logo)
    return base


def main() -> None:
    master = build_master()
    master.save(os.path.join(HERE, "icon.png"))

    # ---- mac: .iconset → iconutil → .icns ----
    iconset = os.path.join(HERE, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    specs = [
        (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
    ]
    for size, name in specs:
        master.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, name))
    subprocess.run(
        ["iconutil", "-c", "icns", iconset, "-o", os.path.join(HERE, "icon.icns")],
        check=True,
    )

    # ---- win: 多尺寸 .ico ----
    master.save(
        os.path.join(HERE, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    # 清理临时 iconset 目录（iconutil 已产出 .icns，无需保留）
    shutil.rmtree(iconset, ignore_errors=True)

    print("[generate-icons] wrote icon.png / icon.icns / icon.ico ->", HERE)


if __name__ == "__main__":
    main()
