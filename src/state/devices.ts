// Device hub state: every simulator/emulator/phone, refreshed while the app is in front,
// and which job is using each one (read from the jobs' commands).
//
// Each space is its own workspace, devices too: a device a job made belongs to that
// job's space, the user's own belong to the space they were put in (Space.devices),
// and one no space has yet shows in both until a job of one uses it.
import { createStore, reconcile } from "solid-js/store";
import { devicesList, type Device } from "../lib/native";
import { setState, state, taskById } from "./store";
import type { SpaceId, Task } from "./types";

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

/** Among `tasks`, the job that mentions this device in its commands; a running one wins, then the latest. */
function lastUser(d: Device, tasks: Task[]): Task | undefined {
  const keys = [d.id, d.serial, d.name].filter((k): k is string => !!k && k.length > 3);
  const mentions = (t: Task) =>
    t.entries.some((e) => e.kind === "tool" && (e.tool.kind === "bash" || e.tool.kind === "desktop" || e.tool.kind === "test" || e.tool.kind === "other") && keys.some((k) => (e.tool.detail ?? "").includes(k) || (e.tool.target ?? "").includes(k)));
  const hits = tasks.filter(mentions);
  return hits.find((t) => t.status === "running") ?? hits.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
}

/** This space's job using the device (made it, or mentions it in its commands). */
export function usedBy(d: Device): Task | undefined {
  const made = madeBy(d);
  if (made && made.space !== state.space) return undefined;
  if (made && jobsOwn(d)) return taskById(made.parentId ?? "") ?? made;
  return lastUser(d, state.tasks.filter((t) => t.space === state.space));
}
