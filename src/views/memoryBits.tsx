// Small pieces the memory tree and side share: badges on a piece, outcome of a
// finished job, dates, where a cited file is on disk.
import { Show } from "solid-js";
import { expand } from "../engine/rpc";
import { userOwned } from "../engine/memory";
import { state } from "../state/store";
import type { JournalEntry, Memory } from "../state/types";
import { Icon } from "../ui/Icon";
import { lang, t } from "../i18n";

export const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
export const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/** shown with t() */
export const OUTCOME: Record<JournalEntry["outcome"], string> = { done: "완료", failed: "실패", stopped: "중단" };

/** "11월 5일 14:32" / "Nov 5, 14:32" (year added when it isn't this year) */
export function stampOf(at: number) {
  const d = new Date(at);
  const year = d.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return d.toLocaleString(lang() === "en" ? "en-US" : "ko-KR", { year, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** a cited code file, as a path on disk (cites are relative to the piece's project or space) */
export function citePath(m: Memory, c: string) {
  if (c.startsWith("/") || c.startsWith("~")) return expand(c);
  const root = m.project ? expand(m.project) : m.space ? expand(state.spaces.find((s) => s.id === m.space)?.folder ?? "") : "";
  return root ? `${root.replace(/\/$/, "")}/${c.replace(/^\.\//, "")}` : c;
}

/** the task log entry a piece was learned from */
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
          <Icon name="route" size={12} />
          <Show when={props.globs}><span class="mb-glob">{m().paths![0]}{m().paths!.length > 1 ? ` +${m().paths!.length - 1}` : ""}</span></Show>
        </span>
      </Show>
      <Show when={m().skill}><span class="mb-i" title={`${t("스킬")} · ${m().skill}`}><Icon name="skill" size={12} /></span></Show>
      <Show when={props.cites && m().cites?.length}><span class="mb-i" title={m().cites!.join("\n")}><Icon name="file" size={12} /></span></Show>
      <Show when={(m().seen ?? 0) > 0}><span class="mb-n" title={t("반복")}>{t("{n}번", { n: m().seen! })}</span></Show>
      <Show when={userOwned(m())}><span class="mb-i mb-user" title={t("사용자")}><Icon name="lock" size={12} /></span></Show>
    </span>
  );
}
