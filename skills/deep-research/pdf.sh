#!/bin/sh
# Print an HTML report to PDF with the bundled headless Chrome.
#   pdf.sh <report.html> [out.pdf]   → prints the PDF path
set -e
[ -f "$1" ] || { echo "usage: pdf.sh <report.html> [out.pdf]" >&2; exit 2; }
in="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
out="${2:-${in%.*}.pdf}"
chrome="${ONDRA_BROWSER_EXECUTABLE_PATH:-}"
[ -x "$chrome" ] || chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$chrome" ] || { echo "no Chrome found (ONDRA_BROWSER_EXECUTABLE_PATH is empty)" >&2; exit 1; }
url="file://$(printf '%s' "$in" | sed -e 's/%/%25/g' -e 's/ /%20/g' -e 's/#/%23/g')"
rm -f "$out"
"$chrome" --headless --disable-gpu --no-pdf-header-footer --virtual-time-budget=3000 --print-to-pdf="$out" "$url" >/dev/null 2>&1 || true
[ -s "$out" ] || { echo "PDF was not written: $out" >&2; exit 1; }
echo "$out"
