"""
auto_capture.py  –  Fully automated template capture (0 → 501)

SETUP (one time):
  1. Open the darts website so the score display is visible on screen.
  2. Run:  python auto_capture.py
  3. When prompted, move your mouse over the score INPUT field
     in the browser (the field where you type the number), then press ENTER.
  4. The script loops 0 → 501 automatically — no interaction needed.

TUNING:
  Change DELAY_AFTER_INPUT below if captures look wrong
  (number not yet updated on screen).  Start with 1.0s, lower if too slow.
"""

import cv2
import mss
import numpy as np
import time
from pathlib import Path

try:
    import pyautogui
    import pyperclip
    pyautogui.FAILSAFE = True   # move mouse to top-left corner to abort
    pyautogui.PAUSE   = 0.05
except ImportError as e:
    raise SystemExit(f"Missing dependency: {e}.  Run:  pip install pyautogui pyperclip")

# ── must match app.py ─────────────────────────────────────────────────────────
OCR_FIELD2 = {"top": 420, "left": 680, "width": 490, "height": 220}

TOTAL_SCORES      = 502    # 0 … 501
DELAY_AFTER_INPUT = 1.0    # seconds to wait after typing before screenshot
OUT_DIR           = Path("templates_capture")


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_dirs():
    (OUT_DIR / "field2").mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "field2" / "gray").mkdir(parents=True, exist_ok=True)


def _already_done() -> set[int]:
    done = set()
    p = OUT_DIR / "field2"
    if p.exists():
        for f in p.glob("*.png"):
            try:
                done.add(int(f.stem))
            except ValueError:
                pass
    return done


def _is_blank(bgr: np.ndarray) -> bool:
    """Returns True if the image is a solid/near-solid color (browser not rendered)."""
    return int(bgr.max()) - int(bgr.min()) < 10


def _capture_valid(max_retries: int = 10, retry_delay: float = 0.3) -> np.ndarray | None:
    """Capture, retrying until the image has real content (not blank)."""
    with mss.mss() as sct:
        for attempt in range(max_retries):
            raw = sct.grab(OCR_FIELD2)
            bgr = np.array(raw)[:, :, :3]
            if not _is_blank(bgr):
                return bgr
            time.sleep(retry_delay)
    return None   # gave up


def _preprocess(bgr: np.ndarray) -> np.ndarray:
    """Same pipeline as app.py: grayscale → 3× upscale → sharpen → OTSU."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    gray   = cv2.filter2D(gray, -1, kernel)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return thresh


def _set_score(x: int, y: int, score: int):
    """Double-click to enter edit mode, paste new number via clipboard, confirm."""
    pyperclip.copy(str(score))        # put number in clipboard first
    pyautogui.doubleClick(x, y)       # open edit mode + select existing text
    time.sleep(0.2)
    pyautogui.hotkey("ctrl", "a")     # make sure everything is selected
    time.sleep(0.05)
    pyautogui.hotkey("ctrl", "v")     # paste — no keyboard layout issues
    time.sleep(0.05)
    pyautogui.press("enter")


def _save(score: int, bgr: np.ndarray):
    cv2.imwrite(str(OUT_DIR / "field2" / f"{score}.png"),            bgr)
    cv2.imwrite(str(OUT_DIR / "field2" / "gray" / f"{score}.png"),   _preprocess(bgr))


# ── calibration ───────────────────────────────────────────────────────────────

def calibrate() -> tuple[int, int]:
    print("\n─── CALIBRATION ───────────────────────────────────────────────")
    print("Move your mouse over the score INPUT field in the browser")
    print("(the box where you type the number).")
    print("Press ENTER when your cursor is on it.")
    input("  > ")
    x, y = pyautogui.position()
    print(f"  Recorded: ({x}, {y})")
    print("────────────────────────────────────────────────────────────────\n")
    return x, y


# ── main loop ─────────────────────────────────────────────────────────────────

def main():
    _make_dirs()

    done      = _already_done()
    remaining = [s for s in range(TOTAL_SCORES) if s not in done]

    if not remaining:
        print("All 502 scores already captured — nothing to do.")
        return


    print(f"Scores to capture : {len(remaining)}")
    print(f"Already done      : {len(done)}")
    print(f"Delay after input : {DELAY_AFTER_INPUT}s  (edit DELAY_AFTER_INPUT in script to tune)")

    input_x, input_y = calibrate()

    print("Starting in 3 seconds …  switch focus to your browser now!")
    print("Move mouse to top-left corner of screen at any time to abort.\n")
    for i in range(3, 0, -1):
        print(f"  {i}…")
        time.sleep(1)

    for idx, score in enumerate(remaining):
        _set_score(input_x, input_y, score)
        time.sleep(DELAY_AFTER_INPUT)

        bgr = _capture_valid()
        if bgr is None:
            print(f"  [{idx+1:>3}/{len(remaining)}]  score {score:>3}  SKIPPED (blank frame)")
            continue
        _save(score, bgr)

        pct = (idx + 1) / len(remaining) * 100
        print(f"  [{idx+1:>3}/{len(remaining)}]  score {score:>3}  saved   ({pct:.0f}%)")

    print(f"\nDone!  {len(remaining)} images saved to {OUT_DIR.resolve()}")


if __name__ == "__main__":
    main()
