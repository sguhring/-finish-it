from flask import Flask, render_template, request, jsonify, send_file
import numpy as np
import threading
import time
import re
import os
import io
import json
import queue
import colorsys
import urllib.request

import mss
import cv2



_TEMPLATES_DIR = os.path.join(os.path.dirname(__file__),
                               "templates_capture", "field2")
_TEMPLATES_LOADED  = False
_TEMPLATE_MATRIX: np.ndarray | None = None   # (N, H*W) normalised float32
_TEMPLATE_SCORES:  list[int]        = []     # score label per row
_MATCH_SIZE = (256, 96)                      # content-only fingerprint size

TEMPLATE_CONF_THRESHOLD = 0.56
TEMPLATE_DEBUG = False


def _load_templates() -> bool:
    global _TEMPLATES_LOADED, _TEMPLATE_MATRIX, _TEMPLATE_SCORES
    if _TEMPLATES_LOADED:
        return _TEMPLATE_MATRIX is not None
    _TEMPLATES_LOADED = True
    if not os.path.isdir(_TEMPLATES_DIR):
        print("Template matching: no template directory found — using Tesseract fallback.")
        return False
    rows, scores = [], []
    for score in range(502):
        path = os.path.join(_TEMPLATES_DIR, f"{score}.png")
        if not os.path.isfile(path):
            continue
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        if img is None:
            continue
        img = _preprocess_for_match_bgr(img)
        small = _make_match_fingerprint(img).astype(np.float32)
        small = small.flatten()
        small -= small.mean()
        std = small.std()
        if std > 0:
            small /= std
        rows.append(small)
        scores.append(score)
    if not rows:
        return False
    _TEMPLATE_MATRIX = np.stack(rows)   # (N, H*W)
    _TEMPLATE_SCORES = scores
    print(f"Template matching: loaded {len(scores)}/502 templates.")
    return True


def _preprocess_gray(gray: np.ndarray) -> np.ndarray:
    """Shared core: sharpen → OTSU threshold."""
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    gray = cv2.filter2D(gray, -1, kernel)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return thresh

def _preprocess_for_match(bgra: np.ndarray) -> np.ndarray:
    """Live frame (BGRA) → binary at native resolution."""
    return _preprocess_gray(cv2.cvtColor(bgra, cv2.COLOR_BGRA2GRAY))

def _preprocess_for_match_bgr(bgr: np.ndarray) -> np.ndarray:
    """Template file (BGR) → binary at native resolution."""
    return _preprocess_gray(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY))


def _make_match_fingerprint(img: np.ndarray) -> np.ndarray:
    """Crop to digit bounding box (top 70% only to ignore bottom UI blocks)."""
    h_limit = int(img.shape[0] * 0.70)
    roi = img[:h_limit, :]
    points = cv2.findNonZero(roi)
    if points is None:
        crop = roi
    else:
        x, y, w, h = cv2.boundingRect(points)
        pad = 8
        x0 = max(0, x - pad)
        y0 = max(0, y - pad)
        x1 = min(roi.shape[1], x + w + pad)
        y1 = min(roi.shape[0], y + h + pad)
        crop = roi[y0:y1, x0:x1]
    return cv2.resize(crop, _MATCH_SIZE, interpolation=cv2.INTER_AREA)


def _template_read(bgra: np.ndarray) -> tuple[int | None, str]:
    """Match live frame against all templates with one matrix multiply."""
    frame = _preprocess_for_match(bgra)
    small = _make_match_fingerprint(frame).astype(np.float32)
    small = small.flatten()
    small -= small.mean()
    std = small.std()
    if std > 0:
        small /= std

    # single matrix-vector multiply → correlation for every template at once
    correlations = (_TEMPLATE_MATRIX @ small) / small.shape[0]
    best_idx  = int(correlations.argmax())
    best_val  = float(correlations[best_idx])
    best_score = _TEMPLATE_SCORES[best_idx]

    if TEMPLATE_DEBUG:
        print(f"Template match: score={best_score}  corr={best_val:.4f}")
    if best_val < TEMPLATE_CONF_THRESHOLD:
        if TEMPLATE_DEBUG:
            print(f"  Low correlation ({best_val:.4f}) — ignoring.")
        return None, f"template low-conf ({best_val:.3f})"
    return best_score, str(best_score)

app = Flask(__name__)

# Cache for the finishes table (2–170) so it is only built once
_FINISH_TABLE_CACHE: list[dict] | None = None

# Screen region the OCR reader captures for the current score
OCR_FIELDS = {
    1: {"top": 420, "left": 120, "width": 430, "height": 220},
    2: {"top": 420, "left": 680, "width": 490, "height": 220},
}
current_field = 2
OCR_REGION = OCR_FIELDS[current_field]
SAVE_OCR_DEBUG = False  # set True only when calibrating OCR/debug images

latest_score = None
latest_raw_text = ""
latest_updated_ts = 0.0
lock = threading.Lock()


# ---------------------------------------------------------------------------
# Pushed scores (browser extension)
#
# The Edge content script reads the scores straight out of the Scolia DOM and
# POSTs them to /api/score. Those values are exact by construction, so while a
# fresh push is available ocr_loop() uses it and skips the screen grab and
# template match entirely. Screen OCR stays as the fallback for when the
# extension is not running (or the page layout changed under it).
# ---------------------------------------------------------------------------

PUSH_TTL_S = 5.0          # a push older than this is considered stale
pushed_scores: dict[int, int | None] = {1: None, 2: None}
pushed_ts = 0.0
latest_source = "none"    # "push" | "ocr" | "none"


# ---------------------------------------------------------------------------
# WLED status light
#
# Mirrors the current checkout situation on an RGB strip around the board.
# The colour is pushed from ocr_loop() whenever the accepted score *changes* —
# not on every poll — and the actual HTTP call runs on its own thread, so an
# unreachable ESP can never stall the OCR reader.
# ---------------------------------------------------------------------------

WLED_HOST = "192.168.8.83"
WLED_ENABLED = True
WLED_BRIGHTNESS = 160        # 0-255; WLED still applies its own current limit
WLED_TIMEOUT_S = 0.6

# Scores with no valid 3-dart checkout (also used by print_solution)
NO_CHECKOUT_SCORES = frozenset({159, 162, 163, 165, 166, 168, 169})

LED_OFF       = (0, 0, 0)
LED_NO_FINISH = (0, 40, 120)    # blue — out of checkout range, keep scoring

# Inside the checkout range the colour is a continuous gradient rather than
# steps: red at 170, through orange and yellow, to green at 2. Interpolating
# the hue (not the RGB channels) is what keeps the middle a clean amber —
# blending red to green in RGB would pass through a muddy brown instead.
HUE_FAR   = 0.0     # 0°   red   at score 170
HUE_CLOSE = 120.0   # 120° green at score 2
CHECKOUT_MAX = 170
CHECKOUT_MIN = 2

