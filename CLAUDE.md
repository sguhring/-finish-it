# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Flask web app ("Finish IT") that reads a darts score off the screen via OCR and shows the
recommended 3-dart checkout ("outshot") combinations for that score. It is designed to run
alongside the online darts game at `game.scoliadarts.com`: the app screenshots the score region,
OCRs the number, and a browser polls it for live finish suggestions.

Everything of substance lives in `app.py`. The other top-level `.py` files are tooling and
one-off scripts. The `flutter/`, `flutter_application_1/`, and `venv/` directories are
unrelated/local checkouts (mostly gitignored) — ignore them.

## Commands

```bash
# Run the app — Flask dev server on http://127.0.0.1:5000. The OCR background
# thread starts automatically. Requires a live score visible on screen to read.
python app.py

# Capture template images (the primary OCR method — see below)
python auto_capture.py        # automated: drives the browser via pyautogui, loops 0..501
python capture_templates.py   # manual: live preview window, SPACE to capture each score

# Walk the LED ring through idle + the full score gradient (needs the ESP reachable)
python test_led.py

# CNN pipeline (NOTE: currently NOT used by app.py — see "OCR pipeline" below)
python generate_data.py       # render synthetic training images -> training_data/
python train.py               # train ScoreCNN -> darts_ocr.pth
```

There is no test runner, linter, or `requirements.txt`. `test_ocr.py`, `show_region.py`, and the
`debug_*.png` / `ocr_debug*.png` files are manual OCR-calibration scratch (the PNGs are gitignored).

### External dependencies (not pip-managed here)
- **Tesseract** must be installed at the hardcoded path `C:\Program Files\Tesseract-OCR\tesseract.exe`
  (`app.py`, `ocr_throws.py`). Windows-only as written.
- Python deps used: `flask`, `numpy`, `opencv-python` (cv2), `mss`, `pytesseract`; capture/training
  also need `pyautogui`, `pyperclip`, `torch`, `torchvision`, `pillow`.

## Architecture

`app.py` has two independent halves joined only by shared module-level state under a `threading.Lock`:

### 1. Score reader (background thread) — push first, OCR as fallback
`ocr_loop()` runs as a daemon thread polling every ~0.35 s, and writes `latest_score` /
`latest_raw_text` / `latest_source`. Each iteration it first checks for a **pushed** score:
the Edge extension reads both players' scores out of the Scolia DOM and POSTs them to
`/api/score`, which stores them in `pushed_scores` + `pushed_ts`. While a push is younger than
`PUSH_TTL_S` (5 s) the loop uses `pushed_scores[current_field]` verbatim — exact, no debounce,
no screen grab, no template matmul — and sets `latest_source = "push"`. Only once pushes go
stale does it fall back to screen OCR (`latest_source = "ocr"`). A push that lands *during* a
slow OCR pass wins: the OCR result is discarded before it is committed.

The screen-OCR path is therefore now the **fallback**, not the primary reader. On that path a score
is only accepted after it reads the **same value twice consecutively** (debounce), and
`ocr_read_score_region()` is two-tier:
1. **Template matching** (primary): the live capture is preprocessed (gray → sharpen → OTSU
   threshold → crop to digit bounding box → resize to a 256×96 "fingerprint" → normalize), then
   correlated against all `templates_capture/field2/{0..501}.png` templates in a **single matrix
   multiply** (`_TEMPLATE_MATRIX @ small`). Best correlation above `TEMPLATE_CONF_THRESHOLD` (0.56) wins.
2. **Tesseract fallback**: only if no templates directory exists or matching is low-confidence.
   Tries multiple threshold images × PSM configs and scores candidates by direct-match/confidence.

The capture region is a **hardcoded pixel rectangle** (`OCR_FIELDS` in `app.py`), tuned to one
specific screen resolution and game layout. `current_field` (1 or 2) selects left/right player.
The capture scripts keep their **own copies** of these coordinates that must be kept in sync with
`app.py` — and they currently differ slightly (e.g. `auto_capture.py` left=680 vs
`capture_templates.py` left=700), so verify before relying on them.

> The CNN (`train.py` / `ScoreCNN` / `darts_ocr.pth`) and the per-dart reader (`ocr_throws.py`) are
> **not imported or used by `app.py`**. The committed `darts_ocr.pth` is currently orphaned. If you
> wire the CNN in, it would replace/augment the template-matching tier.

### 2. Darts checkout math (pure functions, no OCR dependency)
The core is `calculate_output(V)`: it builds every valid 3-dart combination summing to score `V`
via `combvec`/`_make_set` (combinations of Triple/Single/Double/Bull segment-value arrays), then
applies a **large per-score `if/elif` ladder** of darts-strategy filters to keep only the sensible
outshot paths. Internally rows are numpy `object` arrays with 5 numeric columns + 3 dart-notation
string columns (`T20`, `D16`, `Bull`, `NA`, …); functions return the notation columns (`[:, 5:8]`).

- `suggested_ways(V)` reorders/selects the "preferred" rows using the hand-tuned `_SUGGESTED_ROWS`
  index lookup table (and `_RETURN_ALL` for scores returned as-is).
- `na_double_double_finishes(V)`, `single_double_double_finishes(V)` are alternate finish views.
- `print_solution(V)` reports impossible checkouts (e.g. 159, 162, 163, 169, >170, 1).

These per-score filters and the `_SUGGESTED_ROWS` indices are darts-domain heuristics — changing
combination ordering in `calculate_output` will silently break the `_SUGGESTED_ROWS` index lookups,
which reference specific row positions.

### 3. WLED status light (background thread)
`ocr_loop()` mirrors the checkout situation on an addressable LED ring around the Scolia surround
(WLED at `WLED_HOST`, currently `192.168.8.83`; set `WLED_ENABLED = False` to switch it off).

