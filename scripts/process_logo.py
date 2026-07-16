from PIL import Image, ImageDraw

SRC = "logo.png"
OUT = "src-tauri/icons/source-icon.png"

def main():
    img = Image.open(SRC).convert("RGBA")
    w, h = img.size

    # The background is a flat light gray-blue; flood-fill it away from each
    # corner so only the circular emblem stays opaque, regardless of its
    # exact radius/centering.
    seeds = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
    for seed in seeds:
        ImageDraw.floodfill(img, seed, (0, 0, 0, 0), thresh=40)

    img.save(OUT)
    print("Saved", OUT, img.size)

if __name__ == "__main__":
    main()
