// Versions of the memory (Codex / Letta / nanobot keep theirs in git): the
// memory folder is its own git repo. A quiet while after the pieces change, the
// markdown files plus a JSON copy of the pieces are committed with a short
// message ("기억 +2 · 바뀜 1 · 내림 1"). Any version can be brought back.
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { inTauri, memoryGitCommit, memoryGitLog, memoryGitShow } from "../lib/native";
import { loaded, setState, state } from "../state/store";
import type { Memory } from "../state/types";
import { toast } from "../state/ui";

const QUIET_MS = 20_000;
const [version, setVersion] = createSignal(0);
/** bumps after each saved version (for lists to refetch) */
export const memoryVersion = version;

let last: Map<string, string> | undefined;
const sig = (m: Memory) => `${m.text}|${m.kind}|${m.invalidAt ?? ""}|${m.importance ?? ""}|${(m.paths ?? []).join(",")}`;

function message(now: Memory[]): string {
  const cur = new Map(now.map((m) => [m.id, sig(m)]));
  if (!last) return `${now.filter((m) => !m.invalidAt).length}개`;
  let add = 0, change = 0, retire = 0, gone = 0;
  for (const m of now) {
    const was = last.get(m.id);
    if (was === undefined) add++;
    else if (was !== cur.get(m.id)) (m.invalidAt && !was.split("|")[2] ? retire++ : change++);
  }
  for (const id of last.keys()) if (!cur.has(id)) gone++;
  return [add && `+${add}`, change && `바뀜 ${change}`, retire && `내림 ${retire}`, gone && `지움 ${gone}`].filter(Boolean).join(" · ") || "정리";
}

async function save() {
  const list = state.memory;
  const msg = `기억 ${message(list)}`;
  const sha = await memoryGitCommit(msg, JSON.stringify(list, null, 1)).catch(() => null);
  last = new Map(list.map((m) => [m.id, sig(m)]));
  if (sha) setVersion((n) => n + 1);
}

export const memoryHistory = (limit = 60) => memoryGitLog(limit);

/** Bring the pieces back as they were in a version (the current ones are saved first, so this can be undone). */
export async function restoreMemoryAt(sha: string): Promise<number> {
  const raw = await memoryGitShow(sha);
  let list: Memory[];
  try {
    list = JSON.parse(raw);
    if (!Array.isArray(list) || !list.every((m) => m && typeof m.id === "string" && typeof m.text === "string")) throw 0;
  } catch {
    toast("그 버전을 읽지 못했어요", "bad");
    return 0;
  }
  await save();
  setState("memory", list);
  await memoryGitCommit(`되돌림 · ${sha}`, JSON.stringify(list, null, 1)).catch(() => null);
  last = new Map(list.map((m) => [m.id, sig(m)]));
  setVersion((n) => n + 1);
  return list.filter((m) => !m.invalidAt).length;
}

createRoot(() => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => loaded() && state.memory.map(sig).join("\n"),
      (k) => {
        if (!k || !inTauri || location.search.includes("fixture")) return;
        clearTimeout(timer);
        timer = setTimeout(() => void save(), last ? QUIET_MS : 4000);
      },
    ),
  );
});
