// The app's accessibility tree as the model reads it: one short line per element,
// `[12] button "Save"`, indented under its parent. Elements keep their number for the
// whole session, so a later observation can say only what changed:
//   ~ [4] textfield = "hello"        (changed)
//   + [9] button "Save" (in [2])     (appeared)
//   - [6] button "Cancel"            (gone)
// Pure functions; HostObservation holds the state.

import type { HostNode } from "./computer-host";

export type ScreenLine = { ref: number; depth: number; parent?: number; text: string };

const ROLE: Record<string, string> = {
  AXStaticText: "text", AXPopUpButton: "popup", AXMenuButton: "menubutton", AXCheckBox: "checkbox",
  AXRadioButton: "radio", AXTextField: "textfield", AXTextArea: "textarea", AXComboBox: "combobox",
  AXScrollArea: "scrollarea", AXWebArea: "webpage", AXTabGroup: "tabs", AXDisclosureTriangle: "disclosure",
  AXIncrementor: "stepper", AXProgressIndicator: "progress", AXBusyIndicator: "busy", AXMenuBarItem: "menubaritem",
  AXMenuItem: "menuitem", AXColorWell: "colorwell", AXDateField: "datefield", AXLevelIndicator: "level",
  AXRadioGroup: "radiogroup", AXSegmentedControl: "segments", AXValueIndicator: "thumb",
};
const SUBROLE: Record<string, string> = {
  AXSearchField: "searchfield", AXSecureTextField: "passwordfield", AXCloseButton: "close-button",
  AXMinimizeButton: "minimize-button", AXFullScreenButton: "fullscreen-button", AXZoomButton: "zoom-button",
  AXTabButton: "tab", AXSwitch: "switch", AXToggle: "toggle", AXDialog: "dialog", AXSystemDialog: "dialog",
  AXFloatingWindow: "panel", AXSortButton: "sort-button", AXOutlineRow: "row", AXTableRow: "row",
};
// containers that say nothing by themselves: their children are shown in their place
const QUIET = new Set(["AXGroup", "AXUnknown", "AXSplitGroup", "AXLayoutArea", "AXLayoutItem", "AXGenericElement"]);
// actions every such element has, or that the tool covers another way
const PLAIN = new Set(["AXPress", "AXShowMenu", "AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI"]);
const TOGGLES = new Set(["AXCheckBox", "AXRadioButton", "AXSwitch", "AXToggle"]);
// where stepping a value means something (a toolbar button lists them too, for customizing)
const VALUED = new Set(["AXSlider", "AXIncrementor", "AXStepper", "AXDateField", "AXTimeField", "AXComboBox", "AXValueIndicator", "AXScrollBar", "AXLevelIndicator"]);

