// Settings: general, accounts, import from other tools, skills, tools.
import { modelsOf } from "../engine/modelList";
import { ignoredKey, noModifiers, shortcutLabel, viewKey, type ShortcutCommand } from "../lib/shortcuts";
import { appCommands } from "../state/commands";
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { cacheShare, setState, state, uid, updateAccount } from "../state/store";
import type { SpaceId } from "../state/types";
import { EFFORTS, prettyModel } from "../ui/ModelPicker";
import { openTask, setView, type SettingsTab, toast, view } from "../state/ui";
import { allSessions, continueSession, importFrom, scan, scanning, sources } from "../engine/importer";
import { engine, tilde } from "../engine/rpc";
import {
  accountProviders,
  accountRemove,
  openPrivacySettings,
  pickFolder,
  requestAccessibility,
  toolStatus,
  spaceGhLogin,
  spaceGitIdentity,
  spaceTools,
} from "../lib/native";
import { ago, tokens } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";
import { LoginSheet } from "./Login";
import { SkillsTab } from "./SkillsTab";
import { ToolsTab } from "./Tools";
import { HooksTab } from "./Hooks";
import { Logo } from "../ui/Logos";
import { Sheet } from "../ui/Sheet";
import { getVersion } from "@tauri-apps/api/app";
import { available, checkedAt, checkUpdate, installNow, updateProgress, updateReady, updateStatus } from "../engine/update";
import { setNotesFor } from "../engine/releaseNotes";
import { version as appVersion } from "../../package.json";
import { LogIn } from "lucide-solid";

/** a workspace folder as shown: "~" is the home folder */
const folderName = (f: string | undefined) => (!f || f === "~" ? t("홈 폴더") : f);
/** effort ids as words (DESIGN §12: 낮음 · 보통 · 높음 · 매우 높음 · 최대) */
const EFFORT_LABEL: Record<string, string> = { low: "낮음", medium: "보통", high: "높음", xhigh: "매우 높음", max: "최대" };


function Stepper(props: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div class="stepper">
      <button disabled={props.value <= props.min} onClick={() => props.onChange(props.value - 1)} aria-label={t("줄이기")}>−</button>
      <span>{props.value}</span>
      <button disabled={props.value >= props.max} onClick={() => props.onChange(props.value + 1)} aria-label={t("늘리기")}>+</button>
    </div>
  );
}

function Switch_(props: { on: boolean; set: (on: boolean) => void; label?: string }) {
  return <button class="switch" classList={{ on: props.on }} role="switch" aria-checked={props.on} aria-label={props.label} onClick={() => props.set(!props.on)}><i /></button>;
}

function Row(props: { title: string; desc?: string; children?: any }) {
  return (
    <div class="set-row" title={props.desc}>
      <div class="set-label">
        <b>{props.title}</b>
      </div>
      <div class="set-value">{props.children}</div>
    </div>
  );
}

/** A group's title, with its one action (add, rescan) at the right. */
export function GroupTitle(props: { title: string; children?: any }) {
  return (
    <div class="set-group-title">
      <span>{props.title}</span>
      <span class="spacer" />
      {props.children}
    </div>
  );
}

