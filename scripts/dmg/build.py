#!/usr/bin/env python3
"""Ondra's install dmg.

    pnpm tauri build && pnpm dmg          # release .app → bundle/dmg/Ondra_<version>_aarch64.dmg
    python3 scripts/dmg/build.py <Ondra.app> <out.dmg>
    (needs: pip install ds_store mac_alias; sign the dmg afterwards)

The volume holds only Ondra.app and the Applications link. The window
background lives inside the app (Contents/Resources/dmg-background.tiff,
bundled and signed with it), so nothing else shows even with hidden files on,
and nothing sits outside the window to scroll to. The layout is written
straight into .DS_Store (no Finder scripting), so it is the same everywhere.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time

try:
    from ds_store import DSStore
    from mac_alias import Alias
except ImportError:
    sys.exit("pip install ds_store mac_alias")

VOLUME = "Ondra"
SIZE = (660, 400)
ORIGIN = (200, 160)
ICON = 128
TEXT = 13
APP_AT = (180, 180)
APPS_AT = (480, 180)
BG_IN_APP = ("Contents", "Resources", "dmg-background.tiff")


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def detach(mount):
    for i in range(10):
        if subprocess.run(["hdiutil", "detach", mount], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return
        time.sleep(1 + i)
    run("hdiutil", "detach", "-force", mount)


def main(app, out):
    app = os.path.abspath(app.rstrip("/"))
    name = os.path.basename(app)
    if not os.path.isfile(os.path.join(app, *BG_IN_APP)):
        sys.exit(f"{name} has no {'/'.join(BG_IN_APP)} (bundle resource missing)")

    tmp = tempfile.mkdtemp(prefix="ondra-dmg-")
    try:
        stage = os.path.join(tmp, "stage")
        os.mkdir(stage)
        run("ditto", app, os.path.join(stage, name))
        os.symlink("/Applications", os.path.join(stage, "Applications"))

        rw = os.path.join(tmp, "rw.dmg")
        run("hdiutil", "create", "-srcfolder", stage, "-volname", VOLUME, "-fs", "HFS+", "-format", "UDRW", "-ov", rw)
        mount = os.path.join(tmp, "mnt")
        os.mkdir(mount)
        run("hdiutil", "attach", rw, "-nobrowse", "-noautoopen", "-owners", "off", "-mountpoint", mount)
        try:
            bg = Alias.for_file(os.path.join(mount, name, *BG_IN_APP))
            (x, y), (w, h) = ORIGIN, SIZE
            with DSStore.open(os.path.join(mount, ".DS_Store"), "w+") as d:
                d["."]["vSrn"] = ("long", 1)
                d["."]["bwsp"] = {
                    "WindowBounds": f"{{{{{x}, {y}}}, {{{w}, {h}}}}}",
                    "ContainerShowSidebar": False,
                    "PreviewPaneVisibility": False,
                    "ShowSidebar": False,
                    "ShowToolbar": False,
                    "ShowPathbar": False,
                    "ShowStatusBar": False,
                    "ShowTabView": False,
                }
                d["."]["icvp"] = {
                    "viewOptionsVersion": 1,
                    "backgroundType": 2,
                    "backgroundImageAlias": bg.to_bytes(),
                    "backgroundColorRed": 1.0,
                    "backgroundColorGreen": 1.0,
                    "backgroundColorBlue": 1.0,
                    "iconSize": float(ICON),
                    "textSize": float(TEXT),
                    "labelOnBottom": True,
                    "arrangeBy": "none",
                    "gridSpacing": 100.0,
                    "gridOffsetX": 0.0,
                    "gridOffsetY": 0.0,
                    "showIconPreview": False,
                    "showItemInfo": False,
                    "scrollPositionX": 0.0,
                    "scrollPositionY": 0.0,
                }
                d[name]["Iloc"] = APP_AT
                d["Applications"]["Iloc"] = APPS_AT
            for extra in (".Trashes", ".fseventsd", ".Spotlight-V100"):
                shutil.rmtree(os.path.join(mount, extra), ignore_errors=True)
        finally:
            detach(mount)

        if os.path.exists(out):
            os.remove(out)
        run("hdiutil", "convert", rw, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(out)


def defaults():
    import json

    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    version = json.load(open(os.path.join(root, "src-tauri", "tauri.conf.json")))["version"]
    bundle = os.path.join(root, "src-tauri", "target", "release", "bundle")
    os.makedirs(os.path.join(bundle, "dmg"), exist_ok=True)
    return os.path.join(bundle, "macos", "Ondra.app"), os.path.join(bundle, "dmg", f"Ondra_{version}_aarch64.dmg")


if __name__ == "__main__":
    if len(sys.argv) == 1:
        main(*defaults())
    elif len(sys.argv) == 3:
        main(sys.argv[1], sys.argv[2])
    else:
        sys.exit(__doc__)
