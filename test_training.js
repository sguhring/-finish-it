/*
 * Drives the real training-page logic under node: `node test_training.js`
 *
 * The three drills are the one part of this app with no OCR and no board in
 * the loop, so they can be tested properly -- and they need it, because a
 * miscounted throw is invisible until a whole session is already ruined.
 *
 * The script under test is pulled straight out of templates/training.html
 * rather than duplicated here, so it cannot drift from what the page runs.
 * Everything the page needs from the browser is faked below: just enough DOM
 * for the code to render into, and no more.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/* ---------------------------------------------------------------- DOM shim */

// The value each segmented control reports as selected. Tests move these to
// pick a shorter session than the page's defaults.
const SEG_DEFAULT = {
  "#m301-block": "301",
  "#mlegs-count": "10",
  "#mlegs-startscore": "101",
  "#mrand-rounds": "20",
  "#mrand-dist": "practice",
};
const SEG = Object.assign({}, SEG_DEFAULT);

class ClassList {
  constructor() { this.s = new Set(); }
  add(c) { this.s.add(c); }
  remove(c) { this.s.delete(c); }
  contains(c) { return this.s.has(c); }
  toggle(c, on) {
    if (on === undefined) on = !this.s.has(c);
    on ? this.s.add(c) : this.s.delete(c);
  }
}

class El {
  constructor(tag, sel) {
    this.tagName = (tag || "div").toUpperCase();
    this.sel = sel || null;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList();
    this._text = "";
    this._html = "";
    this.hidden = false;
    this.disabled = false;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  set className(v) {
    this.classList = new ClassList();
    String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
  }
  get className() { return Array.from(this.classList.s).join(" "); }
  appendChild(c) { this.children.push(c); return c; }
  insertBefore(c) { this.children.unshift(c); return c; }
  get firstChild() { return this.children[0] || null; }
  setAttribute() {}
  getAttribute() { return null; }
  addEventListener() {}
  closest() { return null; }
  matches() { return false; }
  querySelector(q) {
    // The only real query the page makes on a container is segment()'s
    // "which button is active" -- answer it from the table above.
    if (q === "button.active") {
      const b = new El("button");
      b.dataset.v = SEG[this.sel];
      return b;
    }
    return new El("div");
  }
  querySelectorAll() { return []; }
}

const nodes = {};
globalThis.document = {
  querySelector: sel => nodes[sel] || (nodes[sel] = new El("div", sel)),
  querySelectorAll: () => [],
  createElement: t => new El(t),
  createElementNS: (ns, t) => new El(t),
  addEventListener: () => {},
};
globalThis.window = globalThis;
globalThis.localStorage = {
  _d: {},
  getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
};
globalThis.setInterval = () => 0;
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.fetch = async () => ({
  json: async () => ({
    ok: true, sessions: [], seq: 0, events: [],
    score: null, field: 1, source: "none", updated_ts: 0,
  }),
});

/* ----------------------------------------------------- load the real script */

const page = fs.readFileSync(path.join(__dirname, "templates", "training.html"), "utf8");
const src = page.split("<script>")[1].split("</script>")[0];
const expose = "\n;globalThis.__api = { feed, m301, mlegs, mrand, drawNumber, drawSequence, " +
               "NUMBER_WEIGHTS, PRO_ATTEMPTS, SEQ_LEN, feedChange, feedFlush };";
(0, eval)(src.replace(/^\s*"use strict";/, "") + expose);
const A = globalThis.__api;

/* -------------------------------------------------------------- assertions */

let fails = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? "  ok   " : "  FAIL ") + label +
              "  got=" + JSON.stringify(got) + (ok ? "" : "  want=" + JSON.stringify(want)));
}
function section(t) { console.log("\n--- " + t + " ---"); }

