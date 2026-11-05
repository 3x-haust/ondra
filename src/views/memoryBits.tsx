// Small pieces the memory tree and side share: badges on a piece, outcome of a
// finished job, dates, where a cited file is on disk.
import { Show } from "solid-js";
import { expand } from "../engine/rpc";
import { userOwned } from "../engine/memory";
import { state } from "../state/store";
import type { JournalEntry, Memory } from "../state/types";
import { Icon } from "../ui/Icon";

export const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
export const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export const OUTCOME: Record<JournalEntry["outcome"], string> = { done: "끝남", failed: "실패", stopped: "멈춤" };

const pad = (n: number) => String(n).padStart(2, "0");
/** "11월 5일 14:32" (year added when it isn't this year) */
export function stampOf(t: number) {
  const d = new Date(t);
  const y = d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()}년 `;
  return `${y}${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** a cited code file, as a path on disk (cites are relative to the piece's project or space) */
export function citePath(m: Memory, c: string) {
  if (c.startsWith("/") || c.startsWith("~")) return expand(c);
  const root = m.project ? expand(m.project) : m.space ? expand(state.spaces.find((s) => s.id === m.space)?.folder ?? "") : "";
  return root ? `${root.replace(/\/$/, "")}/${c.replace(/^\.\//, "")}` : c;
}

/** the 일 기록 entry a piece was learned from */
export function learnedIn(m: Memory): JournalEntry | undefined {
  const list = state.journal ?? [];
  return list.find((e) => e.learned?.includes(m.id)) ?? (m.taskId ? list.find((e) => e.taskId === m.taskId) : undefined);
}

/** compact marks on a piece: path rule, the user's own, came up again, skill, cited files */
export function Badges(props: { m: Memory; globs?: boolean; cites?: boolean }) {
  const m = () => props.m;
  return (
    <span class="mb">
      <Show when={m().paths?.length}>
        <span class="mb-i mb-path" title={m().paths!.join("\n")}>
          <Icon name="route" size={11} />
          <Show when={props.globs}><span class="mb-glob">{m().paths![0]}{m().paths!.length > 1 ? ` +${m().paths!.length - 1}` : ""}</span></Show>
        </span>
      </Show>
      <Show when={m().skill}><span class="mb-i" title={`스킬 · ${m().skill}`}><Icon name="skill" size={11} /></span></Show>
      <Show when={props.cites && m().cites?.length}><span class="mb-i" title={m().cites!.join("\n")}><Icon name="file" size={11} /></span></Show>
      <Show when={(m().seen ?? 0) > 0}><span class="mb-n" title="다시 나온 횟수">{m().seen}번</span></Show>
      <Show when={userOwned(m())}><span class="mb-i mb-user" title="사용자"><Icon name="lock" size={10.5} /></span></Show>
    </span>
  );
}