// ───────────────── general
function General() {
  const [editing, setEditing] = createSignal<SpaceId | "new" | null>(null);
  // a quiet "저장됨" for a moment after the instructions change
  const [saved, setSaved] = createSignal(false);
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(savedTimer));
  const saveInstructions = (v: string) => {
    if (v === state.settings.instructions) return;
    setState("settings", "instructions", v);
    setSaved(true);
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => setSaved(false), 2000);
  };
  return (
    <>
      <h2>{t("일반")}</h2>
      <div class="set-group">
        <Row title={t("테마")}>
          <div class="seg">
            <For each={[["system", "시스템"], ["light", "라이트"], ["dark", "다크"]] as const}>
              {([v, l]) => <button classList={{ on: state.settings.theme === v }} onClick={() => setState("settings", "theme", v)}>{t(l)}</button>}
            </For>
          </div>
        </Row>
        <Row title={t("언어")}>
          <div class="seg">
            <For each={[["system", "시스템"], ["ko", "한국어"], ["en", "English"]] as const}>
              {([v, l]) => <button classList={{ on: (state.settings.language ?? "system") === v }} onClick={() => setState("settings", "language", v)}>{v === "system" ? t(l) : l}</button>}
            </For>
          </div>
        </Row>
        <Row title={t("동시 작업 수")}>
          <Stepper value={state.settings.slots.light} min={1} max={10} onChange={(n) => setState("settings", "slots", "light", n)} />
        </Row>
        <Row title={t("무거운 작업 동시 수")} desc={t("빌드, 시뮬레이터, 앱 조작")}>
          <Stepper value={state.settings.slots.heavy} min={1} max={3} onChange={(n) => setState("settings", "slots", "heavy", n)} />
        </Row>
        <Row title={t("작업마다 워크트리")}>
          <Switch_ on={state.settings.isolate} set={(v) => setState("settings", "isolate", v)} />
        </Row>
        <Row title={t("PR 리뷰 자동 대응")}>
          <Switch_ on={!!state.settings.watchPullRequests} set={(v) => setState("settings", "watchPullRequests", v)} />
        </Row>
        <Row title={t("GitHub에 쓰기")}>
          <Switch_ on={state.settings.githubWrite !== false} set={(v) => setState("settings", "githubWrite", v)} />
        </Row>
        <Row title={t("메모리 자동 저장")}>
          <Switch_ on={state.settings.learn} set={(v) => setState("settings", "learn", v)} />
        </Row>
        <Row title={t("포커스 지키기")} desc={t("작업이 연 앱이 앞으로 나오지 않아요")}>
          <Switch_ on={state.settings.focusGuard} set={(v) => setState("settings", "focusGuard", v)} />
        </Row>
      </div>

      <GroupTitle title={t("공통 지침")}>
        <span class="set-saved" classList={{ on: saved() }} aria-hidden={!saved()}>{t("저장됨")}</span>
      </GroupTitle>
      <div class="set-group">
        <div class="set-row col">
          <textarea
            class="textarea plain"
            rows={6}
            aria-label={t("공통 지침")}
            placeholder={t("모든 작업에 적용할 지침")}
            value={state.settings.instructions}
            onChange={(e) => saveInstructions(e.currentTarget.value)}
          />
        </div>
      </div>

      <GroupTitle title={t("워크스페이스")}>
        <button class="btn ghost sm" onClick={() => setEditing("new")}><Icon name="plus" size={14} />{t("추가")}</button>
      </GroupTitle>
      <div class="set-group">
        <For each={state.spaces}>
          {(s) => (
            <button class="sp-row" onClick={() => setEditing(s.id)}>
              <b>{t(s.label)}</b>
              <Show when={state.space === s.id}><span class="sp-now">{t("현재")}</span></Show>
              <span class="sp-folder" classList={{ word: !s.folder || s.folder === "~" }} title={s.folder}>{folderName(s.folder)}</span>
              <span class="sp-n">{t("작업 {n}개", { n: state.tasks.filter((x) => x.space === s.id).length })}</span>
              <Icon name="chevron" size={14} class="sp-go" />
            </button>
          )}
        </For>
      </div>
      <Show when={editing()}>{(id) => <SpaceSheet id={id()} onClose={() => setEditing(null)} />}</Show>

      <GroupTitle title={t("정보|about")} />
      <div class="set-group">
        <UpdateRow />
        <Components />
      </div>
    </>
  );
}

/** What Ondra runs with: the agent, the browser, app control. A version when known, 없음 when missing. */
function Components() {
  const [status, { refetch }] = createResource(toolStatus);
  window.addEventListener("focus", refetch);
  onCleanup(() => window.removeEventListener("focus", refetch));
  const part = (version: string | null | undefined, ready: boolean | undefined) => (
    <Show when={ready} fallback={<span class="pill warn">{t("없음|missing")}</span>}>
      <Show when={version && version !== "dev"} fallback={<span class="set-note">{t("준비됨")}</span>}>
        <span class="set-note">{version}</span>
      </Show>
    </Show>
  );
  return (
    <>
      <Row title={t("에이전트")}>{part(engine.info.engineVersion, engine.ready)}</Row>
      <Row title={t("브라우저")}>{part(status()?.browserVersion, !!status()?.browserVersion && status()?.chromeReady)}</Row>
      <Row title={t("앱 조작")}>{part(status()?.desktopVersion, !!status()?.desktopVersion)}</Row>
    </>
  );
}

