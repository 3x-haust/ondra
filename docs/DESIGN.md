# Ondra design

How Ondra looks, moves and talks. The values live in `src/styles/tokens.css`; this page is the reason behind them.
They were drawn from Linear, T3 Code, Cursor, Codex, Claude and gitsu, then fitted to Ondra.

## 1. Principles

1. **The work is the loudest thing on screen.** Navigation, tabs and headers step back once you have arrived. Linear's wording: "Don't compete for attention you haven't earned," and the 2026 refresh made the sidebar "a few notches dimmer".
2. **Structure is felt, not seen.** Use hairlines at 5–8% alpha, few separators, and spacing to group things. Remove a divider wherever spacing already does its job.
3. **One accent. Color means state.** There is one brand color, used for the main action, selection, focus and "working". Every other hue marks a state (needs you, failed, done, diff). No gradients, glows or tinted chrome.
4. **Dense but calm.** Rows are 32px, controls 28–32px, icons 14–16px, on a 4px grid. Things stay quiet through low contrast in the chrome, not through extra air.
5. **No helper text.** A label, a value, a control. If a setting needs a paragraph to explain it, rename it or rethink it. Put details in a tooltip or not at all.
6. **A still screen.** Motion only for state changes the person caused or must notice: folds, panels, popovers, new items. Nothing loops (see §11).
7. **Plain, soft Korean.** Short "~요" sentences, verbs on buttons, no internal terms (§12).
8. **No logo, no "AI look".** No Ondra mark in the UI, no sparkles, no glowing or animated accents, no gradient-for-show.
9. **GitHub is the record.** Anything from GitHub (issues, PRs, labels, checks) shows GitHub's own data and words, the way gitsu keeps GitHub as the system of record.

---

## 2. Color