# Idle animation: shown whenever no score is being read, so the ring is never
# just dark between games. Effect and palette ids come from the device itself
# (GET /json/eff and /json/pal).
IDLE_EFFECT     = 9     # "Rainbow"
IDLE_PALETTE    = 11    # "Rainbow"
IDLE_SPEED      = 40    # 0-255; low values drift slowly
IDLE_BRIGHTNESS = 90

# Leg-Ende: der Ring pulsiert kurz kräftig, dann zurück zur Score-Farbe.
# "Breathe" (fx 2) ist ein echtes An- und Abschwellen -- "Blink" waere hartes
# Ein/Aus, "Strobe" ein Flackern. Effekt-Id vom Geraet selbst (GET /json/eff).
PULSE_S          = 8.0          # wie lange der Puls laeuft
PULSE_EFFECT     = 2            # "Breathe"
PULSE_SPEED      = 255          # 0-255, hoch = schnell
PULSE_BRIGHTNESS = 255
PULSE_COLOUR     = (255, 255, 255)

pulse_until = 0.0               # bis wann der Puls die Anzeige belegt

_wled_queue: queue.Queue = queue.Queue(maxsize=1)


def score_colour(V) -> tuple[int, int, int]:
    """Map an OCR'd score to the status colour for the LED ring."""
    if V is None:
        return LED_OFF
    if V == 1 or V > CHECKOUT_MAX or V in NO_CHECKOUT_SCORES:
        return LED_NO_FINISH

    span = CHECKOUT_MAX - CHECKOUT_MIN
    t = (V - CHECKOUT_MIN) / span          # 0.0 at score 2, 1.0 at score 170
    t = min(1.0, max(0.0, t))
    hue = (HUE_CLOSE + t * (HUE_FAR - HUE_CLOSE)) / 360.0
    r, g, b = colorsys.hsv_to_rgb(hue, 1.0, 1.0)
    return (round(r * 255), round(g * 255), round(b * 255))


def score_state(V) -> dict:
    """Build the WLED state for a score, or the idle animation when there is none."""
    if V is None:
        return {
            "on": True, "bri": IDLE_BRIGHTNESS,
            "seg": [{"id": 0, "fx": IDLE_EFFECT, "pal": IDLE_PALETTE,
                     "sx": IDLE_SPEED, "ix": 128}],
        }
    return {
        "on": True, "bri": WLED_BRIGHTNESS,
        "seg": [{"id": 0, "fx": 0, "col": [list(score_colour(V))]}],
    }


def pulse_state() -> dict:
    """Build the WLED state for the leg-end pulse."""
    return {
        "on": True, "bri": PULSE_BRIGHTNESS,
        "seg": [{"id": 0, "fx": PULSE_EFFECT, "sx": PULSE_SPEED, "ix": 255,
                 "col": [list(PULSE_COLOUR)]}],
    }


def _wled_send(state: dict) -> None:
    req = urllib.request.Request(
        f"http://{WLED_HOST}/json/state", data=json.dumps(state).encode(),
        headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=WLED_TIMEOUT_S).read()


def wled_loop():
    """Background thread: drain the single-slot queue and talk to the ESP."""
    while True:
        state = _wled_queue.get()
        try:
            _wled_send(state)
        except Exception as e:
            print(f"WLED: {e}")


def set_led(state: dict) -> None:
    """Hand a state to the sender thread. Latest value wins, never blocks."""
    if not WLED_ENABLED:
        return
    try:
        _wled_queue.get_nowait()     # drop a state that is already stale
    except queue.Empty:
        pass
    try:
        _wled_queue.put_nowait(state)
    except queue.Full:
        pass


# ---------------------------------------------------------------------------
# OCR helpers
# ---------------------------------------------------------------------------

def debug_ocr_region():
    """Capture and display the OCR region for visual calibration."""
    try:
        with mss.mss() as sct:
            img = np.array(sct.grab(OCR_REGION))
        img_bgr = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        cv2.imwrite("ocr_region_debug.png", img_bgr)
        print(f"Saved ocr_region_debug.png  Region: {OCR_REGION}")
        cv2.imshow("OCR Region (close to continue)", img_bgr)
        cv2.waitKey(0)
        cv2.destroyAllWindows()
    except Exception as e:
        print(f"Debug error: {e}")


def _score_ocr_attempt(threshold_name: str, cfg: str, image: np.ndarray) -> dict | None:
    """Run one OCR attempt and return a scored candidate for result selection."""
    import pytesseract
    data = pytesseract.image_to_data(
        image,
        config=cfg,
        output_type=pytesseract.Output.DICT,
    )

    pieces: list[tuple[str, float]] = []
    for text, conf in zip(data["text"], data["conf"]):
        text = text.strip()
        if not text:
            continue
        try:
            conf_value = float(conf)
        except (TypeError, ValueError):
            conf_value = -1.0
        pieces.append((text, conf_value))

    raw_text = " ".join(text for text, _ in pieces)
    numbers = re.findall(r"\d+", raw_text)
    if not numbers:
        return None

    digit_confidences = [
        conf for text, conf in pieces if any(ch.isdigit() for ch in text) and conf >= 0
    ]
    avg_confidence = (
        sum(digit_confidences) / len(digit_confidences) if digit_confidences else 0.0
    )

    best_candidate = None
    for number in numbers:
        direct_value = int(number)
        corrected_value = None
        corrected_digits = None

        if 0 <= direct_value <= 501:
            corrected_value = direct_value
            corrected_digits = len(number)
        else:
            for length in range(min(3, len(number)), 0, -1):
                candidate = int(number[:length])
                if 0 <= candidate <= 501:
                    corrected_value = candidate
                    corrected_digits = length
                    break

        if corrected_value is None or corrected_digits is None:
            continue

        is_direct_match = direct_value == corrected_value and len(number) <= 3
        candidate = {
            "threshold": threshold_name,
            "cfg": cfg,
            "raw_text": raw_text,
            "original": number,
            "value": corrected_value,
            "is_direct_match": is_direct_match,
            "avg_confidence": avg_confidence,
            "digits_used": corrected_digits,
            "extra_digits": max(0, len(number) - corrected_digits),
        }

        if best_candidate is None or (
            (
                candidate["is_direct_match"],
                candidate["avg_confidence"],
                candidate["digits_used"],
                -candidate["extra_digits"],
            )
            > (
                best_candidate["is_direct_match"],
                best_candidate["avg_confidence"],
                best_candidate["digits_used"],
                -best_candidate["extra_digits"],
            )
        ):
            best_candidate = candidate

    return best_candidate


