"""
ocr_throws.py
Captures the 3 individual dart-score boxes (e.g. 1 / 20 / 20)
and returns them as a list.  Runs as a background thread and
exposes the latest reading via get_latest_throws().

Region layout (Field 1 – left player, adjust to your screen):

  ┌──────┐  ┌──────┐  ┌──────┐
  │  1   │  │  20  │  │  20  │
  │ S1   │  │ S20  │  │ S20  │
  └──────┘  └──────┘  └──────┘
"""

import threading
import time
import re

import mss
import cv2
import numpy as np
import pytesseract

pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

# ---------------------------------------------------------------------------
# Region definitions  (top, left, width, height – tweak to match your screen)
# ---------------------------------------------------------------------------
# Field 1: left player's dart boxes
THROW_REGIONS_F1 = [
    {"top": 458, "left":  40, "width": 130, "height": 120},  # dart 1
    {"top": 458, "left": 175, "width": 130, "height": 120},  # dart 2
    {"top": 458, "left": 310, "width": 130, "height": 120},  # dart 3
]

# Field 2: right player's dart boxes
THROW_REGIONS_F2 = [
    {"top": 458, "left": 505, "width": 130, "height": 120},
    {"top": 458, "left": 640, "width": 130, "height": 120},
    {"top": 458, "left": 775, "width": 130, "height": 120},
]

current_field = 1
SAVE_DEBUG = True

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
_latest_throws: list[int | None] = [None, None, None]
_latest_ts: float = 0.0
_lock = threading.Lock()


def get_latest_throws() -> list[int | None]:
    with _lock:
        return list(_latest_throws)


# ---------------------------------------------------------------------------
# OCR helpers
# ---------------------------------------------------------------------------

def _ocr_region(region: dict) -> int | None:
    """Grab one box region and return the number inside it."""
    try:
        with mss.mss() as sct:
            img = np.array(sct.grab(region))

        gray = cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY) 
        gray = cv2.resize(gray, None, fx=3, fy=3, interpolation=cv2.INTER_LINEAR)

        # Sharpen
        kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
        gray = cv2.filter2D(gray, -1, kernel)

        otsu  = cv2.threshold(gray, 0,   255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
        binary = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY)[1]

        cfg = "--psm 8 -c tessedit_char_whitelist=0123456789 --oem 1"
        for th in (otsu, binary):
            text = pytesseract.image_to_string(th, config=cfg)
            nums = re.findall(r"\d+", text)
            if nums:
                n = int(nums[0])
                if 0 <= n <= 60:   # max single dart score
                    return n
        return None
    except Exception as e:
        print(f"Throw OCR error: {e}")
        return None


def _read_throws() -> list[int | None]:
    regions = THROW_REGIONS_F1 if current_field == 1 else THROW_REGIONS_F2
    return [_ocr_region(r) for r in regions]


def save_debug_images():
    """Save debug PNGs for all 3 regions to help with calibration."""
    regions = THROW_REGIONS_F1 if current_field == 1 else THROW_REGIONS_F2
    for i, region in enumerate(regions):
        with mss.mss() as sct:
            img = np.array(sct.grab(region))
        bgr = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        path = f"ocr_throw_debug_{i+1}.png"
        cv2.imwrite(path, bgr)
        print(f"Saved {path}")


# ---------------------------------------------------------------------------
# Background polling loop
# ---------------------------------------------------------------------------

def throws_loop(poll_s: float = 0.35):
    global _latest_throws, _latest_ts
    _prev = [None, None, None]
    _count = [0, 0, 0]
    _REQUIRED = 2

    while True:
        try:
            reads = _read_throws()
            confirmed = list(_latest_throws)

            for i, val in enumerate(reads):
                if val is not None:
                    if val == _prev[i]:
                        _count[i] += 1
                    else:
                        _prev[i] = val
                        _count[i] = 1
                    if _count[i] >= _REQUIRED:
                        confirmed[i] = val
                else:
                    _prev[i] = None
                    _count[i] = 0

            with _lock:
                _latest_throws = confirmed
                _latest_ts = time.time()

            print(f"Throws: {confirmed}")
        except Exception as e:
            print(f"Throws loop error: {e}")
        time.sleep(poll_s)


def start_throws_thread():
    t = threading.Thread(target=throws_loop, daemon=True)
    t.start()
    return t


# ---------------------------------------------------------------------------
# Standalone test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("Saving debug images for calibration...")
    save_debug_images()
    print("Starting throw OCR loop (Ctrl+C to stop)...")
    start_throws_thread()
    try:
        while True:
            time.sleep(1)
            print("Latest throws:", get_latest_throws())
    except KeyboardInterrupt:
        print("Stopped.")
