// The engine, the browser and the analyzer are components: they live outside the app and come in
// once (cloned from the app on a fresh install, downloaded when a new version of one is out), so an
// update carries only the app. This follows how far each one is, for Settings, and makes a job
// that has to wait for one say so.
import { createSignal } from "solid-js";
import { componentsStatus, componentsWait, onComponents, setComponentGate, type ComponentStatus } from "../lib/native";
import { dropToast, toast } from "../state/ui";
import { t } from "../i18n";

const [list, setList] = createSignal<ComponentStatus[]>([]);
export const components = list;
export const componentOf = (name: string) => list().find((c) => c.name === name);
/** Being copied in or downloaded */
export const coming = (c: ComponentStatus | undefined) => !!c && (c.state === "queued" || c.state === "copying" || c.state === "downloading");

/** What Settings says about one: how far its download is, else nothing (the row shows its version). */
export function componentNote(c: ComponentStatus | undefined): string | null {
  if (!c) return null;
  if (c.state === "downloading") return t("받는 중 {p}%", { p: c.percent });
  if (c.state === "copying" || c.state === "queued") return t("준비 중");
  if (c.state === "failed") return t("받지 못했어요 · 잠시 뒤 다시 받아요");
  return null;
}

const WAITING: Record<string, string> = {
  engine: "에이전트를 받는 중이에요 · 받으면 바로 시작해요",
  chrome: "브라우저를 받는 중이에요 · 받으면 바로 시작해요",
};

/** A job start waits for the component; if that takes a moment, a notice says why until it's in. */
async function gate(name: string) {
  const done = componentsWait(name);
  let notice = 0;
  const slow = setTimeout(() => (notice = toast(t(WAITING[name] ?? "준비 중"), "info", undefined, { stay: true })), 400);
  try {
    return await done;
  } finally {
    clearTimeout(slow);
    if (notice) dropToast(notice);
  }
}

export async function startComponents(onReady: (name: string) => void) {
  setComponentGate(gate);
  const seen = new Map<string, ComponentStatus["state"]>();
  const take = (next: ComponentStatus[]) => {
    for (const c of next) {
      if (c.state === "ready" && seen.get(c.name) !== "ready" && seen.has(c.name)) onReady(c.name);
      seen.set(c.name, c.state);
    }
    setList(next);
  };
  await onComponents(take);
  take(await componentsStatus());
}