def ocr_read_score_region() -> tuple[int | None, str]:
    """Grab the screen region and return (score, raw_text).

    Priority:
      1. Template matching  – if templates_capture/field2/gray/ exists
      2. Tesseract fallback – if no templates are available
    """
    try:
        with mss.mss() as sct:
            img = np.array(sct.grab(OCR_REGION))   # BGRA

        # --- Template matching ---
        if _load_templates():
            score, label = _template_read(img)
            if score is not None:
                return score, label
            print("Template match failed — falling back to Tesseract.")

        # --- Tesseract fallback ---
        gray = cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
        gray = cv2.resize(gray, None, fx=3, fy=3, interpolation=cv2.INTER_LINEAR)
        kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
        gray = cv2.filter2D(gray, -1, kernel)

        thresholds = {
            "binary":     cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY)[1],
            "binary_inv": cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY_INV)[1],
            "otsu":       cv2.threshold(gray, 0,   255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
        }

        if SAVE_OCR_DEBUG:
            cv2.imwrite("ocr_debug_gray.png", gray)
            for name, th in thresholds.items():
                cv2.imwrite(f"ocr_debug_{name}.png", th)

        import pytesseract
        pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

        best_candidate = None
        cfg7 = "--psm 7 -c tessedit_char_whitelist=0123456789 --oem 1"
        cfg8 = "--psm 8 -c tessedit_char_whitelist=0123456789 --oem 1"
        for cfg, name in (
            (cfg8, "otsu"), (cfg7, "otsu"),
            (cfg8, "binary"), (cfg7, "binary"),
            (cfg8, "binary_inv"), (cfg7, "binary_inv"),
        ):
            candidate = _score_ocr_attempt(name, cfg, thresholds[name])
            if candidate is None:
                continue
            if best_candidate is None or (
                (candidate["is_direct_match"], candidate["avg_confidence"],
                 candidate["digits_used"], -candidate["extra_digits"])
                > (best_candidate["is_direct_match"], best_candidate["avg_confidence"],
                   best_candidate["digits_used"], -best_candidate["extra_digits"])
            ):
                best_candidate = candidate

        if best_candidate is None:
            return None, ""
        if best_candidate["original"] != str(best_candidate["value"]):
            print(f"Auto-corrected: {best_candidate['original']} -> {best_candidate['value']}")
        return best_candidate["value"], best_candidate["raw_text"]

    except Exception as e:
        print(f"OCR error: {e}")
        return None, f"OCR error: {e}"


def ocr_loop(poll_s: float = 0.35):
    """Background thread: refresh latest_score every poll_s seconds."""
    global latest_score, latest_raw_text, latest_updated_ts, latest_source
    _candidate = None
    _candidate_count = 0
    _REQUIRED_CONSECUTIVE = 2
    _led_shown = object()   # sentinel, so the first accepted score always fires
    _pulsing = False        # leg-end pulse currently owns the ring
    while True:
        try:
            with lock:
                fresh_push = (time.time() - pushed_ts) <= PUSH_TTL_S
                push_val   = pushed_scores.get(current_field) if fresh_push else None
                field_now  = current_field

            if fresh_push:
                # Exact value from the browser: no OCR, and no debounce needed
                # because there is nothing to misread.
                _candidate, _candidate_count = None, 0
                with lock:
                    latest_score      = push_val
                    latest_raw_text   = f"push: field{field_now}={push_val}"
                    latest_updated_ts = time.time()
                    latest_source     = "push"
                    _score_now        = latest_score
            else:
                score, raw = ocr_read_score_region()
                # Debounce: only accept a score after it appears 3 consecutive times
                if score is not None:
                    if score == _candidate:
                        _candidate_count += 1
                    else:
                        _candidate = score
                        _candidate_count = 1
                else:
                    _candidate = None
                    _candidate_count = 0

                with lock:
                    # An OCR pass can take a second or more (Tesseract fallback
                    # especially). If a push landed while we were busy, that
                    # value is authoritative — drop what we just read.
                    if (time.time() - pushed_ts) <= PUSH_TTL_S:
                        continue
                    if _candidate_count >= _REQUIRED_CONSECUTIVE:
                        latest_score = _candidate
                    latest_raw_text   = raw
                    latest_updated_ts = time.time()
                    latest_source     = "ocr"
                    _score_now        = latest_score

            # Outside the lock: the status light must never hold up OCR.
            #
            # While a leg-end pulse is running it owns the ring -- otherwise the
            # very next poll would overwrite it with the score colour, and since
            # the score drops to 0 at exactly that moment the pulse would never
            # be seen at all. When it expires the score colour is forced back on
            # by clearing what we think is displayed.
            if time.time() < pulse_until:
                _pulsing = True
            elif _pulsing:
                _pulsing = False
                _led_shown = object()
            if not _pulsing and _score_now != _led_shown:
                _led_shown = _score_now
                set_led(score_state(_score_now))
        except Exception as e:
            with lock:
                latest_raw_text = f"OCR error: {e}"
                latest_updated_ts = time.time()
        time.sleep(poll_s)


# ---------------------------------------------------------------------------
# Dart combination helpers
# ---------------------------------------------------------------------------

def fliplr(arr):
    return np.fliplr(arr)


def combvec(*args):
    """Return all combinations of the given arrays as rows (like MATLAB combvec)."""
    return np.array(np.meshgrid(*args, indexing='ij')).T.reshape(-1, len(args))


def _label(kind: str, val: int) -> str:
    """Convert a numeric dart value to its notation string based on segment type."""
    if kind == 'T':     return f"T{val // 3}"
    if kind == 'S':     return "SBull" if val == 25 else f"S{val}"
    if kind == 'D':     return "Bull"  if val == 50 else f"D{val // 2}"
    if kind == 'Bull':  return "Bull"
    if kind == 'SBull': return "SBull"
    return "NA"   # kind == 'NA'


def _make_set(V: int, c0_vals, c1_vals, c2_vals,
              k0: str, k1: str, k2: str) -> np.ndarray:
    """
    Build a dart-finish combination set.

    Creates all combinations of (c0, c1, c2), keeps only those that sum to V,
    then appends dart-notation strings as three extra columns.
    Returns an (N, 8) array: [c0_num, c1_num, c2_num, sum, mask, c0_str, c1_str, c2_str].
    Column order after fliplr: [c0, c1, c2].
    """
    # combvec(c2, c1, c0) -> fliplr -> columns become [c0, c1, c2]
    S = np.fliplr(combvec(c2_vals, c1_vals, c0_vals))
    total = S[:, 0] + S[:, 1] + S[:, 2]
    mask  = (total == V)
    # Keep sum (col 3) and mask (col 4) for structural compatibility
    S = np.hstack((S, total[:, np.newaxis], mask[:, np.newaxis].astype(float)))
    S = S[mask]
    if S.size == 0:
        return np.empty((0, 8))
    # Build notation strings for each of the three dart throws
    mapped = S[:, :3].astype(object)
    for i in range(S.shape[0]):
        mapped[i, 0] = _label(k0, int(S[i, 0]))
        mapped[i, 1] = _label(k1, int(S[i, 1]))
        mapped[i, 2] = _label(k2, int(S[i, 2]))
    return np.hstack((S, mapped))   # 8 cols total: 5 numeric + 3 label


