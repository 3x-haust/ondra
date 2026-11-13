# QA checklist

Pick from these by risk; don't run all of them on every screen. The ideas
come from the Test Heuristics Cheat Sheet (Hendrickson, Lyndsay, Emery),
Bach's HTSM, Whittaker's tours, W3C Easy Checks and common mobile QA lists.

## Inputs (each field that matters)

- Text: empty, spaces only, one character, at the max length and one over,
  10 000 characters, leading/trailing spaces, line breaks.
- Characters: Korean typed through the IME (composition + Enter must not
  submit half a syllable), emoji and ZWJ emoji (👩‍👩‍👧), RTL text, `<b>x</b>`,
  `"'; --`, `{{x}}`, `../`, a URL, a pasted rich-text block.
- Numbers: 0, -1, 0.1, 1e9, a thousands separator (1,000), letters in a number
  field, leading zeros.
- Dates and time: today, a leap day, end of month/year, a far past/future
  date, another time zone, across a DST change.
- Files: none, empty, huge, wrong type with the right extension, a name with
  spaces and Korean, two at once.
- Submitting: double click, Enter in a field, submit while the first request
  is still running, then back and submit again.

## States

- Zero, one, many (Zero/One/Many): empty list with a useful empty state, one
  item (singular copy), hundreds (scroll, pagination, performance).
- Loading: slow network (a spinner or skeleton, no layout jump, no double
  content), a request that never answers (timeout message).
- Error: 4xx and 5xx from each API the screen uses (a message that says what
  to do, retry works, nothing half-saved), offline mid-action.
- Text: the longest real name, a word with no spaces, a missing optional
  field, a missing image.
- CRUD: create, read, update, delete each object; update twice; delete the
  last one; open a deleted one by its URL.
- Follow the data: enter a value, then find it everywhere it should show up
  (list, detail, search, export, another device or tab).
- Interrupt: refresh, close the tab or the app, lose the network in the
  middle of a multi-step flow; come back and see what was kept.

## Navigation and sessions

- Refresh on every screen keeps the state that should survive (filters in the
  URL, the draft) and nothing that shouldn't.
- Back and forward after each step; back out of a modal; back after submit
  (no resubmit).
- Deep link straight to a screen, signed in and signed out; a bad or another
  user's id (404 or no access, never someone else's data).
- Two tabs at once: change in one, act in the other.
- Session expires mid-form: sign in again and keep the input.

## Web

- Phone and desktop widths: no horizontal scroll, nothing cut
  off, tap targets reachable, menus open and close, sticky bars don't cover
  inputs.
- Light and dark (`set media dark`): text and icons readable, no white flashes,
  images and charts still visible.
- Links: every same-origin link answers (skip logout, delete, unsubscribe).
- Framework tells: Next.js hydration errors and `_next/data` 404s (click links,
  don't only `open` them); SPA stale data after back, scroll position.

## iOS and Android (`device-use`)

- First launch (onboarding, permissions), a returning user, an upgrade from
  the previous build keeping data.
- Permissions: allow, deny (the app explains and still works), revoke later
  in Settings; asked only when the feature needs it.
- Background → foreground keeps state and refreshes; force quit and relaunch.
- Rotation (if supported), largest text size (Dynamic Type / font scale),
  dark mode, a small phone and a large one, notch and home indicator areas.
- Keyboard: it doesn't cover the focused field; the return key moves on or
  submits; the right keyboard per field (email, number, phone).
- Offline and airplane mode mid-action, slow network, coming back online.
- Deep links and push notifications open the right screen, signed in or not.
- Android back button/gesture at each screen; iOS swipe back.
- Touch targets at least 44 pt (iOS) / 48 dp (Android).

## Mac and desktop apps (`computer-use`)

- Menu bar items and their shortcuts do what they say; standard shortcuts
  (⌘W, ⌘Q, ⌘,, ⌘Z) behave.
- Window: resize to small and large, full screen, a second window, closing
  the last window, reopening restores what it should.
- Quit while something is running; relaunch.
- Drag and drop in and out, file open/save dialogs, copy/paste.

## Accessibility, quick

- `ondra-browser a11y` on each main screen; report the violations that matter
  to people (labels, names, contrast, focus), after a look at the element.
  One line each:
  ```bash
  ondra-browser --json a11y | jq -r '.data.violations[] | "\(.impact) \(.id) ×\(.nodes|length) \(.nodes[0].target[0])"'
  ```
- Keyboard only: Tab and Shift-Tab reach and leave every control in a sensible
  order, focus is visible, Enter/Space activate, Esc closes dialogs and focus
  returns to the opener, no trap.
- Each input has a label; errors are in text near the field, not only a red
  border.
- Text contrast at least 4.5:1 (3:1 for large text and UI parts), in both
  themes.
- 200% zoom: no cut-off or overlapping text.
- The page title names the screen; images that mean something have alt text.
- Motion: nothing loops on its own forever; reduced motion is respected.

## Tours, when you want a different angle

- Money: the flow users pay for or come for, as a demo would show it.
- Landmark: the main features in the order a new user meets them.
- Back alley: settings, rarely used options, the second page of everything.
- FedEx: one piece of data from where it enters to every place it appears.
- Supermodel: only the surface — layout, copy, consistency.
- Intellectual: the hardest inputs and the biggest data you can make.

## What did we forget? (HTSM product elements)

Structure (parts, builds, config) · Function (every feature) · Data (inputs,
outputs, stored state) · Interfaces (UI, API, files, other apps) · Platform
(browsers, OS versions, devices) · Operations (how real users use it, at what
scale) · Time (timeouts, time zones, dates, concurrency, long sessions).
