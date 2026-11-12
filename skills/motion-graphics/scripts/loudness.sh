#!/usr/bin/env bash
# Loudness of each section of a sound track (or a video's audio), so the quiet build-up and the drop can be compared.
# usage: loudness.sh <audio-or-video> <t0,t1,t2,...>     e.g. loudness.sh film.wav 0,5.3,16.5,25.8,39.2
# Prints integrated loudness (LUFS) and peak per section. Keep neighbouring sections within ~8–10 LU.
set -euo pipefail
in=${1:?file}; IFS=, read -ra T <<< "${2:?section boundaries in seconds}"
for ((i = 0; i < ${#T[@]} - 1; i++)); do
  a=${T[$i]}; b=${T[$((i + 1))]}
  r=$(ffmpeg -v info -ss "$a" -to "$b" -i "$in" -vn -af ebur128=peak=true -f null - 2>&1 | awk '/Integrated loudness/{f=1} f&&/I:/{i=$2} f&&/Peak:/{p=$2} END{print i, p}')
  printf "%7.2f–%-7.2f  I %6s LUFS   peak %6s dBFS\n" "$a" "$b" ${r}
done
