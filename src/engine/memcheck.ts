// Memory is checked, not trusted: what the 교차 검토 lenses found about the
// memory the job was given. Confirmed → stamped; contradicted with evidence →
// an agent-made piece is retired, the user's own piece goes to 확인 필요 (never
// changed for them); a contradiction without a quote is dropped.
import { fsRead } from "../lib/native";
import { homeDir, setState, state } from "../state/store";
import type { MemoryCheck, Task } from "../state/types";
import { LENSES } from "./crosscheck";
import { applying, core, isLive, retireMemory, userOwned } from "./memory";
import { expand } from "./rpc";

const STATUS: Record<string, MemoryCheck["status"]> = { confirmed: "confirmed", contradicted: "contradicted", unchecked: "unchecked", "not checked": "unchecked", not_checked: "unchecked" };
const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);

/** The items of a lens's {"type":"memory-check"} block, cleaned. */
export function readMemoryCheck(raw: unknown): MemoryCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryCheck[] = [];
  for (const x of raw.slice(0, 16)) {
    const id = str(x?.id, 64)?.replace(/^\[|\]$/g, "");
    const status = STATUS[String(x?.status ?? "").toLowerCase()];
    if (!id || !status) continue;
    out.push({ id, status, evidence: str(x.evidence, 400), now: str(x.now, 300) });
  }
  return out;
}

/** the pieces a lens was shown with their [id]: the job's recalled ones and the always-on rules */
function given(job: Task, group: Task[]): Set<string> {
  const ids = new Set<string>();
  for (const k of group) for (const l of k.memorySnapshot ?? []) for (const m of l.matchAll(/\[([^\]\s]+)\]/g)) ids.add(m[1]);
  for (const m of core(applying(job.space, expand(homeDir(job)), expand, job.reach))) ids.add(m.id);
  return ids;
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const LOC = /([\w@.~/-]+\.[A-Za-z0-9]+):(\d+)/;

/**
 * A contradiction holds only with a location and a quote from it ("src/a.ts:12
 * `const retries = 5`"); when that file can be read, the quote must be in it.
 */
export async function grounded(evidence: string | undefined, cwd: string): Promise<boolean> {
  if (!evidence) return false;
  const loc = LOC.exec(evidence);
  const quotes = [...evidence.matchAll(/`([^`]+)`|"([^"]+)"|“([^”]+)”/g)].map((m) => (m[1] ?? m[2] ?? m[3]).replace(LOC, "").trim()).filter((q) => q.length >= 4);
  if (!loc || !quotes.length) return false;
  const path = loc[1].startsWith("/") ? loc[1] : `${cwd.replace(/\/+$/, "")}/${loc[1].replace(/^\.\//, "")}`;
  const f = await fsRead(expand(path)).catch(() => null);
  const text = f && !(f as { error?: string }).error && !f.binary ? f.text : null;
  if (typeof text !== "string") return true;
  return quotes.some((q) => flat(text).includes(flat(q)));
}

/**
 * Apply both lenses' memory checks at once. A piece the lenses judged
 * differently is left alone and listed as a disagreement. Returns the lines for
 * the combined message.
 */
export async function settleMemory(job: Task, group: Task[]): Promise<{ lines: string[]; split: string[] }> {
  const shown = given(job, group);
  const title = (k: Task) => LENSES.find((l) => l.lens === k.lens)?.title.split(" ")[0] ?? k.title;
  const by = new Map<string, { k: Task; c: MemoryCheck }[]>();
  let dropped = 0;
  for (const k of group.filter((x) => x.status === "done"))
    for (const c of k.memoryCheck ?? []) {
      if (!shown.has(c.id)) {
        dropped++;
        continue;
      }
      const ok = c.status === "confirmed" ? !!c.evidence : c.status === "contradicted" ? await grounded(c.evidence, k.cwd) : true;
      if (!ok) dropped++;
      else by.set(c.id, [...(by.get(c.id) ?? []), { k, c }]);
    }
  const n = { confirmed: 0, retired: 0, kept: 0, unchecked: 0 };
  const split: string[] = [];
  const now = Date.now();
  for (const [id, list] of by) {
    const m = state.memory.find((x) => x.id === id && isLive(x));
    if (!m) continue;
    const yes = list.filter((x) => x.c.status === "confirmed");
    const no = list.filter((x) => x.c.status === "contradicted");
    if (yes.length && no.length) {
      split.push(`- 메모리 [${id}] — ${yes.map((x) => `${title(x.k)}: 맞음`).join(", ")} · ${no.map((x) => `${title(x.k)}: 틀림 (${x.c.evidence})`).join(", ")}`);
      continue;
    }
    if (no.length) {
      const c = no[0].c;
      if (!userOwned(m)) {
        retireMemory(id, undefined, `교차 검토에서 코드와 달라서 내렸어요 · ${c.evidence}`.slice(0, 300));
        n.retired++;
      } else if (c.now) {
        // the user's own piece is never changed and nothing is asked: it stays as they wrote it
        n.kept++;
      } else dropped++;
      continue;
    }
    if (yes.length) {
      setState("memory", (x) => x.id === id, { verifiedAt: now });
      n.confirmed++;
    } else n.unchecked++;
  }
  const parts = [
    n.confirmed ? `맞음 ${n.confirmed}개 (확인 표시함)` : "",
    n.retired ? `틀린 에이전트 메모리 ${n.retired}개 내림` : "",
    n.kept ? `사용자 메모리 ${n.kept}개는 코드와 다르지만 그대로 둠 (사용자가 쓴 것)` : "",
    n.unchecked ? `확인 못 함 ${n.unchecked}개` : "",
    dropped ? `근거 없어 버림 ${dropped}개` : "",
  ].filter(Boolean);
  return { lines: parts.length ? [`- ${parts.join(" · ")}`] : [], split };
}
