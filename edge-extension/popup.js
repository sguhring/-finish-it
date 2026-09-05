// Live status + checkout suggestions for the bridge. The popup page runs with
// the extension's own origin, so host_permissions covers these fetches.
const APP = "http://127.0.0.1:5000";

const $ = id => document.getElementById(id);

const set = (id, text, cls) => {
  const el = $(id);
  el.textContent = text;
  el.className = "v" + (cls ? " " + cls : "");
};

// Same colour bands the WLED ring and the page overlay use.
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
        "No push arriving. Open the Scolia game tab and check its console for [Finish IT] messages.";
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