> The color values live in `src/styles/tokens.css` and stay as they are: the blue accent (#1f6fd8 light, #4d9cf0 dark), sky for working, amber for needs-reply, emerald for done, and the near-black dark surfaces. The tables below describe roles; where a hex below differs from tokens.css, tokens.css wins. Never add a new hue.

### 2.1 What the references use

| Role | Linear light / dark | T3 Code light / dark | gitsu light / dark | Codex light / dark | Claude light / dark | Cursor light / dark |
|---|---|---|---|---|---|---|
| Page | `#ffffff` / `#08090a` | zinc-25 `oklch(99.2% 0 0)` ≈ `#fcfcfc` / `#000` | `#ffffff` / `#09090b` | `#ffffff` / `#212121` (surface) | `#ffffff` / `#2c2c2a` (bg-000) | `#f7f7f4` / `#14120b` |
| Panel / sidebar | `#f9f8f9` / `#0f1011` (bg-panel) | zinc-50 `#fafafa` / card | `#fafafa` / `#18181b` | — | `#f8f8f6` / `#1f1f1e` (bg-100) | `#f2f1ed` / `#1b1913` (card) |
| Raised / tertiary | `#f4f2f4` / `#232326` | white / `#191a1d` (accent) | `#f4f4f5` / `#27272a` | `#f3f3f3` / `#414141` | `#f4f4f1` / `#171716` | `#ebeae5` / `#201e18` |
| Border | `#e9e8ea` / `#23252a`; translucent `#0000000d`, `#00000014` / `#ffffff0d`, `#ffffff14` | zinc-200 `#e4e4e7` / `rgb(255 255 255 / 8%)` | `#e4e4e7` / `#ffffff1a` | `#0000000d` light, `#00000026` heavy / `#ffffff0d`, `#fff3` | — | fg at 10% / 20% |
| Text 1 | `#282a30` / `#f7f8f8` | zinc-900 `#18181b` / `#f1f3f7` | `#09090b` / `#fafafa` | `#0d0d0d` / `#dfdfdf` | `#121212` / `#f8f8f6` | `#26251e` / `#edecec` |
| Text 2 | `#3c4149` / `#d0d6e0` | — | — / `#d4d4d9` (feature text) | `#5d5d5d` / `#aaa`, `#cdcdcd` | `#373734` / `#c3c2b7` | fg 60% |
| Text 3 | `#6f6e77` / `#8a8f98` | zinc-500 `#71717a` / `#a3a3a3` | `#71717b` / `#9f9fa9` | `#8f8f8f` / `#afafaf` | `#7b7974` / `#97958c` | fg 40% |
| Text 4 | `#86848d` / `#62666d` | — | `#a1a1aa` (faint) / `#71717b` | — | — | — |
| Accent | `#7170ff` (accent), brand `#5e6ad2` | `oklch(0.488 0.217 264)` / `oklch(0.571 0.21 264)` | `#5059ff`, hover `#4a52ee`, pressed `#434be0`; dark text `#6d75ff` | info `#3a83f7` / `#63a8f8`; primary button is ink `#0d0d0d` / `#f9f9f9` | clay `#d97757`, blue-450 for links | `#f54e00` |

What they share: neutral (zinc or warm gray) surfaces, a single cool accent (Cursor and Claude use warm ones), 8–10% alpha borders in dark mode, and text tiers made from opacity or gray steps. Linear's 2026 refresh moved its default themes "from a cool, blue-ish palette toward a warmer gray". The person asked for the UI to look like gitsu, so Ondra takes gitsu's zinc family and its indigo, with Linear's translucent hover and border steps.

### 2.2 Ondra tokens: light

| Token | Value | Use | Source |
|---|---|---|---|
| `--canvas` | `#f4f4f5` | Window frame behind the cards, and the sidebar | zinc-100 = gitsu `--muted` |
| `--bg` | `#fcfcfc` | Main and panel cards (the page) | T3 zinc-25 (Ondra keeps "no pure white page") |
| `--card` | `#ffffff` | Composer, popovers, dialogs, toasts | gitsu `--card` |
| `--bubble` | `#f4f4f5` | User message | gitsu `--secondary` |
| `--muted` | `#fafafa` | Chip and track fills | gitsu `--sidebar` |
| `--hover` | `rgba(9, 9, 11, 0.05)` | Hover on any transparent control | Codex ghost hover `#0000000d` |
| `--active` | `rgba(9, 9, 11, 0.08)` | Pressed, open menu row | Linear `--color-border-translucent-strong #00000014` |
| `--row-selected` | `#ffffff` | Current sidebar row | T3 `--sidebar-row-selected` |
| `--row-selected-shadow` | `inset 0 0 0 1px rgba(9, 9, 11, 0.06)` | Edge of the selected row | Ondra |
| `--line` | `#e4e4e7` | Borders | |
| `--line-soft` | `#f0f0f1` | Separators inside groups | Linear `--color-line-tertiary #f0f0f0` |
| `--input` | `#d4d4d8` | Input borders | T3 zinc-300 |
| `--code-bg` | `#f4f4f5` | Inline code, code blocks | muted |
| `--ink` | `#18181b` | Primary text | T3 zinc-900 |
| `--ink-2` | `#3f3f46` | Secondary text | zinc-700, Ondra |
| `--ink-3` | `#71717a` | Meta, labels, icons |; gitsu `#71717b` |
| `--ink-4` | `#a1a1aa` | Placeholder and disabled only, never text people must read | gitsu `--color-faint` |
| `--accent` | `#5059ff` | Main action fill, selection, working | gitsu `--brand` |
| `--accent-hover` | `#4a52ee` | | gitsu `--brand-hover` |
| `--accent-press` (new) | `#434be0` | | gitsu `--brand-pressed` |
| `--accent-text` (new) | `#5059ff` | Accent used as text or icon | gitsu `--brand-text` |
| `--accent-soft` | `rgba(80, 89, 255, 0.08)` | Selected chip, soft fills | gitsu `--brand-tint #5059ff14` |
| `--accent-line` | `rgba(80, 89, 255, 0.32)` | Accent borders | Ondra (same alpha as today) |
| `--accent-ink` | `#ffffff` | Text on accent | |
| `--focus` | `rgba(80, 89, 255, 0.40)` | Focus ring | gitsu `--ring: var(--brand)` |
| `--ok` | `#16a34a` | Checks passed, PR open | gitsu `--success` |
| `--ok-ink` | `#15803d` | Text on ok-soft | Tailwind green-700, inferred from gitsu's green family |
| `--warn` | `#d97706` | Needs you | gitsu `--warning #d97708` |
| `--warn-ink` | `#b45309` | | unchanged |
| `--bad` | `#dc2626` | Failed | unchanged; gitsu's `#e40014` is the sRGB fallback of the same red-600 |
| `--bad-ink` | `#b91c1c` | | unchanged |
| `--ok-soft` / `--warn-soft` / `--bad-soft` | tone at 8% | Pill and banner fills | T3 badge `bg-success/8` |
| `--diff-add` / `--diff-del` | `rgba(16,185,129,0.10)` / `rgba(239,68,68,0.08)` | Diff lines | unchanged; Cursor uses 8% / 6% |

### 2.3 Ondra tokens: dark

| Token | Value | Source |
|---|---|---|
| `--canvas` | `#09090b` | gitsu `--background` (zinc-950) |
| `--bg` | `#151517` | gitsu's card frames `bg-[#151517]` |
| `--card` | `#1c1c1f` | Linear `--color-bg-secondary` |
| `--bubble` | `#232326` | Linear `--color-bg-tertiary` |
| `--muted` | `rgba(255, 255, 255, 0.03)` | T3 `--muted` |
| `--hover` | `rgba(255, 255, 255, 0.05)` | Linear `--color-bg-translucent #ffffff0d` |
| `--active` | `rgba(255, 255, 255, 0.08)` | Linear `#ffffff14` |
| `--row-selected` | `rgba(255, 255, 255, 0.07)` | T3 `--sidebar-row-selected` (7%) |
| `--row-selected-shadow` | `none` | |
| `--line` | `rgba(255, 255, 255, 0.08)` |, Linear `#ffffff14` |
| `--line-soft` | `rgba(255, 255, 255, 0.05)` | Linear `#ffffff0d` |
| `--input` | `rgba(255, 255, 255, 0.15)` | gitsu `--input #ffffff26` |
| `--code-bg` | `#111113` | unchanged (sits just below `--bg`) |
| `--ink` | `#f4f4f5` | zinc-100; gitsu's `#fafafa` toned down to keep "no pure white text" |
| `--ink-2` | `#d4d4d9` | gitsu `--color-feature-text` |
| `--ink-3` | `#9f9fa9` | gitsu `--color-dark-fg-muted` |
| `--ink-4` | `#71717b` | gitsu `--color-dark-fg-subtle` |
| `--accent` | `#5059ff` | Fills stay the same in both themes, as in gitsu |
| `--accent-hover` | `#5e66ff` | Ondra (one step lighter, because hover lightens on dark) |
| `--accent-press` | `#4a52ee` | |
| `--accent-text` | `#6d75ff` | gitsu dark `--brand-text` |
| `--accent-soft` | `rgba(80, 89, 255, 0.14)` | gitsu dark `--brand-tint #5059ff24` |
| `--accent-line` | `rgba(109, 117, 255, 0.40)` | Ondra |
| `--accent-ink` | `#ffffff` | gitsu `--primary-foreground` |
| `--focus` | `rgba(109, 117, 255, 0.50)` | gitsu `--ring: var(--brand-text)` |
| `--ok` / `--ok-ink` | `#26c55f` / `#26c55f` | gitsu dark `--success` |
| `--warn` / `--warn-ink` | `#f99c00` / `#fbbf24` | gitsu dark `--warning`; ink unchanged |
| `--bad` / `--bad-ink` | `#ff6568` / `#ff6568` | gitsu dark `--destructive` |
| `--ok-soft` / `--warn-soft` / `--bad-soft` | tone at 16% | T3 badge `dark:bg-success/16` |
| `--scrim` | `rgba(0, 0, 0, 0.6)` | unchanged |

### 2.4 State colors (one meaning each)

| State (Korean label) | Glyph color | Notes |
|---|---|---|
| 진행 중 (working) | `--accent-text` | `--live` becomes the accent. A separate sky blue next to the indigo would be one hue too many. |
| 답 필요 (needs you) | `--warn` | `--ask` points at `--warn`. Indigo now belongs to the accent. |
| 대기 (queued) | `--ink-4` | |
| 멈춤 (paused) | `--ink-3` | |
| 실패 (failed) | `--bad` | |
| 끝남 (done) | `--accent-text` check on `--accent-soft` | Matches today's DESIGN.md (green stays for diffs and passing checks) |
| GitHub: PR open / merged / closed | `--ok` / `#8250df` (GitHub's merged purple, used only on the PR glyph) / `--ink-3` | GitHub's own convention, per principle 9 |

---

## 3. Typography

### 3.1 What the references use

- Linear: Inter Variable with `"cv01","ss03"`; text-regular 15px/1.6/-0.011em, small 14px/1.5/-0.013em, mini 13px/1.5/-0.01em, micro 12px/1.4, tiny 10px; weights 400/510/590/680. Inter Display is used for headings.
- T3 Code: `-apple-system, BlinkMacSystemFont, "Inter Variable"`; UI at Tailwind `text-sm` (14px), plus `2xs` 11px and `3xs` 10px for metadata.
- Codex: UI defaults to 13px (`var(--font-ui-size, 13px)`) and code to 12px (`var(--font-code-size, 12px)`), on a 12/14/16/18 scale.
- gitsu: system sans for the UI, Geist Variable for display; `text-sm` 14px is its most common class.
- Cursor: CursorGothic; mono is Berkeley Mono or cursorMono.

### 3.2 Ondra scale

Latin apps sit at 13–14px. Hangul fills more of the em box, so Pretendard reads larger at the same size. Ondra already tuned its scale (commit `fb062ea`: 14.5px left Pretendard's glyphs below the middle of the line in WebKit, and 15.5px fixed it). **Keep the sizes.** The density comes from row heights and spacing, not from smaller text. Line heights move to whole pixels on a 2px rhythm.

Family: `"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", system-ui, sans-serif` (unchanged). Mono: `ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace` (unchanged).

| Token | Size | Line height | Weight | Tracking | Use |
|---|---|---|---|---|---|
| `--fs-2xs` | 12.5px | 16px | 500 | 0 | Counters, kbd, badges |
| `--fs-xs` | 13.5px | 18px | 400 / 500 | -0.003em | Meta, timestamps, section labels, tooltips |
| `--fs-sm` | 14.5px | 20px | 400 / 500 | -0.006em | Chips, tabs, menu items, tool rows |
| `--fs-md` | 15.5px | 22px | 400 / 500 | -0.006em | UI default: sidebar rows, buttons, inputs, list rows |
| `--fs-lg` | 16.5px | 26px | 400 | -0.008em | Reading: messages, answers, PR bodies (Linear's reading line height is 1.6) |
| `--fs-xl` | 22px | 28px | 600 | -0.02em | Page titles (settings, empty main) |
| `--fs-2xl` | 30px | 36px | 600 | -0.03em | The one hero line, rarely |
| `--fs-code` | 14px | 20px | 400 | 0 | Code, paths, diffs |

Rules:
- Use only three weights: 400, 500, 600. Do not use 700.
- Use `font-variant-numeric: tabular-nums` on counts, times, `+n −m`, token numbers and percentages.
- Use mono only for code, paths, branch names and commands. Never for labels, placeholders or numbers in prose.
- Korean has no capitals, so section labels use weight and color instead: `--fs-xs`, 500, `--ink-3`. Latin acronyms (PR, CI) stay as they are.
- Line clamp: list titles 1 line, card titles 2 lines, then an ellipsis.
- Check the new pixel line heights against the centering problem that `fb062ea` fixed before shipping them.

---

## 4. Spacing

Base unit 4px, as in Tailwind's `--spacing: .25rem` used by T3 Code, gitsu and Codex (`--spacing: 4px`).

| Token | px | Typical use |
|---|---|---|
| `--s-2` | 2 | Optical nudges only, tab-strip gap |
| `--s-4` | 4 | Menu padding, icon-to-count, chip gap |
| `--s-6` | 6 | Icon-to-label in small controls |
| `--s-8` | 8 | Icon-to-label in rows, card gutter (`--gut`), button gap |
| `--s-10` | 10 | Row horizontal padding |
| `--s-12` | 12 | Card padding (dense), list padding |
| `--s-16` | 16 | Panel inset, card padding (roomy), section gap |
| `--s-20` | 20 | Dialog padding |
| `--s-24` | 24 | Between settings groups, between turns |
| `--s-32` | 32 | Page top padding |
| `--s-48`, `--s-64` | 48, 64 | Empty-state offsets only |

Retire `--s-14`, `--s-28`, `--s-40` and `--s-80`. Keep them as aliases until no CSS uses them.

Layout constants (unchanged unless noted): `--head-h` 52px (T3 `--workspace-topbar-height: 52px`), `--sidebar-w` 264px, `--panel-w` 440px default and resizable, `--chat-w` 736px (T3 `--chat-content-max-width: 46rem`), `--traffic-w` 84px, `--gut` 8px.

---

## 5. Radii

| Token | Value | Use | Reference |
|---|---|---|---|
| `--r-bar` | 2px | Progress ticks | |
| `--r-xs` | 4px | Kbd, inline code, tiny buttons inside chips | Linear `--radius-4`; T3 kbd `rounded` |
| `--r-sm` | 6px | Menu items, tooltips, count badges | T3 `--radius-md` (radius − 2); Linear `--radius-6` |
| `--r-md` | 8px | Buttons, inputs, sidebar rows, tabs | T3 `--control-radius: .5rem`; Linear `--radius-8` |
| `--r-lg` | 10px | Popovers, menus, toasts | Codex `--radius-lg: 10px` (today this token is 8px, the same as `--r-md`) |
| `--r-xl` | 12px | Cards, main and panel shells (`--card-r`), settings groups | T3 `--radius-xl`; Linear `--radius-12` |
| `--r-2xl` | 16px | Composer, dialogs, board columns | T3 dialog `--radius-2xl`; Codex `--radius-2xl: 16px`; gitsu columns (inferred) |
| `--r-pill` | 999px | Status pills, label chips, send button | |

Nest radii: the inner radius equals the outer radius minus the padding (T3 uses `calc(var(--radius-lg) - 1px)` for inner rings).

---

## 6. Borders, shadows, elevation

Borders do the work. Shadows only lift things that float above the page. Linear's light shadows are 6–9% black and its dark ones 20–35%. T3 drops the card shadow in dark mode entirely.

| Level | What | Fill | Edge | Shadow |
|---|---|---|---|---|
| 0 | Canvas: window frame and sidebar | `--canvas` | none | none |
| 1 | Main and panel shells | `--bg` | 1px `--card-line` | **none** (change: today light mode uses `0 1px 2px …, 0 4px 16px -6px …`) |
| 2 | Inline raised: composer, cards in content, user bubble | `--card` / `--bubble` | 1px `--line` (no border on the bubble) | composer only: `--shadow-composer` |
| 3 | Floating: menus, popovers, tooltips, toasts | `--card` | 1px `--line` (dark: inside the shadow ring) | `--shadow-pop` |
| 4 | Modal: dialogs, settings sheet, palette | `--card` | 1px `--line` | `--shadow-pop` + `--scrim` behind |

Shadow values:

| Token | Light | Dark | Source |
|---|---|---|---|
| `--shadow-card` | `none` | `none` | dark; Ondra for light |
| `--shadow-composer` | `0 1px 2px rgba(0,0,0,0.05)` | `0 14px 32px -18px rgba(0,0,0,0.75)` | T3 `--shadow-composer`, `--shadow-composer-dark` (unchanged) |
| `--shadow-pop` | `0 3px 12px rgba(0,0,0,0.09), 0 0 0 1px rgba(0,0,0,0.06)` | `0 7px 32px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.08)` | Linear `--shadow-medium` light `0 3px 12px #00000017`, `--shadow-high` dark `0 7px 32px #00000059` |

Do not use backdrop blur or glass on popovers. T3 uses `dropdown-glass` with a 12–16px blur. Ondra uses solid fills: they are calmer and cheaper in a Tauri webview.

---

## 7. Density

One density. Heights:

| Element | Height | Reference |
|---|---|---|
| Sidebar job row | 32px (today 36px) | T3 sidebar menu button `h-8` |
| Sidebar child row (subagent) | 28px (today 30px) | T3 `h-7` |
| List row, one line | 32px | Linear `--button-height: 32px` family |
| List row, two lines | 48px | inferred from Codex threads |
| Menu item | 28px | T3 `sm:min-h-7` |
| Button sm / md | 28 / 32px | T3 `sm:h-7` / `sm:h-8` |
| Icon button sm / md | 28 / 32px | T3 `icon-sm` / `icon` |
| Input | 32px | T3 input `sm:h-7.5` ≈ 30px, rounded to the grid |
| Panel tab | 28px | Linear: compact tabs that don't span the width |
| Settings row | 44px | gitsu settings rows, inferred |
| Header bar | 52px minus `--gut` | |

---

## 8. Iconography

- Library: lucide (`lucide-solid`, already installed). T3 Code uses lucide as well.
- Stroke: **1.5px absolute** everywhere (`strokeWidth={1.5}` with `absoluteStrokeWidth`). Today the codebase mixes 1, 1.2, 1.5, 2 and 2.5. Linear's refresh redrew its icons smaller and quieter.
- Sizes: 14px in 28px controls, meta rows and chips; 16px in 32px controls, sidebar rows and menus (T3 `size-4`); 20px only for the empty-state glyph. Nothing larger.
- Color: `--ink-3` at rest, `--ink` on hover or when active. Icons are never colored, except status glyphs and the GitHub PR state.
- Linear's refresh cut icon use: "reduces icon usage, scales their sizes down". Ondra does the same. A row gets an icon only if the icon carries meaning (state, file type, tool). Section headers and menu items without a clear glyph get none.
- Product marks (GitHub, agent CLIs) appear only in integration rows, monochrome `--ink-3`, 16px. Ondra's own logo never appears.
- **Status glyph (14px, static).** This replaces the spinner and pulsing dots. Shapes follow Linear and gitsu issue states:
  - 대기: 1.5px dashed ring, `--ink-4`
  - 진행 중: 1.5px ring in `--accent-text`, with a filled pie for progress (half when the progress is unknown). Static.
  - 답 필요: 1.5px ring in `--warn` + 6px center dot
  - 멈춤: 1.5px ring in `--ink-3` + 4px center dot
  - 실패: 1.5px ring in `--bad` + 6px center dot
  - 끝남: filled `--accent-soft` circle + 9px check in `--accent-text`

---

## 9. Components

All measurements are in px. "Hover" means `background: var(--hover)` unless stated otherwise. Every control shows focus as `outline: 2px solid var(--focus); outline-offset: 1px`.

### 9.1 Sidebar rows
- Row: height 32, padding 0 10, gap 8, radius `--r-md`. T3 uses `--sidebar-row-content-inset: .625rem` and `--sidebar-control-gap: .5rem`.
- Leading slot 16 wide, holding the status glyph (14) centered. Every label starts at the same x.
- Title: `--fs-md` 400, `--ink-2`. Unread: 500 weight and `--ink`. Past or settled: `--ink-3`.
- Trailing meta: `--fs-xs`, `--ink-3`, tabular, short Korean time ("3분", "2시간", "어제"). On hover, the meta is swapped for at most 2 icon buttons (24px, 14px icons). Codex shows only the age on the right.
- Hover: `--hover` with title `--ink`. Selected: `--row-selected` + `--row-selected-shadow`, title `--ink`.
- Section label: height 28, padding 0 10, `--fs-xs` 500 `--ink-3`, optional count chip (§9.7). No rule lines between sections. Spacing alone separates them (top margin 12).
- In dark mode the sidebar sits on `--canvas` and its text runs one step dimmer than the main card (`--ink-3` for settled rows). This is Linear's "dimmer sidebar".

### 9.2 Tabs (right panel, browser-like)
- Strip: height `--head-h − --gut`, padding 0 8, gap 2, scrolls horizontally with a 16px edge fade.
- Tab: height 28, padding 0 10 0 8, gap 6, radius `--r-md`, min 72, max 180. Icon 14, label `--fs-sm` 500, 1 line.
- Inactive: transparent, `--ink-3`. Hover: `--hover`, `--ink-2`. Active: light `--card` + 1px `--line`; dark `--active`, no border; label `--ink`.
- Close button: 16, radius `--r-xs`. It shows only on hover and on the active tab, and is always there to keyboard focus.
- New tab "+": 28 square ghost icon button. Linear moved to "smaller, icon-only tabs" in its tab bar. Ondra keeps labels, because Korean tool names are short.
- Segmented control (inside a pane): track `--muted` + 1px `--line`, radius `--r-md`, padding 2. Cells share the width equally. Selected cell: `--card`, 1px `--line` (dark: `--active`), text `--ink`.

### 9.3 Buttons

| Variant | Fill | Border | Text / icon | Hover | Pressed |
|---|---|---|---|---|---|
| Primary | `--accent` | 1px `--accent` | `--accent-ink` | `--accent-hover` | `--accent-press` |
| Secondary | `--card` (dark: `rgba(255,255,255,0.03)`) | 1px `--input` | `--ink` / icon `--ink-3` | `--hover` over the fill | `--active` |
| Ghost | transparent | none | `--ink-2` / icon `--ink-3` | `--hover`, text `--ink` | `--active` |
| Ghost danger | transparent | none | `--ink-2` | text `--bad-ink` | `--bad-soft` |
| Danger (only inside confirm dialogs) | `--bad` | 1px `--bad` | `#fff` | 90% fill | |

- Sizes: sm h 28, padding 0 10, gap 6, `--fs-sm` 500, icon 14. md h 32, padding 0 12, gap 8, `--fs-md` 500, icon 16. These follow T3 `sm` and `default` and Linear `--button-padding: 0 10px / 0 12px`.
- Icon button: square 28 or 32, radius `--r-md`, ghost style, 14 or 16 icon. It always has a tooltip with its name and shortcut.
- Pressed feedback: `transform: scale(0.98)` over 120ms (T3 uses `active:scale-[0.97]`). Not on buttons that open menus.
- Disabled: opacity 0.5, no hover. T3 uses 0.64; 0.5 reads as clearly off on Ondra's lighter surfaces.
- No inset highlights, gradients or colored shadows on any button.
- One primary per view. Composer send, 합치기 and confirm are the only primaries.

### 9.4 Inputs and composer

**Input**
- h 32, padding 0 10, radius `--r-md`, `--fs-md`. Fill `--card` (dark: `rgba(255,255,255,0.03)`), border 1px `--input`, placeholder `--ink-4`.
- Focus: border `--accent-line`, ring `0 0 0 3px var(--accent-soft)`.
- Inline search in a list or panel: no border, h 28, leading 14 search icon in `--ink-4`, bottom hairline `--line-soft`. Like T3's menu search `border-b border-border/70`.
- Error: border `--bad-line`. The message goes in a toast or the field's own row, never as red text below the field.

**Composer**
- Card `--card`, radius `--r-2xl`, border 1px `--line` (focus: `--input`), shadow `--shadow-composer`. Max width `--chat-w`.
- Padding 12 14 8. Textarea `--fs-lg`/26, 1 line minimum, grows to 40% of the window height, then scrolls.
- Bottom bar, h 32: left `+` (28 ghost icon) and the permission chip; right the model chip (name + effort, `--fs-sm`) and send. Codex and T3 put the model on the right and the context on the left.
- Send: 28 circle, `--accent` fill, 14 arrow-up in `--accent-ink`. Empty: `--muted` fill, icon `--ink-4`. Running: the same button becomes stop (square glyph, `--ink` fill, `--card` icon).
- Chips in the bar: h 28, padding 0 8, radius `--r-md`, ghost, 14 icon + `--fs-sm`, chevron 12.
- Trays above the composer (plan, background, ready-to-merge): separate cards, radius `--r-xl`, 8 apart, one line each.
- Placeholder: one short line ("무엇을 할까요?"). No feature list in the placeholder and nothing under the composer except the usage line.

### 9.5 Cards
- `--card` (light) or `--bg`-on-`--canvas` (shells). 1px `--line`, radius `--r-xl`, padding 12 (dense) or 16, no shadow.
- Header row h 28: title `--fs-md` 500 `--ink`, meta right `--fs-xs` `--ink-3`.
- **Work-item card** (board, issue, PR), after gitsu:
  - Line 1 (`--fs-xs`, `--ink-3`): status glyph 14 · `#65` · `›` parent title (truncated). Assignee avatars 20 on the right.
  - Line 2: title `--fs-md` 500 `--ink`, 2-line clamp.
  - Optional line: sub-issue progress (12 ring + `2/7`, tabular).
  - Footer, gap 8: priority glyph 14 · label chips (§9.7) · `+n` overflow.
  - Gap between lines 6, padding 12, radius `--r-xl`, fill `--card` on a column of `--muted` (dark: `#232326` on `#1c1c1f`).

### 9.6 Lists and rows
- One-line row: h 32, padding 0 12, gap 10, radius `--r-md` when the list has an inset; full-bleed rows have no radius.
- Two-line row: h 48, title `--fs-md` + meta line `--fs-xs` `--ink-3`.
- No separators between rows. Hover `--hover`, selected `--row-selected` (light) or `--active` (dark).
- Trailing meta: `--fs-xs` `--ink-3`, tabular. Hover actions replace the meta (never shift the title).
- Group header: h 28, `--fs-xs` 500 `--ink-3`, count chip, chevron 12 when foldable. Folding animates (§11).
- Keyboard: ↑↓ moves, Enter opens, the row under the keyboard gets `--hover`.

### 9.7 Badges, status pills, label chips

| Kind | Size | Shape | Fill / border | Text | Reference |
|---|---|---|---|---|---|
| Count badge | h 18, min-w 18, padding 0 5 | `--r-sm` | transparent, 1px `--line` | `--fs-2xs` 500 `--ink-3`, tabular | gitsu column count chip; T3 badge `sm:h-4.5` |
| Status pill | h 22, padding 0 8, gap 6 | pill | tone `-soft` | `--fs-xs` 500, tone `-ink`, 6px dot | T3 badge tones `bg-*/8`, `dark:bg-*/16` |
| Label chip (GitHub label) | h 22, padding 0 8, gap 6 | pill | transparent, 1px `--line` | `--fs-xs` `--ink-2`, 8px dot in the label's GitHub color | gitsu label chips, without the glow on `agent-working` |
| Kbd | h 18, min-w 18, padding 0 4 | `--r-xs` | `rgba(ink, 0.07)` | `--fs-2xs` 500 `--ink-3`, sans | T3 `bg-foreground/[0.07]` |
| Diff count | inline | none | none | `+12` `--ok-ink`, `−3` `--bad-ink`, tabular | |

Tones: neutral (`--muted`/`--ink-2`), accent, ok, warn, bad. Never two pills for the same fact on one row.

### 9.8 Menus and popovers
- Surface: `--card`, 1px `--line`, radius `--r-lg`, padding 4, shadow `--shadow-pop`, min width 200, max height 60vh with scroll.
- Item: h 28, padding 0 8, gap 8, radius `--r-sm`, `--fs-sm`. Icon 16 `--ink-3` (optional), shortcut right-aligned in `--fs-xs` `--ink-4`, check 14 at the right for the current choice. Highlighted: `--hover`. T3 menu items: `min-h-7 rounded-sm px-2 gap-2`.
- Section label: h 24, padding 0 8, `--fs-xs` 500 `--ink-3`.
- Separator: 1px `--line-soft`, margin 4 −4.
- Danger items: `--bad-ink` text, last, after a separator.
- Only one popover open at a time. Esc closes the popover only. The right-click menu and the ⋯ menu share items and wording.
- Motion: opens with opacity 0→1 and scale 0.98→1 from the anchor side, 140ms `--ease-drawer`; closes with opacity only, 100ms. T3 uses `scale-98` with a 200ms opacity.

### 9.9 Dialogs
- `--scrim` behind. Panel `--card`, 1px `--line`, radius `--r-2xl`, shadow `--shadow-pop`. Width 420 (confirm) or 560 (form). T3 uses `rounded-2xl`.
- Padding 20. Title `--fs-lg` 600 `--ink`, phrased as the question ("이 일을 버릴까요?"). Body at most one line, `--fs-md` `--ink-2`, or nothing.
- Footer: right-aligned, gap 8, cancel (secondary) then the action (primary, or danger when it destroys work). Enter runs the action and Esc cancels.
- No ✕ when a cancel button exists.
- Motion: opacity + scale 0.98→1, 200ms `--ease-drawer` (T3 `duration-200 … data-starting-style:scale-98`). The scrim fades in over 160ms.

### 9.10 Toasts
- Bottom center, 16 above the window edge, one at a time (a new one replaces the old one).
- `--card`, 1px `--line`, radius `--r-lg`, shadow `--shadow-pop`, padding 8 12, min h 36, max width 420.
- One line, `--fs-sm` `--ink`, optional 14 glyph (status tone) on the left, optional single text action on the right in `--accent-text` 500 ("되돌리기").
- Errors use the same toast with a `--bad` glyph. No red background, no large red text.
- Stays 3s (6s if it has an action). Hovering pauses it.
- Motion: in with translateY(8px)→0 + opacity, 180ms `--ease-drawer`; out with opacity, 120ms.

### 9.11 Tooltips
- `--card`, 1px `--line`, radius `--r-sm`, padding 4 8, shadow `0 2px 8px rgba(0,0,0,0.08)` (dark `0 4px 16px rgba(0,0,0,0.4)`), `--fs-xs` `--ink`, max width 280. T3 tooltips are `rounded-md text-xs`.
- Content: the name of the thing + kbd. Never repeat a label that is already visible. Never use a tooltip to explain a feature.
- Delay: 500ms on the first one, 0 while moving between neighbors, hide at once.

### 9.12 Empty states
- Centered in the pane, max width 280, offset slightly above center (−8% of the height).
- Optional 20px line icon in `--ink-4`, with no tile or frame. T3 draws a 36px bordered tile; Ondra drops it.
- Title: `--fs-md` 500 `--ink-2`, one short line ("아직 없어요", "바뀐 파일이 없어요").
- At most one action, secondary sm ("새 일 시작"). No description paragraph and no sample prompts.
- Where a copyable next step exists, offer it as the action. gitsu's empty "Agent working" filter shows a ready prompt with a Copy prompt button.

### 9.13 Settings rows
- Page title `--fs-xl` 600. Group title `--fs-sm` 600 `--ink`, 24 above and 8 below.
- Group: `--card`, 1px `--line`, radius `--r-xl`. Rows are divided by 1px `--line-soft`. gitsu settings use the same bordered list.
- Row: min h 44, padding 0 14, gap 12. Optional leading 16 icon. Label `--fs-md` `--ink`. Control right-aligned. A current value (when it isn't the control) goes right in `--ink-3`.
- **No description line under the label.** If a row cannot be understood without one, rename it. The rare exception is a consequence the person must know before switching (data deletion). That gets one line, `--fs-xs` `--ink-3`, at most 40 characters.
- Switch: 30×18 track, 14 thumb, 2 inset. Off: `--input` track. On: `--accent`. T3 switch: `--thumb-size` 16 → w 30. The thumb slides in 160ms `--ease`.
- Disclosure row ("설치 안 된 9개 보기"): `--ink-3`, 12 chevron, folds open (§11).

### 9.14 Code and diff views
- Theme: Pierre (as T3 Code, via Shiki). Unchanged.
- Code block: `--code-bg`, radius `--r-md`, padding 10 12, `--fs-code`/20, horizontal scroll, no wrap by default. A copy icon button (24) appears on hover, top right.
- Inline code: `--code-bg`, radius `--r-xs`, padding 1 4, 0.92em.
- File view: line numbers `--ink-4`, tabular, right-aligned in a 44 gutter. Current line `--hover`.
- Diff file header: h 36, padding 0 12, sticky. 12 chevron, path in mono `--fs-sm` (folder in `--ink-3`, file name in `--ink`), `+n −m` on the right. The whole header toggles the fold.
- Diff lines: added `--diff-add`, removed `--diff-del`, and a 2px left bar in `--ok` or `--bad`. Word-level marks use the `-strong` tokens. Hunk header: h 28, `--muted`, `--fs-xs` `--ink-3` mono. Cursor's product diff uses 8% and 6% backgrounds; Ondra's 10% and 8% stay because Pierre's code colors sit on top.
- Changed-files list: 32 rows, file glyph 14, path, `+n −m`, and a fixed-width 40px bar (green/red proportion).

### 9.15 Board (job board and GitHub board)
- Columns: `--muted` fill (dark `#1c1c1f`), radius `--r-2xl`, padding 8, gap 8, width 300.
- Column header: h 32, `--fs-xs` 500 `--ink-2`, count badge, `+` icon button on the right. gitsu draws this as uppercase `IN PROGRESS 4`; Korean uses weight instead.
- Cards: §9.5 work-item card, 8 apart.
- Quick-filter row above the board: pills h 28, padding 0 10, gap 6, radius `--r-md`, 14 icon + `--fs-sm` 500. Off: `--muted`, `--ink-2`. On: `--accent-soft`, `--accent-text`. gitsu fills the active pill with a brand gradient; Ondra uses a flat soft fill.

---

## 10. Header bars
- One layout everywhere, because Linear's refresh fixed actions "moving around unpredictably". Left: title (`--fs-md` 500, rename in place) + status pill. Right, in fixed order: context actions (at most 2 ghost icon buttons) · ⋯ menu · panel toggle.
- Rarely used actions go in ⋯. Branch names, ids and paths are not shown in the header.

---

## 11. Motion

Allowed: state changes the person caused or must notice. Forbidden: anything decorative or looping.

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120ms | Hover, color, press scale |
| `--dur` | 160ms | Fold, chevron rotate, switch thumb, popover close |
| `--dur-slow` | 220ms (today 260) | Content entering: a new message, a new list item, toasts |
| `--dur-drawer` | 280ms (today 360) | Sidebar collapse, panel open/close, center view swap |
| `--ease` | `cubic-bezier(0.2, 0, 0, 1)` | Color, fold, small moves |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | Anything that slides or pops in (T3 `--ease-drawer`) |
| `--ease-spring` | **remove** | No overshoot anywhere |

References: Cursor `--duration: .14s`, `--duration-slow: .25s`; Linear `--duration: .18s`, `--transition-duration: .1s`; gitsu default 150ms `cubic-bezier(.4,0,.2,1)`.

Rules:
1. Folds animate height with `grid-template-rows: 0fr → 1fr` (`--dur`, `--ease`) and the chevron rotates in step. Never pop open.
2. Panels and the sidebar slide with `--dur-drawer` `--ease-drawer`. The content inside them does not move.
3. New items fade in (opacity, plus 4px translateY for messages) over `--dur-slow`. No staggered lists.
4. Popovers, dialogs and toasts follow §9.8 to §9.10.
5. **Nothing loops.** No spinners, pulsing or breathing dots, shimmer text, animated gradients, drawn graph lines, or "highlight fading in" on diffs. "Working" is a static glyph plus real content: the live tool line, the text being written, the terminal tail. The one `infinite` animation left in the CSS (`.spin` in `core.css`, `rot 0.75s linear infinite`) is replaced by the static status glyph. The unused `halo`, `ask-ping` and `shimmer` keyframes in `t3.css` are deleted.
6. Under `prefers-reduced-motion: reduce`, durations drop to 0, except opacity fades, which keep 120ms.
7. gitsu's marketing site has hero rise-ins, a cursor spotlight ring, grain and spring "stickers". None of them come into Ondra.

---

## 12. Copy and language

Ondra ships in Korean and English. Every visible string goes through `t()` from
`src/i18n` with the Korean text as the key; the English sits in `src/i18n/en/<area>.ts`.
Write it the way a careful product team writes a dev tool (Linear, Toss, Raycast),
not the way a chatbot talks.

### 12.1 Rules
1. Labels are nouns or short noun phrases: `동시 작업 수`, not `한 번에 하는 일`. Settings rows, tabs, menu items, column titles.
2. Buttons are one or two words, a verb or verb-noun: `저장`, `병합`, `다시 시도`, `작업 만들기`. English: `Save`, `Merge`, `Try again`.
3. Messages (toasts, empty states, errors) are one short sentence in 해요체 at most, and often just a phrase: `저장했어요`, `이슈 없음`. No cheerful filler, no "~해 드릴게요", no "~했답니다", no exclamation marks.
4. No helper text under labels. If a label needs one, the label is wrong. A tooltip may hold one short fact.
5. No internal terms: stdin, JSON, engine, captain, guest, asset, task id. "워크트리" and "브랜치" are fine: the people who use Ondra are developers.
6. Never explain how the product works inside. Say the result or the next step.
7. Errors say what didn't happen and offer one way forward: `불러오지 못했어요 · [다시 시도]`.
8. Numbers over words: `3개`, `64 GB`, `12분 전`.
9. English: sentence case, no period on a label or button, contractions are fine (`Couldn't load`), no "Oops", no "Let's", no "Successfully".

### 12.2 Words (one word per idea, both languages)

| Idea | 한국어 | English |
|---|---|---|
| a unit of work an agent does | 작업 | task |
| the agent of a task's sub-parts | 서브에이전트 | subagent |
| the main conversation | 메인 | Main |
| a folder Ondra knows | 프로젝트 | project |
| 회사 / 개인 split | 워크스페이스 | workspace |
| what the agent remembers | 메모리 | memory |
| files and pages a task made | 결과물 | results |
| the overview of all tasks | 캔버스 | canvas |
| a task waiting on the person | 응답 필요 | needs reply |
| answer it | 응답 | reply |
| states | 진행 중 · 대기 · 일시정지 · 완료 · 실패 · 검토 | running · queued · paused · done · failed · review |
| put a task's changes back | 병합 | merge |
| throw them away | 버리기 | discard |
| hand an issue to an agent | 작업 만들기 | start task |
| instructions for every task | 공통 지침 | global instructions |
| skills / hooks / tools / permissions | 스킬 · 훅 · 도구 · 권한 | skills · hooks · tools · permissions |
| model effort | 추론 강도 | effort |

Never: 일 (for a task), 맡기기, 대장, 기억 (as the feature name), 공간, 합치기, 답 필요, 끝남.

### 12.3 Bad → good

| Bad | 한국어 | English |
|---|---|---|
| 한 번에 하는 일 | 동시 작업 수 | Concurrent tasks |
| 한 번에 하는 무거운 일 | 무거운 작업 동시 수 | Concurrent heavy tasks |
| 일마다 따로 작업하기 | 작업마다 워크트리 | Worktree per task |
| PR 지켜보기 | PR 리뷰 자동 대응 | Follow up on PR reviews |
| 자동으로 기억 | 메모리 자동 저장 | Save memories automatically |
| 일이 띄운 앱은 뒤에 | 포커스 지키기 | Keep my window in front |
| 일로 맡기기 | 작업 만들기 | Start task |
| 원래 폴더에 합치기 | 병합 | Merge |
| 작업이 성공적으로 완료되었습니다. | 완료 | Done |
| 오류가 발생했습니다. 잠시 후 다시 시도해 주십시오. | 실패했어요 · [다시 시도] | Failed · [Try again] |
| 표시할 항목이 없습니다. | 없음 | Nothing here |
| AI가 분석 중입니다… | 보는 중 | Looking |
