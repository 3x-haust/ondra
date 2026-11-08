// Bring over what the user already set up in other agent tools: instructions,
// skills, memory notes, and sessions to continue. Read-only on their side;
// tokens are never copied.
import { createSignal } from "solid-js";
import { setState, state } from "../state/store";
import type { SpaceId } from "../state/types";
import { readTranscript, scanAgents, type ImportSession, type ImportSource } from "../lib/native";
import { addMemory } from "./memory";
import { createTask } from "./tasks";

export const [sources, setSources] = createSignal<ImportSource[]>([]);
export const [scanning, setScanning] = createSignal(false);

export async function scan() {
  setScanning(true);
  try {
    setSources(await scanAgents());
  } finally {
    setScanning(false);
  }
  return sources();
}

const stripFront = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();

export interface ImportPick {
  rules: boolean;
  skills: boolean;
  memories: boolean;
}

/** Import everything picked from the given sources. Safe to run again (no duplicates). */
/** Imports go into one space (the one on screen), never into every space. */
export function importFrom(list: ImportSource[], pick: ImportPick, space: SpaceId = state.space) {
  let rules = 0;
  let skills = 0;
  let memories = 0;
  for (const src of list) {
    if (pick.rules) {
      // another tool's global instructions become pinned pieces, one per line (the
      // same structure as everything else), not a block of text in settings
      for (const r of src.rules) {
        const text = stripFront(r.text);
        const h = `${text.length}:${text.slice(0, 64)}`;
        if (!text || state.absorbed?.[r.path] === h) continue;
        const before = state.memory.length;
        addMemory(text.replace(/^#+ .*$/gm, ""), "space", { space, source: src.id, pinned: true, kind: "rule", from: r.path, quiet: true });
        setState("absorbed", (x) => ({ ...(x ?? {}), [r.path]: h }));
        rules += state.memory.length - before;
      }
    }
    if (pick.skills) {
      const have = new Set(state.skills.map((s) => s.path));
      const names = new Set(state.skills.map((s) => s.name));
      const fresh = src.skills.filter((s) => !have.has(s.path) && !names.has(s.name));
      if (fresh.length) {
        setState("skills", (cur) => [...cur, ...fresh.map((s) => ({ name: s.name, path: s.path, description: s.description, source: src.id, enabled: true, space }))]);
        skills += fresh.length;
      }
    }
    if (pick.memories) {
      for (const m of src.memories) {
        if (/(^|\/)MEMORY\.md$/i.test(m.path)) continue;
        const body = stripFront(m.text);
        if (!body) continue;
        const before = state.memory.length;
        addMemory(body.replace(/^#+ .*$/gm, ""), m.project ? "project" : "space", { space, project: m.project || undefined, source: src.id, from: m.path, quiet: true });
        memories += state.memory.length - before;
      }
    }
  }
  return { rules, skills, memories };
}

/** Continue a session from another tool as an Ondra task. */
export async function continueSession(s: ImportSession, space: SpaceId, sourceName: string): Promise<string> {
  const tr = await readTranscript(s.source, s.path);
  const cwd = tr.cwd || s.cwd;
  const turns = tr.turns.slice(-80);
  let body = turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");
  if (body.length > 40_000) body = `…\n${body.slice(-40_000)}`;
  const lastAsk = [...turns].reverse().find((t) => t.role === "user")?.text ?? s.title;
  const ask = [
    `${sourceName}에서 진행하던 작업을 이어받습니다.`,
    "",
    "# 이전 대화 (최근 부분)",
    body || "(기록 없음)",
    "",
    "# 할 일",
    "위 대화의 마지막 요청과 남은 일을 파악해서 이어서 진행하세요. 먼저 현재 상태를 확인하고 plan을 보내세요.",
  ].join("\n");
  const topic = cwd ? cwd.split("/").filter(Boolean).pop() ?? "가져옴" : "가져옴";
  return createTask({
    space,
    title: s.title,
    topic,
    ask,
    cwd: cwd || undefined,
    origin: { source: s.source, path: s.path },
    display: `${sourceName} 세션 이어받기\n\n마지막 요청: ${lastAsk.slice(0, 400)}`,
  });
}

/** All sessions across sources, newest first. */
export const allSessions = () =>
  sources()
    .flatMap((s) => s.sessions.map((x) => ({ ...x, sourceName: s.name })))
    .sort((a, b) => b.updatedAt - a.updatedAt);
