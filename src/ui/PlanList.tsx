// The to-do list under a job and in its side panel: big steps in the order of the work,
// the smaller steps of the one being worked on under it, a step the user asked for
// while it worked marked as theirs, and their newest words until the job places them.
import { For, Show } from "solid-js";
import type { PlanStep, Task } from "../state/types";
import { stepState } from "../state/progress";
import { t as tr } from "../i18n";
import { Icon } from "./Icon";

function Row(props: { s: PlanStep; t: Task; sub?: boolean }) {
  const st = () => stepState(props.s, props.t);
  return (
    <li class={`todo ${st()}`} classList={{ "todo-sub": !!props.sub }}>
      <span class="todo-box">
        <Show when={props.s.state === "done"} fallback={<Show when={st() === "now"}><i /></Show>}>
          <Icon name="check" size={props.sub ? 8 : 10} stroke={3} />
        </Show>
      </span>
      <span class="todo-text">{props.s.text}</span>
      <Show when={props.s.user}>
        <span class="todo-user" title={tr("일하는 중에 요청한 일이에요")}>{tr("요청|plan")}</span>
      </Show>
    </li>
  );
}

/** the big step being worked on opens to its smaller steps; the others stay one line */
const opened = (s: PlanStep) => !!s.sub?.length && s.state === "now";

export function PlanList(props: { t: Task; class?: string }) {
  return (
    <ol class={`todos-list ${props.class ?? ""}`}>
      <For each={props.t.plan}>
        {(s) => (
          <>
            <Row s={s} t={props.t} />
            <Show when={opened(s)}>
              <For each={s.sub}>{(x) => <Row s={x} t={props.t} sub />}</For>
            </Show>
          </>
        )}
      </For>
      <Show when={props.t.status === "running" && props.t.planAsk}>
        <li class="todo todo-ask" title={props.t.planAsk}>
          <span class="todo-box" />
          <span class="todo-text">
            <span class="shimmer">{tr("새 요청 정리 중")}</span> · {props.t.planAsk}
          </span>
        </li>
      </Show>
    </ol>
  );
}