preferred_ways = 3


def calculate_output(V, pre_filter=False):
    # --- Segment value sets ---
    singles = np.concatenate((np.arange(1, 21), [25]))           # S1-S20 + SBull (25)
    doubles = 2 * np.concatenate((np.arange(1, 21), [25]))       # D1-D20 + Bull  (50)
    d_hi    = 2 * np.concatenate((np.arange(11, 21), [25]))      # D11-D20 + Bull  (preferred finishing doubles)
    triples = 3 * np.arange(7, 21)                               # T7-T20  (below T7 is redundant vs single)
    bull50  = np.array([50.])   # Bullseye (double bull)
    sbull25 = np.array([25.])   # Single bull
    zero    = np.array([0.])    # Placeholder for "NA" (dart not thrown)

    # --- Build all combination sets for 3-dart finishes ---
    # Format: (dart1, dart2, finishing_double) where sum == V.
    # T=Triple, S=Single, D=Double, Bull=50, SBull=25, NA=no dart.
    S1  = _make_set(V, triples, singles,          doubles, 'T',     'S',   'D')  # T  S  D
    S2  = _make_set(V, d_hi,    doubles,          d_hi,    'D',     'D',   'D')  # D  D  D
    S3  = _make_set(V, d_hi,    singles,          doubles, 'D',     'S',   'D')  # D  S  D
    S4  = _make_set(V, triples, triples,          doubles, 'T',     'T',   'D')  # T  T  D
    S5  = _make_set(V, triples, d_hi,             doubles, 'T',     'D',   'D')  # T  D  D
    S6  = _make_set(V, bull50,  singles,          doubles, 'Bull',  'S',   'D')  # Bull S D
    S31 = _make_set(V, sbull25, np.arange(1, 21), doubles, 'SBull', 'S',   'D')  # SBull S D
    S7  = _make_set(V, bull50,  triples,          doubles, 'Bull',  'T',   'D')  # Bull T D
    S8  = _make_set(V, zero,    triples,          doubles, 'NA',    'T',   'D')  # (2-dart) T + D
    S9  = _make_set(V, zero,    d_hi,             doubles, 'NA',    'D',   'D')  # (2-dart) D + D
    S10 = _make_set(V, zero,    singles,          doubles, 'NA',    'S',   'D')  # (2-dart) S + D
    S11 = _make_set(V, zero,    zero,             doubles, 'NA',    'NA',  'D')  # (1-dart) D only

    # --- Select applicable combination sets for score V ---
    output_value = None
    d4 = [4, 8, 16, 20, 24, 32]  # common double values used in low-score filters

    if V == 12:
        output_value = np.vstack((S10[np.isin(S10[:, 2], d4)], S11))
    elif V < 41 and V > 1 and V % 2 == 0 and V % 4 == 0:
        output_value = S11
    elif V < 41 and V > 1 and V % 2 == 0 and V % 4 != 0 and V < 8:
        output_value = np.vstack((S10[np.isin(S10[:, 2], d4)], S11))
    elif V < 41 and V > 1 and V % 4 != 0 and V >= 8:
        output_value = np.vstack((S10[np.isin(S10[:, 2], d4)], S11))
    elif V == 3:
        output_value = S10
    elif V < 41 and V > 1 and V % 2 == 1:
        output_value = S10[(S10[:, 2] % 4 == 0) & (S10[:, 1] != 25)]
    elif 41 <= V <= 49:
        output_value = S10[S10[:, 1] != 25]
    elif V == 50:
        output_value = np.vstack((S11, S10))
    elif 51 <= V <= 60:
        output_value = S10
    elif (61 <= V <= 80 and V % 2 == 0) or (61 <= V < 80 and V % 2 == 1):
        output_value = np.vstack((S10, S9, S8, S6))
    elif 81 <= V < 86 and V % 2 == 0:
        output_value = np.vstack((S10, S9, S8))
    elif 81 <= V < 86 and V % 2 == 1:
        output_value = np.vstack((S10, S9, S8, S6))
    elif 86 <= V < 90 and V % 2 == 0:
        output_value = np.vstack((S8,))
    elif (86 <= V <= 90 and V % 2 == 1) or (90 <= V <= 96):
        output_value = np.vstack((S10, S9, S8, S6))
    elif V == 97:
        output_value = np.vstack((S10, S9, S8, S6, S1))
    elif V in (98, 100):
        output_value = np.vstack((S8,))
    elif V == 99:
        output_value = np.vstack((S1,))
    elif V == 101:
        output_value = np.vstack((S8, S1, S6))
    elif 100 < V < 105 or V == 120:
        output_value = np.vstack((S10, S9, S8, S1))
    elif V == 115:
        output_value = np.vstack((S10, S9, S8, S6, S1, S7, S31))
    elif 104 < V < 120 and V not in (115, 119):
        output_value = np.vstack((S10, S9, S8, S6, S1))
    elif V == 119:
        output_value = np.vstack((S10, S9, S8, S1, S2, S3, S1, S7, S5, S4))
    elif 120 < V <= 4000:
        output_value = np.vstack((S10, S9, S8, S1, S2, S3, S1, S7, S5, S4, S6))

    if output_value is None:
        return np.array([])

    output_value = output_value[:, :10]

    if pre_filter:
        if isinstance(output_value, np.ndarray) and output_value.ndim == 2 and output_value.shape[1] >= 8:
            return output_value[:, 5:8]
        return np.array([])

    # --- Filter rows to the recommended outshot paths for score V ---
    V50 = (V - 50) * 3   # used in range 61-90: value remaining after Bull, expressed as triple
    o   = output_value    # short alias for filter expressions
    selected_rows = np.array([])

    if 61 <= V <= 75:
        selected_rows = o[
            ((o[:, 0] == 0) & (o[:, 1] > 48)) |
            ((o[:, 0] == 0) & (o[:, 1] == V50)) |
            ((o[:, 0] == 0) & np.isin(o[:, 2], [16, 20, 24, 32, 36, 40])) |
            ((o[:, 0] == 0) & (o[:, 1] == 25)) |
            ((o[:, 0] == 0) & (o[:, 2] == o[:, 1])) |
            ((o[:, 1] > 20) & (o[:, 2] > 20))
        ]
    elif 76 <= V <= 80:
        selected_rows = o[
            ((o[:, 0] == 0) & (o[:, 1] > 48) & (o[:, 1] != 50)) |
            ((o[:, 0] == 0) & (o[:, 1] == V50)) |
            ((o[:, 0] == 0) & np.isin(o[:, 2], [16, 20, 24, 28, 32, 36, 40])) |
            ((o[:, 0] == 0) & (o[:, 1] == 25)) |
            ((o[:, 0] == 0) & (o[:, 2] == o[:, 1]))
        ]
    elif 81 <= V <= 85:
        selected_rows = o[
            ((o[:, 0] == 0) & (o[:, 1] > 48) & (o[:, 1] != 50)) |
            ((o[:, 0] == 0) & (o[:, 1] == V50)) |
            ((o[:, 0] == 0) & np.isin(o[:, 2], [16, 24, 32, 36, 40])) |
            ((o[:, 0] == 0) & (o[:, 1] == 25)) |
            (o[:, 1] == 50) |
            ((o[:, 0] == 25) & np.isin(o[:, 2], [24, 40])) |
            ((o[:, 0] == 50) & np.isin(o[:, 2], [16, 24, 32]))
        ]
    elif 86 <= V <= 90 and V % 2 == 0:
        selected_rows = o[
            ((o[:, 0] == 0) & (o[:, 1] >= 48) & (o[:, 1] != 50)) |
            ((o[:, 0] == 0) & (o[:, 1] == V50)) |
            ((o[:, 0] == 0) & np.isin(o[:, 2], [16, 24, 32, 36, 40])) |
            ((o[:, 0] == 0) & (o[:, 1] == 25)) |
            (o[:, 1] == 50) |
            ((o[:, 0] == o[:, 2]) & (o[:, 2] % 4 == 0)) |
            ((o[:, 0] == 32) & (o[:, 2] == 40)) |
            ((o[:, 0] == 36) & (o[:, 2] == 40)) |
            ((o[:, 1] == o[:, 2] / 2) & (o[:, 0] % 4 == 0))
        ]
    elif 86 <= V <= 90 and V % 2 == 1:
        selected_rows = o[
            ((o[:, 0] == 0) & (o[:, 1] >= 48) & (o[:, 1] != 50)) |
            ((o[:, 0] == 0) & (o[:, 1] == V50)) |
            ((o[:, 0] == 0) & np.isin(o[:, 2], [16, 24, 32, 36, 40])) |
            ((o[:, 0] == 0) & (o[:, 1] == 25)) |
            ((o[:, 0] == o[:, 2]) & (o[:, 2] % 4 == 0) & (o[:, 1] != 25)) |
            ((o[:, 0] == 32) & (o[:, 2] == 40) & (o[:, 1] != 25)) |
            ((o[:, 0] == 36) & (o[:, 2] == 40) & (o[:, 1] != 25)) |
            ((o[:, 1] == o[:, 2] / 2) & (o[:, 0] % 4 == 0) & (o[:, 1] != 25))
        ]
    elif 90 <= V <= 95:
        selected_rows = o[
            (o[:, 0] == 0) |
            ((o[:, 0] == 50) & np.isin(o[:, 2], [16, 32, 40]) & (o[:, 1] != 25))
        ]
    elif V == 96:
        selected_rows = o[o[:, 0] == 0]
    elif V == 97:
        selected_rows = o[
            (o[:, 0] == 0) |
            ((o[:, 0] == 51) & (o[:, 1] == 6) & (o[:, 2] == 40))
        ]
    elif V == 99:
        selected_rows = o[
            ((V - o[:, 0] / 3) <= 80) & np.isin(o[:, 2], [32, 40])
        ]
    elif V in (98, 100):
        selected_rows = o[o[:, 0] == 0]
    elif V in (101, 102, 103, 104):
        selected_rows = o[
            (
                (o[:, 0] == 0) |
                ((o[:, 0] == 50) & np.isin(o[:, 2], [32, 40])) |
                ((o[:, 0] != 50) & np.isin(o[:, 2], [32, 40])) |
                ((o[:, 2] == o[:, 0]) & (o[:, 2] != 50))
            ) & (o[:, 1] != 25)
        ]
    elif V == 115:
        base = (
            (o[:, 0] != 50) &
            (~np.isin(V - o[:, 0] / 3, [99, 102, 103, 106, 108, 109])) &
            (o[:, 1] != 25) &
            (np.isin(o[:, 2], [32, 36, 40]) | (o[:, 2] / 2 == o[:, 1]))
        ) | (o[:, 0] == 0)
        bull_trip = (
            (o[:, 0] == 50) & (o[:, 1] != 25) &
            np.isin(o[:, 1], np.arange(21, 61, 3)) &
            ((o[:, 2] == 50) | ((o[:, 2] >= 2) & (o[:, 2] <= 40) & (o[:, 2] % 2 == 0)))
        )
        selected_rows = o[base | bull_trip]
    elif (105 <= V <= 118 or V == 120) and V != 115:
        selected_rows = o[
            ((o[:, 0] != 50) & (~np.isin(V - o[:, 0] / 3, [99, 102, 103, 106, 108, 109])) &
             (o[:, 1] != 25) & (np.isin(o[:, 2], [32, 36, 40]) | (o[:, 2] / 2 == o[:, 1]))) |
            ((o[:, 0] == 50) & np.isin(V - 25, [80]) &
             (np.isin(o[:, 2], [32, 40]) | (o[:, 2] / 2 == o[:, 1]))) |
            (o[:, 0] == 0)
        ]
    elif 119 <= V <= 123:
        selected_rows = o[
            ((o[:, 0] != 50) & (o[:, 2] != 50) & (o[:, 1] != 25) &
             (~np.isin(V - o[:, 0] / 3, [99, 102, 103, 106, 108, 109])) &
             (V - o[:, 0] - o[:, 1] / 3 == 50)) |
            ((o[:, 0] == 50) & ((V - 25 < 99) | (V - 25 == 100)) &
             (V - o[:, 0] - o[:, 1] / 3 <= 60)) |
            ((V - o[:, 0] - o[:, 1] / 2 <= 60) & np.isin(o[:, 1], [24, 32, 36, 40]))
        ]
    elif V == 124:
        selected_rows = o[
            ((o[:, 0] != 50) & (o[:, 2] != 50) &
             np.isin(V - o[:, 0] / 3, [98, 100, 101, 104, 107, 110]) &
             (o[:, 1] != 50) & (V - o[:, 0] - o[:, 1] / 3 <= 60)) |
            ((o[:, 0] == 50) & ((V - 25 < 99) | (V - 25 == 100)) &
             (V - o[:, 0] - o[:, 1] / 3 <= 60)) |
            ((V - o[:, 0] - o[:, 1] / 2 <= 60) & np.isin(o[:, 1], [24, 32, 36, 40]))
        ]
    elif V == 125:
        selected_rows = o[
            ((o[:, 0] != 50) & (o[:, 1] != 50) & (o[:, 2] != 50) &
             np.isin(V - o[:, 0] / 3, [98, 100, 101, 104, 107, 110]) &
             (V - o[:, 0] - o[:, 1] / 3 <= 60)) |
            ((o[:, 0] == 50) & ((V - 25 < 99) | (V - 25 == 100)) &
             (V - o[:, 0] - o[:, 1] / 3 <= 60)) |
            ((V - o[:, 0] - o[:, 1] / 2 <= 60) & np.isin(o[:, 1], [24, 32, 36, 40])) |
            ((o[:, 0] == 50) & (o[:, 1] == 25))
        ]
    elif 126 <= V <= 130:
        selected_rows = o[
            ((o[:, 0] != 50) & (o[:, 2] != 50) & (
                np.isin(V - o[:, 0] / 3, [98, 100, 101, 104, 107, 110]) |
                (np.isin(V - o[:, 0] / 2, [98, 100, 101, 104, 107, 110]) & np.isin(o[:, 0], [24, 32, 36, 40])) |
                (np.isin(V - o[:, 0] / 1, [98, 100, 101, 104, 107, 110]) & (o[:, 0] == 25))
            )) |
            ((o[:, 0] == 50) & np.isin(V - 25, [100, 101, 104, 107, 110]) & (
                ((V - o[:, 1] / 3 <= 110) & np.isin(o[:, 1], [42, 45, 48, 51, 54, 57, 60])) |
                ((V - o[:, 1] / 1 <= 110) & (o[:, 1] == 25)) |
                ((V - o[:, 1] / 2 <= 110) & np.isin(o[:, 1], [28, 32, 36, 38, 40, 50]))
            ))
        ]
    elif V in (131, 132, 133):
        selected_rows = o[
            ((o[:, 0] != 50) & (o[:, 1] != 50) & (
                ((V - o[:, 0] - o[:, 1] / 3 <= 60) & np.isin(o[:, 1], [42, 45, 48, 51, 54, 57, 60])) |
                ((V - o[:, 0] - o[:, 1] / 1 <= 60) & (o[:, 1] == 25)) |
                ((V - o[:, 0] - o[:, 1] / 2 <= 60) & np.isin(o[:, 1], [28, 32, 36, 38, 40, 50]))
            )) |
            ((o[:, 0] == 50) & (o[:, 1] == 50)) |
            ((o[:, 2] == o[:, 1]) & (o[:, 2] != 50) & (o[:, 1] != 50))
        ]
    elif V in (134, 135):
        selected_rows = o[
            ((o[:, 0] != 50) & (o[:, 1] != 50) & (
                ((V - o[:, 0] - o[:, 1] / 3 <= 60) & np.isin(o[:, 1], [42, 45, 48, 51, 54, 57, 60])) |
                ((V - o[:, 0] - o[:, 1] / 1 <= 60) & (o[:, 1] == 25)) |
                ((V - o[:, 0] - o[:, 1] / 2 <= 60) & np.isin(o[:, 1], [28, 32, 36, 38, 40, 50]))
            )) |
            ((o[:, 0] == 50) & np.isin(V - 25, [100, 101, 104, 107, 110]))
        ]
    elif V in (136, 137, 138):
        selected_rows = o[
            (o[:, 0] != 50) & (o[:, 1] != 50) & (
                ((V - o[:, 0] - o[:, 1] / 3 <= 60) & np.isin(o[:, 1], [42, 45, 48, 51, 54, 57, 60])) |
                ((V - o[:, 0] - o[:, 1] / 1 <= 60) & (o[:, 1] == 25)) |
                ((V - o[:, 0] - o[:, 1] / 2 <= 60) & np.isin(o[:, 1], [28, 32, 36, 38, 40, 50]))
            )
        ]
    elif V in (139, 140):
        selected_rows = o[
            (o[:, 0] != 50) & (
                ((V - o[:, 0] - o[:, 1] / 3 <= 70) & np.isin(o[:, 1], [42, 45, 48, 51, 54, 57, 60])) |
                ((V - o[:, 0] - o[:, 1] / 1 <= 70) & (o[:, 1] == 25)) |
                ((V - o[:, 0] - o[:, 1] / 2 <= 70) & np.isin(o[:, 1], [28, 32, 36, 38, 40, 50]))
            )
        ]
    elif V == 141:
        selected_rows = output_value
    elif V in range(141, 147):
        selected_rows = o[
            ((o[:, 1] == 50) & (((V - o[:, 0] - 25) <= 60) | ((V - o[:, 0] - 25) == 65))) |
            ((o[:, 0] != 50) & (o[:, 1] != 50) & ((V - o[:, 0] - o[:, 1] / 3) <= 70))
        ]
    elif 147 <= V <= 170:
        # High scores: return all computed combinations
        selected_rows = output_value
    elif 1 <= V <= 40:
        selected_rows = output_value
    elif 41 <= V <= 60:
        selected_rows = o[
            ((o[:, 1] != 25) & np.isin(o[:, 2], [24, 32, 40])) |
            (o[:, 1] == 0) |
            (o[:, 2] / 2 == o[:, 1])
        ]

    if isinstance(selected_rows, np.ndarray) and selected_rows.ndim == 2 and selected_rows.shape[1] >= 8:
        return selected_rows[:, 5:8]   # return the notation columns only
    return np.array([])