function UpdateRow() {
  // outside the app (fixture) the package's own version
  const [version] = createResource(() => getVersion().catch(() => appVersion));
  const pct = () => { const p = updateProgress(); return p === null || p < 0 ? "" : ` ${p}%`; };
  const note = () => {
    const v = available() ?? "";
    return updateStatus() === "checking" ? t("확인 중")
      : updateProgress() !== null ? t("{v} 받는 중", { v }) + pct()
      : updateStatus() === "installing" ? t("다시 시작하는 중")
      : updateReady() && updateReady() === available() ? t("{v} 준비됨", { v })
      : available() ? t("{v} 있음", { v })
      : checkedAt() ? t("최신 버전")
      : "";
  };
  const busy = () => updateStatus() === "installing";
  return (
    <Row title={`Ondra ${version() ?? appVersion}`}>
      <span class="set-note" title={checkedAt() ? ago(checkedAt()) : undefined}>{note()}</span>
      <button class="btn ghost sm" onClick={() => setNotesFor(available() ?? version() ?? "")}>{t("릴리스 노트")}</button>
      <Show when={!busy()}>
        <Show
          when={available()}
          fallback={<button class="btn sm" disabled={updateStatus() === "checking"} onClick={() => void checkUpdate(true)}>{t("업데이트 확인")}</button>}
        >
          <button class="btn primary sm" onClick={() => void installNow()}>{updateReady() === available() ? t("다시 시작|update") : t("{v} 설치", { v: available()! })}</button>
        </Show>
      </Show>
    </Row>
  );
}