- `score_colour(V)` interpolates the **hue** from red (170) to green (2) — blending RGB directly
  would pass through a muddy brown, so the interpolation is deliberately in HSV. Scores with no
  checkout (`NO_CHECKOUT_SCORES`, plus 1 and >170) get a flat blue; `None` means the idle rainbow
  effect, so the ring is never dark between games.
- The HTTP call runs on its own thread (`wled_loop`) fed by a **single-slot queue** (`set_led`):
  latest state wins, never blocks, so an unreachable ESP can never stall the OCR reader. The push
  only fires when the accepted score actually *changes*, not on every poll.
- **Leg end** (`/api/leg_end`) runs a `PULSE_S`-second Breathe pulse at full brightness. While it
  lasts it *owns* the ring: the score drops to 0 at exactly that moment, so without that guard the
  next poll would overwrite the pulse with the score colour and it would never be seen. A second
  call extends the pulse rather than restarting it.
- `test_led.py` walks the whole range on the real strip — idle, the full gradient, the no-checkout
  colour — printing the RGB for each. Run it with the app stopped.

> The ESP also has a **boot preset** saved on the device, so the ring animates without any network
> at all. If the display is stuck on that preset, `app.py` is not reaching `WLED_HOST` — check the
> IP first, since a DHCP lease change silently points it at nothing.

### Flask routes & frontend
- `GET/POST /` → `templates/index.html`: manual score-entry form + the live-OCR panel.
- `GET /finishes` → `templates/finishes.html`: full precomputed checkout table (scores 2–170,
  cached in `_FINISH_TABLE_CACHE`).
- `GET /api/outshot` → JSON of the latest OCR score + its checkout suggestions. The frontend polls
  this every ~700 ms (`setInterval` in `index.html`).
- `POST /api/set_field` / `GET /api/current_field` → switch/read which player field is being OCR'd.
- `GET /api/region_preview` → live PNG of the current capture rectangle, so you can visually confirm
  the OCR region is aimed correctly in the browser.
- `POST /api/score` → accepts exact scores pushed by the extension, as `{"field1": N, "field2": N}`
  or `{"field": 1|2, "score": N}`. Values outside 0–501 are stored as `None`. Responds with CORS
  headers (including `Access-Control-Allow-Private-Network`, which Chrome's private-network
  preflight requires for an https page calling `127.0.0.1`).
- `POST /api/leg_end` → fired by the extension when a score reaches 0; runs the ring through a
  short bright pulse (see the WLED section). Same CORS treatment as `/api/score`.

Static assets in `static/`; the `templates/` dir is Flask Jinja templates (distinct from
`templates_capture/`, which holds OCR reference images).

### Edge extension (`edge-extension/`)
A Manifest V3 content script doing four jobs on `game.scoliadarts.com`:

1. **The score bridge** (primary): every 250 ms it reads the two score elements out of the DOM and
   POSTs them to `http://127.0.0.1:5000/api/score`, with a 2 s heartbeat so an unchanged score
   keeps push mode alive.

   `SCORE_SELECTOR` is **pinned** to `[class*="styles_counter__"]` — Scolia's remaining-score
   element is `span.styles_counter__ZHHHQ`, and the trailing hash is generated by CSS Modules and
   moves on every Scolia rebuild, hence the prefix match. Clear `SCORE_SELECTOR` to fall back to
   the old heuristic (visible leaf elements whose whole text is a 1–3 digit number ≤ 501, the two
   largest by font size). Either way it logs its picks to the page console.

   Pinning matters beyond tidiness: with the heuristic, the counters vanishing at the end of a game
   left it latching onto leftover statistics and pushing them as live scores. Pinned, `readScores()`
   returns nothing there and the app falls back to OCR instead.

   Scolia normally shows **one** player at a time, so a single number drawn far larger than
   anything else (`DOMINANT_RATIO` = 1.35× the runner-up) is treated as *the* score and pushed
   to both fields. A genuine side-by-side layout still maps leftmost → field 1. Anything more
   ambiguous pushes nothing, so the app falls back to OCR rather than guessing.
2. **The on-page overlay**: a draggable panel in a shadow root (so it can never match its own
   score heuristic) that polls `/api/outshot` every 600 ms and draws the checkout suggestions
   onto the game page — no second window needed. Its P1/P2/AUTO buttons drive `/api/set_field`.
   In **AUTO** (the default) it stops caring which button is pressed and follows whichever player
   the page is showing, identified by name; names are mapped to fields in the order first seen
   and remembered in `localStorage`. Pinning P1 or P2 leaves AUTO; double-clicking AUTO forgets
   the learned names.
3. **Leg-end detection**: when either score reads 0 it POSTs `/api/leg_end` once, then re-arms
   only after a real remaining score is back — the 0 stands for several seconds, so without that
   latch every tick during it would fire again.

   Hooked to the score reaching 0 rather than to any UI marker on purpose. A DOM capture of a live
   leg showed `div.styles_isFinished__uTh81` ("Finished") looks like the signal but appears after
   every visit to the oche, twice per leg, alongside "Removing darts..."; `Finish & View Stats` and
   the `Game` label appear only at the end of a *match*. The score hitting 0 is the only marker
   that fires exactly once per leg regardless of leg number or match state.
4. **OCR-A font injection** (fallback support): makes on-screen digits uniform so the screen-OCR
   fallback stays accurate. If OCR accuracy regresses, check this is still active.

`popup.html` / `popup.js` show the same live status (app reachable, source, field, score, ways)
from the extension's own origin.

Requires `host_permissions` for `127.0.0.1:5000` — that is what lets the content script's `fetch`
bypass the page's CSP and CORS.