// Build a change event the way poll() hands one to feedChange().
let clock = 1000, seq = 0;
function ev(points, after, gapS) {
  clock += (gapS === undefined ? 12 : gapS);
  return { id: ++seq, ts: clock, field: 1, kind: "throw",
           before: after + points, after, points };
}
function freshBoard(source) {
  A.feed.perVisit = false;
  A.feed.lastChangeTs = 0;
  A.feed.source = source || "push";
  globalThis.localStorage._d = {};
}

/* ------------------------------------------------------- a block of darts */

// Throw a whole block and read the average back off it.
function throwBlock(points) {
  A.m301.start();
  let rem = 9999;
  for (const p of points) { rem -= p; A.feedChange(ev(p, rem)); A.feedFlush(); }
}

section("a 100-dart block ends on the visit that reaches it");
SEG["#m301-block"] = "100";
throwBlock(Array(40).fill(60));               // 34 visits would be 102 darts
eq("visits thrown", A.m301.visits.length, 34);
eq("darts, counted three to a visit", A.m301.darts(), 102);
eq("ends past the block, not before it", A.m301.running, false);
eq("scored", A.m301.scored(), 34 * 60);
eq("average is points per visit", A.m301.visits.length && Math.round(A.m301.scored() / A.m301.visits.length), 60);

section("a block ends exactly when the darts divide evenly");
SEG["#m301-block"] = "99";
throwBlock(Array(40).fill(45));
eq("33 visits is exactly 99 darts", A.m301.visits.length, 33);
eq("darts", A.m301.darts(), 99);
eq("ended", A.m301.running, false);

section("a scoreless visit still costs three darts");
SEG["#m301-block"] = "301";
throwBlock([60, 60]);
A.m301.add(0);
eq("three visits", A.m301.visits.length, 3);
eq("nine darts", A.m301.darts(), 9);
eq("scored", A.m301.scored(), 120);
eq("average dragged down by the blank visit", Math.round(A.m301.scored() / A.m301.visits.length), 40);

section("undo drops the last throw");
A.m301.undo();
eq("visits after undo", A.m301.visits.length, 2);
eq("scored after undo", A.m301.scored(), 120);
eq("darts after undo", A.m301.darts(), 6);
A.m301.finish(true);
SEG["#m301-block"] = SEG_DEFAULT["#m301-block"];

/* --------------------------------------------------------- visit grouping */

section("a board that reports each dart: three darts group into one throw");
freshBoard();
A.m301.start();
let rem = 9999;
for (const p of [20, 20, 20]) { rem -= p; A.feedChange(ev(p, rem, 1.5)); }
eq("one throw, not three", A.m301.visits.length, 1);
eq("throw total", A.m301.visits[0] && A.m301.visits[0].points, 60);
eq("three darts, not nine", A.m301.darts(), 3);
A.m301.finish(true);

section("a board that reports whole visits: a change over 60 settles it");
freshBoard();
A.m301.start();
rem = 9999;
for (const p of [100, 45, 26]) { rem -= p; A.feedChange(ev(p, rem)); }
eq("detected as per-visit", A.feed.perVisit, true);
eq("three throws", A.m301.visits.length, 3);
// The point of the flag: no waiting for the quiet spell to be sure.
eq("each throw counted the moment it landed", A.feed.pending, null);
eq("remembered for next time", globalThis.localStorage.getItem("finishit.training.pervisit"), "1");
A.m301.finish(true);

/* The bug this whole section exists for: on the OCR feed a screen pass costs a
   second or three and a score is only accepted after two passes agree, so the
   three darts of one visit surface four to six seconds apart -- over the fast
   threshold. Every dart then closed its own visit and the 301 block reported
   the per-dart average where the 3-dart average belongs. */
