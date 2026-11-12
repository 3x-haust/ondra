#!/usr/bin/env python3
"""Write guides/INDEX.md: one line per guide (file, title, first sentence).

    python3 index.py        # run from anywhere, after copying in newer guides
"""
import os, re

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "guides")
lines = []
for d in sorted(os.listdir(root)):
    p = os.path.join(root, d)
    if not os.path.isdir(p):
        continue
    lines.append(f"\n## {d}\n")
    for f in sorted(os.listdir(p)):
        if not f.endswith(".md"):
            continue
        txt = open(os.path.join(p, f), encoding="utf-8").read().splitlines()
        title = next((l[2:].strip() for l in txt if l.startswith("# ")), f[:-3])
        desc, seen = "", False
        for l in txt:
            if l.startswith("# "):
                seen = True
                continue
            if seen and l.strip() and not l.startswith(("#", "```", "|", "<", "-", ">")):
                desc = l.strip()
                break
        desc = re.split(r"(?<=[.!?])\s", desc)[0][:140]
        lines.append(f"- `{d}/{f}` {title}: {desc}")
with open(os.path.join(root, "INDEX.md"), "w", encoding="utf-8") as out:
    out.write("# Guide index\n\nOne line per guide: its file, title and first sentence. Written by `index.py`.\n" + "\n".join(lines) + "\n")
