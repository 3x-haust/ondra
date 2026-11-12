#!/usr/bin/env bash
# Contact sheet of a video: frames at <fps> per second, tiled with their timestamps.
# usage: sheet.sh <video> <out.jpg> [fps=2] [start=0] [duration=all] [columns=6]
#   2 fps for an overview of a whole film; 10 fps over 2–4 s to study one move frame by frame.
set -euo pipefail
in=${1:?video}; out=${2:?out.jpg}; fps=${3:-2}; ss=${4:-0}; dur=${5:-}; cols=${6:-6}
len=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")
span=${dur:-$(echo "$len - $ss" | bc -l)}
n=$(echo "($span * $fps + 0.999) / 1" | bc)
rows=$(( (n + cols - 1) / cols ))
tile="tile=${cols}x${rows}:padding=4:margin=4"
label="drawtext=text='%{pts\:hms}':x=6:y=6:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4"
# ffmpeg builds without freetype have no drawtext: fall back to an unlabelled sheet (read left→right, 1/fps s apart)
if ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' drawtext '; then vf="fps=$fps,scale=360:-2,$label,$tile"; note="timestamps from $ss s"
else vf="fps=$fps,scale=360:-2,$tile"; note="no labels: frame k is at $ss + k/$fps s"; fi
ffmpeg -v error -y -ss "$ss" ${dur:+-t "$dur"} -i "$in" -vf "$vf" -frames:v 1 -q:v 3 "$out"
echo "$out ($n frames, ${cols}x${rows}; $note)"
