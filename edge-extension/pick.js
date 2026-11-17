// Injected by the popup right after content.js, in the same call, so the
// picker starts even if the popup has already closed by the time the
// injection lands (the permission prompt can close it).
if (globalThis.__finishitPick) globalThis.__finishitPick();
