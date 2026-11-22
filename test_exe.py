"""Start a built FinishIT.exe on a spare port and check it against the source.

    python test_exe.py [path\\to\\FinishIT.exe]        (default: dist\\FinishIT.exe)

Run it after build_exe.py. The exe is started with FINISHIT_PORT and
FINISHIT_NO_BROWSER, so it neither collides with a copy already running on
port 5000 nor opens a browser tab. It passes when every page answers and the
exe returns the same checkout lists as app.py for every score from 0 to 180 --
the things a build gets wrong when it loses a data file or bundles a library
that behaves differently from the one the source runs on.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

import app

HERE  = os.path.dirname(os.path.abspath(__file__))
EXE   = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "dist", "FinishIT.exe")
PORT  = 5055
BASE  = f"http://127.0.0.1:{PORT}"
PAGES = ["/", "/live", "/finishes", "/training", "/static/icon.svg"]
START_TIMEOUT_S = 90        # a one-file exe unpacks itself before it starts

# Straight to 127.0.0.1, whatever proxy the environment has set.
_open = urllib.request.build_opener(urllib.request.ProxyHandler({})).open


def get(path, timeout=20):
    with _open(BASE + path, timeout=timeout) as r:
        return r.status, r.read()


def stop(proc):
    # The one-file exe is two processes (the unpacker and the app), so take
    # the whole tree down; killing only the parent leaves the port taken.
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.kill()


def main():
    if not os.path.exists(EXE):
        sys.exit(f"{EXE} not found - run build_exe.py first")

    env = dict(os.environ, FINISHIT_PORT=str(PORT), FINISHIT_NO_BROWSER="1")
    proc = subprocess.Popen([EXE], env=env, cwd=os.path.dirname(EXE))
    try:
        deadline = time.time() + START_TIMEOUT_S
        while True:
            if proc.poll() is not None:
                sys.exit(f"the exe exited with code {proc.returncode} before it answered")
            try:
                get("/api/current_field", timeout=3)
                break
            except OSError:
                if time.time() > deadline:
                    sys.exit(f"the exe did not answer on port {PORT} within {START_TIMEOUT_S} s")
                time.sleep(1)

        for page in PAGES:
            status, body = get(page)
            if status != 200 or not body:
                sys.exit(f"{page} answered {status} with {len(body)} bytes")

        wrong = []
        for score in range(0, 181):
            want = {"ok": True, **app._ways_payload(score)}
            got  = json.loads(get(f"/api/ways/{score}")[1])
            if got != want:
                wrong.append(score)
        if wrong:
            sys.exit(f"the exe disagrees with app.py on {len(wrong)} score(s): {wrong[:20]}")

        print(f"OK: {os.path.basename(EXE)} started, {len(PAGES)} pages answered, "
              f"checkout lists identical to app.py for 0..180")
    finally:
        stop(proc)


if __name__ == "__main__":
    main()
