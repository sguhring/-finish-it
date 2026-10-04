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

# Exercise the training-drill logic (no browser, no board) -- the only part of
# the app with a real test. Pulls the script straight out of training.html.
node test_training.js

# CNN pipeline (NOTE: currently NOT used by app.py — see "OCR pipeline" below)
python generate_data.py       # render synthetic training images -> training_data/
python train.py               # train ScoreCNN -> darts_ocr.pth
```

`test_training.js` is the one real test (run it with node; it needs nothing installed).
There is otherwise no test runner, linter, or `requirements.txt`. `test_ocr.py`, `show_region.py`, and the
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
(WLED at `WLED_HOST`, currently `192.168.237.83`; set `WLED_ENABLED = False` to switch it off).
The light is **two rings on one output** (GPIO2, 246 LEDs), inner first: segment 0 is the inner
ring (LEDs 0–107), segment 1 the original outer ring (108–245). The segments are set up on the
device and saved in its boot preset; `WLED_SEGMENTS` in `app.py` lists them. Adding strips means
raising the LED count on the device (Config → LED Preferences) and the segment bounds, or the
new LEDs stay dark.

**Only the outer ring is the status display.** The inner ring sits right at the board, so it
holds one steady, dim light red (`INNER_COLOUR`, `INNER_BRIGHTNESS`) whatever the outer ring is
doing — score colour, idle rainbow or the leg-end pulse. `_rings()` builds both: WLED multiplies a
segment's own `bri` by the master `bri`, and the master changes per state (idle 90, score 160,
pulse 255), so the inner segment's `bri` is scaled the opposite way and the ring looks equally dim
in all three instead of flaring with the pulse. Empty `WLED_INNER_SEGMENTS` to make the inner
ring follow the outer one again. The device's own boot preset is separate: until `app.py` first
reaches the ESP, the inner ring shows whatever that preset says.

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

### 4. Training modes (`/training`, `templates/training.html`)
Three drills scored off the real board, sharing one derived feed. All of the game
logic is client-side; `app.py` only supplies events and stores results.

**The throw feed.** The board only ever reports an *absolute* remaining score.
`_feed_training()` (called from `ocr_loop()` under `lock`, for both fields on the
push path and for the selected field on the OCR path) diffs consecutive readings
into `_throw_events`, a 500-deep deque of `{id, ts, field, kind, before, after,
points}`. A drop of 1..180 is a `throw`; anything else — the score going *up* —
is a `reset` (new leg, a bust Scolia reverted, board reset). `GET /api/throws?
since=<id>` serves everything after an id, so the page cannot miss a throw
between its slower polls and a reload just resumes. `since=-1` means "starting
fresh, do not replay".

> Events are emitted **per field**, and the extension pushes the same number to
> both fields whenever Scolia shows one player — so a consumer that does not
> filter on the selected field counts every throw twice.

**Visits vs. darts.** Whether Scolia updates its counter once per dart or once
per visit is not knowable from the numbers, so the client does not assume:
`feedChange()` groups changes into a visit by the gap between them, and the gap
depends on **which reader the feed came from**, because that decides how fast a
dart surfaces rather than how fast it was thrown:

- `push` (`VISIT_GAP_FAST`, 4 s) — the extension reads the DOM every 250 ms, so
  the three darts of a visit arrive about a second apart, as thrown.
- `ocr` (`VISIT_GAP_SLOW`, 9 s) — a screen pass costs 2–3 s and a score is only
  accepted once two passes agree, so darts inside one visit surface 4–6 s apart.
  With the fast threshold every single dart closed its own visit, and the 301
  block then reported the **per-dart** average (15.7) where the 3-dart average
  (47) belongs. Measured over a real session, the walk to the board never put
  two visits closer than 14 s, so the slow threshold has room either way.

A change over 60 is necessarily a whole visit, and seeing one flips
`feed.perVisit` on (remembered in `localStorage`), after which grouping is
dropped and each change is a visit the moment it lands. That is only ever
concluded from the push feed: on the OCR path two darts routinely land between
passes and surface as one change, and a merged 20 + 60 is indistinguishable from
a visit of 80. The latch also **undoes itself** — two changes closer together
than the gap prove the board is not reporting one change per visit, which heals
a flag learned on the wrong board instead of leaving it stuck for good.

**The drills.**
- **301 darts** — board on `9999`. A fixed block of darts (100 / 301 / 601), no
  finish and no bust; the block measures what you average. Headline metric: the
  3-dart average (higher is better).

  A visit counts as **three darts whatever the board reports**, and that is the
  point: a dart that scores nothing changes the remaining score by zero and so
  produces no event at all, and counting the events that did arrive would drop
  those darts and flatter the average. The block is set in darts but thrown in
  visits of three, so the last visit usually carries it past the number — the
  average is taken over the darts actually thrown. A whole visit that scores
  nothing stays invisible to the board, which is what the "Nothing scored"
  button on all three drills is for.
- **10 × 101** — board on `101`, Scolia runs the legs for real. A leg closes when
  the board reads **0**; the next one arms on the following `reset`. A `reset`
  *mid*-leg is a bust, which is why a rise only means "new leg" once the leg has
  actually been won. The winning visit is assumed to be 3 darts until tagged
  1/2/3, and the final leg deliberately does not auto-finish — otherwise there is
  nowhere left to tag it. Headline metric: darts per leg.
- **Random 20** — board on `9999`. A round is a **sequence of three numbers**
  (`drawSequence`, distinct within the round), one dart at each in the order
  shown; the board visit scores the round and turns the next sequence over.
  Three darts at one number is a different, easier skill — the first dart tells
  you where you are and the other two correct off it — so the drill switches bed
  every dart, the way a real visit does.

  Points alone are a bad metric here (a stray 20 while aiming at 1 scores more
  than a perfect T1), so the honest number is the optional tag, and it is taken
  **per dart** (buttons under each number, keys 1–3, `0` for none) rather than as
  a count: a count cannot say *which* of the three was missed, and that is the
  only thing the per-number weakness table can be built from. A round tagged
  "none" still counts as tagged — leaving it untagged would drop your worst
  rounds out of the hit rate. Headline metric: hit rate, falling back to avg
  points.

  **The draw is data, not guesswork.** `PRO_ATTEMPTS` is the number of darts the
  top 16 professionals *aimed* at each number over the 2019 season — trebles
  (T20/T19/T18/T17) plus doubles (D1–D20) at that number, from the dataset behind
  Haugh & Wang, *An Empirical Bayes Approach for Estimating Skill Models for
  Professional Darts Players* (arXiv:2302.10750, data at
  `github.com/wangchunsem/OptimalDarts`). Raw, it is brutally top-heavy: 20 takes
  71% of all darts aimed, 19 another 16%, 13 one in three thousand. That is true
  match darts and a poor practice hour, so **Practice** (the default) draws on
  `NUMBER_WEIGHTS` = those counts raised to `TEMPER` (0.5), which keeps the order
  and rough shape the data gives — 20, 19, 18, then 17/16/10/8 off the finishing
  doubles — while pulling 20 down to about a third of rounds. **Pro** draws
  straight from the counts, **Even** ignores them. Changing `TEMPER` is the whole
  knob; the counts themselves are measurements and should not be hand-edited.

**Storage.** `training_stats.json` next to the app (gitignored, written
atomically via a `.tmp` + `os.replace`). The server does **not** understand the
per-mode `stats` blob — it stores whatever the drill computed, so a new drill
needs no schema change in `app.py`. Deliberately server-side rather than
`localStorage` so history survives a cache clear and reads the same from a phone.

> `_clean_score()` accepts 0..`MAX_PUSH_SCORE` (9999), not 0..501 — a 9999 board
> would otherwise be rejected outright. The extension's own filters were widened
> to four digits to match. Big scores are safe downstream: `suggested_ways(9999)`
> returns an empty array and `score_colour()` already sends anything over 170 to
> the flat blue.

### Flask routes & frontend
- `GET/POST /` → `templates/index.html`: **the calculator, and only the calculator** — type a
  score, get the best finish and the alternatives. Nothing on it polls the reader, the fields or
  the LEDs; that all lives on `/live`. The layout and element order follow the `PhoneFrame`
  mockup in `flutter_application_1/lib/main.dart` (title + edit icon, score box + Calculate,
  Best Finish, Alternatives as wrapping chips). On a wide viewport the page draws the phone body
  (390×844, notch) around itself; at ≤480 px the frame drops away and the screen fills the
  display. It renders client-side from `/api/ways/<score>`, remembers the last score in
  `localStorage` (`finishit.lastScore`), and opens at a given score via `/?score=121`.
  "Show all N ways" reveals the unfiltered `all_ways` list on demand.

  **Brand system** (tokens at the top of `index.html`, written to port 1:1 to Flutter for the
  App Store build):
  - *The mark*: a chalk calculator with a green dart through it — the original
    `static/finishit_logo.svg` idea (outlined, green on white) redrawn in solid shapes so it
    survives small sizes. The dart is drawn as a dart, not an arrow: needle point, thick barrel,
    thin shaft, flights; an ink halo under it separates it from the calculator body.
    `static/icon.svg` is the master and is what the page header shows; `icon-1024/512/192/180.png`
    are exported from it as **RGB without alpha** (the App Store rejects icons with transparency)
    and full-bleed square, since iOS and Android apply their own corner mask. `static/icon-f.svg`
    is an earlier abstract alternative (two bars and a dot), kept only as a fallback.
  - *The one rule*: green (`--finish`, `#19D17F`) is **reserved for the finish** — the dart in the
    mark and the double that ends a route. The primary button is therefore ink, not green, so
    the one green thing on screen is always the answer. Do not spend green on decoration.
  - `--finish` is for fills only (with `--finish-ink` text on it); green *text* on the card uses
    `--finish-text`, which is the shade that passes AA contrast. Light and dark token sets both
    exist and follow `prefers-color-scheme`.
  - One typeface, Space Grotesk (OFL, available in `google_fonts`). Radii: card 24, controls 14,
    pills full. Touch targets are ≥ 48 px.
  - `static/manifest.webmanifest` makes the page installable to a home screen. That is **not** an
    App Store path by itself — see the note below.

  > **App Store note.** The calculator needs the Flask server for its maths, and a store app
  > cannot. The clean route is to bundle the finish table: `_build_finish_table()` already
  > produces every list for 2–170, so the Flutter app can ship it as a JSON asset and work
  > offline with no Python at all. A bare web-view wrapper around this page risks rejection under
  > Apple's minimum-functionality guideline (4.2).
