// A fork (or subagent) as a live card: state, what it is doing, plan
// progress, its subagents. Used in the main conversation and inside forks.
import { For, Show } from "solid-js";
import { state, taskById } from "../state/store";
import type { Task } from "../state/types";
import { openTask } from "../state/ui";
import { compact, now, statusLabel, ago } from "./bits";
import { Icon } from "./Icon";
import { costDetail, jobCost } from "./cost";
import { t as tr } from "../i18n";

export function StatusIcon(props: { t: Task; size?: "sm" | "md" }) {
  return (
    <span class={`st-icon ${props.t.status} ${props.size ?? "md"}`} classList={{ unmerged: props.t.status === "done" && props.t.worktree?.state === "open" }}>
      <Show
        when={props.t.status === "running"}
        fallback={
          <Show when={props.t.status === "done"} fallback={<i />}>
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
  return plain(t.now || "") || tr("시작하는 중");
}

export function ForkCard(props: { id: string; compact?: boolean }) {
  const t = () => taskById(props.id);
  const kids = () => state.tasks.filter((k) => k.parentId === props.id);
  const live = () => kids().filter((k) => k.status === "running").length;
  const planDone = () => t()!.plan.filter((p) => p.state === "done").length;
  const time = () => {
    const x = t()!;
    if (x.status === "done") return ago(x.finishedAt ?? x.createdAt);
    if (x.status === "running") return compact(now() - (x.startedAt ?? x.createdAt));
    return tr(statusLabel[x.status]);
  };
  return (
    <Show when={t()} fallback={<div class="fork-card gone">{tr("삭제된 작업")}</div>}>
      {(x) => (
        <button class={`fork-card ${x().status}`} classList={{ compact: props.compact }} onClick={() => openTask(x().id)}>
          <StatusIcon t={x()} />
          <span class="fork-main">
            <span class="fork-title">{x().title}</span>
            <span class="fork-line" classList={{ shimmer: x().status === "running" }}>{line(x())}</span>
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
            <span class="fork-time" title={x().status === "done" && !x().answer ? costDetail(jobCost(x())) || undefined : undefined}>{time()}</span>
            <Icon name="chevron" size={14} class="fork-go" />
          </span>
        </button>
      )}
    </Show>
  );
}
