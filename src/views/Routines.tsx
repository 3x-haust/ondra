// Settings › 루틴, and the card main shows in the chat when it proposes one. A routine is a prompt,
// a project and a "when"; its runs are ordinary jobs (engine/routines.ts). The project picker holds
// this Mac's projects and the other Macs' ones: a routine on another Mac's project runs there.
// An alarm is a routine with no job: its words, a time and a repeat (no project, no way of running);
// when it rings the chat gets a line (AlarmLine) and the Mac a notice with a sound.
import { createMemo, createSignal, For, Show } from "solid-js";
import { projectById, projectsShown, state } from "../state/store";
import type { Route, Routine, RoutineEvent, RoutineWhen } from "../state/types";
import { openTask, setView, toast } from "../state/ui";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";
import { addRoutine, removeRoutine, routineById, routineLine, routinesIn, runRoutine, runsOf, saveRoutine, SNOOZE_MIN, snoozeAlarm } from "../engine/routines";
import { dayTime, describeWhen, EVENT_LABEL, MIN_EVERY, validTime } from "../engine/routineTime";
import { EmptyState, PageHead, Switch_ } from "./Settings";

/** the routine the page opens with (a chat card's 수정) */
export const [editing, setEditing] = createSignal<string | null>(null);
export const openRoutine = (id: string) => (setEditing(id), setView({ name: "settings", tab: "routines" }));

