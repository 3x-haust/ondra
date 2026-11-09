// Device hub state: every simulator/emulator/phone, refreshed while the app is in front,
// and which job is using each one (read from the jobs' commands).
//
// Each space is its own workspace, devices too: a device a job made belongs to that
// job's space, the user's own belong to the space they were put in (Space.devices),
// and one no space has yet shows in both until a job of one uses it.
import { untrack } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { devicesList, type Device } from "../lib/native";
import { setState, state, taskById } from "./store";
import type { Entry, SpaceId, Task } from "./types";

// a store reconciled by id: the same device stays the same object between polls,
// so its card (and the screen in it) isn't rebuilt every few seconds
const [store, setStore] = createStore<{ list: Device[] }>({ list: [] });
const all = () => store.list;

/** The job whose id is in the device's name (ondra-<id>, or a name a job gave it). */
function madeBy(d: Device): Task | undefined {
  for (const m of `${d.name} ${d.id}`.matchAll(/\bt[a-z0-9]{10,14}\b/g)) {
    const t = taskById(m[0]);
    if (t) return t;
  }
  return undefined;
}
/** Made by the device tool for one job (ondra-<id>): that job's alone. */
const jobsOwn = (d: Device) => /^ondra-/.test(d.name) || /^ondra-/.test(d.id);

/** The space a device belongs to; undefined while no space has it. */
export function deviceSpace(d: Device): SpaceId | undefined {
  const job = madeBy(d);
  if (job) return job.space;
  return state.spaces.find((s) => s.devices?.includes(d.id))?.id;
}

/** This space's devices, and the ones no space has yet. */
export const devicesIn = (space: SpaceId) => all().filter((d) => (deviceSpace(d) ?? space) === space);
export const devices = () => devicesIn(state.space);
export const bootedDevices = () => devices().filter((d) => d.booted);

/** Put a device in a space (undefined: in none, so both see it). Job-made devices go with their job. */
export function setDeviceSpace(d: Device, space: SpaceId | undefined) {
  setState("spaces", (list) => list.map((s) => ({ ...s, devices: [...(s.devices ?? []).filter((x) => x !== d.id), ...(s.id === space ? [d.id] : [])] })));
}

/** What a job of this space may drive: its devices (ids, names, serials), never another space's or another job's. */
export function allowedDevices(space: SpaceId, jobId?: string): string[] {
  const out = new Set<string>();
  for (const d of devicesIn(space)) {
    const job = madeBy(d);
    if (job && jobsOwn(d) && job.id !== jobId) continue;
    for (const k of [d.id, d.name, d.serial]) if (k) out.add(k);
  }
  return [...out];
}

/** A device no space has yet goes to the space whose job used it last. */
function claim() {
  for (const d of all()) {
    if (deviceSpace(d)) continue;
    const job = lastUser(d, state.tasks);
    if (job) setDeviceSpace(d, job.space);
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let busy: Promise<void> | null = null;
let last = 0;
export function refreshDevices(): Promise<void> {
  // one listing at a time: simctl alone takes a quarter second of CPU
  last = Date.now();
  busy ??= devicesList()
    .then((next) => {
      if (!next) return;
      setStore("list", reconcile(next, { key: "id" }));
      claim();
    })
    .catch(() => {})
    .finally(() => (busy = null));
  return busy;
}

/**
 * Keep the list fresh without spending the Mac on it: often while the device hub
 * is open, slowly while only the sidebar shows running devices, rarely when none
 * runs, never while the window is in the back (and at once when it comes back).
 */
export function watchDevices(hubOpen: () => boolean) {
  if (timer) return;
  const every = () => (hubOpen() ? 4_000 : all().some((d) => d.booted) ? 15_000 : 45_000);
  void refreshDevices();
  // a cheap clock; the listing itself runs only when it's due
  timer = setInterval(() => !document.hidden && Date.now() - last >= every() && void refreshDevices(), 2_000);
  document.addEventListener("visibilitychange", () => !document.hidden && void refreshDevices());
}

const says = (e: Entry, keys: string[]) =>
  e.kind === "tool" && (e.tool.kind === "bash" || e.tool.kind === "desktop" || e.tool.kind === "test" || e.tool.kind === "other") && keys.some((k) => (e.tool.detail ?? "").includes(k) || (e.tool.target ?? "").includes(k));
/** what each transcript was last found to say about a device: only lines added since are read again */
const seen = new WeakMap<Entry[], Map<string, { first?: string; last?: string; hit: boolean }>>();
/** whether a job's commands mention the device (a call never changes once made, so a transcript is read once) */
function mentions(t: Task, keys: string[]): boolean {
  const es = t.entries;
  const n = es.length;
  // what this depends on: lines coming and going, not each line's contents
  const first = es[0]?.id;
  const last = es[n - 1]?.id;
  return untrack(() => {
    const raw = unwrap(es);
    let byKey = seen.get(raw);
    if (!byKey) seen.set(raw, (byKey = new Map()));
    const key = keys.join("\n");
    const was = byKey.get(key);
    if (was && was.first === first && was.last === last) return was.hit;
    // grown at the end (nothing dropped at the start): read only the new lines
    let from = 0;
    if (was && was.first === first && !was.hit) {
      for (let i = n - 1; i >= 0; i--) if (es[i].id === was.last) (from = i + 1), (i = -1);
    } else if (was?.hit && was.first === first) from = n;
    let hit = !!(was?.hit && was.first === first);
    for (let i = from; i < n && !hit; i++) hit = says(es[i], keys);
    byKey.set(key, { first, last, hit });
    return hit;
  });
}

/** Among `tasks`, the job that mentions this device in its commands; a running one wins, then the latest. */
function lastUser(d: Device, tasks: Task[]): Task | undefined {
  const keys = [d.id, d.serial, d.name].filter((k): k is string => !!k && k.length > 3);
  const hits = tasks.filter((t) => mentions(t, keys));
  return hits.find((t) => t.status === "running") ?? hits.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
}

/** This space's job using the device (made it, or mentions it in its commands). */
export function usedBy(d: Device): Task | undefined {
  const made = madeBy(d);
  if (made && made.space !== state.space) return undefined;
  if (made && jobsOwn(d)) return taskById(made.parentId ?? "") ?? made;
  return lastUser(d, state.tasks.filter((t) => t.space === state.space));
}
