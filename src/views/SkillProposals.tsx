// Settings › 스킬, on top: changes proposed to skills from jobs that went badly
// (engine/skillReflect.ts). Each says what went wrong, which jobs it learned from,
// the change itself, and waits for 적용 or 무시.
import { createSignal, For, Show } from "solid-js";
import { applyEdits, applyProposal, dismissProposal, lineDiff, openProposals } from "../engine/skillReflect";
import { openTask } from "../state/ui";
import type { SkillProposal } from "../state/types";
import { Icon } from "../ui/Icon";
import { agoIn } from "../ui/bits";
import { t } from "../i18n";
import { GroupTitle } from "./Settings";
import "../styles/skill-proposals.css";

function Proposal(props: { p: SkillProposal }) {
  const [busy, setBusy] = createSignal(false);
  const diff = () => {
    const after = applyEdits(props.p.base, props.p.edits);
    return after == null ? [] : lineDiff(props.p.base, after);
  };
  return (
    <div class="sp-card">
      <div class="sp-head">
        <Icon name="skill" size={15} class="muted" />
        <b>{props.p.skill}</b>
        <span class="sp-when">{agoIn(props.p.at)}</span>
      </div>
      <p class="sp-diag">{props.p.diagnosis}</p>
      <div class="sp-jobs">
        <For each={props.p.lessons}>
          {(l) => (
            <button class="sp-job" title={t("작업 열기")} onClick={() => openTask(l.taskId)}>
              <span class="sp-job-title">{l.title ?? t("작업")}</span>
              <span class="sp-job-why">{l.problem.split(" · ").map((x) => t(x)).join(" · ")}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={diff().length}>
        <div class="sp-diff" aria-label={t("바뀌는 내용")}>
          <For each={diff()}>
            {(d) => (
              <Show when={d.kind !== "gap"} fallback={<span class="diff-line h">⋯</span>}>
                <span class="diff-line" classList={{ a: d.kind === "add", d: d.kind === "del" }}>
                  {d.kind === "add" ? "+ " : d.kind === "del" ? "− " : "  "}
                  {d.text}
                </span>
              </Show>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.p.why}>
        <p class="sp-why">
          <Icon name="arrow" size={13} />
          {props.p.why}
        </p>
      </Show>
      <div class="sp-foot">
        <Show when={props.p.kind !== "mine"}>
          <span class="sp-note">{t("기본 스킬은 내 사본으로 고쳐요 · 원래대로 되돌릴 수 있어요")}</span>
        </Show>
        <span class="spacer" />
        <button class="btn ghost sm" disabled={busy()} onClick={() => dismissProposal(props.p.id)}>{t("무시")}</button>
        <button class="btn primary sm" disabled={busy()} onClick={() => (setBusy(true), void applyProposal(props.p.id).finally(() => setBusy(false)))}>{t("적용")}</button>
      </div>
    </div>
  );
}

/** The open proposals, newest first; nothing when there are none. */
export function SkillProposals() {
  const list = () => [...openProposals()].sort((a, b) => b.at - a.at);
  return (
    <Show when={list().length}>
      <GroupTitle title={t("다듬기 제안")} />
      <div class="sp-list">
        <For each={list()}>{(p) => <Proposal p={p} />}</For>
      </div>
    </Show>
  );
}