const DAYS = ["일|day", "월|day", "화|day", "수|day", "목|day", "금|day", "토|day"];
type Kind = "daily" | "every" | "once" | "event";

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The form for one routine: what, where, when, how. Saves into a copy until 저장. */
function Editor(props: { r: Routine; onDone: () => void }) {
  const r = props.r;
  const [title, setTitle] = createSignal(r.title);
  const [prompt, setPrompt] = createSignal(r.prompt);
  const [project, setProject] = createSignal(r.project ?? "");
  const [kind, setKind] = createSignal<Kind>(r.when.kind);
  const [time, setTime] = createSignal(r.when.kind === "daily" ? r.when.time : "09:00");
  const [days, setDays] = createSignal<number[]>(r.when.kind === "daily" ? (r.when.days ?? []) : []);
  const [minutes, setMinutes] = createSignal(r.when.kind === "every" ? r.when.minutes : 60);
  const [at, setAt] = createSignal(r.when.kind === "once" ? localInput(r.when.at) : localInput(Date.now() + 3_600_000));
  const [event, setEvent] = createSignal<RoutineEvent>(r.when.kind === "event" ? r.when.event : "issue");
  const [filter, setFilter] = createSignal(r.when.kind === "event" ? (r.when.filter ?? "") : "");
  const [mode, setMode] = createSignal(r.mode);
  const [quiet, setQuiet] = createSignal(r.quiet);
  const projects = createMemo(() => projectsShown(r.space));

  const when = (): RoutineWhen | undefined => {
    switch (kind()) {
      case "daily":
        return validTime(time()) ? { kind: "daily", time: time(), ...(days().length && days().length < 7 ? { days: [...days()].sort() } : {}) } : undefined;
      case "every":
        return minutes() >= MIN_EVERY ? { kind: "every", minutes: minutes() } : undefined;
      case "once": {
        const ms = Date.parse(at());
        return Number.isFinite(ms) && ms > Date.now() ? { kind: "once", at: ms } : undefined;
      }
      case "event":
        return { kind: "event", event: event(), ...(filter().trim() ? { filter: filter().trim() } : {}) };
    }
  };
  const alarm = !!r.alarm;
  const problem = () =>
    !prompt().trim() ? (alarm ? t("알려 줄 말을 적어 주세요") : t("할 일을 적어 주세요")) : !when() ? (kind() === "once" ? t("지나지 않은 시간을 골라 주세요") : t("시간을 확인해 주세요")) : kind() === "event" && !project() ? t("GitHub 사건은 프로젝트가 필요해요") : "";
  const save = () => {
    const w = when();
    if (!w || problem()) return;
    if (alarm) {
      // an alarm's name is its words; it stays in the chat it was set in
      saveRoutine(r.id, { title: prompt().trim().slice(0, 80), prompt: prompt().trim(), when: w, snoozeAt: undefined, ...(r.draft ? { draft: false, enabled: true } : {}) });
      toast(t("알람 «{name}»: {when}", { name: prompt().trim().slice(0, 40), when: describeWhen(w) }));
      return props.onDone();
    }
    saveRoutine(r.id, { title: title().trim() || prompt().trim().slice(0, 40), prompt: prompt().trim(), project: project() || undefined, when: w, mode: mode(), quiet: quiet(), ...(r.draft ? { draft: false, enabled: true } : {}) });
    toast(t("루틴 «{name}»: {when}", { name: title().trim() || prompt().trim().slice(0, 40), when: describeWhen(w) }));
    props.onDone();
  };
  const toggleDay = (d: number) => setDays((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]));

  return (
    <div class="rt-edit">
      <Show when={!alarm}>
        <input class="input rt-title" placeholder={t("이름")} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} aria-label={t("이름")} />
      </Show>
      <textarea
        class="rt-prompt"
        rows={alarm ? 2 : 3}
        placeholder={alarm ? t("알려 줄 말. 예: 회의 10분 전이에요") : t("할 일. 예: 열린 PR을 보고 리뷰가 필요한 것만 정리해 줘")}
        value={prompt()}
        onInput={(e) => setPrompt(e.currentTarget.value)}
        aria-label={alarm ? t("알려 줄 말") : t("할 일")}
      />
      <div class="rt-line">
        <select class="select" value={kind()} onChange={(e) => setKind(e.currentTarget.value as Kind)} aria-label={t("언제")}>
          <option value="daily">{t("정해진 시간")}</option>
          <option value="every">{t("간격마다")}</option>
          <option value="once">{t("한 번")}</option>
          <Show when={!alarm}><option value="event">{t("GitHub에서 일이 생기면")}</option></Show>
        </select>
        <Show when={kind() === "daily"}>
          <input class="input rt-time" type="time" value={time()} onInput={(e) => setTime(e.currentTarget.value)} aria-label={t("시간")} />
          <span class="rt-days">
            <For each={DAYS}>
              {(d, i) => (
                <button type="button" class="rt-day" classList={{ on: days().includes(i()) }} aria-pressed={days().includes(i())} onClick={() => toggleDay(i())}>{t(d)}</button>
              )}
            </For>
          </span>
        </Show>
        <Show when={kind() === "every"}>
          <select class="select" value={String(minutes())} onChange={(e) => setMinutes(Number(e.currentTarget.value))} aria-label={t("간격")}>
            <For each={[15, 30, 60, 120, 180, 360, 720, 1440]}>{(m) => <option value={m}>{describeWhen({ kind: "every", minutes: m })}</option>}</For>
          </select>
        </Show>
        <Show when={kind() === "once"}>
          <input class="input rt-at" type="datetime-local" value={at()} onInput={(e) => setAt(e.currentTarget.value)} aria-label={t("시간")} />
        </Show>
        <Show when={kind() === "event"}>
          <select class="select" value={event()} onChange={(e) => setEvent(e.currentTarget.value as RoutineEvent)} aria-label={t("사건")}>
            <For each={Object.keys(EVENT_LABEL) as RoutineEvent[]}>{(ev) => <option value={ev}>{t(EVENT_LABEL[ev])}</option>}</For>
          </select>
          <input class="input rt-filter" placeholder={event() === "issue" || event() === "pr" || event() === "review" ? t("검색어 (예: label:bug)") : t("제목에 들어갈 말")} value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} aria-label={t("거르기")} />
        </Show>
      </div>
      <Show when={!alarm}>
      <div class="rt-line">
        <select class="select" value={project()} onChange={(e) => setProject(e.currentTarget.value)} aria-label={t("프로젝트")}>
          <option value="">{t("프로젝트 없이")}</option>
          <For each={projects()}>{(p) => <option value={p.id}>{p.host ? `${p.name} · ${p.hostName ?? "Mac"}` : p.name}</option>}</For>
        </select>
        <select class="select" value={mode()} onChange={(e) => setMode(e.currentTarget.value as Routine["mode"])} aria-label={t("실행 방식")}>
          <option value="continue">{t("지난 실행에 이어서")}</option>
          <option value="fresh">{t("매번 새로")}</option>
        </select>
        <label class="rt-quiet">
          <Switch_ on={quiet()} set={setQuiet} label={t("할 일 없으면 조용히")} />
          {t("할 일 없으면 조용히")}
        </label>
      </div>
      </Show>
      <div class="rt-foot">
        <Show when={problem()}><span class="rt-problem">{problem()}</span></Show>
        <span class="spacer" />
        <button class="btn ghost sm" onClick={props.onDone}>{t("취소")}</button>
        <button class="btn primary sm" disabled={!!problem()} onClick={save}>{r.draft ? (alarm ? t("알람 맞추기") : t("루틴 만들기")) : t("저장")}</button>
      </div>
    </div>
  );
}

