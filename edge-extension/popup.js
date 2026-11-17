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

function renderWays(ways) {
  $("ways").innerHTML = (ways || []).slice(0, 3).map((w, i) =>
    `<div class="way${i === 0 ? " best" : ""}">` +
    w.map(dart => {
      const t = String(dart);
      const isDouble = /^D/.test(t) || t === "Bull";
      return `<span class="d${isDouble ? " dbl" : ""}">${t === "NA" ? "·" : t}</span>`;
    }).join("") +
    `</div>`
  ).join("");
}

function clearFinish() {
  $("score").textContent = "—";
  $("score").className = "score";
  $("msg").textContent = "";
  $("ways").innerHTML = "";
}

async function refresh() {
  try {
    const d = await fetch(APP + "/api/outshot").then(r => r.json());

    set("app", "running");
    set("field", d.field === undefined ? "—" : String(d.field));

    if (d.source === "push") {
      set("src", "extension", "");
      $("hint").textContent = "Scores are coming from the page. No OCR in use.";
    } else if (d.source === "ocr") {
      set("src", "screen ocr", "warn");
      $("hint").textContent =
        "No push arriving. Open the game tab and check its console for [Finish IT] messages.";
    } else {
      set("src", "none", "warn");
      $("hint").textContent = "No score read yet.";
    }

    $("score").textContent = (d.score === null || d.score === undefined) ? "—" : d.score;
    $("score").className = "score " + band(d.score);
    $("msg").textContent = d.message || (d.ok ? "" : "no score");
    renderWays(d.suggested_ways);

  } catch (e) {
    set("app", "not reachable", "bad");
    set("src", "—", "bad");
    set("field", "—");
    clearFinish();
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
  if (!web)  { siteState("not a web page", "warn"); return; }
  if (isApp) { siteState("this is the app", ""); return; }

  let st = null;
  try { st = await chrome.tabs.sendMessage(tab.id, { cmd: "status" }); } catch (e) {}

  $("forget").hidden = !(st && st.source === "picked");
  $("selectors").textContent = st && st.selectors ? st.selectors.join("   |   ") : "";

  if (!st || !st.source) {
    siteState("not set up", "warn");
  } else if (st.lost) {
    siteState("lost - select it again", "bad");
  } else if (st.read) {
    const r = st.read;
    const v = r.mode === "two-up" ? `${r.field1} / ${r.field2}` : String(r.field1);
    siteState(`picked · reads ${v}`);
  } else {
    siteState("picked");
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
