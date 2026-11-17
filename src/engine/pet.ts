// The main window's side of the pet (src/pet, src-tauri/src/pet.rs): it tells the pet what it is
// (Settings › 펫) and what happened (a job done, a question for the user, a failure, an answer
// given), and opens the job the pet was clicked on. A pet job makes new pets (skills/pet-maker)
// and sends {"type":"pet","id":…} to put one on.
import { createEffect, on } from "solid-js";
import { onEvent, petSay, petSet, type PetConfig, type PetWord } from "../lib/native";
import { decisionFor, setState, state, taskById } from "../state/store";
import type { Decision, Task } from "../state/types";

export const PET_SIZE = 88;
/** most pets on screen at once (src-tauri/src/pet.rs MAX_PETS) */
export const MAX_PETS = 5;
const petIds = () => {
  const p = state.settings.pet;
  const ids = p?.ids?.length ? p.ids : [p?.id || "default"];
  return ids.slice(0, MAX_PETS);
};
export const petConfig = (): PetConfig => ({
  on: !!state.settings.pet?.on,
  ids: petIds(),
  size: state.settings.pet?.size ?? PET_SIZE,
  names: state.settings.pet?.names,
  v: state.settings.pet?.v,
});

/** A pet picked or unpicked in Settings: on screen with the others, or off it (one always stays). */
export function togglePet(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids.length > 1 ? ids.filter((x) => x !== id) : ids;
  return [...ids, id].slice(-MAX_PETS);
}

/** A job's question as the pet carries it: answerable in its bubble when it is a plain choice (at most 3). */
export function petAsk(d: Decision | undefined) {
  if (!d || d.ui || !d.options.length || d.options.length > 3) return undefined;
  return { decisionId: d.id, question: d.question, options: d.options.map((o) => ({ id: o.id, label: o.label, primary: o.primary })) };
}

/** What the pet hears when a top-level job moves from `was` to its status now, if anything. */
export function petWord(t: Pick<Task, "id" | "status" | "parentId" | "title">, was: string | undefined, at = Date.now(), d?: Decision): PetWord | undefined {
  if (t.parentId || !was || was === t.status) return undefined;
  if (t.status === "done") return { kind: "done", taskId: t.id, title: t.title, at };
  if (t.status === "waiting") return { kind: "waiting", taskId: t.id, title: t.title, at, ask: petAsk(d) };
  if (t.status === "failed") return { kind: "failed", taskId: t.id, title: t.title, at };
  // it was waiting on the user and goes on: the question is answered
  if (was === "waiting") return { kind: "clear", taskId: t.id };
  return undefined;
}

export function tellPet(t: Task, was: string | undefined) {
  if (!state.settings.pet?.on) return;
  const w = petWord(t, was, Date.now(), decisionFor(t.id));
  if (w) void petSay(w).catch(() => {});
}

/** Put a pet on (a pet job made it): it joins the pets on screen. */
export function wearPet(id: string) {
  const clean = id.trim().replace(/[^\w.-]/g, "").slice(0, 64);
  if (!clean) return;
  const ids = petIds();
  // made again (a pet already out): its pictures are new, so the pets load them again
  setState("settings", "pet", { ...petConfig(), on: true, ids: ids.includes(clean) ? ids : [...ids, clean].slice(-MAX_PETS), v: Date.now() });
}
/** Settings: a pet clicked in the list goes on screen, or comes off it. */
export const pickPet = (id: string) => setState("settings", "pet", { ...petConfig(), on: true, ids: togglePet(petIds(), id) });

/** Keep the pet in step with Settings and the jobs running; open what it was clicked on, answer what it was answered. */
export function startPet(open: (t: Task) => void, openSettings: () => void) {
  createEffect(on(() => JSON.stringify(petConfig()), () => void petSet(petConfig()).catch(() => {})));
  createEffect(
    on(
      () => state.tasks.filter((t) => t.status === "running" && !t.parentId).length,
      (n) => state.settings.pet?.on && void petSay({ kind: "busy", n }).catch(() => {}),
    ),
  );
  // a question that comes a moment after its job started waiting: the pet gets its choices then
  const told = new Set<string>();
  createEffect(
    on(
      () => state.decisions.map((d) => d.id).join(","),
      () => {
        if (!state.settings.pet?.on) return;
        for (const d of state.decisions) {
          if (told.has(d.id)) continue;
          told.add(d.id);
          const t = taskById(d.taskId);
          if (t && !t.parentId && t.status === "waiting") void petSay({ kind: "waiting", taskId: t.id, title: t.title, at: Date.now(), ask: petAsk(d) }).catch(() => {});
        }
      },
    ),
  );
  void onEvent<{ taskId?: string; settings?: boolean }>("pet:open", ({ taskId, settings }) => {
    if (settings) return openSettings();
    const t = taskId ? taskById(taskId) : undefined;
    if (t) open(t);
  });
  void onEvent<{ answer?: { decisionId: string; optionId: string }; hide?: boolean }>("pet:tell", ({ answer, hide }) => {
    if (hide) setState("settings", "pet", { ...petConfig(), on: false });
    if (answer) void import("./tasks").then((m) => m.decide(answer.decisionId, answer.optionId));
  });
}