# ---------------------------------------------------------------------------
# Preferred outshot row-index lookup table (used by suggested_ways)
# Each entry maps score V -> ordered list of row indices from calculate_output
# ---------------------------------------------------------------------------
_SUGGESTED_ROWS: dict[int, list[int]] = {
    18:  [0, 1, 3],        21:  [0, 1, 2],
    22:  [0, 1, 4, 2],     26:  [2, 4, 3, 1],
    27:  [1, 2, 3, 0],     29:  [2, 1, 0],
    30:  [2, 3, 1, 0],     31:  [2, 1, 0],
    33:  [0, 3, 2, 1],     34:  [0, 4, 2, 3],
    38:  [0, 2, 3, 1],
    61:  [0, 2, 3],        62:  [15, 12, 14],
    63:  [1, 3, 0],        64:  [14, 10, 13, 9],
    65:  [0, 6, 4],        66:  [9, 12, 7],
    67:  [0, 4, 5],        68:  [9, 12, 13, 4],
    69:  [-1, 0, 2, 3],    70:  [-1, -2, -7, 5],
    71:  [2, 4, 1, 5],     72:  [-3, -5, -1, 3],
    73:  [-1, -3, 0, -2],  74:  [-4, -2, 5, 2],
    75:  [-2, -3, -1, 0],  76:  [-1, -3, 0, 1],
    77:  [2, 1, 0],        78:  [-2, -1, -3, 0],
    80:  [3, 1, 0],        81:  [2, 1, 4, 3],
    82:  [0, 1, 2, 3],     83:  [0, 1, 4],
    84:  [3, 1, 0, 2],     85:  [2, 5, 0, 2],
    90:  [2, 0, 1],        91:  [0, 1, 3],
    92:  [1, 2, 4],        94:  [1, 3, 2, 0],
    95:  [1, 2, 0],
    101: [13, 0, 10, 8],   102: [5, 10, 8],
    103: [6, 8, 9],        104: [2, 5, 8, 6],
    105: [0, 12, 15],      106: [11, 9, 8, -2],
    107: [0, 9, 6],        108: [4, 8, 11],
    109: [5, 6, 8],        110: [0, 4, 1, 8],
    111: [1, 4, 5, 8],     112: [0, 1, 5, 2],
    113: [3, 1, 0, 4],     114: [1, 3, 4, 2],
    115: [0, 1, 2, 6],
    121: [5, 4, 0],        122: [5, 2, 0],
    123: [4, 3, 2],        124: [16, 18, 2],
    125: [0, 4, 14],       126: [19, 1, 12],
    127: [13, 1, 9],       128: [10, 11, 4],
    129: [9, 11, 0],       130: [6, 8, 13],
    131: [0, 13, 14],      132: [0, 6, 18],
    133: [10, 1, 2],       134: [11, 0, 8],
    135: [2, 7, 11],       136: [0, 7, 5],
    137: [0, 1, 3],        138: [0, 1, 3],
    139: [15, 3, 9],       140: [15, 7, 2],
    141: [8, 17, 5],       143: [0, 5, 3],
    144: [0, 7, 4],        145: [1, 2, 3],
    146: [0, 2, 3],        147: [5, 8, 7],
    148: [7, 13, 9],       150: [5, 6, 7],
    151: [6, 4, 1],        152: [10, 7, 3],
    154: [2, 3, 5],        155: [7, 4, 3],
    157: [0, 2],           158: [2, 5],
    161: [2, 3],
}

