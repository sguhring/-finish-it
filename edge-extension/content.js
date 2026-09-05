// Finish IT bridge
//
// Two jobs on game.scoliadarts.com:
//   1. read both players' scores out of the DOM and push them to the local app
//      (so the app never has to OCR the screen), and
//   2. draw the checkout suggestions back onto the game page, so you never have
//      to look at a second window.
//
// The OCR-A font injection stays as a safety net: if the bridge ever stops
// pushing, app.py falls back to screen OCR after PUSH_TTL_S and the uniform
// font is what makes that fallback accurate.
(function () {
  "use strict";

  // Bump on every change, so the console tells you which build a tab is really
  // running. Reloading the extension does NOT swap the script in tabs that are
  // already open - those keep the old copy alive until the page is reloaded.
  const VERSION       = "v3 (single-layout + AUTO)";

  const APP           = "http://127.0.0.1:5000";
  const POLL_MS       = 250;    // how often we re-read the DOM
  const FINISH_MS     = 600;    // how often we pull the checkout suggestions
  const HEARTBEAT_MS  = 2000;   // resend an unchanged score to keep push mode alive
  const DEBUG         = true;   // logs the elements it picked, once

  // Pin an exact selector here if the heuristic picks the wrong elements.
  // It must match exactly two elements: the left player's score and the right
  // player's score (left becomes field 1, right becomes field 2).
  const SCORE_SELECTOR = "";

  // -- OCR-A font (fallback path) --------------------------------------------
  const style = document.createElement("style");
  style.textContent = `
    @import url('https://fonts.cdnfonts.com/css/ocr-a-extended');

    /* Finish IT (127.0.0.1:5000) */
    .score-display,
    .header-score,
    .finish-row .dart,
    .finish-row .dart-double,
    #liveScore,
    .field-btn .field-num {
      font-family: 'OCR A Extended', 'OCR A Std', monospace !important;
      letter-spacing: 0.05em !important;
    }

    /* Scolia (game.scoliadarts.com) */
    * {
      font-family: 'OCR A Extended', 'OCR A Std', monospace !important;
    }
  `;
  document.head.appendChild(style);

  // The bridge only makes sense on the game page.
  if (!location.hostname.endsWith("scoliadarts.com")) return;

  console.log(`[Finish IT] content script ${VERSION} loaded`);

  // -- Score extraction ------------------------------------------------------

  function describe(el) {
    const r  = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      el,
      value: parseInt(el.textContent.trim(), 10),
      size:  parseFloat(cs.fontSize) || r.height,
      x:     r.left + r.width / 2,
      sel:   el.tagName.toLowerCase() +
             (el.className ? "." + String(el.className).trim().split(/\s+/).join(".") : ""),
    };
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) !== 0;
  }

  // Every visible leaf element whose entire text is a plausible darts score.
  // Our own overlay lives in a shadow root, so it can never match here.
  function candidates() {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (!/^\d{1,3}$/.test(t)) continue;
      if (parseInt(t, 10) > 501) continue;
      if (!isVisible(el)) continue;
      out.push(describe(el));
    }
    return out;
  }

  // Scolia shows one player at a time (hence its SWITCH PLAYER link), so the
  // remaining score is normally a single number drawn far larger than anything
  // else on the page - the turn history down the left is less than half its
  // size. When one number dominates like that we treat it as *the* score and
  // push it to both fields, so the app is right whichever field is selected.
  //
  // A genuinely side-by-side layout (two numbers of comparable size) still maps
  // leftmost -> field 1, rightmost -> field 2. Anything else is too ambiguous
  // to guess from, so we push nothing and let OCR take over.
  const DOMINANT_RATIO = 1.35;

  function readScores() {
    const list = (SCORE_SELECTOR
      ? Array.from(document.querySelectorAll(SCORE_SELECTOR))
             .filter(el => /^\d{1,3}$/.test((el.textContent || "").trim()) && isVisible(el))
             .map(describe)
      : candidates()
    ).sort((a, b) => b.size - a.size);

    if (!list.length) return null;

    const [top, second] = list;
    if (!second || top.size >= DOMINANT_RATIO * second.size) {
      return { field1: top.value, field2: top.value, picked: [top], mode: "single" };
    }

    const pair = [top, second].sort((a, b) => a.x - b.x);
    return { field1: pair[0].value, field2: pair[1].value, picked: pair, mode: "two-up" };
  }

  // -- Who is at the throw ---------------------------------------------------
  // In AUTO mode we stop caring which field button is pressed and follow the
  // player the page is currently showing. Scolia does not label the players
  // "1" and "2" anywhere we can read, so we identify them by name and hand out
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
  // Shadow DOM so nothing on the Scolia page can restyle it, and so the score
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

    return { root, q };
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
    try {
      render(await fetch(APP + "/api/outshot").then(r => r.json()));
    } catch (e) { /* app down - keep the last frame on screen */ }
  }

  // -- Push loop -------------------------------------------------------------

  let lastSent = "";
  let lastSentAt = 0;
  let logged = false;
  let warned = false;

  async function tick() {
    const s = readScores();
    if (!s) {
      if (DEBUG && !warned) {
        warned = true;
        console.warn("[Finish IT] no score element found - falling back to OCR. Candidates:",
                     candidates().map(c => [c.value, c.sel, c.size]));
      }
      return;
    }
    warned = false;

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
    if (autoMode && s.mode === "single") {
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

  setInterval(tick, POLL_MS);
  setInterval(refreshFinishes, FINISH_MS);
  refreshFinishes();
})();
