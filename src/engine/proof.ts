// Proof before "done" (after OmO's claim-receipt and gajae-code's quality gate):
// the job's evidence is checked against what actually happened in its session,
// not taken on its word.
//   test / build / run → the same command ran here, passed, and no code changed after it
//   file / shot        → the file is really there (a screenshot is not empty)
//   link               → kept as the job said (marked "자가 신고")
import { fsRead } from "../lib/native";
import type { Entry, Evidence, Task } from "../state/types";
import { expand } from "./rpc";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const isCode = (p: string) => !/\.(md|txt)$/i.test(p) && !/(^|\/)(now|handoff|log|memory|notes|todo)\.md$/i.test(p);
const toolAt = (e: Entry) => (e.kind === "tool" ? e.tool : undefined);

/** index of the last code edit in the transcript (-1 if none) */
export function lastCodeEdit(t: Task): number {
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const x = toolAt(t.entries[i]);
    if (x && (x.kind === "edit" || x.kind === "write") && x.ok !== false && !x.note && isCode((x.detail ?? "").split("\n")[0])) return i;
  }
  return -1;
}

function ranCommand(t: Task, ref: string): { at: number; ok: boolean } | null {
  const want = norm(ref.replace(/^\$\s*/, ""));
  if (want.length < 2) return null;
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const x = toolAt(t.entries[i]);
    if (!x || (x.kind !== "bash" && x.kind !== "test")) continue;
    const cmd = norm(x.detail ?? x.target ?? "");
    if (cmd.includes(want) || (cmd.length > 4 && want.includes(cmd))) return { at: i, ok: x.ok !== false };
  }
  return null;
}

/** Each item gets `check`; anything not backed by the session gets ok:false and a reason. */
export async function checkEvidence(t: Task, items: Evidence[]): Promise<Evidence[]> {
  const edited = lastCodeEdit(t);
  return Promise.all(
    items.map(async (e): Promise<Evidence> => {
      if (e.kind === "test" || e.kind === "build" || e.kind === "run") {
        const r = ranCommand(t, e.ref);
        if (!r) return { ...e, ok: false, check: "no-run", why: "돌린 기록이 없어요" };
        if (!r.ok) return { ...e, ok: false, check: "failed", why: "마지막 실행이 실패했어요" };
        if (edited > r.at) return { ...e, ok: false, check: "stale", why: "돌린 뒤에 코드가 바뀌었어요" };
        return { ...e, ok: true, check: "ran" };
      }
      if (e.kind === "file" || e.kind === "shot" || /^[/~]/.test(e.ref)) {
        const path = expand(e.ref.replace(/:\d+(:\d+)?$/, ""));
        const f = await fsRead(path).catch(() => null);
        const err = (f as { error?: string } | null)?.error;
        if (!f || err) return { ...e, ok: false, check: "missing", why: "파일이 없어요" };
        if (e.kind === "shot" && f.size < 4096) return { ...e, ok: false, check: "missing", why: "빈 스크린샷 같아요" };
        return { ...e, check: "exists" };
      }
      return { ...e, check: "self" };
    }),
  );
}

/** A review child that reported P1/P2 problems and nothing was fixed after it finished. */
export function reviewUnresolved(t: Task, kids: Task[]): boolean {
  const reviews = kids.filter((k) => k.review && k.status === "done").sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  const last = reviews[reviews.length - 1];
  if (!last) return false;
  const text = `${last.summary ?? ""}\n${last.result ?? ""}`;
  const found = /\bP[12]\b/.test(text) && !/(P1|P2)[^\n]{0,12}(없|0개|none)/i.test(text) && !/문제\s*없|발견\s*없|no (p1|p2|issues)/i.test(text);
  if (!found) return false;
  const editAt = lastCodeEdit(t);
  return editAt < 0 || (t.entries[editAt]?.at ?? 0) < (last.finishedAt ?? 0);
}