# Scores whose full row set is returned unchanged (no preferred reordering)
_EXCL = {18, 21, 22, 26, 27, 29, 30, 31, 33, 34, 38}
_RETURN_ALL = (
    {v for v in range(1, 61) if v not in _EXCL} |
    {79, 86, 87, 88, 89, 93, 96, 116, 117, 118, 119, 120, 142, 153, 156, 160} |
    set(range(97, 101)) |
    (set(range(160, 170)) - {161})
)


def suggested_ways(V, all_ways=None):
    """Return preferred outshot orderings for score V."""
    if all_ways is None:
        all_ways = calculate_output(V)

    # For these scores all rows are already in the preferred order
    if V in _RETURN_ALL:
        return all_ways

    # Use the lookup table to pick and reorder specific rows
    if V in _SUGGESTED_ROWS:
        return np.vstack([all_ways[i, :] for i in _SUGGESTED_ROWS[V]])

    return np.array([])


# ---------------------------------------------------------------------------
# Auxiliary finish helpers
# ---------------------------------------------------------------------------

def na_double_double_finishes(V, all_ways=None):
    """Return NA-double-double finishes for scores 62-80."""
    if V < 62 or V > 80:
        return np.array([])

    if all_ways is None:
        all_ways = calculate_output(V)

    if not isinstance(all_ways, np.ndarray) or all_ways.size == 0 or all_ways.ndim != 2 or all_ways.shape[1] < 3:
        return np.array([])

    # Special-case preferred rows for 62 and 64
    if V == 62 and all_ways.shape[0] > 15:
        return np.vstack((all_ways[1, :], all_ways[4, :]))
    if V == 64 and all_ways.shape[0] > 15:
        return np.vstack((all_ways[6, :], all_ways[0, :]))

    # Default: all rows that are NA-Double-Double
    mask = np.array([
        str(r[0]) == "NA" and str(r[1]).startswith("D") and str(r[2]).startswith("D")
        for r in all_ways
    ], dtype=bool)
    return all_ways[mask] if mask.any() else np.array([])


