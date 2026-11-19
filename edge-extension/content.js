// Finish IT bridge
//
// Three jobs on any scoring page, once the user has pointed the picker
// (popup -> "Select score element") at its score:
//   1. read both players' scores out of the DOM and push them to the local app
//      (so the app never has to OCR the screen),
//   2. draw the checkout suggestions back onto the game page, so you never have
//      to look at a second window, and
//   3. tell the app when a leg ends, so the LED ring pulses.
//
// The OCR-A font on the picked score elements stays as a safety net: if the
// bridge ever stops pushing, app.py falls back to screen OCR after PUSH_TTL_S
// and the uniform font is what makes that fallback accurate.
//
// There is no built-in site: the bridge stays silent until a score element
// has been picked. The picks are kept per host in chrome.storage.sync, and
// background.js keeps the script registered on every host the user granted
// from the popup.
(function () {
  "use strict";

  // The script can land twice on one page: once declared or registered, once
  // more when the popup injects it to start the picker. The second copy has
  // nothing to do -- the first one already exposes the picker.
  if (globalThis.__finishit) return;
  globalThis.__finishit = true;

  // Bump on every change, so the console tells you which build a tab is really
  // running. Reloading the extension does NOT swap the script in tabs that are
  // already open - those keep the old copy alive until the page is reloaded.
  const VERSION       = "v7 (broadcast overlay)";

  const APP           = "http://127.0.0.1:5000";
  const POLL_MS       = 250;    // how often we re-read the DOM
  const FINISH_MS     = 600;    // how often we pull the checkout suggestions
  const HEARTBEAT_MS  = 2000;   // resend an unchanged score to keep push mode alive
  const DEBUG         = true;   // logs the elements it picked, once

  // A picked selector beats any font-size heuristic twice over: it cannot pick
  // up a statistics number by mistake, and when the counters disappear at the
  // end of a game readScores() returns nothing at all -- a heuristic latches
  // onto leftover stats and pushes them as if they were live scores.

  // -- OCR-A font (fallback path) --------------------------------------------
  // Uniform digit shapes are what keep the screen-OCR fallback accurate. On
  // the app's own pages that means the numbers they render; on a game page only
  // the picked score elements, so the rest of the site keeps its own fonts.
  // Nothing is injected (and the font is never fetched) until there is a pick.
  const ON_APP    = location.port === "5000" &&
                    /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  const OCR_FONT  = "font-family: 'OCR A Extended', 'OCR A Std', monospace !important;";

  const style = document.createElement("style");
  function setFontRules(selectors) {
    const app = ON_APP ? `
    /* Finish IT (127.0.0.1:5000) */
    .score-display,
    .header-score,
    .finish-row .dart,
    .finish-row .dart-double,
    #liveScore,
    .field-btn .field-num {
      ${OCR_FONT}
      letter-spacing: 0.05em !important;
    }` : "";
    const picks = selectors && selectors.length ? `
    /* picked score elements */
    ${selectors.join(",\n    ")} { ${OCR_FONT} }` : "";
    style.textContent = app || picks
      ? `@import url('https://fonts.cdnfonts.com/css/ocr-a-extended');${app}${picks}` : "";
  }
  setFontRules(null);
  document.head.appendChild(style);

  // The app's own pages only want the font.
  if (ON_APP) return;

  console.log(`[Finish IT] content script ${VERSION} loaded`);

  // -- Score extraction ------------------------------------------------------

  function describe(el) {
    const r  = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      el,
      value: parseScore(el.textContent),
      size:  parseFloat(cs.fontSize) || r.height,
      x:     r.left + r.width / 2,
      sel:   el.tagName.toLowerCase() +
             (el.className ? "." + String(el.className).trim().split(/\s+/).join(".") : ""),
    };
  }

  // One number in the element's text, with at most a short label around it
  // ("501", "Rest: 501"). Two numbers means a container, not a score.
  function parseScore(text) {
    const t = (text || "").trim();
    if (t.length > 24) return null;
    const m = t.match(/^\D*(\d{1,4})\D*$/);
    return m ? parseInt(m[1], 10) : null;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) !== 0;
  }

  // Every visible leaf element whose entire text is a plausible darts score.
  // Our own overlay lives in a shadow root, so it can never match here.
  //
  // The ceiling is MAX_SCORE, not 501: the training drills are thrown on a
  // board set to 9999 so the leg never ends and every visit shows up as a drop
  // in the remaining score. Four digits have to get through for that to work.
  const MAX_SCORE = 9999;

  function candidates() {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (!/^\d{1,4}$/.test(t)) continue;
      if (parseInt(t, 10) > MAX_SCORE) continue;
      if (!isVisible(el)) continue;
      out.push(describe(el));
    }
    return out;
  }

  // Many scoring pages show one player at a time, so the remaining score is
  // normally a single number drawn far larger than anything else on the page -
  // the turn history next to it is often less than half its size. When one
  // number dominates like that we treat it as *the* score and push it to both
  // fields, so the app is right whichever field is selected.
  //
  // A genuinely side-by-side layout (two numbers of comparable size) still maps
  // leftmost -> field 1, rightmost -> field 2. Anything else is too ambiguous
  // to guess from, so we push nothing and let OCR take over.
  const DOMINANT_RATIO = 1.35;

  // Visible elements matching `sel` that hold a score, biggest first. A
  // selector saved on another build of the site may no longer even parse.
  function readMatches(sel) {
    let els;
    try { els = document.querySelectorAll(sel); } catch (e) { return []; }
    return Array.from(els)
      .filter(el => parseScore(el.textContent) !== null && isVisible(el))
      .map(describe)
      .sort((a, b) => b.size - a.size);
  }

  function readScores() {
    const sels = activeSelectors();

    // Two picks: one element per player, no guessing about the layout.
    if (sels && sels.length === 2) {
      const [a] = readMatches(sels[0]);
      const [b] = readMatches(sels[1]);
      if (!a || !b) return null;
      return { field1: a.value, field2: b.value, picked: [a, b], mode: "two-up" };
    }

    const list = sels ? readMatches(sels[0]) : [];

    if (!list.length) return null;

    const [top, second] = list;
    if (!second || top.size >= DOMINANT_RATIO * second.size) {
      return { field1: top.value, field2: top.value, picked: [top], mode: "single" };
    }

    const pair = [top, second].sort((a, b) => a.x - b.x);
    return { field1: pair[0].value, field2: pair[1].value, picked: pair, mode: "two-up" };
  }

  // -- Which element holds the score ------------------------------------------
  // No site is built in. A page gets nothing until the user points the picker
  // at its score: one selector when the page shows a single score, two
  // (player 1, player 2) when it shows both. When a site ships a new build and
  // the score moves, re-picking fixes it -- nothing in this file to edit.

  const SITES_KEY = "finishit.sites";       // chrome.storage.sync: host -> pick
  const HOST      = location.hostname;
  let picked      = null;                   // ["sel"] or ["sel P1", "sel P2"]

  const activeSelectors = () => picked;
  const configured      = () => !!picked;

  function applySites(sites) {
    const site = (sites || {})[HOST];
    picked = site && Array.isArray(site.selectors) && site.selectors.length
           ? site.selectors : null;
    setFontRules(picked);
    logged = false;                         // log the new picks once
    lostSince = 0;
  }

  function loadPicked() {
    try {
      chrome.storage.sync.get(SITES_KEY, r => applySites(r && r[SITES_KEY]));
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync" && changes[SITES_KEY]) applySites(changes[SITES_KEY].newValue);
      });
    } catch (e) { /* extension reloaded underneath us */ }
  }

  function savePicked(selectors) {
    picked = selectors;
    setFontRules(picked);
    try {
      chrome.storage.sync.get(SITES_KEY, r => {
        const sites = (r && r[SITES_KEY]) || {};
        sites[HOST] = { selectors, pickedAt: new Date().toISOString() };
        chrome.storage.sync.set({ [SITES_KEY]: sites });
      });
    } catch (e) {}
  }

  // -- Who is at the throw ---------------------------------------------------
  // In AUTO mode we stop caring which field button is pressed and follow the
  // player the page is currently showing. A one-score page usually does not
  // label the players "1" and "2" anywhere we can read, so we identify them by
  // name and hand out
  // fields in the order we first see them: first name seen -> field 1, the
  // next distinct name -> field 2. That mapping is remembered per browser.

  // Static UI wording that would otherwise out-size the player name.
  const NOT_A_NAME = /^(legs?|leg \d+|average|first \d+ avg\.?|checkout|switch player|none|total|sets?|darts?|score)$/i;

  function readPlayerName() {
    let best = null;
    for (const el of document.querySelectorAll("*")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (t.length < 2 || t.length > 24) continue;
      if (!/[A-Za-z]/.test(t)) continue;      // a name has letters; scores do not
      if (NOT_A_NAME.test(t)) continue;
      if (!isVisible(el)) continue;
      const d = describe(el);
      if (!best || d.size > best.size) best = { text: t, size: d.size, sel: d.sel };
    }
    return best;
  }

  // name -> field, in order of first sighting
  function fieldForName(name) {
    const map = store.get(PLAYERS_KEY, {});
    if (map[name]) return map[name];
    const taken = new Set(Object.values(map));
    const free = [1, 2].find(f => !taken.has(f));
    if (!free) return null;                   // more than two names seen - give up
    map[name] = free;
    store.set(PLAYERS_KEY, map);
    if (DEBUG) console.log(`[Finish IT] "${name}" -> field ${free}`);
    return free;
  }

  // -- Overlay ---------------------------------------------------------------
  // Shadow DOM so nothing on the game page can restyle it, and so the score
  // scanner above can never pick up our own numbers.
  //
  // Everything inside scales off one --s factor derived from the panel width,
  // so dragging the grip resizes the whole thing as a unit rather than just
  // reflowing text. Default width is a third of the viewport.
  //
  // The look follows the app's brand system (templates/index.html): chalk on
  // ink, Space Grotesk, card radius 24 / controls 14 / pills full -- and green
  // only on the dart that finishes a route, so the one green thing in the
  // panel is always the answer. The score, the buttons and the source chip
  // therefore never use it.

  const POS_KEY     = "finishit.pos";
  const COL_KEY     = "finishit.collapsed";
  const SIZE_KEY    = "finishit.width";
  const PLAYERS_KEY = "finishit.players";   // name -> field
  const AUTO_KEY    = "finishit.auto";
  const BASE_W   = 250;    // width the raw px sizes below were designed at
  const MIN_W    = 200;
  const EDGE     = 8;      // gap a full-size panel keeps to the viewport edge
  let ui = null;

  const store = {
    get(k, fallback) {
      try {
        const v = localStorage.getItem(k);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // Space Grotesk ships with the extension (fonts/, OFL). A @font-face inside
  // a shadow root is ignored, and a url() to the extension can be refused by
  // the page's font-src, so the files are fetched here and handed to the
  // document as binary faces. Under a private family name, so a page that
  // uses Space Grotesk itself is left alone. Until they land (or if they never
  // do) the panel is drawn in the system face; every line height below is
  // fixed, so the swap does not move anything.
  const FONT_NAME  = "Finish IT Grotesk";
  const FONT_FILES = [
    ["fonts/SpaceGrotesk-latin.woff2",
     "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329," +
     "U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"],
    ["fonts/SpaceGrotesk-latin-ext.woff2",      // player names: Ł, ř, ő ...
     "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F," +
     "U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"],
  ];
  let fontAsked = false;

  function loadFont() {
    if (fontAsked) return;
    fontAsked = true;
    for (const [file, unicodeRange] of FONT_FILES) {
      let url;
      try { url = chrome.runtime.getURL(file); } catch (e) { return; }   // extension reloaded
      fetch(url)
        .then(r => r.arrayBuffer())
        .then(buf => new FontFace(FONT_NAME, buf, { weight: "300 700", unicodeRange }).load())
        .then(face => document.fonts.add(face))
        .catch(() => {});
    }
  }

  // AUTO follows the thrower; otherwise the pinned P1/P2 button wins.
  let autoMode        = store.get(AUTO_KEY, true);
  let currentField    = null;   // what the app last reported
  let lastSyncedField = null;   // avoids re-POSTing set_field every tick

  function setField(f) {
    lastSyncedField = f;
    return fetch(APP + "/api/set_field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: f }),
    }).catch(() => { lastSyncedField = null; });
  }

  // The name AUTO learned for a field, "" when it has none.
  function nameFor(f) {
    const map = store.get(PLAYERS_KEY, {});
    for (const name of Object.keys(map || {})) if (map[name] === f) return name;
    return "";
  }

  // A pressed button is the mode in force: AUTO, or the pinned field. The
  // field in play is marked separately, so in AUTO you still see who it is
  // following -- with the learned name next to it when there is one.
  function paintFields() {
    if (!ui) return;
    ui.root.querySelectorAll(".fields button").forEach(b => {
      const isAuto  = b.dataset.f === "auto";
      const f       = Number(b.dataset.f);
      const pressed = isAuto ? autoMode : !autoMode && f === currentField;
      b.classList.toggle("on", pressed);
      b.setAttribute("aria-pressed", String(pressed));
      if (isAuto) return;
      const inPlay = f === currentField;
      const name   = nameFor(f);
      b.classList.toggle("cur", inPlay);
      b.querySelector(".who").textContent = inPlay ? name : "";
      b.title = (name ? `${name} (P${f})` : `Player ${f}`) + (pressed ? " - pinned" : " - click to pin");
      b.setAttribute("aria-label", name ? `Player ${f}, ${name}` : `Player ${f}`);
    });
  }

  // Layout viewport, without a vertical scrollbar the panel would sit under.
  const vw = () => Math.min(window.innerWidth, document.documentElement.clientWidth || Infinity);
  const vh = () => window.innerHeight;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Height / width of the panel with everything in it (three ways). Measured
  // once when the panel is built; because the whole panel scales with its
  // width, this turns "must fit the viewport height" into a cap on the width.
  let fullAspect = 1.1;

  const maxW      = () => Math.max(MIN_W, Math.floor(Math.min(vw() - 2 * EDGE,
                                                              (vh() - 2 * EDGE) / fullAspect)));
  const clampW    = w => clamp(Math.round(w), MIN_W, maxW());
  const defaultW  = () => clampW(vw() / 3);

  const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

  // One way as three cells. The finish is the last dart actually thrown: a
  // double or the Bull earlier in the route (T15 D18 D20, Bull T19 D7) is a
  // set-up shot and stays ink.
  function wayHtml(way, cls, label) {
    const darts = way.map(String);
    let last = -1;
    darts.forEach((t, i) => { if (t !== "NA") last = i; });
    const said = darts.filter(t => t !== "NA").join(", ");
    return `<div class="way ${cls}" role="group" aria-label="${esc(label)}: ${esc(said)}">` +
      darts.map((t, i) => {
        const isDouble = /^D/.test(t) || t === "Bull";
        const c = "d" + (isDouble ? " dbl" : "") + (isDouble && i === last ? " fin" : "") +
                  (t === "NA" ? " na" : "");
        return `<span class="${c}">${t === "NA" ? "·" : esc(t)}</span>`;
      }).join("") +
      `</div>`;
  }

  const SOURCE_CHIP = {
    live:    ["LIVE",    "Scores are read straight from this page"],
    ocr:     ["OCR",     "No score from this page - the app is reading the screen"],
    idle:    ["IDLE",    "The app has not read a score yet"],
    offline: ["OFFLINE", "Finish IT app not reachable - showing the last score"],
  };

  function buildOverlay() {
    loadFont();
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.zIndex   = "2147483647";
    const root = host.attachShadow({ mode: "open" });
    const p = n => `calc(${n}px * var(--s))`;     // design px -> scaled px
    root.innerHTML = `
      <style>
        :host {
          all: initial;
          /* Brand tokens, dark set (templates/index.html). */
          --surface:     rgba(11, 16, 22, .84);
          --tile:        rgba(244, 241, 234, .07);
          --ink:         #F4F1EA;
          --ink-60:      rgba(244, 241, 234, .62);
          --ink-40:      rgba(244, 241, 234, .40);
          --line:        rgba(244, 241, 234, .14);
          --btn:         #F4F1EA;
          --btn-ink:     #0F1720;
          --finish:      #19D17F;   /* fills only: the dart that finishes */
          --finish-ink:  #06281A;   /* text on a --finish fill */
          --finish-text: #3DDC97;   /* green text on the dark surface, AA */
          --live:        #FF5D52;   /* source chip only */
          --ocr:         #F5B544;
        }
        *, *::before, *::after { box-sizing: border-box; }

        .panel {
          position: relative;
          font-family: '${FONT_NAME}', 'Space Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif;
          font-variant-numeric: tabular-nums;
          line-height: 1;
          color: var(--ink);
          background: var(--surface);
          -webkit-backdrop-filter: blur(24px) saturate(1.2);
          backdrop-filter: blur(24px) saturate(1.2);
          border: 1px solid var(--line);
          border-radius: ${p(24)};
          box-shadow: 0 ${p(12)} ${p(36)} rgba(0, 0, 0, .45);
          -webkit-font-smoothing: antialiased;
          user-select: none;
        }
        button { font: inherit; margin: 0; }
        button:focus-visible {
          outline: ${p(2)} solid var(--ink);
          outline-offset: ${p(2)};
        }

        /* -- bar: source chip, wordmark, fold. Also the drag handle. -- */
        .head {
          display: flex; align-items: center; gap: ${p(8)};
          height: ${p(40)};
          padding: 0 ${p(6)} 0 ${p(12)};
          cursor: grab; touch-action: none;
        }
        .head:active { cursor: grabbing; }
        .chip {
          flex: none; display: inline-flex; align-items: center; gap: ${p(5)};
          height: ${p(18)}; padding: 0 ${p(8)} 0 ${p(6)};
          border: 1px solid var(--line); border-radius: 999px;
          font-size: ${p(9)}; font-weight: 700; letter-spacing: .1em;
          color: var(--ink-60);
        }
        .chip .dot {
          width: ${p(6)}; height: ${p(6)}; border-radius: 50%;
          background: var(--ink-40);
        }
        .chip[data-state="live"]          { color: var(--ink); }
        .chip[data-state="live"] .dot     { background: var(--live); }
        .chip[data-state="ocr"]           { color: var(--ocr); border-color: rgba(245, 181, 68, .4); }
        .chip[data-state="ocr"] .dot      { background: var(--ocr); }
        .chip[data-state="offline"] .dot  { background: none; border: ${p(1.5)} solid var(--ink-60); }
        .title {
          flex: 1; min-width: 0;
          font-size: ${p(10)}; font-weight: 600; letter-spacing: .16em; text-transform: uppercase;
          color: var(--ink-60);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .mini {
          display: none; min-width: ${p(28)}; text-align: center;
          font-size: ${p(22)}; font-weight: 700; letter-spacing: -.03em;
        }
        .fold {
          position: relative; flex: none; display: grid; place-items: center;
          width: ${p(28)}; height: ${p(28)}; padding: 0;
          border: 0; border-radius: ${p(14)};
          background: none; color: var(--ink-60); cursor: pointer;
        }
        /* The drawn control stays small; the target around it is 48 px. */
        .fold::before { content: ""; position: absolute; inset: ${p(-11)}; }
        .fold:hover { background: var(--tile); color: var(--ink); }
        .fold svg {
          width: ${p(14)}; height: ${p(14)};
          fill: none; stroke: currentColor; stroke-width: 2;
          stroke-linecap: round; stroke-linejoin: round;
          transition: transform .18s ease;
        }
        .collapsed .fold svg { transform: rotate(180deg); }

        /* -- player switch: one segmented control -- */
        .fields {
          display: flex; gap: ${p(2)};
          height: ${p(34)}; margin: 0 ${p(12)}; padding: ${p(2)};
          background: var(--tile); border: 1px solid var(--line);
          border-radius: ${p(14)};
        }
        .fields button {
          position: relative; flex: 1 1 0; min-width: ${p(48)};
          display: flex; align-items: center; justify-content: center; gap: ${p(5)};
          padding: 0 ${p(8)};
          border: 0; border-radius: ${p(11)};
          background: none; color: var(--ink-60); cursor: pointer;
          font-size: ${p(10.5)}; font-weight: 700; letter-spacing: .08em;
          white-space: nowrap;
        }
        /* 48 px tall target. It grows downwards, into the blank above the score,
           so it never eats into the drag bar over it. */
        .fields button::before { content: ""; position: absolute; inset: ${p(-3)} 0 ${p(-17)}; }
        .fields button:hover { color: var(--ink); }
        .fields button.cur { flex-grow: 1.9; color: var(--ink); background: rgba(244, 241, 234, .10); }
        .fields button.on  { background: var(--btn); color: var(--btn-ink); }
        .who {
          min-width: 0; overflow: hidden; text-overflow: ellipsis;
          font-weight: 600; letter-spacing: 0;
        }
        .who:empty { display: none; }

        /* -- readout: the score is the hero -- */
        .body { padding: ${p(8)} ${p(12)} ${p(12)}; text-align: center; }
        .score {
          height: ${p(68)};
          font-size: ${p(68)}; font-weight: 700; line-height: 1; letter-spacing: -.04em;
        }
        /* No finish on: same number, calm. Not an alarm. */
        .score.dead, .mini.dead { color: var(--ink-60); font-weight: 500; }
        .score.wait, .mini.wait { color: var(--ink-40); font-weight: 500; }
        .msg {
          display: inline-flex; align-items: center;
          height: ${p(24)}; margin-top: ${p(8)}; padding: 0 ${p(12)};
          border-radius: 999px;
          font-size: ${p(10)}; font-weight: 600; letter-spacing: .14em; text-transform: uppercase;
          color: var(--ink-60);
        }
        .msg.dead { border: 1px solid var(--line); }
        .msg:empty, .ways:empty { display: none; }

        .ways { margin-top: ${p(10)}; }
        .way { display: grid; grid-template-columns: repeat(3, 1fr); gap: ${p(6)}; }
        .d { display: flex; align-items: center; justify-content: center; }

        /* The best finish: three tiles, the finishing dart the one green fill. */
        .way.best .d {
          height: ${p(46)};
          background: var(--tile); border: 1px solid var(--line);
          border-radius: ${p(14)};
          font-size: ${p(20)}; font-weight: 700; letter-spacing: -.01em;
        }
        .way.best .d.fin { background: var(--finish); border-color: var(--finish); color: var(--finish-ink); }
        .way.best .d.na  { background: none; border-style: dashed; color: var(--ink-40); }

        /* Alternatives: same three columns, no tiles, a size the eye skips. */
        .way.alt { margin-top: ${p(2)}; }
        .way.best + .way.alt { margin-top: ${p(8)}; }
        .way.alt .d {
          height: ${p(20)};
          font-size: ${p(11.5)}; font-weight: 600; color: var(--ink-60);
        }
        .way.alt .d.fin { color: var(--finish-text); font-weight: 700; }
        .way.alt .d.na  { color: var(--ink-40); }

        /* -- resize grip: an arc inside the corner, there when you reach for it -- */
        .grip {
          position: absolute; right: ${p(3)}; bottom: ${p(3)};
          width: ${p(24)}; height: ${p(24)};
          color: var(--ink-60); cursor: nwse-resize; touch-action: none;
          opacity: 0; transition: opacity .15s ease;
        }
        .grip svg {
          display: block; width: 100%; height: 100%;
          fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round;
        }
        .panel:hover .grip, .grip:active { opacity: 1; }
        @media (hover: none) { .grip { opacity: .7; } }
        @media (pointer: coarse) {
          .grip::before { content: ""; position: absolute; inset: ${p(-24)} 0 0 ${p(-24)}; }
        }

        /* -- app not answering: the last frame stays, visibly stale -- */
        .body, .fields, .mini { transition: opacity .2s ease; }
        .offline .body, .offline .fields, .offline .mini { opacity: .38; }

        /* -- collapsed: a pill with the score and the source, nothing else -- */
        .collapsed { border-radius: 999px; }
        .collapsed .title, .collapsed .fields, .collapsed .body, .collapsed .grip { display: none; }
        .collapsed .head { gap: ${p(10)}; padding: 0 ${p(6)} 0 ${p(11)}; }
        .collapsed .mini { display: block; }

        /* -- motion: only when something actually changed -- */
        @keyframes fi-in {
          from { opacity: 0; transform: translateY(${p(6)}); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes fi-pulse {
          from { box-shadow: 0 0 0 0 rgba(25, 209, 127, .55); }
          to   { box-shadow: 0 0 0 ${p(10)} rgba(25, 209, 127, 0); }
        }
        .score.tick, .mini.tick { animation: fi-in .18s cubic-bezier(.2, .7, .2, 1); }
        .way.fresh .d           { animation: fi-in .18s cubic-bezier(.2, .7, .2, 1); }
        .way.pulse .d.fin       { animation: fi-in .18s cubic-bezier(.2, .7, .2, 1),
                                             fi-pulse .7s .12s ease-out; }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { animation: none !important; transition: none !important; }
        }
      </style>
      <div class="panel" role="region" aria-label="Finish IT checkout">
        <div class="head">
          <span class="chip" data-state="idle"><i class="dot"></i><span class="chip-t">IDLE</span></span>
          <span class="title">Finish IT</span>
          <span class="mini wait" aria-live="polite" aria-atomic="true">&mdash;</span>
          <button class="fold" type="button" aria-expanded="true">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>
          </button>
        </div>
        <div class="fields" role="group" aria-label="Player">
          <button type="button" data-f="auto" aria-pressed="false"
                  title="Follow whoever is at the throw (double-click to forget players)">AUTO</button>
          <button type="button" data-f="1" aria-pressed="false"><span>P1</span><span class="who"></span></button>
          <button type="button" data-f="2" aria-pressed="false"><span>P2</span><span class="who"></span></button>
        </div>
        <div class="body">
          <div class="score wait" aria-live="polite" aria-atomic="true">&mdash;</div>
          <div class="msg"></div>
          <div class="ways"></div>
        </div>
        <div class="grip" title="Drag to resize, double-click to reset">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8.8A17 17 0 0 1 8.8 19"/></svg>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const q = sel => root.querySelector(sel);
    const panel = q(".panel");
    const head  = q(".head");
    const fold  = q(".fold");
    const grip  = q(".grip");
    const collapsed = () => panel.classList.contains("collapsed");

    // How tall the panel gets relative to its width, with every row filled.
    host.style.width = BASE_W + "px";
    host.style.setProperty("--s", "1");
    q(".ways").innerHTML = wayHtml(["T20", "T20", "Bull"], "best", "") +
                           wayHtml(["T20", "T20", "Bull"], "alt", "").repeat(2);
    if (panel.offsetHeight > 0) fullAspect = panel.offsetHeight / BASE_W;
    q(".ways").innerHTML = "";

    // `pos` is where the open panel sits. `r` says it lives in the right half
    // of the screen: folded there, the pill hangs off the panel's right edge
    // rather than its left, so a panel parked in a corner folds into that
    // corner and opens back out of it.
    let width = clampW(store.get(SIZE_KEY, defaultW()));
    let pos   = store.get(POS_KEY, null);
    if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) {
      pos = { x: vw() - width - 24, y: 24, r: true };      // default: top-right corner
    } else if (typeof pos.r !== "boolean") {
      pos.r = pos.x + width / 2 > vw() / 2;                // saved by an older build
    }

    // The panel never leaves the viewport: what is stored is where the user
    // put it, what is drawn is that position pulled back on screen.
    function place() {
      const r = host.getBoundingClientRect();
      const x = collapsed() && pos.r ? pos.x + width - r.width : pos.x;
      host.style.left = clamp(x,     0, Math.max(0, vw() - r.width))  + "px";
      host.style.top  = clamp(pos.y, 0, Math.max(0, vh() - r.height)) + "px";
    }

    // One knob drives the whole panel: width -> scale factor.
    function applyWidth(w) {
      width = clampW(w);
      host.style.width = collapsed() ? "" : width + "px";   // the pill wraps its content
      host.style.setProperty("--s", (width / BASE_W).toFixed(3));
      place();
    }

    function setCollapsed(on) {
      panel.classList.toggle("collapsed", on);
      fold.setAttribute("aria-expanded", String(!on));
      fold.setAttribute("aria-label", on ? "Expand" : "Collapse");
      fold.title = on ? "Expand" : "Collapse";
      applyWidth(width);
    }
    setCollapsed(!!store.get(COL_KEY, false));

    fold.addEventListener("click", () => {
      setCollapsed(!collapsed());
      store.set(COL_KEY, collapsed());
    });

    root.querySelectorAll(".fields button").forEach(b => {
      const isAuto = b.dataset.f === "auto";
      b.addEventListener("click", () => {
        if (isAuto) {
          autoMode = !autoMode;                 // toggle following the thrower
        } else {
          autoMode = false;                     // pinning a field leaves AUTO
          setField(Number(b.dataset.f));
        }
        store.set(AUTO_KEY, autoMode);
        paintFields();
      });
      if (isAuto) {
        // Forget the name -> field mapping, e.g. after an opponent change.
        b.addEventListener("dblclick", () => {
          store.set(PLAYERS_KEY, {});
          lastSyncedField = null;
          paintFields();
          if (DEBUG) console.log("[Finish IT] player mapping cleared");
        });
      }
    });

    // Drag the bar to move (the whole pill, when folded).
    let drag = null;
    head.addEventListener("pointerdown", e => {
      if (e.target.closest("button")) return;
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener("pointermove", e => {
      if (!drag) return;
      const r = host.getBoundingClientRect();
      const x = clamp(e.clientX - drag.dx, 0, Math.max(0, vw() - r.width));
      const y = clamp(e.clientY - drag.dy, 0, Math.max(0, vh() - r.height));
      pos = { x: collapsed() && pos.r ? x + r.width - width : x, y, r: pos.r };
      place();
    });
    const drop = () => {
      if (!drag) return;
      drag = null;
      // Settle which half it now lives in, without moving what is on screen.
      const r = host.getBoundingClientRect();
      const right = r.left + r.width / 2 > vw() / 2;
      pos = { x: collapsed() && right ? r.right - width : r.left, y: r.top, r: right };
      store.set(POS_KEY, pos);
    };
    head.addEventListener("pointerup", drop);
    head.addEventListener("pointercancel", drop);

    // Drag the grip to resize; double-click it to snap back to a third.
    let sizing = null;
    grip.addEventListener("pointerdown", e => {
      e.stopPropagation();
      sizing = { x: e.clientX, w: width };
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener("pointermove", e => {
      if (!sizing) return;
      applyWidth(sizing.w + (e.clientX - sizing.x));
      store.set(SIZE_KEY, width);
    });
    const release = () => { sizing = null; };
    grip.addEventListener("pointerup", release);
    grip.addEventListener("pointercancel", release);
    grip.addEventListener("dblclick", () => {
      applyWidth(defaultW());
      store.set(SIZE_KEY, width);
    });

    // Keep it on screen and sensibly sized when the window changes ...
    const onResize = () => applyWidth(width);
    window.addEventListener("resize", onResize);
    // ... and when the panel itself does: ways coming and going change its
    // height, and the folded pill is as wide as its score (and gets a little
    // wider when the font lands), which matters when it hangs off the right.
    const watch = new ResizeObserver(place);
    watch.observe(panel);

    return {
      host, root, q,
      remove() {
        window.removeEventListener("resize", onResize);
        watch.disconnect();
        host.remove();
      },
      // what is on screen, so a frame only touches (and animates) what changed
      score: undefined, ways: "", source: null, offline: false,
    };
  }

  // Same colour bands the WLED ring uses, so page and light agree.
  const NO_CHECKOUT = [159, 162, 163, 165, 166, 168, 169];
  function band(v) {
    if (v === null || v === undefined) return "";
    if (v === 1 || v > 170 || NO_CHECKOUT.includes(v)) return "dead";
    if (v >= 100) return "big";
    if (v >= 41)  return "mid";
    return "easy";
  }

  function paintChip() {
    const state = ui.offline ? "offline"
                : ui.source === "push" ? "live"
                : ui.source === "ocr"  ? "ocr" : "idle";
    const chip = ui.q(".chip");
    chip.dataset.state = state;
    chip.title = SOURCE_CHIP[state][1];
    ui.q(".chip-t").textContent = SOURCE_CHIP[state][0];
  }

  function setOffline(on) {
    if (!ui || ui.offline === on) return;
    ui.offline = on;
    ui.q(".panel").classList.toggle("offline", on);
    paintChip();
  }

  // Restart a one-shot CSS animation on an element that may still carry it.
  function replay(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  let lastRender = "";

  function render(d) {
    if (!ui) ui = buildOverlay();
    setOffline(false);                // the app answered
    const sig = JSON.stringify([d.score, d.source, d.field, d.message, d.suggested_ways,
                                nameFor(d.field)]);
    if (sig === lastRender) return;   // nothing changed - leave the DOM alone
    lastRender = sig;

    ui.source = d.source;
    paintChip();
    currentField = d.field;
    paintFields();

    const none  = d.score === null || d.score === undefined;
    const state = none ? "wait" : band(d.score);
    const ways  = (d.suggested_ways || []).slice(0, 3);

    // The score, in the panel and in the folded pill. It only moves when the
    // number itself changed, and not on the very first frame.
    const text = none ? "—" : String(d.score);
    const moved = ui.score !== undefined && ui.score !== text;
    for (const el of [ui.q(".score"), ui.q(".mini")]) {
      const base = el.classList.contains("mini") ? "mini" : "score";
      el.className = `${base} ${state}`;
      if (el.textContent !== text) el.textContent = text;
      if (moved) replay(el, "tick");
    }
    ui.score = text;

    // One calm line where the finish would be, when there is none to show.
    const msg = ui.q(".msg");
    msg.className = "msg" + (none ? " wait" : state === "dead" ? " dead" : "");
    msg.textContent = ways.length ? ""
                    : none ? "Waiting for board"
                    : state === "dead" ? "No finish"
                    : (d.message || "");

    // The ways are only rebuilt when they changed, so nothing replays because
    // the source or the field flipped. A new best route slides in; one that
    // appears where there was none also pulses once.
    const key = JSON.stringify(ways);
    if (key !== ui.ways) {
      const fresh = ways.length ? " fresh" + (ui.ways === "[]" ? " pulse" : "") : "";
      ui.q(".ways").innerHTML = ways.map((w, i) => i === 0
        ? wayHtml(w, "best" + fresh, "Best finish")
        : wayHtml(w, "alt", "Alternative")).join("");
      ui.ways = key;
    }
  }

  let misses = 0;                     // polls in a row the app did not answer

  async function refreshFinishes() {
    // Nothing picked on this site (or the pick was just reset): no panel.
    if (!configured()) {
      if (ui) { ui.remove(); ui = null; lastRender = ""; }
      return;
    }
    try {
      render(await fetch(APP + "/api/outshot").then(r => r.json()));
      misses = 0;
    } catch (e) {
      // App down - keep the last frame on screen, marked as stale. One
      // dropped poll is not an outage.
      if (++misses >= 2) setOffline(true);
    }
  }

  // -- Push loop -------------------------------------------------------------

  let lastSent = "";
  let lastSentAt = 0;
  let logged = false;
  let warned = false;
  let lastRead = null;       // what the last tick read, for the popup
  let lostSince = 0;         // configured, but the element has gone missing since

  // -- Leg end ---------------------------------------------------------------
  // A leg ends exactly when a remaining score reaches 0. That is an edge, not
  // a state: the 0 stands for a few seconds before the page clears its
  // counters. So it fires once and then stays locked until a real remaining
  // score is back -- otherwise every tick during the 0 would start a new pulse.
  //
  // Deliberately NOT tied to a "Finished" marker in the page: scoring pages
  // tend to show one after every visit to the board, several times per leg.
  let legArmed = true;

  async function fireLegEnd() {
    console.log("[Finish IT] Leg beendet - Puls ausgeloest");
    try {
      await fetch(APP + "/api/leg_end", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    "{}",
      });
    } catch (e) {
      legArmed = true;         // App war nicht da - beim naechsten Tick erneut
    }
  }

  async function tick() {
    if (!configured() || picking) return;
    const s = readScores();
    lastRead = s;
    if (!s) {
      if (!lostSince) lostSince = Date.now();
      if (DEBUG && !warned) {
        warned = true;
        console.warn("[Finish IT] no score element found - falling back to OCR. Candidates:",
                     candidates().map(c => [c.value, c.sel, c.size]));
      }
      return;
    }
    warned = false;
    lostSince = 0;

    const zero = s.field1 === 0 || s.field2 === 0;
    if (zero && legArmed) {
      legArmed = false;
      fireLegEnd();
    } else if (!zero && (s.field1 > 2 || s.field2 > 2)) {
      legArmed = true;         // neues Leg laeuft, wieder scharf
    }

    if (DEBUG && !logged) {
      logged = true;
      const who = readPlayerName();
      console.log(`[Finish IT] ${s.mode} layout, reading from:`,
                  s.picked.map(p => `${p.sel} = ${p.value} (${p.size}px)`).join("   |   "),
                  `| player detected: ${who ? `"${who.text}" (${who.sel}, ${who.size}px)` : "none"}`);
    }

    // In AUTO mode, with the page showing one player, work out *who* that is
    // and push to their field only, dragging the app's selected field along.
    // Otherwise the score goes to both fields, so either button reads right.
    let body = { field1: s.field1, field2: s.field2 };
    let follow = null;
    // Only with a one-score pick: that is the layout the name heuristic is
    // built for (the page shows whoever is at the throw, name in large type).
    // With two picks the layout already says who is who. On an unusual page
    // the largest text may be a menu rather than a name; pin P1 or P2 there.
    if (autoMode && s.mode === "single" && picked && picked.length === 1) {
      const name = readPlayerName();
      const f = name ? fieldForName(name.text) : null;
      if (f) {
        body = { field: f, score: s.field1 };
        follow = f;
      }
    }

    const key = JSON.stringify(body);
    const now = Date.now();
    if (key === lastSent && now - lastSentAt < HEARTBEAT_MS) return;

    try {
      await fetch(APP + "/api/score", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      lastSent = key;
      lastSentAt = now;
      if (follow !== null && follow !== lastSyncedField) await setField(follow);
    } catch (e) {
      lastSent = "";           // app not up yet - retry on the next tick
      if (DEBUG && !warned) {
        warned = true;
        console.warn("[Finish IT] push failed (is app.py running?):", e.message);
      }
    }
  }

  // -- Element picker --------------------------------------------------------
  // Started from the popup (pick.js). Hovering outlines the score under the
  // mouse, a click takes it: first player 1's score, then optionally player
  // 2's -- Enter or "Only one score" when the page shows a single number.
  // Esc cancels. The page never sees a click while the picker runs.

  // The smallest element still holding the whole number, so a click on the
  // padding of a score box lands on the span inside it rather than the box.
  function scoreTarget(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return null;
    const v = parseScore(el.textContent);
    if (v === null) return null;
    for (;;) {
      const kid = Array.from(el.children).find(c => parseScore(c.textContent) === v);
      if (!kid) return el;
      el = kid;
    }
  }

  // Turn the clicked element into a selector that should still find it after
  // the page re-renders or the site ships a new build:
  //  - ids, test hooks and aria labels, when they look hand-written,
  //  - class names with their CSS Modules hash cut off (styles_counter__AbC12
  //    -> [class*="styles_counter__"], since the hash moves on every build),
  //  - generated classes (css-1x2y3z, sc-AbCdE, runs of digits) dropped,
  //    because they change with every build,
  //  - :nth-of-type only where nothing better exists.
  // Nothing is taken from the text: that is the one thing certain to change.
  const STABLE_ATTRS = ["data-testid", "data-test", "data-qa", "data-cy", "data-role",
                        "data-name", "aria-label", "name", "itemprop"];
  const GENERATED    = /^(css|sc|jsx|emotion|svelte|astro)-|\d{3,}|:/;
  const HASHED       = /^(.{3,}?_{1,3})([A-Za-z0-9-]{5,10})$/;

  function tokensFor(el) {
    const out = [];
    if (el.id && !GENERATED.test(el.id)) out.push("#" + CSS.escape(el.id));
    for (const a of STABLE_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length <= 40 && !/\d/.test(v)) out.push(`[${a}="${v.replace(/["\\]/g, "\\$&")}"]`);
    }
    for (const c of el.classList) {
      if (GENERATED.test(c)) continue;
      const m = c.match(HASHED);
      const t = m && /[A-Z0-9]/.test(m[2]) ? `[class*="${m[1]}"]` : "." + CSS.escape(c);
      if (!out.includes(t)) out.push(t);
    }
    return out;
  }

  function nthStep(el) {
    const tag = el.tagName.toLowerCase();
    const same = Array.from(el.parentElement ? el.parentElement.children : [el])
                      .filter(c => c.tagName === el.tagName);
    return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag;
  }

  function buildSelector(el) {
    const unique = s => {
      try { const m = document.querySelectorAll(s); return m.length === 1 && m[0] === el; }
      catch (e) { return false; }
    };
    const tag  = el.tagName.toLowerCase();
    const own  = tokensFor(el);
    const self = tag + own.join("");

    // 1. The element on its own.
    for (const t of own) if (unique(t)) return t;
    if (own.length && unique(self)) return self;

    // 2. Narrowed by a stable ancestor.
    for (let cur = el.parentElement, depth = 0; cur && cur !== document.body && depth < 5;
         cur = cur.parentElement, depth++) {
      for (const t of tokensFor(cur)) if (unique(`${t} ${self}`)) return `${t} ${self}`;
    }

    // 3. A structural path, anchored as close as possible.
    let chain = nthStep(el);
    for (let cur = el.parentElement; cur && cur !== document.documentElement; cur = cur.parentElement) {
      if (cur === document.body) return "body > " + chain;
      const t = tokensFor(cur);
      const s = cur.tagName.toLowerCase() + t.join("") + " > " + chain;
      if (t.length && unique(s)) return s;
      chain = nthStep(cur) + " > " + chain;
    }
    return chain;
  }

  let picking = null;

  function toast(text) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647";
    host.attachShadow({ mode: "open" }).innerHTML = `
      <div style="font:600 14px/1.3 system-ui,sans-serif;color:#fff;background:#16a34a;
                  padding:10px 16px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35)">${text}</div>`;
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 3000);
  }

  function startPicker() {
    if (picking) return;

    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .box, .mark {
          position: fixed; pointer-events: none; display: none;
          border: 2px solid #2563eb; background: rgba(37, 99, 235, .15); border-radius: 4px;
        }
        .mark { display: block; border-color: #16a34a; background: rgba(22, 163, 74, .18); }
        .tag {
          position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; white-space: nowrap;
          font: 600 12px system-ui, sans-serif; color: #fff; background: #2563eb;
          padding: 2px 6px; border-radius: 4px;
        }
        .mark .tag { background: #16a34a; }
        .bar {
          position: fixed; left: 50%; top: 14px; transform: translateX(-50%);
          pointer-events: auto; display: flex; gap: 10px; align-items: center;
          font: 14px/1.3 system-ui, sans-serif; color: #e5e7eb; background: #111827;
          padding: 10px 12px 10px 16px; border-radius: 12px; border: 1px solid #374151;
          box-shadow: 0 10px 30px rgba(0, 0, 0, .45); max-width: calc(100vw - 32px);
        }
        .bar b { color: #fff; }
        button {
          font: 600 13px system-ui, sans-serif; cursor: pointer; border-radius: 8px;
          padding: 7px 12px; border: 1px solid #374151; background: #1f2937; color: #e5e7eb;
        }
        button.go { background: #16a34a; border-color: #16a34a; color: #fff; }
        button[hidden] { display: none; }
      </style>
      <div class="box"><span class="tag"></span></div>
      <div class="bar">
        <span class="say"></span>
        <button class="go" data-act="one" hidden>Only one score</button>
        <button data-act="cancel">Cancel</button>
      </div>`;
    document.documentElement.appendChild(host);

    const box  = root.querySelector(".box");
    const tag  = root.querySelector(".tag");
    const say  = root.querySelector(".say");
    const one  = root.querySelector('[data-act="one"]');
    const chosen = [];
    let hover = null;

    const ours = e => e.composedPath().includes(host);

    function place(div, el) {
      const r = el.getBoundingClientRect();
      Object.assign(div.style, {
        left: r.left - 3 + "px", top: r.top - 3 + "px",
        width: r.width + 6 + "px", height: r.height + 6 + "px", display: "block",
      });
    }

    function prompt() {
      say.innerHTML = chosen.length
        ? `Player 1 reads <b>${parseScore(chosen[0].textContent)}</b>. Click player 2's score &mdash; or:`
        : `Click the score Finish IT should read.`;
      one.hidden = !chosen.length;
    }

    function onMove(e) {
      if (ours(e)) return;
      const raw = e.composedPath()[0];
      // Selectors cannot reach into a shadow root, so its numbers are off limits.
      hover = raw && raw.getRootNode && raw.getRootNode() === document ? scoreTarget(raw) : null;
      if (hover && chosen.includes(hover)) hover = null;
      if (!hover) { box.style.display = "none"; return; }
      place(box, hover);
      tag.textContent = `${chosen.length ? "Player 2" : "Score"}: ${parseScore(hover.textContent)}`;
    }

    function block(e) {
      if (ours(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onClick(e) {
      if (ours(e)) return;
      block(e);
      if (!hover) return;
      chosen.push(hover);
      const mark = document.createElement("div");
      mark.className = "mark";
      mark.innerHTML = `<span class="tag">Player 1</span>`;
      root.appendChild(mark);
      place(mark, hover);
      box.style.display = "none";
      hover = null;
      if (chosen.length === 2) finish(); else prompt();
    }

    function onKey(e) {
      if (e.key === "Escape") { block(e); stop(); }
      else if (e.key === "Enter" && chosen.length) { block(e); finish(); }
    }

    const BLOCKED = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu", "auxclick"];
    const on  = () => {
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("click", onClick, true);
      window.addEventListener("keydown", onKey, true);
      BLOCKED.forEach(t => window.addEventListener(t, block, true));
    };
    const off = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      BLOCKED.forEach(t => window.removeEventListener(t, block, true));
    };

    function stop() {
      off();
      host.remove();
      picking = null;
    }

    function finish() {
      const selectors = chosen.map(buildSelector);
      savePicked(selectors);
      stop();
      const values = chosen.map(el => parseScore(el.textContent)).join(" / ");
      toast(`Finish IT reads this ${chosen.length === 2 ? "pair" : "score"}: ${values}`);
      if (DEBUG) console.log("[Finish IT] picked", selectors);
    }

    root.querySelector('[data-act="cancel"]').addEventListener("click", stop);
    one.addEventListener("click", finish);
    on();
    prompt();
    picking = { stop };
  }

  // pick.js, injected right after this file by the popup, calls this.
  globalThis.__finishitPick = startPicker;

  // The popup asks what this tab is reading.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (!msg || msg.cmd !== "status") return;
      const r = lastRead;
      reply({
        host:      HOST,
        source:    picked ? "picked" : null,
        selectors: activeSelectors(),
        read:      r ? { field1: r.field1, field2: r.field2, mode: r.mode } : null,
        lost:      !!lostSince && Date.now() - lostSince > 3000,
      });
    });
  } catch (e) {}

  loadPicked();

  setInterval(tick, POLL_MS);
  setInterval(refreshFinishes, FINISH_MS);
  refreshFinishes();
})();
