# How Finish IT works

The [README](../README.md) covers setup and everyday use. This page explains what happens inside: where a score comes from, how the finishes are computed, how the drills count throws, and what the API returns.

- [The score reader](#the-score-reader)
- [The Edge extension](#the-edge-extension)
- [Screen reading](#screen-reading)
- [The checkout maths](#the-checkout-maths)
- [Training drills](#training-drills)
- [API](#api)
- [The exe and its settings](#the-exe-and-its-settings)
- [The look](#the-look)
- [The CNN experiment](#the-cnn-experiment)

## The score reader

`ocr_loop()` in `app.py` runs as a background thread and checks for a new score about three times a second. It has two sources, in this order:

1. **A pushed score.** The extension POSTs the number it reads from the scoreboard page to `/api/score`. While the last push is younger than `PUSH_TTL_S` (5 seconds), the reader uses it as it is: exact, no screen capture, no debounce. The source is reported as `push`.
2. **The screen.** When pushes stop, the reader captures a fixed region of the screen and reads the number from the pixels (see [Screen reading](#screen-reading)). A value is accepted only after two passes agree. The source is reported as `ocr`.

A push that arrives while a slow screen pass is running wins; the screen result is dropped.

The reader keeps one score per player field (1 and 2). `current_field` decides which one the pages show; `/api/set_field` switches it, and the P1, P2 and AUTO buttons call it.

## The Edge extension

A Manifest V3 extension in `edge-extension/`. It names no scoring service and does nothing on a page until you have picked the score there.

> **Terms of use.** Reading a scoreboard page with an extension is scraping in the sense of many terms of use, and some online scoreboards and autoscoring systems forbid it. Check the terms of the site or system before you pick a score there, and use the extension only where they allow it or the provider agrees. The extension sends the score only to the app on `127.0.0.1`.

**The picker.** **Select score element** in the popup injects `content.js` and `pick.js` into the current tab (the `activeTab` permission allows that without a prompt). You click player 1's score, then player 2's, or press Enter when the page shows one number. Each click becomes a CSS selector that avoids the number itself and auto-generated class names; hashed CSS-module classes are cut down to a prefix match, because the hash changes with every build of a site. The selectors are stored per host in `chrome.storage.sync` under `finishit.sites`.

**Coming back.** The same click asks for an optional host permission for that site. `background.js` registers `content.js` on every granted host, so the pick works on the next visit without the popup. **Reset** in the popup removes the selectors and the permission.

**On a picked page** the content script:

- reads the picked elements every 250 ms and POSTs them to `http://127.0.0.1:5000/api/score`, with a 2-second heartbeat so an unchanged score keeps the push source alive;
- with one pick on a page that shows one player at a time, sends that number for both fields;
- draws an overlay in a shadow root (so the page's styles and its own score search cannot touch it) that polls `/api/outshot` and shows the finish; it can be dragged, folded and resized, and its P1, P2 and AUTO buttons switch the field. AUTO follows whichever player the page shows, recognised by the largest name-like text; double-click AUTO to forget the learned names;
- POSTs `/api/leg_end` once when a score reaches 0, and re-arms only when a real score is back;
- sets a uniform OCR font on the picked elements only, so the screen fallback reads the same digits; the rest of the site keeps its fonts.

The popup shows whether the app is reachable, where the score comes from, what the pick reads, and **lost** when the picked element has been missing for three seconds.

`host_permissions` for `127.0.0.1:5000` is what lets the content script reach the app from inside a scoreboard page.

## Screen reading

The fallback reads the score from a rectangle of the screen, `OCR_FIELDS` in `app.py`, one per player field:

```python
OCR_FIELDS = {
    1: {"top": 420, "left": 120, "width": 430, "height": 220},
    2: {"top": 420, "left": 680, "width": 490, "height": 220},
}
```

```text
Screen capture (mss)
       │
       ├─ Reference images loaded? ──yes──► Template match (one matrix multiply)
       │                                          │
       │                                    correlation ≥ 0.56? ──no──► Tesseract
       │
       └─ No reference images ─────────────► Tesseract
```

**Template matching.** Each frame is converted to grey, sharpened and thresholded (Otsu), cropped to the digits, and resized to a 256 × 96 fingerprint. The fingerprint is compared with all reference images in `templates_capture/field2/` (one per score, 0 to 501) in a single matrix multiply. The best match wins if its correlation is at least `TEMPLATE_CONF_THRESHOLD` (0.56).

**Tesseract** runs only when there are no reference images or the match is unsure. It tries several threshold images and page-segmentation modes and keeps the most confident reading within 0 to 501. Without Tesseract installed, that tier is skipped.

Both tiers stop at 501, so a game started at 9999 for the training drills can only be followed through the extension.

**Calibrating.** `python show_region.py` saves `ocr_region_current.png` with what the reader sees; the **Reader** fold on `/live` shows the same rectangle live. To capture reference images for your own scoreboard font:

```powershell
python capture_templates.py   # live preview; SPACE captures and moves on, arrows change the score, Q quits
python auto_capture.py        # types each score 0–501 into the page and captures it (needs pyautogui)
```

The capture scripts keep their own copy of the coordinates; keep them in step with `OCR_FIELDS`.

**Tips.** Capture the references at the same browser zoom you play at; rescaling changes the digits and breaks matches. If the reader misses often, lower `TEMPLATE_CONF_THRESHOLD` a little (0.50); if it reads wrong numbers, raise it (0.62). `mss` captures the primary monitor.

## The checkout maths

`calculate_output(V)` builds every combination of up to three darts (singles, doubles, trebles, outer and inner bull) that adds up to `V` and ends on a double or the bull, then filters out the routes no player would choose. Each route comes back as dart notation: `T20`, `S5`, `D16`, `Bull`, `SBull`.

`suggested_ways(V)` orders those routes with a hand-curated table, `_SUGGESTED_ROWS`, so the common routes come first; the first one is the best finish on every page. The table has no entry for 149 and 170; for those `suggested_or_all(V)` falls back to the routes `calculate_output(V)` returned, so `/api/outshot` and `/finishes` never show a finishable score without a route. `na_double_double_finishes(V)` and `single_double_double_finishes(V)` add two alternative shapes: two doubles (62 to 80), and a single followed by two doubles (97 and 102 to 120).

Scores with no checkout are 1, 159, 162, 163, 165, 166, 168, 169 and everything above 170.

> `_SUGGESTED_ROWS` refers to rows by position, so changing the order in which `calculate_output` builds its combinations silently breaks the preferred routes. Check `/finishes` after any change there.

## Training drills

The board only ever reports the **remaining** score. `_feed_training()` turns consecutive readings into numbered events: a drop of 1 to 180 is a throw, anything else (the score going up) is a reset, such as a new leg, a reverted bust or a cleared board. `/api/throws?since=<id>` returns everything after an id, so the training page polls at its own pace, never misses a throw, and picks up where it was after a reload. All game logic runs in `templates/training.html`; the app only supplies events and stores results.

**Visits.** Whether a page updates its counter once per dart or once per visit cannot be told from the numbers, so the page groups changes into visits by the time between them. The gap depends on the source: about 4 seconds for pushed scores, which arrive as thrown, and about 9 seconds for screen reading, which needs two slow passes per value. A single change over 60 can only be a whole visit; once one is seen, every change counts as a visit.

**Every visit counts as three darts**, whatever the board reports. A dart that scores nothing does not move the remaining score, so counting only what arrived would drop it and flatter the average. A whole visit that scores nothing is invisible, which is what **Nothing scored** is for. The 301 block is set in darts but thrown in threes, so the last visit usually goes a dart or two past 301; the average is taken over the darts actually thrown.

**Random 20** draws three different numbers each round, and you throw one dart at each in the order shown. Tagging which darts hit (buttons under the numbers, or keys `1` to `3`, `0` for none) is optional, but it is what feeds the hit rate and the weakest-numbers table.

Its draw comes from real match data. `PRO_ATTEMPTS` in `templates/training.html` is how many darts the top 16 professionals aimed at each number over the 2019 season (trebles plus doubles at that number), from the dataset behind Haugh & Wang, *An Empirical Bayes Approach for Estimating Skill Models for Professional Darts Players* ([arXiv:2302.10750](https://arxiv.org/abs/2302.10750), data at [wangchunsem/OptimalDarts](https://github.com/wangchunsem/OptimalDarts)). Taken raw, 20 gets 71 % of all aimed darts and 13 almost none, which makes a poor practice hour, so the drill offers three draws:

| Draw | What it does |
|---|---|
| **Practice** (default) | The counts square-rooted: 20 about 34 %, 19 about 16 %, 18 about 9 %, then the finishing-double numbers, down to under 1 % for 13. Same order as the professionals, but every number still comes up. |
| **Pro** | The counts as measured. Seven rounds in ten are a 20. |
| **Even** | Every number equally likely. |

Finished sessions are appended to `training_stats.json` next to the app (or the exe), at most 2,000. **Progress** charts each drill's headline number over time and marks personal bests.

```powershell
node test_training.js   # runs the drill logic from training.html under node, no browser and no board
```

## API

All routes are served on `127.0.0.1:5000`. `/api/score` and `/api/leg_end` answer CORS requests, because the extension calls them from inside a scoreboard page.

| Method | Route | What it does |
|---|---|---|
| `GET` | `/` | The calculator; `?score=121` opens it at a score |
| `POST` | `/` | The calculator without JavaScript: posts a score, returns the page with the finish |
| `GET`, `POST` | `/live` | The live page |
| `GET` | `/finishes` | Every checkout from 2 to 170 |
| `GET` | `/training` | The training drills |
| `GET` | `/api/outshot` | Current score, its source and field, and the suggested routes |
| `GET` | `/api/ways/<score>` | Every route list for one score, 0 to 9999 |
| `POST` | `/api/score` | Push a score: `{"field1": 501, "field2": 340}` or `{"field": 2, "score": 340}` |
| `POST` | `/api/leg_end` | End-of-leg signal from the extension; a hook for local add-ons, no effect by default |
| `POST` | `/api/set_field` | Choose the field the pages follow: `{"field": 1}` or `{"field": 2}` |
| `GET` | `/api/current_field` | The field the pages follow |
| `GET` | `/api/region_preview` | PNG of the screen rectangle the reader captures |
| `GET` | `/api/throws` | Throw and reset events after `?since=<id>` (`-1` starts fresh) |
| `GET`, `POST` | `/api/training/sessions` | List the saved sessions, or save a finished one |
| `DELETE` | `/api/training/sessions/<id>` | Delete a saved session |

`/api/outshot` returns, for example:

```json
{
  "ok": true,
  "score": 81,
  "raw": "81",
  "message": "Good Luck",
  "suggested_ways": [["NA", "T19", "D12"], ["NA", "T17", "D15"], ["Bull", "S15", "D8"], ["Bull", "S7", "D12"]],
  "na_double_double_finishes": [],
  "single_double_double_finishes": [],
  "source": "push",
  "field": 2,
  "updated_ts": 1794915426.25
}
```

`NA` marks a dart that is not needed; routes are padded at the front, so the last entry is always the finishing double.

## The exe and its settings

`python build_exe.py` runs PyInstaller and writes `dist\FinishIT.exe`, one file with the page templates, static files and reference images inside. It does not contain Tesseract or the extension. The exe starts the server on `127.0.0.1:5000` without the debug reloader, opens `/live` in the browser and keeps a console window open; closing the window stops the app.

Settings for one machine go in `finishit.json` next to `app.py` or the exe. The file is gitignored and optional:

```json
{ "tesseract_cmd": "D:/Tools/Tesseract-OCR/tesseract.exe" }
```

If `finishit.json` exists next to `app.py` when you build, `build_exe.py` copies it into `dist\` (unless one is already there), so your own copy keeps its settings while a copy you hand out starts without any. `training_stats.json` also lives next to the exe.

## The look

Ink on chalk, one typeface on the calculator ([Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk)), and one rule: green belongs to the finish. The double that ends the best route is the only green fill on the screen, so the answer is where the eye lands. The icon is a calculator with a dart through it, the dart its one green element; `static/icon.svg` is the master and the PNG sizes next to it are exported from it. On a desktop browser the calculator draws a phone around itself; on a phone the frame drops away.

| Token | Value | Use |
|---|---|---|
| chalk | `#F4F1EA` | light background |
| ink | `#0F1720` | text, dark background |
| finish green | `#19D17F` | fills only: the finishing double |
| finish ink | `#06281A` | text on finish green |
| finish text | `#0A7F52` light, `#3DDC97` dark | green text, e.g. doubles in the alternatives |

The live and training pages still use their own darker style (Poppins and Oswald, a teal accent); bringing them onto the calculator's palette is open work.

## The CNN experiment

`train.py` trains a small three-block CNN on 502 classes (scores 0 to 501) from images in `training_data/` and saves the best model to `darts_ocr.pth`. Both stay on your machine; the repo does not include them. The app does not load it: template matching reads the same numbers without a GPU. Training improved little per epoch and cost a lot of compute, which is why it stayed an experiment.
