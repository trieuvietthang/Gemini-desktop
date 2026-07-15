import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
JUSTICE_BLUE = (35, 56, 184)
AUTHORITY_RED = (240, 25, 29)
LEGAL_GOLD = (255, 230, 0)
WHITE = (255, 255, 255)
FONT_PATH = "C:/Windows/Fonts/segoeuib.ttf"

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def make_gradient(size, c1, c2):
    # Diagonal gradient (top-left -> bottom-right)
    x = np.linspace(0, 1, size)
    y = np.linspace(0, 1, size)
    xx, yy = np.meshgrid(x, y)
    t = ((xx + yy) / 2.0)
    t = np.clip(t, 0, 1)
    grad = np.zeros((size, size, 3), dtype=np.uint8)
    for i in range(3):
        grad[..., i] = (c1[i] + (c2[i] - c1[i]) * t).astype(np.uint8)
    return Image.fromarray(grad, mode="RGB")

def rounded_square_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=radius, fill=255)
    return mask

def sparkle_points(cx, cy, outer_r, inner_r, rotation_deg=0):
    points = []
    for i in range(8):
        angle = math.radians(i * 45 + rotation_deg)
        r = outer_r if i % 2 == 0 else inner_r
        points.append((cx + r * math.sin(angle), cy - r * math.cos(angle)))
    return points

def main():
    bg = make_gradient(SIZE, JUSTICE_BLUE, AUTHORITY_RED).convert("RGBA")
    mask = rounded_square_mask(SIZE, radius=int(SIZE * 0.22))

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), mask)

    draw = ImageDraw.Draw(canvas)

    # "T" monogram (TVT), not a sparkle/star, to stay clearly distinct from
    # Google's Gemini mark.
    font = ImageFont.truetype(FONT_PATH, int(SIZE * 0.62))
    text = "T"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (SIZE - tw) / 2 - bbox[0]
    ty = (SIZE - th) / 2 - bbox[1] - SIZE * 0.02
    draw.text((tx, ty), text, font=font, fill=WHITE)

    # Small gold accent dot, top-right, as a light nod to the AI theme.
    r = SIZE * 0.045
    cx, cy = SIZE * 0.795, SIZE * 0.205
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=LEGAL_GOLD)

    out_path = "src-tauri/icons/source-icon.png"
    canvas.save(out_path)
    print("Saved", out_path)

if __name__ == "__main__":
    main()