/** One space in a dialog: a new one, or editing an existing one. */
function SpaceSheet(props: { id: SpaceId | "new"; onClose: () => void }) {
  const cur = props.id === "new" ? undefined : state.spaces.find((x) => x.id === props.id);
  // the default names are stored in Korean ("회사"/"개인") and shown in the app's language
  const shown = cur ? t(cur.label) : "";
  const [label, setLabel] = createSignal(shown);
  const [folder, setFolder] = createSignal(cur?.folder ?? "~");
  const [rules, setRules] = createSignal(cur?.rules ?? "");
  // this space's own GitHub login and git name/email (jobs here push and commit with them)
  const [tools, setTools] = createSignal<Awaited<ReturnType<typeof spaceTools>>>(null);
  const [gitName, setGitName] = createSignal<string>();
  const [gitEmail, setGitEmail] = createSignal<string>();
  const loadTools = () => cur && void spaceTools(state.spaces.find((x) => x.id === cur.id) ?? cur).then(setTools);
  loadTools();
  // gh login happens in a terminal and the browser: check again when Ondra is back in front
  window.addEventListener("focus", loadTools);
  onCleanup(() => window.removeEventListener("focus", loadTools));
  let name!: HTMLInputElement;
  onMount(() => requestAnimationFrame(() => (name.focus(), name.select())));
  let saved = false;
  const save = () => {
    if (saved) return;
    if (name) setLabel(name.value);
    const l = label().trim();
    if (!l) return name.focus();
    saved = true;
    if (cur) setState("spaces", (x) => x.id === cur.id, { label: l === shown ? cur.label : l, folder: folder(), rules: rules() });
    if (cur && (gitName() !== undefined || gitEmail() !== undefined))
      void spaceGitIdentity(cur, gitName() ?? tools()?.git_name ?? "", gitEmail() ?? tools()?.git_email ?? "");
    else if (!cur) setState("spaces", (list) => [...list, { id: uid("sp"), label: l, folder: folder(), rules: rules() }]);
    props.onClose();
  };
  return (
    <Sheet
      title={cur ? t(cur.label) : t("새 워크스페이스")}
      class="sp-sheet"
      onClose={props.onClose}
      foot={
        <>
          <Show when={cur && cur.id !== "home"}><SpaceDelete id={cur!.id} onDone={props.onClose} /></Show>
          <span class="spacer" />
          <button class="btn sm" onClick={props.onClose}>{t("취소")}</button>
          <button class="btn primary sm" disabled={!label().trim()} onMouseDown={(e) => e.preventDefault()} onClick={save}>{cur ? t("저장") : t("만들기")}</button>
        </>
      }
    >
      <div class="sp-form">
        <label class="sp-field">
          <span>{t("이름")}</span>
          <input
            ref={name}
            class="input"
            value={label()}
            onInput={(e) => setLabel(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || ignoredKey(e) || !noModifiers(e)) return;
              e.preventDefault();
              save();
            }}
            onCompositionEnd={(e) => setLabel(e.currentTarget.value)}
          />
        </label>
        <div class="sp-field">
          <span>{t("기본 폴더")}</span>
          <button
            class="sp-pick"
            onClick={async () => {
              const p = await pickFolder(t("기본 폴더"));
              if (p) setFolder(tilde(p));
            }}
          >
            <Icon name="folder" size={14} />
            <Show when={folder() && folder() !== "~"} fallback={<span>{folderName(folder())}</span>}><code title={folder()}>{folder()}</code></Show>
            <span class="spacer" />
            <span class="muted">{t("변경|action")}</span>
          </button>
        </div>
        <Show when={cur}>
          <div class="sp-field">
            <span>{t("CLI 로그인")}</span>
            <button
              class="sp-pick"
              title={tools()?.home ? tilde(tools()!.home!) : undefined}
              onClick={async () => {
                const p = await pickFolder(t("CLI 로그인 폴더"));
                if (!p) return;
                setState("spaces", (x) => x.id === cur!.id, { cliHome: tilde(p) });
                loadTools();
              }}
            >
              <LogIn size={14} stroke-width={1.5} absoluteStrokeWidth class="icon" aria-hidden="true" />
              <Show when={tools()?.home} fallback={<span>{t("기본 로그인")}</span>}><code>{tilde(tools()!.home!)}</code></Show>
              <span class="spacer" />
              <span class="muted">{t("변경|action")}</span>
            </button>
          </div>
          <div class="sp-field">
            <span>GitHub</span>
            <div class="sp-gh">
              <Show when={tools()?.gh_user} fallback={<span class="muted">{t("로그인 안 됨")}</span>}>
                <code>{tools()!.gh_user}</code>
              </Show>
              <span class="spacer" />
              <button class="btn sm" onClick={() => void spaceGhLogin(state.spaces.find((x) => x.id === cur!.id) ?? cur!)}>{tools()?.gh_user ? t("다시 로그인") : t("로그인")}</button>
            </div>
          </div>
          {/* only for a space that already browses with an Aside account */}
          <Show when={cur!.aside}>
            <label class="sp-field">
              <span>{t("Aside 계정")}</span>
              <input
                class="input"
                value={state.spaces.find((x) => x.id === cur!.id)?.aside ?? ""}
                onChange={(e) => setState("spaces", (x) => x.id === cur!.id, { aside: e.currentTarget.value.trim() || undefined })}
              />
            </label>
          </Show>
          <div class="sp-field">
            <span>{t("커밋 작성자")}</span>
            <div class="sp-git-row">
              <input class="input" placeholder={t("이름")} aria-label={t("이름")} value={gitName() ?? tools()?.git_name ?? ""} onInput={(e) => setGitName(e.currentTarget.value)} />
              <input class="input" placeholder={t("이메일")} aria-label={t("이메일")} value={gitEmail() ?? tools()?.git_email ?? ""} onInput={(e) => setGitEmail(e.currentTarget.value)} />
            </div>
          </div>
        </Show>
        <label class="sp-field sp-top">
          <span>{t("워크스페이스 지침")}</span>
          <textarea class="textarea" rows={4} placeholder={t("이 워크스페이스 작업에 적용할 지침")} value={rules()} onInput={(e) => setRules(e.currentTarget.value)} />
        </label>
      </div>
    </Sheet>
  );
}

