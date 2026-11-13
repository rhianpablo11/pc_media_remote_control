"""Gera o ícone oficial da aplicação nos formatos PNG e ICO em múltiplos tamanhos."""

from __future__ import annotations

import os

from PIL import Image, ImageDraw


def draw_media_icon(size: int = 512) -> Image.Image:
    """Desenha um ícone elegante de mídia com fundo escuro e ondas/play em gradiente."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = int(size * 0.06)
    radius = int(size * 0.22)

    # Fundo azul-marinho moderno com cantos arredondados
    # Cores: Dark slate navy (#0f172a) com anel sutil (#1e293b)
    bg_color = (15, 23, 42, 255)
    border_color = (56, 189, 248, 180)  # Ciano suave

    draw.rounded_rectangle(
        [(margin, margin), (size - margin, size - margin)],
        radius=radius,
        fill=bg_color,
        outline=border_color,
        width=max(2, int(size * 0.02)),
    )

    # Desenha o triângulo de Play estilizado + ondas de som
    cx, cy = size // 2, size // 2

    # Triângulo Play
    play_size = int(size * 0.22)
    play_offset_x = int(size * 0.03)  # Compensar centro óptico
    play_points = [
        (cx - play_size + play_offset_x, cy - play_size),
        (cx - play_size + play_offset_x, cy + play_size),
        (cx + play_size + play_offset_x, cy),
    ]
    draw.polygon(play_points, fill=(56, 189, 248, 255))  # Cyan (#38bdf8)

    # Ondas sonoras à direita
    arc_width = max(3, int(size * 0.035))
    arc_color = (125, 211, 252, 220)  # Light cyan

    r1 = int(size * 0.32)
    draw.arc(
        [(cx - r1, cy - r1), (cx + r1, cy + r1)],
        start=-45,
        end=45,
        fill=arc_color,
        width=arc_width,
    )

    r2 = int(size * 0.40)
    draw.arc(
        [(cx - r2, cy - r2), (cx + r2, cy + r2)],
        start=-40,
        end=40,
        fill=(224, 242, 254, 180),
        width=arc_width,
    )

    return img


def main() -> None:
    assets_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
    os.makedirs(assets_dir, exist_ok=True)

    base_img = draw_media_icon(512)

    png_path = os.path.join(assets_dir, "icon.png")
    base_img.save(png_path, format="PNG")
    print(f"Salvo: {png_path}")

    ico_path = os.path.join(assets_dir, "icon.ico")
    icon_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base_img.save(ico_path, format="ICO", sizes=icon_sizes)
    print(f"Salvo: {ico_path}")


if __name__ == "__main__":
    main()
