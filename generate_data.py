"""
generate_data.py
================
Generates synthetic training images for the darts score CNN classifier.

For every score 0-501 it renders the number using the same font the game
displays, then creates N augmented variants per score to simulate real-world
screen capture conditions (blur, brightness shifts, noise, slight rotation).

Output: training_data/<score>.png  (base)
        training_data/aug_<score>_<i>.png  (augmented)

Usage:
    python generate_data.py

Adjust BG_COLOR / FG_COLOR / FONT_PATH to match your game's visual style.
Run ocr_region_debug.png to see what the game looks like before generating.
"""

import os
import random
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# ---------------------------------------------------------------------------
# Configuration — adjust to match your game's score display
# ---------------------------------------------------------------------------

# Candidate font locations: add your game's font here if you know it,
# otherwise the script falls back to Courier New (monospace, readable).
FONT_CANDIDATES = [
    "OCRB.ttf",                                         # project root
    r"C:\Windows\Fonts\OCRB.ttf",
    r"C:\Windows\Fonts\ocr-b.ttf",
    r"C:\Windows\Fonts\OCRBMT.TTF",
    r"C:\Windows\Fonts\cour.ttf",                       # Courier New fallback
]

IMG_W       = 160    # width fed into the CNN
IMG_H       = 64     # height fed into the CNN
FONT_SIZE   = 48     # tweak until numbers fill ~80 % of the image height
BG_COLOR    = 0      # 0 = black background  (set to 255 for white background)
FG_COLOR    = 255    # 255 = white text       (set to 0 for black text)
AUGMENTS    = 50     # augmented variants per score (total = 502 * (1+50))
OUTPUT_DIR  = "training_data"

# ---------------------------------------------------------------------------


def _find_font() -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.isfile(path):
            print(f"Using font: {path}")
            return ImageFont.truetype(path, size=FONT_SIZE)
    # Last resort: Pillow's built-in bitmap font (low quality but always works)
    print("WARNING: No TTF font found — using Pillow default bitmap font.")
    print("         For best results, install Courier New or OCR-B.")
    return ImageFont.load_default()


def _render(text: str, font: ImageFont.FreeTypeFont) -> Image.Image:
    """Render a score string centred on a blank canvas."""
    img  = Image.new("L", (IMG_W, IMG_H), color=BG_COLOR)
    draw = ImageDraw.Draw(img)
    bbox = draw.textbbox((0, 0), text, font=font)
    x    = (IMG_W - (bbox[2] - bbox[0])) // 2 - bbox[0]
    y    = (IMG_H - (bbox[3] - bbox[1])) // 2 - bbox[1]
    draw.text((x, y), text, fill=FG_COLOR, font=font)
    return img


def _augment(img: Image.Image, rng: random.Random) -> Image.Image:
    """Apply random augmentations to simulate screen-capture variation."""
    arr = np.array(img, dtype=np.float32)

    # 1. Brightness / contrast shift
    alpha = rng.uniform(0.75, 1.25)   # contrast
    beta  = rng.uniform(-30,  30)     # brightness offset
    arr   = np.clip(arr * alpha + beta, 0, 255)

    # 2. Gaussian noise
    noise = rng.gauss(0, rng.uniform(0, 8))
    arr   = np.clip(arr + np.random.normal(0, abs(noise), arr.shape), 0, 255)

    img = Image.fromarray(arr.astype(np.uint8))

    # 3. Slight blur (simulates out-of-focus capture)
    if rng.random() < 0.5:
        radius = rng.uniform(0, 1.2)
        img = img.filter(ImageFilter.GaussianBlur(radius=radius))

    # 4. Sub-pixel translation (±3 px)
    dx, dy = rng.randint(-3, 3), rng.randint(-3, 3)
    if dx != 0 or dy != 0:
        img = img.transform(
            img.size,
            Image.AFFINE,
            (1, 0, -dx, 0, 1, -dy),
            resample=Image.BILINEAR,
            fillcolor=BG_COLOR,
        )

    # 5. Tiny rotation (±3 °)
    if rng.random() < 0.4:
        angle = rng.uniform(-3, 3)
        img = img.rotate(angle, resample=Image.BILINEAR, fillcolor=BG_COLOR)

    return img


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    font = _find_font()
    rng  = random.Random(42)

    total = 0
    for score in range(0, 502):
        text = str(score)
        base = _render(text, font)

        # Save base image
        base.save(os.path.join(OUTPUT_DIR, f"{score}.png"))
        total += 1

        # Save augmented variants
        for i in range(AUGMENTS):
            aug = _augment(base, rng)
            aug.save(os.path.join(OUTPUT_DIR, f"aug_{score}_{i}.png"))
            total += 1

        if score % 50 == 0:
            print(f"  Generated score {score:>3}  ({total} images so far)")

    print(f"\nDone. {total} images saved to '{OUTPUT_DIR}/'")
    print(f"  Base images : 502")
    print(f"  Augmented   : {502 * AUGMENTS}")
    print(f"\nNext step: python train.py")


if __name__ == "__main__":
    main()