- `GET/POST /live` → `templates/live.html`: the dark board follower. One big score, the best finish
  as three dart tiles, the remaining ways in collapsed folds, and a **Reader** fold with the OCR
  diagnostics (source, raw text, region preview). Two modes, remembered in `localStorage` under
  `ocrEnabled`: **Live** polls `/api/outshot` every ~700 ms and follows the board (P1/P2 buttons
  drive `/api/set_field`); **Type** takes a score by hand. Also renders from `/api/ways/<score>`,
  fetched only when the score actually changes. Live is the default on a fresh browser.
- Both pages share `_posted_ways()`: a `POST` (the form without JS) server-renders the same
  sections through Jinja macros and seeds the script via `initial`.
- `GET /api/ways/<score>` → every list the page shows for one score (`suggested`, `alternatives`,
  `all_ways`, `na_dd`, `sdd`, `message`, `possible`), built by `_ways_payload()`. `alternatives`
  is `calculate_output()` minus the rows already in `suggested`. Scores outside 0–9999 are a 400.
- `GET /finishes` → `templates/finishes.html`: full precomputed checkout table (scores 2–170,
  cached in `_FINISH_TABLE_CACHE`).
- `GET /api/outshot` → JSON of the latest OCR score + its checkout suggestions. `/live` polls
  this in Live mode; the extension overlay and popup poll it too.
