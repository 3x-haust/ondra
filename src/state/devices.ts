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
export async function refreshDevices() {
  const next = await devicesList().catch(() => null);
  if (next) setStore("list", reconcile(next, { key: "id" }));
}
/** Poll every few seconds while the window is visible (simctl/adb are cheap). */
export function watchDevices() {
  if (timer) return;
  void refreshDevices();
  timer = setInterval(() => !document.hidden && void refreshDevices(), 6000);
}

/** The job that mentions this device in its commands; a running one wins, then the latest. */
export function usedBy(d: Device): Task | undefined {
  const keys = [d.id, d.serial, d.name].filter((k): k is string => !!k && k.length > 3);
  const mentions = (t: Task) =>
    t.entries.some((e) => e.kind === "tool" && (e.tool.kind === "bash" || e.tool.kind === "desktop" || e.tool.kind === "test") && keys.some((k) => (e.tool.detail ?? "").includes(k)));
  const hits = state.tasks.filter(mentions);
  return hits.find((t) => t.status === "running") ?? hits.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
}
