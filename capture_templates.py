"""
capture_templates.py  –  Template image capture tool for darts OCR

HOW TO USE:
  1. Run:  python capture_templates.py
  2. A live preview window opens showing both OCR areas.
  3. Use your browser extension to set the score on screen.
  4. Press SPACE to capture and save that score's image.
  5. The counter auto-increments.  Use LEFT/RIGHT arrows to adjust.
  6. Type digits + ENTER to jump to a specific score.
  7. Press Q to quit.

Images are saved to:
  templates_capture/field2/<score>.png        (raw crop, 0–501)
  templates_capture/field2/gray/<score>.png   (preprocessed grayscale)
"""

import cv2
import mss
import numpy as np
from pathlib import Path

# ── OCR regions (must match app.py) ──────────────────────────────────────────
OCR_FIELD2 = {"top": 420, "left": 700, "width": 490, "height": 220}

TOTAL_SCORES = 502          # 0 … 501
OUT_DIR      = Path("templates_capture")

# preview window layout constants
PREVIEW_SCALE  = 1.5        # magnify the crop for easier viewing
PANEL_PAD      = 20         # pixels between panels
INFO_HEIGHT    = 80         # pixels for the text bar at the bottom


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_dirs():
    (OUT_DIR / "field2").mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "field2" / "gray").mkdir(parents=True, exist_ok=True)


def _capture_field(sct: mss.mss) -> np.ndarray:
    """Grab Field 2 screen region; return BGR uint8 array."""
    raw = sct.grab(OCR_FIELD2)
    return np.array(raw)[:, :, :3]  # BGRA → BGR


def _preprocess(bgr: np.ndarray) -> np.ndarray:
    """Same preprocessing as app.py: grayscale → upscale → sharpen → OTSU."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    gray = cv2.filter2D(gray, -1, kernel)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return thresh


def _count_captured() -> dict[int, list[int]]:
    """Return {field: [captured_scores]} from what already exists on disk."""
    captured = {1: [], 2: []}
    for field in (1, 2):
        p = OUT_DIR / f"field{field}"
        if p.exists():
            for f in p.glob("*.png"):
                try:
                    captured[field].append(int(f.stem))
                except ValueError:
                    pass
    return captured


def _build_preview(bgr2: np.ndarray,
                   score: int, captured: dict[int, list[int]],
                   typed_buf: str) -> np.ndarray:
    """Compose Field 2 crop + status bar into one preview image."""
    h2, w2 = bgr2.shape[:2]
    row = cv2.resize(bgr2, (int(w2 * PREVIEW_SCALE), int(h2 * PREVIEW_SCALE)),
                     interpolation=cv2.INTER_LINEAR)

    # status bar
    W = row.shape[1]
    bar = np.zeros((INFO_HEIGHT, W, 3), dtype=np.uint8)

    n2    = len(captured[2])
    total = TOTAL_SCORES

    cv2.putText(row, "FIELD 2", (10, 22),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (180, 180, 255), 1)

    score_txt = f"Score: {score}  [{typed_buf}]" if typed_buf else f"Score: {score}"
    cv2.putText(bar, score_txt, (10, 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 100), 2)

    prog2_txt = f"Captured: {n2}/{total}"
    cv2.putText(bar, prog2_txt, (10, 60),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (180, 180, 255), 1)

    hint = "SPACE=capture  LEFT/RIGHT=adjust  0-9+ENTER=jump  Q=quit"
    cv2.putText(bar, hint, (10, 78),
                cv2.FONT_HERSHEY_SIMPLEX, 0.38, (150, 150, 150), 1)

    return np.vstack([row, bar])


# ── main loop ─────────────────────────────────────────────────────────────────

def main():
    _make_dirs()
    captured = _count_captured()

    # start from first uncaptured score (field 2)
    done2 = set(captured[2])
    score = next((s for s in range(TOTAL_SCORES) if s not in done2), 0)

    typed_buf = ""
    flash_msg = ""
    flash_until = 0.0

    cv2.namedWindow("Template Capture", cv2.WINDOW_NORMAL)
    cv2.resizeWindow("Template Capture", 1000, 500)

    import time

    with mss.mss() as sct:
        while True:
            bgr2 = _capture_field(sct)

            preview = _build_preview(bgr2, score, captured, typed_buf)

            # flash overlay
            if time.time() < flash_until:
                overlay = preview.copy()
                cv2.rectangle(overlay, (0, 0), (preview.shape[1], preview.shape[0]),
                              (0, 200, 0), -1)
                cv2.addWeighted(overlay, 0.25, preview, 0.75, 0, preview)
                cv2.putText(preview, flash_msg,
                            (preview.shape[1] // 2 - 160, preview.shape[0] // 2),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 3)

            cv2.imshow("Template Capture", preview)
            key = cv2.waitKey(40) & 0xFF  # ~25 fps

            if key == ord('q') or key == 27:           # Q or ESC → quit
                break

            elif key == ord(' '):                       # SPACE → capture
                # save Field 2 only (reference side)
                raw_path  = OUT_DIR / "field2" / f"{score}.png"
                gray_path = OUT_DIR / "field2" / "gray" / f"{score}.png"
                cv2.imwrite(str(raw_path),  bgr2)
                cv2.imwrite(str(gray_path), _preprocess(bgr2))
                if score not in captured[2]:
                    captured[2].append(score)

                flash_msg   = f"Saved {score}"
                flash_until = time.time() + 0.6

                # auto advance to next uncaptured score
                done2 = set(captured[2])
                nxt = next((s for s in range(score + 1, TOTAL_SCORES)
                            if s not in done2), None)
                if nxt is not None:
                    score = nxt
                typed_buf = ""

            elif key == 81 or key == 2424832:           # LEFT arrow
                score = max(0, score - 1)
                typed_buf = ""

            elif key == 83 or key == 2555904:           # RIGHT arrow
                score = min(TOTAL_SCORES - 1, score + 1)
                typed_buf = ""

            elif ord('0') <= key <= ord('9'):           # digit
                typed_buf += chr(key)

            elif key == 13 or key == 10:                # ENTER → jump to typed score
                if typed_buf:
                    val = int(typed_buf)
                    if 0 <= val < TOTAL_SCORES:
                        score = val
                    else:
                        flash_msg   = f"Out of range (0-501)"
                        flash_until = time.time() + 1.0
                    typed_buf = ""

    cv2.destroyAllWindows()
    captured = _count_captured()
    print(f"\nDone.  Field 1: {len(captured[1])}/502  Field 2: {len(captured[2])}/502")
    print(f"Images saved in: {OUT_DIR.resolve()}")


if __name__ == "__main__":
    main()
