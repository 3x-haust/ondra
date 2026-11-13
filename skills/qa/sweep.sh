#!/usr/bin/env bash
# Open pages one after another in your ondra-browser tab and print one line per
# page: load time, page errors, console errors, failed requests (4xx/5xx) and
# the screen's first heading (BLANK when it shows almost nothing, hscroll when
# it scrolls sideways).
#
#   sweep.sh <base-url> /path /other/path ...
#   sweep.sh <base-url> < paths.txt          # one path per line, # comments ok
#   sweep.sh <base-url> 'board=js:document.querySelector("[data-nav=board]").click()'
#
# A step `[label=]js:<expression>` runs that expression in the current page
# instead of opening a path: for screens without their own URL (a nav click, a
# tab). The base URL is opened once before the first such step.
#
# Uses the tab and settings you already have (viewport, dark mode, login): set
# those first with `ondra-browser set ...`. QA_SLOW_MS (default 3000) marks a
# slow load; QA_IGNORE is a regex of request URLs to leave out (noise you have
# already explained, e.g. a missing favicon). Exit status 1 if any page failed.
set -uo pipefail

base=${1:?usage: sweep.sh <base-url> [path ...]}
shift
slow=${QA_SLOW_MS:-3000}
ignore=${QA_IGNORE:-'^$'}
command -v jq >/dev/null || { echo "sweep.sh needs jq" >&2; exit 2; }

ab() { ondra-browser "$@" 2>/dev/null; }
paths=("$@")
if [ ${#paths[@]} -eq 0 ]; then
  while IFS= read -r p; do [[ -z "$p" || "$p" == \#* ]] || paths+=("$p"); done
fi

failed=0
opened=
for p in "${paths[@]}"; do
  label=$p
  if [[ "$p" =~ ^([^=:]*)=(js:.*)$ ]]; then label=${BASH_REMATCH[1]}; p=${BASH_REMATCH[2]}; fi
  if [[ "$p" == js:* && -z "$opened" ]]; then ab open "$base" >/dev/null && ab wait --load networkidle >/dev/null; fi
  ab errors --clear >/dev/null; ab console --clear >/dev/null; ab network requests --clear >/dev/null
  if [[ "$p" == js:* ]]; then
    if ! ab eval "${p#js:}" >/dev/null; then printf 'FAIL %s  script failed\n' "$label"; failed=1; continue; fi
    ab wait --load networkidle >/dev/null || true
    ms=
  else
    url="${base%/}/${p#/}"
    if ! ab open "$url" >/dev/null; then printf 'FAIL %s  did not open\n' "$label"; failed=1; continue; fi
    ab wait --load networkidle >/dev/null || true
    ms=$(ab eval "Math.round(performance.getEntriesByType('navigation')[0]?.duration||0)" | tr -dc '0-9')
  fi
  opened=1
  # what the screen shows: its first heading (to see you are where you meant), BLANK
  # if almost no text, hscroll if the page scrolls sideways
  seen=$(ab eval "(() => { const t = document.body?.innerText.trim() || ''; const h = document.querySelector('h1,h2,[role=heading]')?.textContent.trim() || document.title; const x = document.documentElement.scrollWidth > innerWidth + 1 ? ' hscroll' : ''; return t.length < 20 ? 'BLANK' : h.replace(/\\s+/g, ' ').slice(0, 30) + x; })()" | tr -d '"')
  js=$(ab --json errors | jq '.data.errors | length' 2>/dev/null || echo "?")
  con=$(ab --json console | jq '[.data.messages[]? | select(.type == "error")] | length' 2>/dev/null || echo "?")
  http=$(ab --json network requests --status 400-599 | jq -r --arg ig "$ignore" '
    [.data.requests[]? | select(.url | test($ig) | not) | "\(.status) \(.url | sub("^[a-z]+://[^/]+"; "") | .[0:60])"]
    | (length | tostring) + (if length > 0 then " (" + (unique | .[0:3] | join(", ")) + ")" else "" end)' 2>/dev/null || echo "?")
  status=ok
  [[ "$js" != 0 || "$con" != 0 || "${http%% *}" != 0 || "$seen" == BLANK ]] && status=FAIL && failed=1
  [[ "$status" == ok && "$ms" =~ ^[0-9]+$ && $ms -gt $slow ]] && status=SLOW
  step=$label; [ ${#step} -gt 60 ] && step="${step:0:57}..."
  printf '%-4s %s  %s  js:%s console:%s http:%s  [%s]\n' "$status" "$step" "${ms:+${ms}ms}" "$js" "$con" "$http" "$seen"
done
exit $failed