def single_double_double_finishes(V, all_ways=None):
    """Return Single-Double-Double checkouts for scores 97 and 102-120."""
    if V != 97 and (V < 102 or V > 120):
        return np.array([])

    def _is_double(x): s = str(x); return s.startswith("D") or s == "Bull"
    def _is_single(x): s = str(x); return s.startswith("S") or s == "SBull"

    # Try filtering the provided array first
    if isinstance(all_ways, np.ndarray) and all_ways.size > 0 and all_ways.ndim == 2 and all_ways.shape[1] >= 3:
        mask = np.array([
            _is_single(r[0]) and _is_double(r[1]) and _is_double(r[2])
            for r in all_ways
        ], dtype=bool)
        if mask.any():
            return all_ways[mask]

    # Fallback: compute S-D-D combinations directly
    singles = [(f"S{i}", i) for i in range(1, 21)] + [("SBull", 25)]
    doubles = [(f"D{i}", 2 * i) for i in range(1, 21)] + [("Bull", 50)]
    results = []
    for s_lbl, s_val in singles:
        for d1_lbl, d1_val in doubles:
            rem = V - s_val - d1_val
            if rem <= 0:
                continue
            if rem == 50:
                d2_lbl = "Bull"
            elif rem % 2 == 0 and 2 <= rem <= 40:
                d2_lbl = f"D{rem // 2}"
            else:
                continue
            results.append([s_lbl, d1_lbl, d2_lbl])
    return np.array(results, dtype=object) if results else np.array([])


def print_solution(V):
    """Return a message indicating whether a checkout is possible for score V."""
    if V in NO_CHECKOUT_SCORES or V > 170 or V == 1:
        return "No possible outshot"
    return "Good Luck"


# ---------------------------------------------------------------------------
# Finish table builder and Flask routes
# ---------------------------------------------------------------------------

def _ways_to_list(ways) -> list[list[str]]:
    """Convert a numpy ways array (Nx3) to a list of string triples."""
    if not isinstance(ways, np.ndarray) or ways.size == 0:
        return []
    if ways.ndim == 1:
        return [[str(x) for x in ways.tolist()]]
    return [[str(x) for x in row] for row in ways.tolist()]


