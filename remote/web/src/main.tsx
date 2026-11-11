import { render } from "solid-js/web";
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import "../../../src/styles/tokens.css";
import "./style.css";
import { forget, mac, onMessage, open, phase, send, wake, type Mac } from "./link";
import { ago, t } from "./i18n";

interface Summary { id: string; title: string; status: string; now: string; project: string; at: number }
type Item =
  | { k: "user"; id: string; text: string; by: string | null }
  | { k: "text"; id: string; text: string }
  | { k: "error"; id: string; text: string }
  | { k: "step"; id: string; verb: string; target: string; ok: boolean; running: boolean }
  | { k: "link"; id: string; title: string; ref: string; kind: string }
  | { k: "checks"; id: string; label: string; items: { label: string; done: boolean }[] }
  | { k: "turn"; id: string; ms: number };
interface Detail extends Summary { plan: { text: string; state: string }[]; queue: string[]; items: Item[] }

const [data, setData] = createStore<{ mac: string; tasks: Summary[]; task: Detail | null; projects: { id: string; name: string }[] }>({ mac: "", tasks: [], task: null, projects: [] });
const [openId, setOpenId] = createSignal<string | null>(null);

onMessage((m) => {
  if (m.t === "hello") {
    setData("mac", String((m.mac as { name?: string })?.name ?? ""));
    setData("projects", (m.projects as { id: string; name: string }[]) ?? []);
    const id = openId();
    if (id) send({ t: "open", id });
  } else if (m.t === "tasks") setData("tasks", reconcile(m.tasks as Summary[], { key: "id" }));
  else if (m.t === "task") {
    const d = m.task as Detail;
    if (d.id !== openId()) return;
    if (data.task?.id === d.id) setData("task", reconcile(d, { key: "id" }));
    else setData("task", d);
  } else if (m.t === "created") go(String(m.id));
});

function go(id: string | null) {
  setOpenId(id);
  if (!id) {
    send({ t: "close" });
    setData("task", null);
    if (location.hash.startsWith("#t=")) history.back();
    return;
  }
  if (data.task?.id !== id) setData("task", null);
  send({ t: "open", id });
  if (location.hash !== `#t=${id}`) history.pushState(null, "", `#t=${id}`);
}
window.addEventListener("popstate", () => {
  const id = location.hash.startsWith("#t=") ? location.hash.slice(3) : null;
  if (id !== openId()) {
    setOpenId(id);
    if (id) send({ t: "open", id });
    else {
      send({ t: "close" });
      setData("task", null);
    }
  }
});

const STATUS: Record<string, string> = { running: "진행 중", waiting: "답 기다림", queued: "대기", done: "완료", paused: "일시정지", failed: "실패" };

function Dot(props: { status: string }) {
  return <span class={`dot dot-${props.status}`} aria-hidden="true" />;
}

/* ───────── before the session is up */

