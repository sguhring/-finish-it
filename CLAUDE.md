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

Static assets in `static/`; the `templates/` dir is Flask Jinja templates (distinct from
`templates_capture/`, which holds OCR reference images).

### Edge extension (`edge-extension/`)
A Manifest V3 content script doing two jobs on `game.scoliadarts.com`:

1. **The score bridge** (primary): every 250 ms it finds the two score elements in the DOM and
   POSTs them to `http://127.0.0.1:5000/api/score`, with a 2 s heartbeat so an unchanged score
   keeps push mode alive. Elements are found heuristically — visible leaf elements whose whole
   text is a 1–3 digit number ≤ 501, the two largest by font size, leftmost = field 1. Set
   `SCORE_SELECTOR` at the top of `content.js` to pin an exact selector if the heuristic misfires;
   it logs its picks (and, on failure, all candidates) to the page console. Anything other than
   exactly two matches pushes nothing, so the app falls back to OCR rather than guessing.
2. **OCR-A font injection** (fallback support): makes on-screen digits uniform so the screen-OCR
   fallback stays accurate. If OCR accuracy regresses, check this is still active.

Requires `host_permissions` for `127.0.0.1:5000` — that is what lets the content script's `fetch`
bypass the page's CSP and CORS.
