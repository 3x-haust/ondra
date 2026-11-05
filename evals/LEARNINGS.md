# What the evals taught us

date · case · cause · fix · before → after

- 2026-11-05 · cu-calculator · agent-desktop refused every command while macOS listed Xcode's Device Hub with pid -1 · patched agent-desktop (scripts/patches) · 52 tools / 13 failed → 19 tools / 0 failed
- 2026-11-05 · cu-* · jobs read help pages and turned on the screen cursor overlay · fast path + no-focus rules in skills/computer-use · ~5 min → 70 s
- 2026-11-05 · dev-android · job lost its emulator after an app restart; emulator window took focus; job left it running · device.ts remembers its device, -no-window, stop before final answer · blocked → done
- 2026-11-05 · web-example, ask-taste · shared browser "바로 닫혔어요": `pkill -f --user-data-dir=…` read the pattern as an option and killed nothing, so a leftover Chrome kept the profile locked · `pkill -f -- <pattern>` in browser.rs · 5 failed browser tools → rerun pending