function Gate(props: { pair?: { mac: Mac; code: string } }) {
  const name = () => props.pair?.mac.name ?? mac()?.name ?? "Mac";
  return (
    <main class="gate">
      <Switch>
        <Match when={phase().k === "idle" && props.pair}>
          <div class="gate-mark"><PhoneMac /></div>
          <h1>{t("{mac}에 연결", { mac: name() })}</h1>
          <p>{t("이 폰에서 {mac}의 작업을 보고 지시해요.", { mac: name() })}</p>
          <button class="btn primary big" onClick={() => void open(props.pair!.mac, props.pair!.code)}>{t("연결")}</button>
        </Match>
        <Match when={phase().k === "idle"}>
          <div class="gate-mark"><PhoneMac /></div>
          <h1>{t("Ondra 원격 제어")}</h1>
          <p>{t("Mac의 Ondra에서 설정 › 원격 제어를 열고 QR을 찍어요.")}</p>
        </Match>
        <Match when={phase().k === "connecting"}>
          <div class="gate-mark"><span class="spin" /></div>
          <h1>{t("연결 중")}</h1>
          <p class="muted">{name()}</p>
        </Match>
        <Match when={phase().k === "waiting"}>
          <div class="gate-mark"><PhoneMac /></div>
          <h1>{t("Mac에서 허용을 눌러주세요")}</h1>
          <p>{t("{mac} 화면에 연결 요청이 떠 있어요.", { mac: name() })}</p>
        </Match>
        <Match when={phase().k === "lost"}>
          <div class="gate-mark"><span class="spin" /></div>
          <h1>{t("연결이 끊겼어요")}</h1>
          <p>{t("{n}초 뒤 다시 연결해요", { n: (phase() as { retryIn: number }).retryIn })}</p>
          <button class="btn big" onClick={wake}>{t("지금 연결")}</button>
        </Match>
        <Match when={phase().k === "denied"}>
          <h1>{t("거절됐어요")}</h1>
          <p>{(phase() as { reason: string }).reason === "refused" ? t("Mac에서 거절했어요. 다시 하려면 QR을 새로 찍어요.") : t("이 기기는 연결이 끊겼어요. Ondra 설정 › 원격 제어에서 QR을 다시 찍어요.")}</p>
        </Match>
        <Match when={phase().k === "error"}>
          <h1>{t("연결하지 못했어요")}</h1>
          <p class="muted small">{(phase() as { message: string }).message}</p>
          <Show when={props.pair ?? (mac() ? { mac: mac()!, code: "" } : undefined)}>
            {(p) => <button class="btn big" onClick={() => void open(p().mac, p().code || undefined)}>{t("다시 시도")}</button>}
          </Show>
        </Match>
      </Switch>
    </main>
  );
}

function PhoneMac() {
  return (
    <svg width="64" height="44" viewBox="0 0 64 44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="16" height="30" rx="3.5" />
      <rect x="30" y="4" width="32" height="22" rx="2.5" />
      <path d="M26 32h40" transform="translate(-2 0)" />
      <path d="M21 21h6" stroke-dasharray="1.5 3" />
    </svg>
  );
}

/* ───────── job list */

function Tasks() {
  const groups = createMemo(() => {
    const live = data.tasks.filter((x) => x.status === "running" || x.status === "waiting");
    const rest = data.tasks.filter((x) => x.status !== "running" && x.status !== "waiting");
    return { live, rest };
  });
  const [draft, setDraft] = createSignal("");
  const [project, setProject] = createSignal("");
  const submit = () => {
    const text = draft().trim();
    if (!text) return;
    send({ t: "new", text, ...(project() ? { project: project() } : {}) });
    setDraft("");
  };
  const Row = (p: { x: Summary }) => (
    <button class="row" onClick={() => go(p.x.id)}>
      <Dot status={p.x.status} />
      <span class="row-main">
        <span class="row-title">{p.x.title}</span>
        <span class="row-sub">
          <Show when={p.x.now} fallback={<>{t(STATUS[p.x.status] ?? p.x.status)}</>}>{p.x.now}</Show>
          <Show when={p.x.project}> · {p.x.project}</Show>
        </span>
      </span>
      <span class="row-at">{ago(p.x.at)}</span>
    </button>
  );
  return (
    <div class="screen">
      <header class="bar">
        <div class="bar-title">
          <b>{t("작업")}</b>
          <span class="muted">{data.mac || mac()?.name}</span>
        </div>
        <button class="icon-btn" aria-label={t("이 기기 연결 해제")} title={t("이 기기 연결 해제")} onClick={() => confirm(t("이 기기 연결 해제") + "?") && forget()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>
        </button>
      </header>
      <div class="scroll">
        <Show when={data.tasks.length} fallback={<p class="empty">{t("아직 작업이 없어요")}</p>}>
          <Show when={groups().live.length}>
            <div class="group-title">{t("진행 중")}</div>
            <div class="list"><For each={groups().live}>{(x) => <Row x={x} />}</For></div>
          </Show>
          <Show when={groups().rest.length}>
            <div class="group-title">{t("작업 목록")}</div>
            <div class="list"><For each={groups().rest}>{(x) => <Row x={x} />}</For></div>
          </Show>
        </Show>
      </div>
      <Composer
        value={draft()}
        onInput={setDraft}
        onSend={submit}
        placeholder={t("무엇을 할까요")}
        extra={
          <Show when={data.projects.length}>
            <select class="chip-select" value={project()} onChange={(e) => setProject(e.currentTarget.value)} aria-label={t("새 작업")}>
              <option value="">{t("프로젝트 없음")}</option>
              <For each={data.projects}>{(p) => <option value={p.id}>{p.name}</option>}</For>
            </select>
          </Show>
        }
      />
    </div>
  );
}

/* ───────── one job */

function Text(props: { text: string }) {
  // paragraphs, `code`, and ``` blocks — enough to read an answer on a phone
  const parts = () => props.text.split(/```[\w-]*\n?/);
  return (
    <div class="md">
      <For each={parts()}>
        {(part, i) =>
          i() % 2 ? (
            <pre><code>{part.replace(/\n$/, "")}</code></pre>
          ) : (
            <For each={part.split(/\n{2,}/).filter((p) => p.trim())}>
              {(p) => (
                <p>
                  <For each={p.split(/(`[^`]+`|\*\*[^*]+\*\*)/)}>
                    {(s) => (s.startsWith("`") && s.endsWith("`") && s.length > 1 ? <code>{s.slice(1, -1)}</code> : s.startsWith("**") && s.endsWith("**") && s.length > 3 ? <b>{s.slice(2, -2)}</b> : s)}
                  </For>
                </p>
              )}
            </For>
          )
        }
      </For>
    </div>
  );
}

