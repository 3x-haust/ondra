// Device hub state: every simulator/emulator/phone, refreshed while the app is in front,
// and which job is using each one (read from the jobs' commands).
import { createStore, reconcile } from "solid-js/store";
import { devicesList, type Device } from "../lib/native";
import { state } from "./store";
import type { Task } from "./types";

// a store reconciled by id: the same device stays the same object between polls,
// so its card (and the screen in it) isn't rebuilt every few seconds
const [store, setStore] = createStore<{ list: Device[] }>({ list: [] });
export const devices = () => store.list;
export const bootedDevices = () => store.list.filter((d) => d.booted);

let timer: ReturnType<typeof setInterval> | undefined;
let busy: Promise<void> | null = null;
let last = 0;
export function refreshDevices(): Promise<void> {
  // one listing at a time: simctl alone takes a quarter second of CPU
  last = Date.now();
  busy ??= devicesList()
    .then((next) => void (next && setStore("list", reconcile(next, { key: "id" }))))
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
  const every = () => (hubOpen() ? 4_000 : bootedDevices().length ? 15_000 : 45_000);
  void refreshDevices();
  // a cheap clock; the listing itself runs only when it's due
  timer = setInterval(() => !document.hidden && Date.now() - last >= every() && void refreshDevices(), 2_000);
  document.addEventListener("visibilitychange", () => !document.hidden && void refreshDevices());
}

/** The job that mentions this device in its commands; a running one wins, then the latest. */
export function usedBy(d: Device): Task | undefined {
  const keys = [d.id, d.serial, d.name].filter((k): k is string => !!k && k.length > 3);
  const mentions = (t: Task) =>
    t.entries.some((e) => e.kind === "tool" && (e.tool.kind === "bash" || e.tool.kind === "desktop" || e.tool.kind === "test") && keys.some((k) => (e.tool.detail ?? "").includes(k)));
  const hits = state.tasks.filter(mentions);
  return hits.find((t) => t.status === "running") ?? hits.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
}
