// Live status + checkout suggestions for the bridge. The popup page runs with
// the extension's own origin, so host_permissions covers these fetches.
const APP = "http://127.0.0.1:5000";

const $ = id => document.getElementById(id);

const set = (id, text, cls) => {
  const el = $(id);
  el.textContent = text;
  el.className = "v" + (cls ? " " + cls : "");
};

// Same colour bands the page overlay uses.
const NO_CHECKOUT = [159, 162, 163, 165, 166, 168, 169];
function band(v) {
  if (v === null || v === undefined) return "";
  if (v === 1 || v > 170 || NO_CHECKOUT.includes(v)) return "dead";
  if (v >= 100) return "big";
  if (v >= 41)  return "mid";
  return "easy";
}

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// The same readout the overlay draws: the best way as three tiles, the rest
// as quiet rows under it. Only the dart that ends a route is green -- a
// double or the Bull earlier in it is a set-up shot.
function wayHtml(way, cls) {
  const darts = way.map(String);
  let last = -1;
  darts.forEach((t, i) => { if (t !== "NA") last = i; });
  return `<div class="way ${cls}">` +
    darts.map((t, i) => {
      const isDouble = /^D/.test(t) || t === "Bull";
      const c = "d" + (isDouble ? " dbl" : "") + (isDouble && i === last ? " fin" : "") +
                (t === "NA" ? " na" : "");
      return `<span class="${c}">${t === "NA" ? "·" : esc(t)}</span>`;
    }).join("") +
    `</div>`;
}

// Source chip: text as well as colour, the same four states as the overlay.
const SOURCE_CHIP = { live: "LIVE", ocr: "OCR", idle: "IDLE", offline: "OFFLINE" };
function setChip(state) {
  $("src").dataset.state = state;
  $("srcText").textContent = SOURCE_CHIP[state];
}

function renderFinish(d) {
  const none  = d.score === null || d.score === undefined;
  const state = none ? "wait" : band(d.score);
  const ways  = (d.suggested_ways || []).slice(0, 3);

  $("score").textContent = none ? "—" : d.score;
  $("score").className = "score " + state;
  $("msg").className = "msg" + (none ? " wait" : state === "dead" ? " dead" : "");
  $("msg").textContent = ways.length ? ""
                       : none ? "Waiting for board"
                       : state === "dead" ? "No finish"
                       : (d.message || "");
  $("ways").innerHTML = ways.map((w, i) => wayHtml(w, i === 0 ? "best" : "alt")).join("");
}

async function refresh() {
  try {
    const d = await fetch(APP + "/api/outshot").then(r => r.json());

    set("app", "Running");
    set("field", d.field === undefined ? "—" : "P" + d.field);
    $("readout").classList.remove("offline");

    if (d.source === "push") {
      setChip("live");
      $("hint").textContent = "Scores are coming from the page. No OCR in use.";
    } else if (d.source === "ocr") {
      setChip("ocr");
      $("hint").textContent =
        "No push arriving. Open the game tab and check its console for [Finish IT] messages.";
    } else {
      setChip("idle");
      $("hint").textContent = "No score read yet.";
    }

    renderFinish(d);

  } catch (e) {
    // Same as the overlay: whatever was last read stays, visibly stale.
    set("app", "Not reachable", "bad");
    set("field", "—");
    setChip("offline");
    $("readout").classList.add("offline");
    $("hint").textContent = "Start it with:  python app.py";
  }
}

refresh();
setInterval(refresh, 700);

// -- This site: which element the bridge reads --------------------------------
// "Select score element" injects the picker into the current tab (activeTab
// allows that without asking) and asks for permission to run on this host from
// now on -- granting it is what brings the bridge back on the next visit, and
// background.js registers the script for it. Declining still lets the picker
// run this once.

const SITES_KEY = "finishit.sites";
let tab = null;
let tabUrl = null;

function siteState(text, cls) { set("pickState", text, cls); }

async function refreshSite() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { tabUrl = new URL(tab.url); } catch (e) { tabUrl = null; }

  const web = tabUrl && /^https?:$/.test(tabUrl.protocol);
  const isApp = web && tabUrl.port === "5000" && /^(127\.0\.0\.1|localhost)$/.test(tabUrl.hostname);
  set("site", web ? tabUrl.hostname : "—");
  $("pick").disabled = !web || isApp;
  if (!web)  { siteState("Not a web page", "warn"); return; }
  if (isApp) { siteState("This is the app", ""); return; }

  let st = null;
  try { st = await chrome.tabs.sendMessage(tab.id, { cmd: "status" }); } catch (e) {}

  $("forget").hidden = !(st && st.source === "picked");
  $("selectors").textContent = st && st.selectors ? st.selectors.join("   |   ") : "";

  if (!st || !st.source) {
    siteState("Not set up", "warn");
  } else if (st.lost) {
    siteState("Lost - select it again", "bad");
  } else if (st.read) {
    const r = st.read;
    const v = r.mode === "two-up" ? `${r.field1} / ${r.field2}` : String(r.field1);
    siteState(`Picked · reads ${v}`);
  } else {
    siteState("Picked");
  }
}

$("pick").addEventListener("click", () => {
  const pattern = `${tabUrl.protocol}//${tabUrl.hostname}/*`;
  // Both calls go out inside the click, before anything is awaited: the
  // permission request needs the user gesture, and the injection must already
  // be on its way if the prompt closes this popup.
  const granted  = chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  const injected = chrome.scripting.executeScript({
    target: { tabId: tab.id }, files: ["content.js", "pick.js"],
  });
  Promise.all([granted, injected]).then(
    () => window.close(),
    err => { $("hint").textContent = "Could not start the picker: " + err.message; });
});

$("forget").addEventListener("click", async () => {
  const host = tabUrl.hostname;
  const r = await chrome.storage.sync.get(SITES_KEY);
  const sites = r[SITES_KEY] || {};
  delete sites[host];
  await chrome.storage.sync.set({ [SITES_KEY]: sites });
  await chrome.permissions.remove({ origins: [`${tabUrl.protocol}//${host}/*`] }).catch(() => {});
  refreshSite();
});

refreshSite();
setInterval(refreshSite, 1000);