/** consecutive steps fold into one line ("12 steps"), the last one shown */
function Steps(props: { steps: Extract<Item, { k: "step" }>[] }) {
  const [openSteps, setOpen] = createSignal(false);
  const last = () => props.steps[props.steps.length - 1];
  return (
    <div class="steps" classList={{ open: openSteps() }}>
      <Show when={props.steps.length > 1}>
        <button class="steps-toggle" onClick={() => setOpen(!openSteps())} aria-expanded={openSteps()}>
          <svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3l3 3-3 3" /></svg>
          <span>{t("단계 {n}개", { n: props.steps.length })}</span>
        </button>
      </Show>
      <For each={openSteps() ? props.steps : [last()]}>
        {(s) => (
          <div class="step" classList={{ bad: !s.ok, running: s.running }}>
            <span class={s.running ? "shimmer" : ""}>{s.verb}</span>
            <Show when={s.target}><span class="step-target">{s.target}</span></Show>
          </div>
        )}
      </For>
    </div>
  );
}

function TaskScreen() {
  let scroller!: HTMLDivElement;
  const [draft, setDraft] = createSignal("");
  const [stick, setStick] = createSignal(true);
  const task = () => data.task;
  const summary = () => data.tasks.find((x) => x.id === openId());
  const running = () => (task()?.status ?? summary()?.status) === "running";
  // runs of steps grouped, everything else as is
  const blocks = createMemo(() => {
    const out: ({ k: "steps"; id: string; steps: Extract<Item, { k: "step" }>[] } | Item)[] = [];
    for (const it of task()?.items ?? []) {
      const prev = out[out.length - 1];
      if (it.k === "step") {
        if (prev && prev.k === "steps") prev.steps.push(it);
        else out.push({ k: "steps", id: it.id, steps: [it] });
      } else if (it.k !== "turn") out.push(it);
    }
    return out;
  });
  const follow = () => stick() && scroller && requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
  const submit = () => {
    const text = draft().trim();
    const id = openId();
    if (!text || !id) return;
    send({ t: "tell", id, text });
    setDraft("");
    setStick(true);
  };
  return (
    <div class="screen">
      <header class="bar">
        <button class="icon-btn" aria-label={t("작업 목록")} onClick={() => go(null)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <div class="bar-title">
          <b>{task()?.title ?? summary()?.title ?? ""}</b>
          <span class="muted">
            <Dot status={task()?.status ?? summary()?.status ?? "queued"} /> {t(STATUS[task()?.status ?? summary()?.status ?? ""] ?? "")}
            <Show when={task()?.project}> · {task()!.project}</Show>
          </span>
        </div>
        <Show when={running()}>
          <button class="btn sm" onClick={() => send({ t: "stop", id: openId() })}>
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="currentColor" /></svg>
            {t("멈추기")}
          </button>
        </Show>
      </header>
      <div class="scroll chat" ref={scroller} onScroll={() => setStick(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40)}>
        <Show when={task()} fallback={<div class="loading"><span class="spin" /></div>}>
          <For each={blocks()}>
            {(b) => {
              queueMicrotask(follow);
              switch (b.k) {
                case "user":
                  return <div class="msg-user"><div class="bubble">{b.text}</div><Show when={b.by}><span class="by">{t("다른 에이전트")}</span></Show></div>;
                case "text":
                  return <Text text={b.text} />;
                case "error":
                  return <div class="msg-error">{b.text}</div>;
                case "steps":
                  return <Steps steps={b.steps} />;
                case "link":
                  return <a class="link-card" href={/^https?:/.test(b.ref) ? b.ref : undefined} target="_blank" rel="noreferrer"><b>{b.title}</b><span class="muted">{b.ref}</span></a>;
                case "checks":
                  return (
                    <div class="checks">
                      <Show when={b.label}><b>{b.label}</b></Show>
                      <For each={b.items}>{(c) => <div class="check" classList={{ done: c.done }}><span class="box" />{c.label}</div>}</For>
                    </div>
                  );
                default:
                  return null;
              }
            }}
          </For>
          <Show when={running()}>
            <div class="thinking"><span class="shimmer">{summary()?.now || t("생각 중")}</span></div>
          </Show>
          <Show when={task()!.queue.length}>
            <div class="queue">
              <span class="muted">{t("다음에 보낼 메시지")}</span>
              <For each={task()!.queue}>{(q) => <div class="queue-item">{q}</div>}</For>
            </div>
          </Show>
        </Show>
      </div>
      <Composer value={draft()} onInput={setDraft} onSend={submit} placeholder={t("메시지")} />
    </div>
  );
}

function Composer(props: { value: string; onInput: (v: string) => void; onSend: () => void; placeholder: string; extra?: any }) {
  let ta!: HTMLTextAreaElement;
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };
  return (
    <form class="composer" onSubmit={(e) => { e.preventDefault(); props.onSend(); queueMicrotask(grow); }}>
      <div class="composer-box">
        <textarea
          ref={ta}
          rows={1}
          value={props.value}
          placeholder={props.placeholder}
          enterkeyhint="send"
          onInput={(e) => { props.onInput(e.currentTarget.value); grow(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(hover: hover)").matches) {
              e.preventDefault();
              props.onSend();
              queueMicrotask(grow);
            }
          }}
        />
        <div class="composer-foot">
          {props.extra}
          <button class="send" type="submit" disabled={!props.value.trim()} aria-label={t("보내기")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          </button>
        </div>
      </div>
    </form>
  );
}

/* ───────── the page */

function App() {
  // #m=<mac id>&p=<code>&n=<name>: a QR from Ondra. Read it and take it out of the address.
  const h = new URLSearchParams(location.hash.slice(1));
  const pair = h.get("m") && h.get("p") ? { mac: { id: h.get("m")!, name: h.get("n") || "Mac" }, code: h.get("p")! } : undefined;
  if (pair) history.replaceState(null, "", location.pathname);
  if (location.hash.startsWith("#t=")) history.replaceState(null, "", location.pathname);
  onMount(() => {
    const m = mac();
    // paired before (and no new QR to another Mac): straight in
    if (m && (!pair || pair.mac.id === m.id)) void open(m);
    const vis = () => document.visibilityState === "visible" && wake();
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("online", wake);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("online", wake);
    });
  });
  return (
    <Show when={phase().k === "ok"} fallback={<Gate pair={pair} />}>
      <Show when={openId()} fallback={<Tasks />}>
        <TaskScreen />
      </Show>
    </Show>
  );
}

render(() => <App />, document.getElementById("app")!);
