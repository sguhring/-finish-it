r"""Faehrt Ruhezustand und Score-Farbverlauf aus app.py am echten Strip ab.

Aufruf:  venv\Scripts\python.exe test_led.py

Liegt neben app.py, importiert also direkt daraus -- app.run() startet dabei
nicht, weil der Flask-Start hinter __main__ haengt. Die OCR- und WLED-Threads
starten ebenfalls nicht, dieses Skript spricht den ESP selbst an.
"""
import time

import app

SCORES = [None,
          501, 171,
          170, 140, 120, 100, 86, 70, 50, 40, 24, 12, 2,
          1,
          None]

print(f"WLED unter {app.WLED_HOST}\n")
print("  Score   Anzeige")
print("  " + "-" * 44)

for V in SCORES:
    state = app.score_state(V)
    seg = state["seg"][0]
    if V is None:
        note = f"Ruhezustand — Effekt {seg['fx']}, Palette {seg['pal']}"
        hold = 5.0
    else:
        r, g, b = seg["col"][0]
        kind = "kein Checkout" if (r, g, b) == app.LED_NO_FINISH else "Verlauf"
        note = f"RGB {r:>3},{g:>3},{b:>3}   {kind}"
        hold = 0.9
    try:
        app._wled_send(state)
        status = ""
    except Exception as e:
        status = f"   FEHLER: {e}"
    print(f"  {str(V):>5}   {note}{status}")
    time.sleep(hold)

print("\nFertig — bleibt im Ruhezustand.")
