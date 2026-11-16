#!/bin/zsh
# Runs optimize.py in its venv (made on first use under /Users/lyu/Work/cache/gepa-venv).
set -e
VENV=${GEPA_VENV:-/Users/lyu/Work/cache/gepa-venv}
[ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install -q "gepa==0.1.4"; }
cd "${0:A:h}/../.."
exec "$VENV/bin/python" evals/gepa/optimize.py "$@"