/** Removing a space keeps its work: jobs, projects, accounts and memory move to 개인. */
function SpaceDelete(props: { id: SpaceId; onDone?: () => void }) {
  const [sure, setSure] = createSignal(false);
  const n = () => state.tasks.filter((x) => x.space === props.id).length + (state.projects ?? []).filter((p) => p.space === props.id).length;
  const home = () => t(state.spaces.find((s) => s.id === "home")?.label ?? "개인");
  const remove = () => {
    const to = "home";
    setState("tasks", (x) => x.space === props.id, "space", to);
    setState("projects", (p) => p.space === props.id, "space", to);
    setState("accounts", (a) => a.space === props.id, "space", to);
    setState("memory", (m) => m.space === props.id, "space", to);
    setState("captain", (m) => m.space === props.id, "space", to);
    if (state.space === props.id) setState("space", to);
    setState("spaces", (l) => l.filter((s) => s.id !== props.id));
    toast(t("워크스페이스를 삭제했어요"));
    props.onDone?.();
  };
  return (
    <button
      class="btn ghost sm set-del"
      classList={{ sure: sure() }}
      onClick={() => (sure() ? remove() : setSure(true))}
      onBlur={() => setSure(false)}
      title={n() ? t("작업과 프로젝트 {n}개는 {to} 워크스페이스로 옮겨요", { n: n(), to: home() }) : undefined}
    >
      <Icon name="trash" size={14} />
      {sure() ? t("삭제할까요?") : t("삭제")}
    </button>
  );
}

// ───────────────── accounts
const providerName = (p: string) =>
  /anthropic|claude/.test(p) ? "Claude" : /codex|chatgpt|openai/.test(p) ? "ChatGPT" : /gemini|google/.test(p) ? "Gemini" : /copilot/.test(p) ? "Copilot" : p;

function AccountRow(props: { id: string; onLogin: () => void }) {
  const a = () => state.accounts.find((x) => x.id === props.id)!;
  const [models] = createResource(() => (a().providers.length ? props.id : null), modelsOf);
  const [confirm, setConfirm] = createSignal(false);
  const [typed, setTyped] = createSignal<string>();
  const used = () => a().stats.input + a().stats.cacheRead + a().stats.cacheWrite + a().stats.output;
  const cache = () => Math.round((cacheShare(a()) ?? 0) * 100);
  return (
    <div class="acc-row">
      <div class="acc-line">
        <span class="acc-name-wrap" data-v={typed() ?? t(a().label)}>
          <input
            class="acc-name"
            size={1}
            aria-label={t("계정 이름")}
            value={t(a().label)}
            onInput={(e) => setTyped(e.currentTarget.value)}
            onChange={(e) => (updateAccount(props.id, (x) => (x.label = e.currentTarget.value.trim() || x.label)), setTyped(undefined))}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </span>
        <For each={[...new Set(a().providers.map(providerName))]} fallback={<span class="pill warn">{t("로그인 필요")}</span>}>
          {(p) => (
            <span class="pill svc" title={props.id === "default" ? t("{p} · 이 Mac의 기본 로그인", { p }) : p}>
              <Logo name={p === "Claude" ? "claude" : p} size={14} />
              {p}
            </span>
          )}
        </For>
        <span class="spacer" />
        <Show when={used()} fallback={<span class="acc-usage">{t("사용 기록 없음")}</span>}>
          <span class="acc-usage" title={t("캐시 적중률")}>
            <span class="cache-bar"><i style={{ width: `${cache()}%` }} /></span>
            {t("캐시 {n}%", { n: cache() })}
            <span>· {t("{n} 토큰", { n: tokens(used()) })}</span>
          </span>
        </Show>
      </div>
      <div class="acc-line">
        <select class="select" aria-label={t("모델")} value={a().model} onChange={(e) => updateAccount(props.id, (x) => (x.model = e.currentTarget.value))}>
          <option value="" disabled>{t("모델")}</option>
          <For each={models() ?? (a().model ? [a().model] : [])}>{(m) => <option value={m}>{prettyModel(m)}</option>}</For>
        </select>
        <select class="select" aria-label={t("추론 강도")} title={t("추론 강도")} value={a().effort || "high"} onChange={(e) => updateAccount(props.id, (x) => (x.effort = e.currentTarget.value))}>
          <For each={EFFORTS}>{(x) => <option value={x.id}>{t(EFFORT_LABEL[x.id] ?? x.label)}</option>}</For>
        </select>
        <select class="select" aria-label={t("워크스페이스")} title={t("워크스페이스")} value={a().space} onChange={(e) => updateAccount(props.id, (x) => (x.space = e.currentTarget.value as SpaceId))}>
          <For each={state.spaces}>{(s) => <option value={s.id}>{t(s.label)}</option>}</For>
        </select>
        <span class="spacer" />
        <button class="btn sm" onClick={props.onLogin}>{a().providers.length ? t("서비스 추가") : t("로그인")}</button>
        <Show when={props.id !== "default"}>
          <Show
            when={confirm()}
            fallback={<button class="icon-btn sm" title={t("삭제")} aria-label={t("삭제")} onClick={() => setConfirm(true)}><Icon name="trash" size={14} /></button>}
          >
            <button
              class="btn sm danger"
              ref={(el) => requestAnimationFrame(() => el.focus())}
              onBlur={() => setConfirm(false)}
              onClick={() => {
                accountRemove(props.id);
                setState("accounts", (l) => l.filter((x) => x.id !== props.id));
              }}
            >
              {t("계정 삭제")}
            </button>
          </Show>
        </Show>
      </div>
    </div>
  );
}

