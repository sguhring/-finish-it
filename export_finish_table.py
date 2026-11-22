"""Write the checkout table as one JSON file, for an app that has no server.

    python export_finish_table.py [out.json]

The phone app cannot ask app.py for a finish, so it ships the answers: one
entry per score from 2 to 170, each exactly what GET /api/ways/<score>
returns. That is the data templates/index.html renders from, so a port of the
calculator can follow that page line by line:

    best finish   suggested[0], or alternatives[0] when suggested is empty (170)
    alternatives  the rest of suggested, then alternatives
    all ways      all_ways, shown on demand
    no checkout   possible is false (the scores in no_checkout); 0, 1 and
                  anything above 170 are not in the table and have none either

A dart is a treble "T20", a double "D16", a single "S5", "Bull" (50, which
finishes like a double) or "SBull" (25). "NA" means no dart is thrown in that
slot and is left out when a route is drawn.

Without an argument the file goes to flutter_application_1/assets/, which is
local only and gitignored, so the generated table never lands in this repo.
The output is deterministic: run it again after changing the checkout maths or
_SUGGESTED_ROWS, and a diff of the file shows what moved.
"""

import json
import os
import sys

import app

HERE    = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(HERE, "flutter_application_1", "assets", "finish_table.json")

MIN_SCORE, MAX_SCORE = 2, 170


def build() -> dict:
    return {
        "format":      1,
        "min_score":   MIN_SCORE,
        "max_score":   MAX_SCORE,
        "no_checkout": sorted(app.NO_CHECKOUT_SCORES),
        "scores":      {str(v): app._ways_payload(v) for v in range(MIN_SCORE, MAX_SCORE + 1)},
    }


def main():
    out = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    os.makedirs(os.path.dirname(out), exist_ok=True)
    table = build()
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(table, f, separators=(",", ":"))
        f.write("\n")
    finishable = sum(1 for s in table["scores"].values() if s["possible"])
    print(f"Wrote {out}: {len(table['scores'])} scores, {finishable} with a checkout, "
          f"{os.path.getsize(out) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
