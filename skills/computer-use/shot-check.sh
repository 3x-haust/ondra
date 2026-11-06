#!/bin/bash
# Is a window picture real, or Stage Manager's side-strip thumbnail?
#   shot-check.sh                 → "stage-manager on" / "stage-manager off"
#   shot-check.sh <png> <App>     → "ok WxH" or "thumbnail: WxH picture of a WxH window"
# Exit 0 when the picture is usable, 3 when it is a thumbnail, 2 on bad input.
set -euo pipefail

stage=$(defaults read com.apple.WindowManager GloballyEnabled 2>/dev/null || echo 0)
if [[ $# -eq 0 ]]; then
  [[ $stage == 1 ]] && echo "stage-manager on" || echo "stage-manager off"
  exit 0
fi
[[ $# -eq 2 && -f $1 ]] || { echo "usage: shot-check.sh [<png> <App>]" >&2; exit 2; }
png=$1 app=$2

read -r pw ph < <(sips -g pixelWidth -g pixelHeight "$png" 2>/dev/null | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w, h}')
[[ -n ${pw:-} && -n ${ph:-} ]] || { echo "not a picture: $png" >&2; exit 2; }

# the app's largest window by accessibility (its real size, not the strip's) and the display scale
read -r ww wh scale < <(
  { agent-desktop list-windows --app "$app"; echo; agent-desktop list-displays; } 2>/dev/null | python3 -c '
import json, sys
docs = [json.loads(l) for l in sys.stdin.read().splitlines() if l.strip().startswith("{")]
wins = [w for w in (docs[0].get("data") or []) if w.get("accessible")] if docs else []
disp = (docs[1].get("data") or [{}])[0] if len(docs) > 1 else {}
w = max(wins, key=lambda w: w["bounds"]["width"] * w["bounds"]["height"], default=None)
b = w["bounds"] if w else {"width": 0, "height": 0}
print(int(b["width"]), int(b["height"]), disp.get("scale", 2.0))'
)

if [[ ${ww:-0} -eq 0 ]]; then
  # no window to compare with: only Stage Manager's state says anything
  [[ $stage == 1 ]] && echo "unknown: no window of $app found, stage manager is on" || echo "ok ${pw}x${ph}"
  exit 0
fi

# picture in points vs the window; a strip thumbnail is a fraction of the size and off in shape
verdict=$(python3 -c '
import sys
pw, ph, ww, wh, s = map(float, sys.argv[1:])
w, h = pw / s, ph / s
small = w < ww * 0.6 or h < wh * 0.6
skew = abs((w / h) - (ww / wh)) / (ww / wh) > 0.15
print("thumbnail" if small or skew else "ok")' "$pw" "$ph" "$ww" "$wh" "$scale")

if [[ $verdict == ok ]]; then
  echo "ok ${pw}x${ph}"
else
  echo "thumbnail: ${pw}x${ph} picture of a ${ww}x${wh} window (stage manager $([[ $stage == 1 ]] && echo on || echo off))"
  exit 3
fi
