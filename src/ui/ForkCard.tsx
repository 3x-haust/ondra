// A fork (or subagent) as a live card: state, what it is doing, plan
// progress, its subagents. Used in the main conversation and inside forks.
import { nowText } from "../engine/describe";
import { For, Show } from "solid-js";
import { state, taskById } from "../state/store";
import type { Task } from "../state/types";
import { openTask } from "../state/ui";
import { ago, compact, endedAt, now, short, statusLabel } from "./bits";
import { Icon } from "./Icon";
import { Glyph, glyphOf } from "../views/Sidebar";
import { costDetail, jobCost } from "./cost";
import { t as tr } from "../i18n";

/** A task's status glyph, the sidebar's shapes (glyphOf): review is the blue ring with a dot, never a check. */
export function StatusIcon(props: { t: Task; size?: "sm" | "md" }) {
  const g = () => glyphOf(props.t);
  return (
    <span class={`st-icon ${g()} ${props.size ?? "md"}`}>
      <Show
        when={g() === "running"}
        fallback={
          <Show when={g() === "done"} fallback={<i />}>
            <Icon name="check" size={props.size === "sm" ? 10 : 12} stroke={2.75} />
          </Show>
        }
      >
        <span class="spin" />
      </Show>
    </span>
  );
}

/** Status lines are for people: drop branch names, commit hashes and ids an agent may leave in. */
export function plain(text: string): string {
  return text
    .replace(/(최종\s*)?커밋[은는:]?\s*\(?`?\b[0-9a-f]{7,40}\b`?\)?\s*(입니다|이에요|예요)?/g, "커밋까지 했어요")
    .replace(/\(?\b[0-9a-f]{7,40}\b\)?/g, "")
    .replace(/\btask\/[\w-]+/g, "")
    .replace(/브랜치에\s*커밋\s*:?/g, "커밋했어요")
    .replace(/\s*:\s*(?=[.,]|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim();
}

export function line(t: Task): string {
  if (t.status === "done") return plain(t.summary || "") || tr("완료");
  if (t.status === "failed") return t.error || tr("실패");
  if (t.status === "waiting") return state.decisions.find((d) => d.taskId === t.id)?.question ?? tr("응답 대기 중");
  if (t.status === "queued") return tr("대기 중");
  if (t.status === "paused") return tr("일시정지");
  return plain(nowText(t.now)) || tr("시작하는 중");
}

export function ForkCard(props: { id: string; compact?: boolean }) {
  const t = () => taskById(props.id);
  const kids = () => state.tasks.filter((k) => k.parentId === props.id);
  const live = () => kids().filter((k) => k.status === "running").length;
  const planDone = () => t()!.plan.filter((p) => p.state === "done").length;
  /** how long it took and what it used, for the hover on a finished one */
  const took = (x: NonNullable<ReturnType<typeof t>>) => {
    const c = jobCost(x);
    return [c.ms ? tr("{d} 동안 작업", { d: short(c.ms) }) : "", costDetail(c)].filter(Boolean).join(" · ");
  };
  const time = () => {
    const x = t()!;
    if (x.status === "done") return glyphOf(x) === "inreview" ? tr("검토") : ago(endedAt(x) ?? x.createdAt);
    if (x.status === "running") return compact(now() - (x.startedAt ?? x.createdAt));
    return tr(statusLabel[x.status]);
  };
  /** the line under the title, unless it only says the state the right side already says ("일시정지" beside 일시정지) */
  const sub = () => {
    const x = t()!;
    const l = line(x).trim();
    const word = tr(statusLabel[x.status]);
    const same = [word, tr("대기 중"), tr("일시정지"), tr("실패"), tr("응답 대기 중"), tr("완료")].some((w) => w.toLowerCase() === l.toLowerCase());
    return x.status !== "running" && x.status !== "done" && same ? "" : l;
  };
  return (
    <Show when={t()} fallback={<div class="fork-card gone">{tr("삭제된 작업")}</div>}>
      {(x) => (
        <button class="fork-card" classList={{ [x().status]: true, compact: !!props.compact, review: glyphOf(x()) === "inreview" }} onClick={() => openTask(x().id)}>
          {/* the sidebar's glyph, so a queued subagent reads the same here as there (dashed ring) */}
          <Glyph t={x()} class="fork-glyph" />
          <span class="fork-main">
            <span class="fork-title">{x().title}</span>
            <Show when={sub()}>
              <span class="fork-line" classList={{ shimmer: x().status === "running" }}>{sub()}</span>
            </Show>
          </span>
          <span class="fork-side">
            <Show when={x().plan.length && x().status !== "done"}>
              <span class="fork-plan" title={`${planDone()}/${x().plan.length}`}>
                <For each={x().plan}>{(p) => <i class={p.state} />}</For>
              </span>
            </Show>
            <Show when={kids().length}>
              <span class="fork-kids" title={tr("서브에이전트")}>
                <Icon name="branch" size={12} />
                {live() ? `${live()}/${kids().length}` : kids().length}
              </span>
            </Show>
            {/* one time per card: when it ended; how long it took is on hover */}
            <span class="fork-time" title={x().status === "done" && !x().answer ? took(x()) || undefined : undefined}>{time()}</span>
            <Icon name="chevron" size={14} class="fork-go" />
          </span>
        </button>
      )}
    </Show>
  );
}
