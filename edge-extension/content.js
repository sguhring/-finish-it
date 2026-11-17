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
  const VERSION       = "v6 (picker only, no built-in site)";

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

  const POS_KEY     = "finishit.pos";
  const COL_KEY     = "finishit.collapsed";
  const SIZE_KEY    = "finishit.width";
  const PLAYERS_KEY = "finishit.players";   // name -> field
  const AUTO_KEY    = "finishit.auto";
  const BASE_W   = 250;    // width the raw px sizes below were designed at
  const MIN_W    = 200;
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

  function paintFields() {
    if (!ui) return;
    ui.root.querySelectorAll(".fields button").forEach(b => {
      const isAuto = b.dataset.f === "auto";
      b.classList.toggle("on",  isAuto ? autoMode : Number(b.dataset.f) === currentField);
      b.classList.toggle("dim", !isAuto && autoMode);
    });
  }

  const maxW      = () => Math.max(MIN_W, window.innerWidth - 40);
  const clampW    = w => Math.max(MIN_W, Math.min(maxW(), Math.round(w)));
  const defaultW  = () => clampW(window.innerWidth / 3);

  function buildOverlay() {
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.zIndex   = "2147483647";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }
        .panel {
          position: relative;
          font-family: 'OCR A Extended', Consolas, monospace;
          width: 100%;
          background: rgba(10, 12, 16, 0.93);
          border: 1px solid #1f2937;
          border-radius: calc(10px * var(--s));
          color: #e5e7eb;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
          overflow: hidden;
          user-select: none;
        }
        .head {
          display: flex; align-items: center; gap: calc(8px * var(--s));
          padding: calc(7px * var(--s)) calc(10px * var(--s));
          background: #111827;
          cursor: grab;
          border-bottom: 1px solid #1f2937;
        }
        .head:active { cursor: grabbing; }
        .dot {
          width: calc(8px * var(--s)); height: calc(8px * var(--s));
          border-radius: 50%; background: #6b7280; flex: none;
        }
        .dot.push { background: #22c55e; }
        .dot.ocr  { background: #f59e0b; }
        .title {
          font-size: calc(10px * var(--s)); letter-spacing: .12em;
          text-transform: uppercase; color: #9ca3af; flex: 1;
          white-space: nowrap; overflow: hidden;
        }
        .fields { display: flex; gap: calc(3px * var(--s)); }
        .fields button {
          font: inherit; font-size: calc(10px * var(--s));
          padding: calc(2px * var(--s)) calc(7px * var(--s));
          border-radius: calc(4px * var(--s)); cursor: pointer;
          background: #1f2937; color: #9ca3af; border: 1px solid #374151;
        }
        .fields button.on { background: #2563eb; color: #fff; border-color: #2563eb; }
        .fields button[data-f="auto"].on { background: #16a34a; border-color: #16a34a; }
        .fields button.dim { opacity: .45; }
        .fold {
          font-size: calc(13px * var(--s)); color: #6b7280;
          cursor: pointer; padding: 0 calc(2px * var(--s));
        }
        .body { padding: calc(10px * var(--s)); }
        .panel.collapsed .body { display: none; }
        .panel.collapsed .grip { display: none; }
        .score {
          font-size: calc(40px * var(--s)); font-weight: 700; line-height: 1;
          text-align: center; margin-bottom: calc(8px * var(--s));
        }
        .score.easy { color: #22c55e; }
        .score.mid  { color: #f59e0b; }
        .score.big  { color: #a855f7; }
        .score.dead { color: #ef4444; }
        .msg {
          font-size: calc(11px * var(--s)); color: #9ca3af;
          text-align: center; padding: calc(2px * var(--s)) 0 calc(4px * var(--s));
        }
        .way { display: flex; gap: calc(5px * var(--s)); margin-top: calc(5px * var(--s)); }
        .way.best .d { border-color: #22c55e; color: #d1fae5; }
        .d {
          flex: 1; text-align: center;
          padding: calc(6px * var(--s)) 0;
          font-size: calc(14px * var(--s)); font-weight: 700;
          background: #0f172a; border: 1px solid #1f2937;
          border-radius: calc(5px * var(--s));
        }
        .d.dbl { background: #14532d33; }
        .grip {
          position: absolute; right: 0; bottom: 0;
          width: calc(16px * var(--s)); height: calc(16px * var(--s));
          cursor: nwse-resize;
          background: linear-gradient(135deg, transparent 50%, #374151 50%, #374151 60%,
                      transparent 60%, transparent 72%, #374151 72%, #374151 82%, transparent 82%);
        }
      </style>
      <div class="panel">
        <div class="head">
          <span class="dot"></span>
          <span class="title">Finish IT</span>
          <span class="fields">
            <button data-f="auto" title="follow whoever is at the throw (double-click to forget players)">AUTO</button
            ><button data-f="1">P1</button><button data-f="2">P2</button>
          </span>
          <span class="fold">&ndash;</span>
        </div>
        <div class="body">
          <div class="score">&mdash;</div>
          <div class="msg"></div>
          <div class="ways"></div>
        </div>
        <div class="grip" title="drag to resize / double-click to reset"></div>
      </div>`;
    document.documentElement.appendChild(host);

    const q = sel => root.querySelector(sel);
    const panel = q(".panel");
    const head  = q(".head");
    const grip  = q(".grip");

    // One knob drives the whole panel: width -> scale factor.
    let width = clampW(store.get(SIZE_KEY, defaultW()));
    function applyWidth(w) {
      width = clampW(w);
      host.style.width = width + "px";
      host.style.setProperty("--s", (width / BASE_W).toFixed(3));
    }
    applyWidth(width);

    // Restore where the user last put it; default to the top-right corner.
    const pos = store.get(POS_KEY, null);
    const startX = pos ? pos.x : Math.max(0, window.innerWidth - width - 24);
    const startY = pos ? pos.y : 24;
    host.style.left = startX + "px";
    host.style.top  = startY + "px";
    if (store.get(COL_KEY, false)) panel.classList.add("collapsed");

    q(".fold").addEventListener("click", () => {
      panel.classList.toggle("collapsed");
      store.set(COL_KEY, panel.classList.contains("collapsed"));
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
          if (DEBUG) console.log("[Finish IT] player mapping cleared");
        });
      }
    });

    // Drag the header to move.
    let drag = null;
    head.addEventListener("pointerdown", e => {
      if (e.target.tagName === "BUTTON" || e.target.classList.contains("fold")) return;
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener("pointermove", e => {
      if (!drag) return;
      const x = Math.max(0, Math.min(window.innerWidth  - 60, e.clientX - drag.dx));
      const y = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - drag.dy));
      host.style.left = x + "px";
      host.style.top  = y + "px";
      store.set(POS_KEY, { x, y });
    });
    head.addEventListener("pointerup", () => { drag = null; });

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
    grip.addEventListener("pointerup", () => { sizing = null; });
    grip.addEventListener("dblclick", () => {
      applyWidth(defaultW());
      store.set(SIZE_KEY, width);
    });

    // Keep it on screen and sensibly sized when the window changes.
    window.addEventListener("resize", () => {
      applyWidth(width);
      const r = host.getBoundingClientRect();
      const x = Math.max(0, Math.min(window.innerWidth  - 60, r.left));
      const y = Math.max(0, Math.min(window.innerHeight - 30, r.top));
      host.style.left = x + "px";
      host.style.top  = y + "px";
    });

    return { host, root, q };
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

  let lastRender = "";

  function render(d) {
    if (!ui) ui = buildOverlay();
    const sig = JSON.stringify([d.score, d.source, d.field, d.message, d.suggested_ways]);
    if (sig === lastRender) return;   // nothing changed - leave the DOM alone
    lastRender = sig;

    ui.q(".dot").className   = "dot " + (d.source || "");
    ui.q(".score").className = "score " + band(d.score);
    ui.q(".score").textContent = (d.score === null || d.score === undefined) ? "—" : d.score;
    ui.q(".msg").textContent = d.message || (d.ok ? "" : "no score");
    currentField = d.field;
    paintFields();

    const ways = (d.suggested_ways || []).slice(0, 3);
    ui.q(".ways").innerHTML = ways.map((w, i) =>
      `<div class="way${i === 0 ? " best" : ""}">` +
      w.map(dart => {
        const t = String(dart);
        const isDouble = /^D/.test(t) || t === "Bull";
        return `<span class="d${isDouble ? " dbl" : ""}">${t === "NA" ? "·" : t}</span>`;
      }).join("") +
      `</div>`
    ).join("");
  }

  async function refreshFinishes() {
    // Nothing picked on this site (or the pick was just reset): no panel.
    if (!configured()) {
      if (ui) { ui.host.remove(); ui = null; lastRender = ""; }
      return;
    }
    try {
      render(await fetch(APP + "/api/outshot").then(r => r.json()));
    } catch (e) { /* app down - keep the last frame on screen */ }
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