/** One routine's row: on/off, name, when · where · next, and its actions. */
function RoutineRow(props: { r: Routine }) {
  const r = () => props.r;
  const [confirm, setConfirm] = createSignal(false);
  const where = () => (r().project ? (projectById(r().project)?.name ?? t("지운 프로젝트")) : "");
  const last = () => (r().lastTask ? runsOf(r().id).slice(-1)[0]?.id ?? r().lastTask : undefined);
  return (
    <Show
      when={editing() !== r().id}
      fallback={<Editor r={r()} onDone={() => (r().draft && !r().from ? removeRoutine(r().id) : undefined, setEditing(null))} />}
    >
      <div class="rt-row" classList={{ off: !r().enabled }}>
        <Switch_ on={r().enabled} set={(on) => saveRoutine(r().id, { enabled: on })} label={r().enabled ? t("켜짐") : t("꺼짐")} />
        <button class="rt-main" onClick={() => setEditing(r().id)} title={r().prompt}>
          <b><Show when={r().alarm}><Icon name="bell" size={13} class="rt-bell" /></Show>{r().title}</b>
          <span class="rt-sub">{[r().alarm ? t("알람") : "", describeWhen(r().when), r().alarm ? "" : where(), routineLine(r())].filter(Boolean).join(" · ")}</span>
        </button>
        <Show
          when={!confirm()}
          fallback={
            <>
              <button class="btn sm danger" onClick={() => (removeRoutine(r().id), setConfirm(false))}>{t("삭제")}</button>
              <button class="btn ghost sm" onClick={() => setConfirm(false)}>{t("취소")}</button>
            </>
          }
        >
          <Show when={!r().alarm && last()}>
            <button class="icon-btn sm" title={t("최근 실행 보기")} aria-label={t("최근 실행 보기")} onClick={() => openTask(last()!)}><Icon name="history" size={14} /></button>
          </Show>
          <Show when={!r().alarm}>
            <button class="icon-btn sm" title={t("지금 실행")} aria-label={t("지금 실행")} onClick={() => { const id = runRoutine(r().id, { manual: true }); if (id) openTask(id); }}><Icon name="play" size={14} /></button>
          </Show>
          <button class="icon-btn sm" title={t("삭제")} aria-label={t("삭제")} onClick={() => setConfirm(true)}><Icon name="trash" size={14} /></button>
        </Show>
      </div>
    </Show>
  );
}

export function RoutinesSettings() {
  const list = () => [...routinesIn(state.space), ...(state.routines ?? []).filter((r) => r.space === state.space && r.draft && editing() === r.id)];
  const add = () => setEditing(addRoutine({ space: state.space, title: "", prompt: "", when: { kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] }, mode: "continue", draft: true }));
  const addAlarm = () => setEditing(addRoutine({ space: state.space, title: "", prompt: "", when: { kind: "once", at: Date.now() + 3_600_000 }, mode: "fresh", quiet: false, alarm: true, draft: true }));
  return (
    <>
      <PageHead tab="routines">
        <Show when={list().length}>
          <button class="btn sm" onClick={addAlarm}><Icon name="bell" size={14} />{t("알람 추가")}</button>
          <button class="btn sm" onClick={add}><Icon name="plus" size={14} />{t("추가")}</button>
        </Show>
      </PageHead>
      <div class="set-group">
        <For
          each={list()}
          fallback={
            <EmptyState icon="repeat" title={t("루틴 없음")} desc={t("정해진 시간에 알려 주거나, 시간이나 GitHub 일에 맞춰 작업을 시작해요. 채팅에서 \"3시에 알려줘\", \"매일 9시에 …\"라고 해도 돼요.")}>
              <button class="btn sm" onClick={add}><Icon name="plus" size={14} />{t("루틴 만들기")}</button>
              <button class="btn sm" onClick={addAlarm}><Icon name="bell" size={14} />{t("알람 추가")}</button>
            </EmptyState>
          }
        >
          {(r) => <RoutineRow r={r} />}
        </For>
      </div>
    </>
  );
}