def _build_finish_table(min_score: int = 2, max_score: int = 170) -> list[dict]:
    """Pre-compute all outshot data for every score from min_score to max_score."""
    rows = []
    for v in range(min_score, max_score + 1):
        all_np   = calculate_output(v)
        sug_np   = suggested_ways(v, all_ways=all_np)
        na_dd_np = na_double_double_finishes(v, all_ways=all_np)
        rows.append({
            "score":     v,
            "suggested": _ways_to_list(sug_np),
            "na_dd":     _ways_to_list(na_dd_np),
            "all_ways":  _ways_to_list(all_np),
            "message":   print_solution(v),
        })
    return rows


@app.route('/finishes')
def finishes_table():
    global _FINISH_TABLE_CACHE
    if _FINISH_TABLE_CACHE is None:
        _FINISH_TABLE_CACHE = _build_finish_table(2, 170)
    return render_template('finishes.html', rows=_FINISH_TABLE_CACHE)


@app.route('/api/outshot')
def api_outshot():
    with lock:
        V   = latest_score
        raw = latest_raw_text
        ts  = latest_updated_ts
        src = latest_source
        fld = current_field

    if V is None:
        return jsonify({"ok": False, "score": None, "message": "No score detected",
                        "raw": raw, "updated_ts": ts, "source": src,
                        "field": fld})

    ways  = suggested_ways(V)
    na_dd = na_double_double_finishes(V)
    sdd   = single_double_double_finishes(V)
    return jsonify({
        "ok":    True,
        "score": int(V),
        "message": print_solution(V),
        "suggested_ways":                ways.tolist()  if isinstance(ways,  np.ndarray) else [],
        "na_double_double_finishes":     na_dd.tolist() if isinstance(na_dd, np.ndarray) else [],
        "single_double_double_finishes": sdd.tolist()   if isinstance(sdd,   np.ndarray) else [],
        "raw": raw,
        "updated_ts": ts,
        "source": src,
        "field": fld,
    })


@app.route('/api/set_field', methods=['POST'])
def api_set_field():
    global current_field, OCR_REGION
    data = request.get_json(silent=True) or {}
    field = int(data.get("field", 1))
    if field not in OCR_FIELDS:
        return jsonify({"ok": False, "message": "Invalid field"}), 400
    with lock:
        current_field = field
        OCR_REGION = OCR_FIELDS[field]
    return jsonify({"ok": True, "field": current_field, "region": OCR_REGION})


@app.route('/api/current_field')
def api_current_field():
    with lock:
        region = dict(OCR_REGION)
    return jsonify({"field": current_field, "region": region})


def _cors(resp):
    """Allow the Scolia page's extension to POST here.

    Chrome also gates public -> private-network requests behind a preflight
    that wants Allow-Private-Network, hence the third header.
    """
    resp.headers["Access-Control-Allow-Origin"]           = "*"
    resp.headers["Access-Control-Allow-Headers"]          = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"]          = "POST, OPTIONS"
    resp.headers["Access-Control-Allow-Private-Network"]  = "true"
    return resp


def _clean_score(v):
    """Accept only plausible darts scores; anything else is dropped."""
    try:
        v = int(v)
    except (TypeError, ValueError):
        return None
    return v if 0 <= v <= 501 else None


@app.route('/api/score', methods=['POST', 'OPTIONS'])
def api_score():
    """Exact scores pushed from the browser extension — no OCR involved.

    Payload is either both fields at once::

        {"field1": 501, "field2": 340}

    or a single one::

        {"field": 2, "score": 340}

    While these keep arriving, ocr_loop() serves them instead of reading the
    screen; if they stop for PUSH_TTL_S it silently falls back to OCR.
    """
    global pushed_ts
    if request.method == 'OPTIONS':
        return _cors(app.make_default_options_response())

    data = request.get_json(silent=True) or {}
    got = {}
    for field in (1, 2):
        key = f"field{field}"
        if key in data:
            got[field] = _clean_score(data[key])
    single = _clean_score(data.get("field"))
    if single in (1, 2) and "score" in data:
        got[single] = _clean_score(data["score"])

    if not got:
        return _cors(jsonify({"ok": False, "message": "no field1/field2/score in payload"})), 400

    with lock:
        pushed_scores.update(got)
        pushed_ts = time.time()
        field_now = current_field
    return _cors(jsonify({"ok": True, "accepted": got, "current_field": field_now}))


@app.route('/api/leg_end', methods=['POST', 'OPTIONS'])
def api_leg_end():
    """Fired by the extension when a player's score reaches 0.

    Runs the ring through a short, bright pulse. Deliberately idempotent-ish:
    a second call while a pulse is already running just extends it, so a double
    fire from the extension looks like one slightly longer celebration rather
    than a stutter.
    """
    global pulse_until
    if request.method == 'OPTIONS':
        return _cors(app.make_default_options_response())

    pulse_until = time.time() + PULSE_S
    set_led(pulse_state())
    print("LEG END -- pulsing")
    return _cors(jsonify({"ok": True, "pulse_s": PULSE_S}))


@app.route('/api/region_preview')
def api_region_preview():
    """Capture the current OCR region and return it as a PNG.

    Lets you see in the browser exactly which part of the screen is captured.
    """
    with lock:
        region = dict(OCR_REGION)
    try:
        with mss.mss() as sct:
            img = np.array(sct.grab(region))   # BGRA
        img_bgr = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        ok, buf = cv2.imencode(".png", img_bgr)
        if not ok:
            return "encode failed", 500
        resp = send_file(io.BytesIO(buf.tobytes()), mimetype="image/png")
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except Exception as e:
        return f"capture error: {e}", 500


@app.route('/', methods=['GET', 'POST'])
def index():
    output_value = preferred_ways_result = print_solution_message = None
    suggested_ways_result = na_double_double_result = single_double_double_result = []

    if request.method == 'POST':
        V = int(request.form['input_value'])
        output_np                   = calculate_output(V)
        output_value                = _ways_to_list(calculate_output(V, pre_filter=True))
        preferred_ways_result       = _ways_to_list(output_np)
        print_solution_message      = print_solution(V)
        suggested_ways_result       = _ways_to_list(suggested_ways(V, all_ways=output_np))
        na_double_double_result     = _ways_to_list(na_double_double_finishes(V, all_ways=output_np))
        single_double_double_result = _ways_to_list(single_double_double_finishes(V, all_ways=output_np))

    return render_template(
        'index.html',
        output_value=output_value,
        preferred_ways=preferred_ways_result,
        print_solution_message=print_solution_message,
        suggested_ways=suggested_ways_result,
        na_double_double_finishes=na_double_double_result,
        single_double_double_finishes=single_double_double_result,
    )


# === App entry point ===
if __name__ == '__main__':
    threading.Thread(target=ocr_loop, daemon=True).start()
    threading.Thread(target=wled_loop, daemon=True).start()
    app.run(debug=True)