section("the slow OCR feed: darts five seconds apart are still one visit");
freshBoard("ocr");
SEG["#m301-block"] = "9";
A.m301.start();
rem = 9999;
for (const p of [60, 20, 5]) { rem -= p; A.feedChange(ev(p, rem, 5.0)); }
eq("one visit, not three", A.m301.visits.length, 1);
eq("visit total", A.m301.visits[0] && A.m301.visits[0].points, 85);
eq("three darts, not nine", A.m301.darts(), 3);
for (const p of [20, 20, 20]) { rem -= p; A.feedChange(ev(p, rem, 5.0)); }
eq("the walk to the board still separates visits", A.m301.visits.length, 2);
eq("3-dart average, not the per-dart one", Math.round(A.m301.scored() / A.m301.visits.length), 73);
A.m301.finish(true);
SEG["#m301-block"] = SEG_DEFAULT["#m301-block"];

section("a latch learned on the wrong board undoes itself");
freshBoard("ocr");
A.feed.perVisit = true;              // as if remembered from an earlier session
globalThis.localStorage.setItem("finishit.training.pervisit", "1");
A.m301.start();
rem = 9999;
A.feedChange(ev(60, rem -= 60));     // flushed on its own, the flag says so
eq("still latched after the first change", A.feed.perVisit, true);
A.feedChange(ev(20, rem -= 20, 5.0));
eq("a second change too soon proves it wrong", A.feed.perVisit, false);
eq("forgotten for next time", globalThis.localStorage.getItem("finishit.training.pervisit"), "0");
A.feedChange(ev(20, rem -= 20, 5.0));
eq("and the rest of the visit groups", A.m301.visits.length, 1);
A.feedFlush();
eq("two visits: the split one, then the regrouped rest", A.m301.visits.length, 2);
A.m301.finish(true);

/* --------------------------------------------------------------- 10 x 101 */

section("101 legs: legs, busts, and tagging the winning visit");
freshBoard();
A.feed.perVisit = true;
SEG["#mlegs-count"] = "2";
A.mlegs.start();

A.feedChange(ev(60, 41));
A.feedChange(ev(41, 0));
eq("leg 1 closed by the board reading 0", A.mlegs.legs.length, 1);
eq("leg 1 darts, winner assumed to be 3", A.mlegs.legs[0].darts, 6);
A.mlegs.tag(2);
eq("leg 1 darts after tagging 2", A.mlegs.legs[0].darts, 5);
eq("waiting for the board to come back up", A.mlegs.awaitingReset, true);

A.mlegs.onReset({ kind: "reset", before: 0, after: 101 });
eq("armed for leg 2", A.mlegs.awaitingReset, false);

A.feedChange(ev(60, 41));
A.mlegs.onReset({ kind: "reset", before: 41, after: 101 });   // Scolia reverts a bust
eq("bust counted, not treated as a new leg", A.mlegs.busts, 1);
eq("still on leg 2", A.mlegs.legs.length, 1);
A.feedChange(ev(101, 0));
eq("leg 2 closed", A.mlegs.legs.length, 2);
eq("leg 2 throws (60, bust, 101)", A.mlegs.legs[1].throws, 3);
eq("last leg waits to be tagged", A.mlegs.awaitingFinish, true);
eq("still running until you finish", A.mlegs.running, true);
A.mlegs.finish();
eq("finished", A.mlegs.running, false);
SEG["#mlegs-count"] = SEG_DEFAULT["#mlegs-count"];

/* -------------------------------------------------------------- random 20 */

section("random 20: a three-number sequence a round");
freshBoard();
A.feed.perVisit = true;      // a board that reports the visit, so each change lands at once
SEG["#mrand-rounds"] = "3";
A.mrand.start();
const seqs = [];
// Round 1: all three in.
seqs.push(A.mrand.targets); A.feedChange(ev(60, 9939));
A.mrand.tag(0); A.mrand.tag(1); A.mrand.tag(2);
// Round 2: only the middle one.
seqs.push(A.mrand.targets); A.feedChange(ev(20, 9919)); A.mrand.tag(1);
// Round 3: thrown, never tagged.
seqs.push(A.mrand.targets); A.feedChange(ev(5, 9914));

