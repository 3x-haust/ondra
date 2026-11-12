---
name: modern-web-guidance
description: >-
  Current web platform practice from the Chrome team, offline: 209 short guides
  on HTML, CSS and client-side JS (dialogs, popovers, anchor positioning,
  container queries, view transitions, scroll-driven animation, forms and
  validation, accessibility, dark mode, Core Web Vitals, images, security,
  dates, web components, built-in AI). Use when writing or changing web UI code
  and a guide may know a newer, lighter way than habit: 웹 화면 코드, CSS,
  모달, 팝오버, 폼, 접근성, 성능.
---

# Modern web guidance

Models learn web code from older pages, so habit often reaches for a heavy
script where the platform now has a one-line answer (`<dialog>`, `popover`,
`:has()`, anchor positioning, `field-sizing`). These guides, from the Chrome
team's modern-web-guidance (Apache 2.0, `NOTICE`), say what to use today, with
its browser support and fallback.

## Use

When a piece of UI code is about to be written or changed, look for a guide
on that capability and read it if one fits:

```bash
grep -i "<capability words>" "<this skill's folder>/guides/INDEX.md"
```

`INDEX.md` has one line per guide (file, title, first sentence). Search for
the capability, not the app's names: "light dismiss popover", "date input",
"responsive table", "dark mode". Read the matching guide in full, plus the
broad one for its area when useful (`css/css.md`, `forms/forms.md`,
`accessibility/accessibility.md`, `performance/...`).

Nothing fits, or the change is trivial: carry on without it.

## Applying a guide

- The guides use plain HTML, CSS and JS; carry the idea into the project's
  framework and keep its components, tokens and style.
- Browser support: the guides treat "Baseline widely available" as safe and
  give a fallback for newer features. The project's own support policy wins.
  A Tauri or other desktop app on macOS runs in WebKit (Safari's engine), so
  check a newer feature's Safari support there.
- A guide is advice for this capability, not a rewrite order: change what
  the task touches.

## Updating the guides

The guides are copied from the source repository at the commit in `NOTICE`.
To refresh: copy `skills/modern-web-guidance/guides/` from a newer checkout,
run `python3 index.py` and update the commit in `NOTICE`.