async function refreshProviders() {
  for (const a of state.accounts) {
    const providers = await accountProviders(a.id);
    updateAccount(a.id, (x) => (x.providers = providers));
  }
}

function Accounts() {
  const [login, setLogin] = createSignal<string | null>(null);
  onMount(() => {
    refreshProviders();
    window.addEventListener("focus", refreshProviders);
    onCleanup(() => window.removeEventListener("focus", refreshProviders));
  });
  const add = (space: SpaceId) => {
    const id = uid("acc");
    const n = state.accounts.filter((a) => a.space === space).length + 1;
    setState("accounts", (l) => [
      ...l,
      { id, space, label: `${t(state.spaces.find((s) => s.id === space)?.label ?? "계정")} ${n}`, providers: [], model: "", badModels: [], stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
    setLogin(id);
  };
  return (
    <>
      <h2>{t("계정")}</h2>
      <For each={state.spaces}>
        {(s) => (
          <>
            <GroupTitle title={t(s.label)}>
              <button class="btn ghost sm" onClick={() => add(s.id)}><Icon name="plus" size={14} />{t("계정 추가")}</button>
            </GroupTitle>
            <div class="set-group">
              <For each={state.accounts.filter((a) => a.space === s.id)} fallback={<div class="empty-line">{t("계정 없음")}</div>}>
                {(a) => <AccountRow id={a.id} onLogin={() => setLogin(a.id)} />}
              </For>
            </div>
          </>
        )}
      </For>
      <Show when={login()}>{(id) => <LoginSheet accountId={id()} onClose={() => setLogin(null)} />}</Show>
    </>
  );
}

// ───────────────── import
/** "지침 3 · 스킬 2" / "3 instructions · 2 skills": the non-zero counts */
function counts(c: { rules?: number; skills?: number; memories?: number; sessions?: number }): string {
  const parts: [number | undefined, string][] = [[c.rules, "지침 {n}"], [c.skills, "스킬 {n}"], [c.memories, "메모리 {n}"], [c.sessions, "세션 {n}"]];
  return parts.filter(([n]) => n).map(([n, k]) => t(k, { n: n! })).join(" · ");
}
function Import() {
  const [pick, setPick] = createSignal({ rules: true, skills: true, memories: true });
  const [query, setQuery] = createSignal("");
  const [importing, setImporting] = createSignal<string | null>(null);
  onMount(() => !sources().length && scan());
  const found = () => sources().filter((s) => s.found);
  const sessions = createMemo(() => {
    const q = query().trim().toLowerCase();
    const imported = new Set(state.tasks.map((x) => x.origin?.path));
    return allSessions()
      .filter((s) => !q || `${s.title} ${s.cwd} ${s.sourceName}`.toLowerCase().includes(q))
      .map((s) => ({ ...s, done: imported.has(s.path) }))
      .slice(0, 80);
  });
  const run = () => {
    const r = importFrom(found(), pick());
    const parts = counts({ rules: r.rules, skills: r.skills, memories: r.memories });
    toast(parts ? t("가져왔어요 · {parts}", { parts }) : t("새로 가져올 것 없음"));
  };
  const pickUp = async (s: ReturnType<typeof allSessions>[number]) => {
    setImporting(s.path);
    try {
      openTask(await continueSession(s, state.space, s.sourceName));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setImporting(null);
    }
  };
  return (
    <>
      <h2>{t("가져오기")}</h2>
      <Show
        when={found().length}
        fallback={
          <div class="set-group">
            <div class="empty-line imp-empty">
              <span>{scanning() ? t("찾는 중") : t("Claude Code, Codex 세션을 찾지 못했어요")}</span>
              <span class="spacer" />
              <button class="btn sm" onClick={scan} disabled={scanning()}><Icon name="refresh" size={14} />{t("다시 찾기")}</button>
            </div>
          </div>
        }
      >
      <GroupTitle title={t("찾은 도구")}>
        <button class="btn ghost sm" onClick={scan} disabled={scanning()}><Icon name="refresh" size={14} />{scanning() ? t("찾는 중") : t("다시 찾기")}</button>
      </GroupTitle>
      <div class="set-group">
        <For each={sources()}>
          {(s) => (
            <div class="set-row src-row" classList={{ off: !s.found }}>
              <div class="set-label"><b>{s.name}</b></div>
              <div class="set-value">
                <Show when={s.found} fallback={<span class="set-note">{t("없음|missing")}</span>}>
                  <span class="set-note">{counts({ rules: s.rules.length, skills: s.skills.length, memories: s.memories.length, sessions: s.sessions.length }) || t("없음|missing")}</span>
                  <Show when={s.loggedIn}><span class="pill ok">{t("로그인됨")}</span></Show>
                </Show>
              </div>
            </div>
          )}
        </For>
        <Show when={found().length}>
          <div class="set-row src-pick">
            <label class="check" title="CLAUDE.md, AGENTS.md"><input type="checkbox" checked={pick().rules} onChange={(e) => setPick({ ...pick(), rules: e.currentTarget.checked })} />{t("지침")}</label>
            <label class="check"><input type="checkbox" checked={pick().skills} onChange={(e) => setPick({ ...pick(), skills: e.currentTarget.checked })} />{t("스킬")}</label>
            <label class="check"><input type="checkbox" checked={pick().memories} onChange={(e) => setPick({ ...pick(), memories: e.currentTarget.checked })} />{t("메모리")}</label>
            <span class="spacer" />
            <button class="btn primary sm" disabled={!pick().rules && !pick().skills && !pick().memories} onClick={run}>{t("가져오기")}</button>
          </div>
        </Show>
      </div>

      <GroupTitle title={t("세션")} />
      <div class="set-group">
        <Show when={allSessions().length}>
          <label class="set-search">
            <Icon name="search" size={14} />
            <input placeholder={t("세션 검색")} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
          </label>
        </Show>
        <For each={sessions()} fallback={<div class="empty-line">{t("세션 없음")}</div>}>
          {(s) => (
            <div class="item-row">
              <div class="item-main">
                <b>{s.title || t("제목 없음")}</b>
                <p>{s.sourceName} · {tilde(s.cwd) || t("폴더 모름")} · {ago(s.updatedAt)} · {t("메시지 {n}개", { n: s.messages })}</p>
              </div>
              <Show when={!s.done} fallback={<span class="set-note">{t("가져옴")}</span>}>
                <button class="btn sm" disabled={importing() === s.path} onClick={() => pickUp(s)}>{importing() === s.path ? t("여는 중") : t("이어받기")}</button>
              </Show>
            </div>
          )}
        </For>
      </div>
      </Show>
    </>
  );
}

// ───────────────── permissions (macOS)
function Permissions() {
  const [status, { refetch }] = createResource(toolStatus);
  const timer = setInterval(() => !document.hidden && refetch(), 3000);
  onCleanup(() => clearInterval(timer));
  const perm = (granted: boolean | undefined, ask: () => void) => (
    <Show when={granted} fallback={<><span class="pill warn">{t("허용 필요")}</span><button class="btn sm" onClick={ask}>{t("허용")}</button></>}>
      <span class="pill ok">{t("허용됨")}</span>
    </Show>
  );
  return (
    <>
      <h2>{t("권한")}</h2>
      <GroupTitle title={t("macOS 권한")} />
      <div class="set-group">
        <Row title={t("손쉬운 사용")} desc={t("다른 앱 조작에 필요")}>
          {perm(status()?.accessibility, async () => { await requestAccessibility(); openPrivacySettings("accessibility"); })}
        </Row>
        <Row title={t("화면 기록")} desc={t("앱 화면 캡처에 필요")}>
          {perm(status()?.screenRecording, () => openPrivacySettings("screen"))}
        </Row>
      </div>
    </>
  );
}

// ───────────────── shortcuts
function Shortcuts() {
  const groups = createMemo(() => {
    const out = new Map<string, ShortcutCommand[]>();
    for (const c of appCommands()) if (c.shortcut) out.set(c.section, [...(out.get(c.section) ?? []), c]);
    return [...out];
  });
  return (
    <>
      <h2>{t("단축키")}</h2>
      <div class="set-group">
        <Row title={t("버튼 단축키 표시")}><kbd>{t("⌘ 길게")}</kbd></Row>
        <Row title={t("어디서든 요청")}><kbd>⌥ Space</kbd></Row>
        <Row title={t("단축키 목록")}><kbd>?</kbd></Row>
        <Row title={t("종료")}><kbd>{t("⌘Q 길게")}</kbd></Row>
      </div>
      <For each={groups()}>
        {([section, list]) => (
          <>
            <GroupTitle title={t(section)} />
            <div class="set-group">
              <For each={list}>{(c) => <Row title={t(c.label)}><kbd>{shortcutLabel(c.shortcut!)}</kbd></Row>}</For>
            </div>
          </>
        )}
      </For>
      <GroupTitle title={t("터미널")} />
      <div class="set-group">
        <Row title={t("터미널에서 요청")}><code class="muted">{t('throw.sh "요청"')}</code></Row>
      </div>
    </>
  );
}

export const SETTINGS_TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "general", label: "일반", icon: "gear" },
  { id: "accounts", label: "계정", icon: "key" },
  { id: "tools", label: "권한", icon: "shield" },
  { id: "agent-tools", label: "도구", icon: "tools" },
  { id: "skills", label: "스킬", icon: "skill" },
  { id: "hooks", label: "훅", icon: "bolt" },
  { id: "import", label: "가져오기", icon: "download" },
  { id: "shortcuts", label: "단축키", icon: "list" },
];

const settingsTab = () => {
  const v = view();
  return (v.name === "settings" && v.tab) || "general";
};

/** Like Codex: settings take the whole window. The sidebar becomes the list of sections. */
export function SettingsNav(props: { onBack: () => void }) {
  return (
    <aside class="sidebar settings-side">
      <div class="sb-top" data-tauri-drag-region />
      <div class="sb-scroll">
        <button class="sb-row sb-main settings-back" onClick={props.onBack} title={`${t("앱으로 돌아가기")} (Esc)`}>
          <Icon name="back" size={16} />
          <span class="sb-title">{t("앱으로 돌아가기")}</span>
        </button>
        <div class="settings-side-list">
          <For each={SETTINGS_TABS}>
            {(tab) => (
              <button class="sb-row sb-main" classList={{ on: settingsTab() === tab.id }} onClick={() => setView({ name: "settings", tab: tab.id })}>
                <Icon name={tab.icon} size={16} />
                <span class="sb-title">{t(tab.label)}</span>
              </button>
            )}
          </For>
        </div>
      </div>
    </aside>
  );
}

export function SettingsPage(props: { onBack: () => void }) {
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !viewKey(e) || !noModifiers(e)) return;
    e.preventDefault();
    props.onBack();
  };
  onMount(() => window.addEventListener("keydown", key, true));
  onCleanup(() => window.removeEventListener("keydown", key, true));
  let body!: HTMLDivElement;
  // each tab opens at its top
  createEffect(on(settingsTab, () => body && (body.scrollTop = 0), { defer: true }));
  return (
    <div class="settings settings-page">
      <div class="head" data-tauri-drag-region />
      <div class="settings-body" ref={body}>
        <div class="settings-inner">
          <Switch>
            <Match when={settingsTab() === "general"}><General /></Match>
            <Match when={settingsTab() === "shortcuts"}><Shortcuts /></Match>
            <Match when={settingsTab() === "accounts"}><Accounts /></Match>
            <Match when={settingsTab() === "import"}><Import /></Match>
            <Match when={settingsTab() === "agent-tools"}><ToolsTab /></Match>
            <Match when={settingsTab() === "skills"}><SkillsTab /></Match>
            <Match when={settingsTab() === "hooks"}><HooksTab /></Match>
            <Match when={settingsTab() === "tools"}><Permissions /></Match>
          </Switch>
        </div>
      </div>
    </div>
  );
}

export { LoginSheet };