eq("three rounds", A.mrand.rounds.length, 3);
eq("ended after the planned rounds", A.mrand.running, false);
eq("three targets a round", A.mrand.rounds.map(r => r.targets.length), [3, 3, 3]);
eq("no number twice in one round",
   A.mrand.rounds.every(r => new Set(r.targets).size === 3), true);
eq("each round kept its sequence", A.mrand.rounds.map(r => r.targets), seqs);
eq("hit rate over the two tagged rounds", A.mrand.stats().hitRate, 66.7);
eq("average points", A.mrand.stats().avgPoints, 28.3);
eq("untagged round left untagged", A.mrand.rounds[2].hits, null);

section("random 20: tagging is per dart, not a count");
eq("round 1: all three in", A.mrand.rounds[0].hits, [true, true, true]);
eq("round 2: the middle one only", A.mrand.rounds[1].hits, [false, true, false]);

// Tagging always lands on the round just thrown -- here the third, left
// untagged above. Four hits of nine darts once it is tagged.
A.mrand.tag(1);
eq("the last round takes its tag after the fact", A.mrand.rounds[2].hits, [false, true, false]);
eq("all three rounds tagged", A.mrand.stats().tagged, 3);
eq("hit rate over nine darts", A.mrand.stats().hitRate, 55.6);

A.mrand.tag(1);
eq("the same dart again takes it back", A.mrand.rounds[2].hits, [false, false, false]);
eq("a round with nothing in is still a tagged round", A.mrand.stats().tagged, 3);
eq("and it counts against you", A.mrand.stats().hitRate, 44.4);

A.mrand.tag(0); A.mrand.tag(2);
eq("first and last in", A.mrand.rounds[2].hits, [true, false, true]);
A.mrand.tagNone();
eq("none wipes the round in one press", A.mrand.rounds[2].hits, [false, false, false]);
eq("hit rate back to four of nine", A.mrand.stats().hitRate, 44.4);
SEG["#mrand-rounds"] = SEG_DEFAULT["#mrand-rounds"];

section("a sequence never repeats a number");
for (let i = 0; i < 3000; i++) {
  const q = A.drawSequence("pro");        // the most lopsided weights there are
  if (q.length !== A.SEQ_LEN || new Set(q).size !== A.SEQ_LEN) {
    eq("distinct on draw " + i, q, "three distinct numbers");
    break;
  }
}
eq("3000 pro draws, all three distinct", true, true);

section("practice draw matches the weights derived from the pro counts");
const N = 60000;
const tally = {};
for (let i = 0; i < N; i++) { const n = A.drawNumber("practice"); tally[n] = (tally[n] || 0) + 1; }
const total = Object.keys(A.NUMBER_WEIGHTS).reduce((a, k) => a + A.NUMBER_WEIGHTS[k], 0);
let drift = 0;
for (const n of Object.keys(A.NUMBER_WEIGHTS)) {
  drift = Math.max(drift, Math.abs(tally[n] / N - A.NUMBER_WEIGHTS[n] / total));
}
eq("all twenty numbers come up", Object.keys(tally).length, 20);
eq("20 is the most common", Object.keys(tally).every(n => tally[n] <= tally[20]), true);
eq("empirical shares within 1 point of the table", drift < 0.01, true);
console.log("       20 -> " + (tally[20] / N * 100).toFixed(1) + "%" +
            "   19 -> " + (tally[19] / N * 100).toFixed(1) + "%" +
            "    1 -> " + (tally[1] / N * 100).toFixed(1) + "%");

section("even draw is flat");
const flatTally = {};
for (let i = 0; i < 40000; i++) { const n = A.drawNumber(true); flatTally[n] = (flatTally[n] || 0) + 1; }
eq("all twenty within a point of 5%",
   Object.values(flatTally).every(c => Math.abs(c / 40000 - 0.05) < 0.008), true);

console.log(fails ? "\n" + fails + " FAILURE(S)\n" : "\nall assertions passed\n");
process.exit(fails ? 1 : 0);
