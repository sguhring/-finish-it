// Two jobs. The second is at the bottom: asking the app for the overlay.
//
// Keeps content.js registered on every site the user has granted from the
// popup's "Select score element". The app itself is declared in the manifest;
// every game site comes from here.
//
// Registrations survive a browser restart on their own, but resyncing from
// the granted origins on every permission change (and on install/update)
// means the two can never drift apart.

const DECLARED = [
  "http://127.0.0.1:5000/*",
  "http://localhost:5000/*",
];
const ID = "picked-sites";

async function sync() {
  const { origins = [] } = await chrome.permissions.getAll();
  const extra = origins.filter(o => !DECLARED.includes(o));
  const have  = await chrome.scripting.getRegisteredContentScripts({ ids: [ID] });
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: [ID] });
  if (extra.length) {
    await chrome.scripting.registerContentScripts([{
      id: ID, matches: extra, js: ["content.js"], runAt: "document_end",
    }]);
  }
}

chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.permissions.onAdded.addListener(sync);
chrome.permissions.onRemoved.addListener(sync);

// -- The app, on behalf of the overlay ----------------------------------------
// content.js runs inside the scoring page, and the browser treats a content
// script's fetch as the page's own: the page's CORS rules apply to it, whatever
// host_permissions say. This worker is an extension context, where
// host_permissions for 127.0.0.1:5000 do count, so the overlay's two calls are
// made here and content.js asks for them with chrome.runtime.sendMessage.
//
// The point of doing it here rather than sending CORS headers from the app:
// with those headers on /api/outshot and /api/set_field, any site the user
// visits could read the score and switch the field. This way the app never
// has to send them.
//
// Exactly these two calls, not a general proxy: a message names a command,
// never a path.

const APP = "http://127.0.0.1:5000";
const APP_TIMEOUT_MS = 5000;    // a hung app must not pile up open channels

async function appJson(path, init) {
  const r = await fetch(APP + path, { ...init, signal: AbortSignal.timeout(APP_TIMEOUT_MS) });
  return { ok: r.ok, data: await r.json() };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;

  // -> what /api/outshot returned, or null when the app cannot be reached.
  if (msg.cmd === "outshot") {
    appJson("/api/outshot").then(r => reply(r.data), () => reply(null));
    return true;                // the reply comes later; keep the channel open
  }

  // -> true once the app has switched to the field.
  if (msg.cmd === "set_field") {
    if (msg.field !== 1 && msg.field !== 2) { reply(false); return; }
    appJson("/api/set_field", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ field: msg.field }),
    }).then(r => reply(r.ok), () => reply(false));
    return true;
  }
});