- `POST /api/set_field` / `GET /api/current_field` → switch/read which player field is being OCR'd.
- `GET /api/region_preview` → live PNG of the current capture rectangle, so you can visually confirm
  the OCR region is aimed correctly in the browser.
- `POST /api/score` → accepts exact scores pushed by the extension, as `{"field1": N, "field2": N}`
  or `{"field": 1|2, "score": N}`. Values outside 0–9999 are stored as `None`. Responds with CORS
  headers (including `Access-Control-Allow-Private-Network`, which Chrome's private-network
  preflight requires for an https page calling `127.0.0.1`).
- `POST /api/leg_end` → fired by the extension when a score reaches 0; runs the ring through a
  short bright pulse (see the WLED section). Same CORS treatment as `/api/score`.
- `GET /training` → `templates/training.html`: the three training drills + progress history.
- `GET /api/throws?since=<id>` → the score-change feed described above.
- `GET|POST /api/training/sessions`, `DELETE /api/training/sessions/<id>` → the session store.

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

   The blanket `* { font-family: ... !important }` rule is scoped to Scolia
   (`ON_SCOLIA`). The content script also runs on `127.0.0.1:5000`, where that rule
   used to override the app's own Poppins/Oswald styling; there it now only touches
   the specific score elements it needs uniform.

Both score filters accept **four** digits, not three, so a board set to 9999 for the
training drills is read rather than ignored.

`popup.html` / `popup.js` show the same live status (app reachable, source, field, score, ways)
from the extension's own origin.

Requires `host_permissions` for `127.0.0.1:5000` — that is what lets the content script's `fetch`
bypass the page's CSP and CORS.