/** In the chat: the alarm main set (already on), to change or drop. */
function AlarmCard(props: { r: Routine }) {
  const r = () => props.r;
  return (
    <div class="rt-card alarm-card">
      <div class="rt-card-head">
        <Icon name="bell" size={14} />
        <b>{t("알람")}</b>
        <span class="rt-sub">{[describeWhen(r().when), routineLine(r())].filter(Boolean).join(" · ")}</span>
        <span class="spacer" />
        <button class="btn ghost sm" onClick={() => openRoutine(r().id)}>{t("고치기")}</button>
        <Show when={r().enabled || r().snoozeAt}>
          <button class="btn ghost sm" onClick={() => removeRoutine(r().id)}>{t("알람 취소")}</button>
        </Show>
      </div>
      <p class="rt-card-prompt">{r().prompt}</p>
    </div>
  );
}

/** In the chat: an alarm that rang, its words as they were set, and a snooze. */
export function AlarmLine(props: { route: Extract<Route, { kind: "alarm" }> }) {
  const a = () => props.route;
  const r = () => routineById(a().routineId);
  const snoozed = () => (r()?.snoozeAt ?? 0) > Date.now();
  return (
    <div class="alarm-line" classList={{ late: !!a().late }} role="status">
      <span class="alarm-ic"><Icon name="bell" size={15} /></span>
      <div class="alarm-body">
        <span class="alarm-when">
          {t("{time} 알람", { time: dayTime(a().due) })}
          <Show when={a().late}> · {t("늦게 울렸어요 (Ondra가 꺼져 있었거나 Mac이 잠들어 있었어요)")}</Show>
        </span>
        <b class="alarm-text">{a().text}</b>
      </div>
      <Show when={r()}>
        {(x) => (
          <Show when={!snoozed()} fallback={<span class="rt-sub">{routineLine(x())}</span>}>
            <button class="btn ghost sm" onClick={() => snoozeAlarm(x().id)}>{t("{n}분 뒤 다시", { n: SNOOZE_MIN })}</button>
          </Show>
        )}
      </Show>
    </div>
  );
}

/** In the chat: the routine main proposed, to save as it is, change first, or drop. */
export function RoutineCard(props: { id: string; alarm?: boolean }) {
  const r = () => routineById(props.id);
  const where = () => (r()?.project ? projectById(r()!.project)?.name : undefined);
  return (
    <Show when={r()} fallback={<div class="reply-note"><Icon name={props.alarm ? "bell" : "repeat"} size={14} /><span>{props.alarm ? t("알람을 지웠어요") : t("루틴을 지웠어요")}</span></div>}>
      {(x) => (
        <Show when={!x().alarm} fallback={<AlarmCard r={x()} />}>
        <div class="rt-card">
          <div class="rt-card-head">
            <Icon name="repeat" size={14} />
            <b>{x().title}</b>
            <span class="rt-sub">{[describeWhen(x().when), where()].filter(Boolean).join(" · ")}</span>
          </div>
          <p class="rt-card-prompt">{x().prompt}</p>
          <div class="rt-card-acts">
            <Show
              when={x().draft}
              fallback={
                <>
                  <span class="rt-sub">{routineLine(x())}</span>
                  <span class="spacer" />
                  <button class="btn ghost sm" onClick={() => openRoutine(x().id)}>{t("루틴 보기")}</button>
                </>
              }
            >
              <button class="btn primary sm" onClick={() => (saveRoutine(x().id, { draft: false, enabled: true }), toast(t("루틴 «{name}»: {when}", { name: x().title, when: describeWhen(x().when) })))}>{t("루틴 만들기")}</button>
              <button class="btn ghost sm" onClick={() => openRoutine(x().id)}>{t("고치기")}</button>
              <span class="spacer" />
              <button class="btn ghost sm" onClick={() => removeRoutine(x().id)}>{t("안 만들기")}</button>
            </Show>
          </div>
        </div>
        </Show>
      )}
    </Show>
  );
}