/** the actions worth naming: not the common ones, the app's own unnamed extras, or paging a scroll area */
function extraActions(n: HostNode, actions: string[]): string[] {
  return actions.filter((a) => !PLAIN.has(a) && /^AX[A-Za-z]+$/.test(a) && !/^AXScroll\w*ByPage$/.test(a) && a !== "AXRaise" &&
    (!["AXIncrement", "AXDecrement"].includes(a) || VALUED.has(n.role)) &&
    !(["AXDelete", "AXCancel"].includes(a) && n.role === "AXButton"));
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const q = (s: string, max: number) => JSON.stringify(s.length > max ? s.slice(0, max) + "…" : s);

export function roleName(n: HostNode): string {
  const sub = typeof n.subrole === "string" ? SUBROLE[n.subrole] : undefined;
  return sub ?? ROLE[n.role] ?? n.role.replace(/^AX/, "").toLowerCase();
}

/** what an element is called on screen */
function nameOf(n: HostNode): string | undefined {
  if (n.role === "AXStaticText") return str(n.value) ?? str(n.title) ?? str(n.desc);
  const title = str(n.title), desc = str(n.desc);
  return title && desc && title !== desc ? `${title} — ${desc}` : title ?? desc;
}

function describe(n: HostNode): { text: string; quiet: boolean; name?: string } {
  const name = nameOf(n);
  const actions = Array.isArray(n.actions) ? (n.actions as unknown[]).filter((a): a is string => typeof a === "string") : [];
  const extra = extraActions(n, actions).map((a) => a.replace(/^AX/, ""));
  const parts = [roleName(n)];
  if (name) parts.push(q(name, 300));
  const toggle = TOGGLES.has(n.role) || (typeof n.subrole === "string" && TOGGLES.has(n.subrole));
  if (n.role !== "AXStaticText" && n.value !== undefined) {
    const v = String(n.value);
    if (toggle) parts.push(v === "1" ? "checked" : v === "2" ? "mixed" : "unchecked");
    else if (v !== name) parts.push(`= ${q(v, 2000)}`);
  }
  if (str(n.placeholder)) parts.push(`placeholder ${q(String(n.placeholder), 120)}`);
  if (str(n.selection)) parts.push(`selected ${q(String(n.selection), 200)}`);
  if (n.secure === true) parts.push("password");
  if (n.focused === true) parts.push("focused");
  if (n.enabled === false) parts.push("disabled");
  if (n.settable === true && !["AXTextField", "AXTextArea", "AXComboBox"].includes(n.role)) parts.push("settable");
  if (extra.length) parts.push(`actions=${extra.join(",")}`);
  if (typeof n.offscreen === "number" && n.offscreen > 0) parts.push(`(+${n.offscreen} more out of view; scroll)`);
  if (n.truncated === true) parts.push("(…)");
  const quiet = QUIET.has(n.role) && !name && n.value === undefined && !actions.length && n.focused !== true &&
    !str(n.placeholder) && typeof n.offscreen !== "number" && n.truncated !== true;
  return { text: parts.join(" "), quiet, name };
}

/** The tree as lines, in reading order. `refOf` gives each element its session number. */
export function renderTree(tree: HostNode, refOf: (id: string) => number): ScreenLine[] {
  const out: ScreenLine[] = [];
  const walk = (n: HostNode, depth: number, parent: number | undefined, parentName: string | undefined) => {
    const ref = refOf(n.id);
    const d = describe(n);
    // a label repeating its parent's name ("Save" inside button "Save") adds nothing
    const repeat = n.role === "AXStaticText" && !!d.name && d.name === parentName && !(n.children ?? []).length;
    const shown = !d.quiet && !repeat;
    if (shown) out.push({ ref, depth, ...(parent !== undefined ? { parent } : {}), text: d.text });
    for (const c of n.children ?? []) walk(c, shown ? depth + 1 : depth, shown ? ref : parent, shown ? d.name : parentName);
  };
  walk(tree, 0, undefined, undefined);
  return out;
}

const line = (l: ScreenLine, depth = l.depth) => `${"  ".repeat(Math.min(depth, 24))}[${l.ref}] ${l.text}`;

export function screenText(lines: ScreenLine[]): string {
  return lines.map((l) => line(l)).join("\n");
}

/** What changed between two renderings, or undefined when nothing did. */
export function screenDelta(before: ScreenLine[], after: ScreenLine[]): string | undefined {
  const old = new Map(before.map((l) => [l.ref, l]));
  const now = new Map(after.map((l) => [l.ref, l]));
  const out: string[] = [];
  for (const l of before) if (!now.has(l.ref)) out.push(`- [${l.ref}] ${l.text}`);
  // depth of each new line under the nearest element that was already there
  const base = new Map<number, number>();
  for (const l of after) {
    const was = old.get(l.ref);
    if (!was) {
      const p = l.parent;
      const top = p === undefined || old.has(p) || !base.has(p);
      const rel = top ? 0 : base.get(p!)! + 1;
      base.set(l.ref, rel);
      out.push(`+ ${"  ".repeat(Math.min(rel, 24))}[${l.ref}] ${l.text}${top && p !== undefined ? ` (in [${p}])` : ""}`);
    } else if (was.text !== l.text || was.parent !== l.parent) {
      out.push(`~ [${l.ref}] ${l.text}${was.parent !== l.parent && l.parent !== undefined ? ` (now in [${l.parent}])` : ""}`);
    }
  }
  return out.length ? out.join("\n") : undefined;
}

/** Only the lines matching a phrase (or, when the phrase is nowhere, any of its words), with their parents. */
export function screenQuery(lines: ScreenLine[], query: string): { text: string; matches: number } {
  const norm = (s: string) => s.toLowerCase().normalize("NFC");
  const phrase = norm(query.trim());
  const words = phrase.split(/\s+/).filter((w) => w.length > 0);
  let hit = (l: ScreenLine) => norm(l.text).includes(phrase);
  if (!lines.some(hit)) hit = (l) => words.some((w) => norm(l.text).includes(w));
  const byRef = new Map(lines.map((l) => [l.ref, l]));
  const keep = new Set<number>();
  let matches = 0;
  for (const l of lines) {
    if (!hit(l)) continue;
    matches++;
    for (let r: number | undefined = l.ref; r !== undefined && !keep.has(r); r = byRef.get(r)?.parent) keep.add(r);
  }
  return { text: lines.filter((l) => keep.has(l.ref)).map((l) => line(l)).join("\n"), matches };
}
