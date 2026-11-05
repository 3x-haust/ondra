#!/bin/sh
# Throw a thought into Ondra from a terminal, a hook or a Shortcut.
#   scripts/throw.sh "폰 백업 고쳐 줘"
#   scripts/throw.sh --home "블로그 초안 써 줘"
space=""
case "$1" in --work) space=work; shift;; --home) space=home; shift;; esac
[ -n "$*" ] || { echo "usage: throw.sh [--work|--home] \"thought\"" >&2; exit 1; }
dir="$HOME/Library/Application Support/dev.3xhaust.ondra/inbox"
mkdir -p "$dir"
tmp="$dir/.$$.tmp"
{ [ -n "$space" ] && echo "space: $space"; printf '%s\n' "$*"; } > "$tmp"
mv "$tmp" "$dir/$(date +%s)-$$.txt"
