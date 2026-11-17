"""Build FinishIT.exe -- the Flask app as one double-clickable file.

    venv\\Scripts\\python.exe build_exe.py        ->  dist\\FinishIT.exe

Needs PyInstaller in the venv (pip install pyinstaller). The exe bundles the
page templates, static assets and the OCR reference images; it does not bundle
Tesseract (optional, see app.py) or the Edge extension, which is installed in
the browser separately.

Double-clicking the exe starts the server on 127.0.0.1:5000, opens /live in the
browser, and keeps a console window open -- closing it stops the app.

Machine-specific settings (an optional light, the Tesseract path) live in a
finishit.json next to the exe. If there is one next to app.py, the build copies
it into dist\\, so this machine's copy keeps its settings; hand out only
FinishIT.exe and other people's copies start with none.
"""

import os
import shutil

from PIL import Image
import PyInstaller.__main__

HERE  = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
DIST  = os.path.join(HERE, "dist")
NAME  = "FinishIT"

# What a script run would find next to app.py; the exe finds it in _MEIPASS.
DATA = ["templates", "static", "templates_capture"]

# This machine's settings, if any (gitignored; see app.py).
LOCAL_SETTINGS = os.path.join(HERE, "finishit.json")


def make_icon() -> str:
    os.makedirs(BUILD, exist_ok=True)
    ico = os.path.join(BUILD, "finishit.ico")
    Image.open(os.path.join(HERE, "static", "icon-512.png")).save(
        ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return ico


def main():
    args = [
        os.path.join(HERE, "app.py"),
        "--name", NAME,
        "--onefile",
        "--console",
        "--noconfirm",
        "--clean",
        "--icon", make_icon(),
        "--distpath", DIST,
        "--workpath", BUILD,
        "--specpath", BUILD,
        # app.py never imports these, but they sit in the venv for the CNN
        # scripts; keep them out in case a hook drags them in.
        "--exclude-module", "torch",
        "--exclude-module", "torchvision",
        "--exclude-module", "matplotlib",
        "--exclude-module", "tkinter",
    ]
    for d in DATA:
        args += ["--add-data", f"{os.path.join(HERE, d)}{os.pathsep}{d}"]
    PyInstaller.__main__.run(args)

    settings = os.path.join(DIST, "finishit.json")
    if os.path.exists(LOCAL_SETTINGS) and not os.path.exists(settings):
        shutil.copyfile(LOCAL_SETTINGS, settings)
    print(f"\nBuilt {os.path.join(DIST, NAME + '.exe')}")


if __name__ == "__main__":
    main()
