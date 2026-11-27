// What was typed in each input and not sent yet, by the input's key ("main:<chat key>", a job's id…),
// so switching chats keeps each its own. A main chat's unsent text also follows its workspace to
// another device (state/shared.ts): there it shows in the same input, and what is typed there comes
// back here.
import { createSignal } from "solid-js";

export interface Draft {
  text: string;
  files: string[];
  /** each attached picture's number, as "[Image #n]" names it */
  nums?: [string, number][];
}

const drafts = new Map<string, Draft>();
/** the last text put in from elsewhere, per key (an open input shows it) */
const [pushed, setPushed] = createSignal<Record<string, string>>({});

/** keys kept on another device (its workspace's chats): read and set there */
let route: { owns(key: string): boolean; get(key: string): string | undefined; set(key: string, text: string): void } | undefined;
export const setDraftRoute = (r: typeof route) => void (route = r);
/** told when an input here changes a main chat's text (to pass it on) */
const heard = new Set<(key: string) => void>();
export const onDraft = (f: (key: string) => void) => void heard.add(f);

export function draftOf(key: string): Draft | undefined {
  if (route?.owns(key)) {
    const text = route.get(key);
    return text ? { text, files: [] } : undefined;
  }
  return drafts.get(key);
}

/** an input's text (and files) as typed there; empty: nothing kept */
export function setDraft(key: string, d: Draft | string) {
  const v = typeof d === "string" ? { text: d, files: [] } : d;
  if (route?.owns(key)) return route.set(key, v.text);
  if (v.text || v.files.length) drafts.set(key, v);
  else drafts.delete(key);
  if (key.startsWith("main:")) for (const f of heard) f(key);
}

/** text put into an input from elsewhere (another device): kept, and shown in that input if it is open */
export function pushDraft(key: string, text: string) {
  const had = drafts.get(key);
  if (text) drafts.set(key, { text, files: had?.files ?? [], nums: had?.nums });
  else if (!had?.files.length) drafts.delete(key);
  setPushed((p) => ({ ...p, [key]: text }));
}

/** what an open input with this key should show now when it came from elsewhere (reactive) */
export const draftFromAfar = (key: string): string | undefined => (route?.owns(key) ? (route.get(key) ?? "") : pushed()[key]);

export const hasDraft = (key: string) => !!draftOf(key);

/** every main chat's unsent text kept here, by key */
export const mainDrafts = (): [string, string][] => [...drafts].filter(([k, d]) => k.startsWith("main:") && d.text).map(([k, d]) => [k, d.text]);
