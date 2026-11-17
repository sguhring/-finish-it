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
