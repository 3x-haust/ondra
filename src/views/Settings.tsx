// Settings: general, accounts, import from other tools, skills, tools.
import { accountName } from "../ui/AccountPicker";
import { modelsOf, refreshModels } from "../engine/modelList";
import { ignoredKey, noModifiers, shortcutLabel, viewKey, type ShortcutCommand } from "../lib/shortcuts";
import { appCommands } from "../state/commands";
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { cacheShare, setState, state, uid, updateAccount } from "../state/store";
import type { Account, SpaceId } from "../state/types";
import { creditsOf, loadEmail, refreshLimits, usageOf, windowLabel } from "../state/limits";
import { EFFORTS, prettyModel } from "../ui/ModelPicker";
import { openTask, setView, type SettingsTab, toast, view } from "../state/ui";
import { allSessions, continueSession, importFrom, scan, scanning, sources } from "../engine/importer";
import { engine, tilde } from "../engine/rpc";
import {
  accountProviders,
  accountRemove,
  inTauri,
  openPrivacySettings,
  pickFolder,
  requestAccessibility,
  toolStatus,
  spaceGhLogin,
  spaceGitIdentity,
  spaceTools,
} from "../lib/native";
import { ago, now, tokens } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";
import { LoginSheet } from "./Login";
import { SHORTCUT_EXTRAS } from "./ShortcutSheet";
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
          <Switch_ label={t("작업마다 워크트리")} on={state.settings.isolate} set={(v) => setState("settings", "isolate", v)} />
        </Row>
        <Row title={t("PR 리뷰 자동 대응")}>
          <Switch_ label={t("PR 리뷰 자동 대응")} on={!!state.settings.watchPullRequests} set={(v) => setState("settings", "watchPullRequests", v)} />
        </Row>
        <Row title={t("GitHub에 쓰기")}>
          <Switch_ label={t("GitHub에 쓰기")} on={state.settings.githubWrite !== false} set={(v) => setState("settings", "githubWrite", v)} />
        </Row>
        <Row title={t("메모리 자동 저장")}>
          <Switch_ label={t("메모리 자동 저장")} on={state.settings.learn} set={(v) => setState("settings", "learn", v)} />
        </Row>
        <Row title={t("포커스 지키기")} desc={t("작업이 연 앱이 앞으로 나오지 않아요")}>
          <Switch_ label={t("포커스 지키기")} on={state.settings.focusGuard} set={(v) => setState("settings", "focusGuard", v)} />
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
              <span class="sp-n">{t("작업 {n}개", { n: state.tasks.filter((x) => x.space === s.id && !x.parentId && !x.answer && !x.archived).length })}</span>
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
const servicesOf = (a: Account) => [...new Set(a.providers.map(providerName))];
/** the name the person gave an account; "" when it still has a made-up one ("기본", "회사", "회사 2") */
const ownLabel = (a: Account) => {
  const made = ["기본", "계정", ...state.spaces.map((s) => s.label)].flatMap((l) => [l, t(l)]);
  return a.label && !made.some((l) => a.label === l || a.label.startsWith(`${l} `)) ? a.label : "";
};
/** signed in = the account has a provider login (the same test the account chip uses) */
const signedIn = (a: Account) => a.providers.length > 0;

/** "2시간" / "3일": how long until a plan window starts over */
const resetIn = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return t("{m}분", { m });
  const h = Math.round(m / 60);
  return h < 48 ? t("{n}시간", { n: h }) : t("{n}일", { n: Math.round(h / 24) });
};

/** what the per-account sign-in button says; its sheet carries the same title */
const loginWord = (a: Account) => (signedIn(a) ? "로그인 추가" : "로그인");

function AccountRow(props: { id: string; onLogin: () => void }) {
  const a = () => state.accounts.find((x) => x.id === props.id)!;
  const [models] = createResource(() => (a().providers.length ? props.id : null), modelsOf);
  const [confirm, setConfirm] = createSignal(false);
  const [typed, setTyped] = createSignal<string>();
  const used = () => a().stats.input + a().stats.cacheRead + a().stats.cacheWrite + a().stats.output;
  const cache = () => Math.round((cacheShare(a()) ?? 0) * 100);
  // the plan windows the composer shows (5시간 / 주간), only while signed in
  onMount(() => signedIn(a()) && void refreshLimits(props.id));
  const windows = () => (signedIn(a()) ? usageOf(props.id, now()) : []);
  const credits = () => (signedIn(a()) ? creditsOf(props.id) : undefined);
  // provider + email until the person names it; clearing the name goes back to that
  const made = () => state.spaces.find((s) => s.id === a().space)?.label ?? "계정";
  const auto = () => accountName({ ...a(), label: made() });
  const rename = (v: string) =>
    updateAccount(props.id, (x) => (x.label = v.trim() && v.trim() !== auto() ? v.trim() : made()));
  return (
    <div class="acc-row">
      <div class="acc-line">
        <For each={servicesOf(a())}>
          {(p) => <span class="acc-logo" title={props.id === "default" ? t("{p} · 이 Mac의 기본 로그인", { p }) : p}><Logo name={p === "Claude" ? "claude" : p} size={14} /></span>}
        </For>
        <span class="acc-name-wrap" data-v={typed() ?? (ownLabel(a()) || auto())}>
          <input
            class="acc-name"
            size={1}
            aria-label={t("계정 이름")}
            title={accountName(a())}
            placeholder={auto()}
            value={ownLabel(a())}
            onInput={(e) => setTyped(e.currentTarget.value || undefined)}
            onChange={(e) => (rename(e.currentTarget.value), setTyped(undefined))}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </span>
        <Show when={!signedIn(a())}><span class="pill warn">{t("로그인 필요")}</span></Show>
        <span class="spacer" />
        <span class="acc-usage">
          <For each={windows()}>
            {(l) => (
              <span class="acc-lim" classList={{ hot: l.used >= 80 && !credits() }} title={[t("{w} {n}% 사용", { w: windowLabel(l.window), n: Math.round(l.used) }), ...(l.resetsAt ? [t("{t} 후 초기화", { t: resetIn(l.resetsAt - now()) })] : [])].join(" · ")}>
                <span class="acc-lim-name">{windowLabel(l.window)}</span>
                <span class="acc-lim-num">{Math.round(l.used)}%</span>
              </span>
            )}
          </For>
          <Show when={credits()}>
            {(c) => <span class="acc-stat" title={t("요금제 한도 이후 사용")}>{t("크레딧 {n}|left", { n: Number.isFinite(Number(c())) ? Number(c()) : c() })}</span>}
          </Show>
          <Show when={used()} fallback={<Show when={!windows().length}><span class="acc-stat">{t("사용 기록 없음")}</span></Show>}>
            <span class="acc-stat" title={t("{k} 토큰", { n: used(), k: tokens(used()) })}>{t("캐시 적중 {p}%", { p: cache() })}</span>
          </Show>
        </span>
      </div>
      <div class="acc-line acc-fields">
        <label class="acc-field">
          <span>{t("모델")}</span>
          <select class="select" value={a().model} onChange={(e) => updateAccount(props.id, (x) => (x.model = e.currentTarget.value))}>
            <option value="" disabled>{t("자동")}</option>
            <For each={models() ?? (a().model ? [a().model] : [])}>{(m) => <option value={m}>{prettyModel(m)}</option>}</For>
          </select>
        </label>
        <label class="acc-field">
          <span>{t("추론 강도")}</span>
          <select class="select" value={a().effort || "high"} onChange={(e) => updateAccount(props.id, (x) => (x.effort = e.currentTarget.value))}>
            <For each={EFFORTS}>{(x) => <option value={x.id}>{t(EFFORT_LABEL[x.id] ?? x.label)}</option>}</For>
          </select>
        </label>
        <label class="acc-field">
          <span>{t("워크스페이스|one")}</span>
          <select class="select" value={a().space} onChange={(e) => updateAccount(props.id, (x) => (x.space = e.currentTarget.value as SpaceId))}>
            <For each={state.spaces}>{(s) => <option value={s.id}>{t(s.label)}</option>}</For>
          </select>
        </label>
        <span class="spacer" />
        <button class="btn sm" classList={{ primary: !signedIn(a()) }} onClick={props.onLogin}>{t(loginWord(a()))}</button>
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
  // outside the app there is no login to read: keep what the account chip shows
  if (!inTauri) return;
  for (const a of state.accounts) {
    const providers = await accountProviders(a.id);
    updateAccount(a.id, (x) => (x.providers = providers));
  }
}

function Accounts() {
  /** the sign-in sheet open now, and the words on the button that opened it */
  const [login, setLogin] = createSignal<{ id: string; title: string } | null>(null);
  /** 계정 추가: an account that exists only once its sign-in goes through */
  const [pending, setPending] = createSignal<{ id: string; space: SpaceId } | null>(null);
  onMount(() => {
    refreshProviders();
    for (const a of state.accounts) void loadEmail(a.id).catch(() => {});
    window.addEventListener("focus", refreshProviders);
    onCleanup(() => window.removeEventListener("focus", refreshProviders));
  });
  const add = (space: SpaceId) => {
    const id = uid("acc");
    setPending({ id, space });
    setLogin({ id, title: "계정 추가" });
  };
  const closed = async () => {
    const p = pending();
    setLogin(null);
    setPending(null);
    if (!p) return;
    // signed in: the account is made now, with what it signed in to; else nothing is left behind
    const providers = await accountProviders(p.id).catch(() => [] as string[]);
    if (!providers.length) return void accountRemove(p.id).catch(() => {});
    const n = state.accounts.filter((a) => a.space === p.space).length + 1;
    setState("accounts", (l) => [
      ...l,
      { id: p.id, space: p.space, label: `${t(state.spaces.find((s) => s.id === p.space)?.label ?? "계정")} ${n}`, providers, model: "", badModels: [], stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
    void refreshModels(p.id, true);
    void loadEmail(p.id).catch(() => {});
  };
  return (
    <>
      <h2>{t("계정")}</h2>
      <For each={state.spaces}>
        {(s) => (
          <>
            <GroupTitle title={t(s.label)}>
              <button class="btn ghost sm" disabled={!!pending()} onClick={() => add(s.id)}><Icon name="plus" size={14} />{t("계정 추가")}</button>
            </GroupTitle>
            <div class="set-group">
              <For each={state.accounts.filter((a) => a.space === s.id)} fallback={<Show when={pending()?.space !== s.id}><div class="empty-line">{t("계정 없음")}</div></Show>}>
                {(a) => <AccountRow id={a.id} onLogin={() => setLogin({ id: a.id, title: loginWord(a) })} />}
              </For>
              <Show when={pending()?.space === s.id}>
                <div class="acc-row acc-pending">
                  <div class="acc-line">
                    <span class="acc-pending-name">{t("새 계정")}</span>
                    <span class="spacer" />
                    <span class="acc-usage"><span class="spin sm" />{t("로그인 중")}</span>
                  </div>
                </div>
              </Show>
            </div>
          </>
        )}
      </For>
      <Show when={login()}>{(l) => <LoginSheet accountId={l().id} title={t(l().title)} onClose={() => void closed()} />}</Show>
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
/**
 * The `?` sheet's groups, in its order: 일반 first with the keys that aren't commands
 * (SHORTCUT_EXTRAS), then each command section, 설정 last.
 * TODO(merge): the same grouping lives inside ShortcutSheet(); once the shell group exports it, use that.
 */
function shortcutGroups(): { title: string; rows: { label: string; keys: string }[] }[] {
  const out = new Map<string, ShortcutCommand[]>();
  for (const c of appCommands()) if (c.shortcut) out.set(c.section, [...(out.get(c.section) ?? []), c]);
  const last = (s: string) => Number(s === t("설정"));
  const sections = [...out].sort((a, b) => last(a[0]) - last(b[0]));
  const general = t("일반");
  const row = (c: ShortcutCommand) => ({ label: c.label, keys: shortcutLabel(c.shortcut!) });
  return [
    { title: general, rows: [...SHORTCUT_EXTRAS.map(([label, keys]) => ({ label: t(label), keys: t(keys) })), ...(out.get(general) ?? []).map(row)] },
    ...sections.filter(([sec]) => sec !== general).map(([title, list]) => ({ title, rows: list.map(row) })),
  ];
}

function Shortcuts() {
  const groups = createMemo(shortcutGroups);
  return (
    <>
      <h2>{t("단축키")}</h2>
      <For each={groups()}>
        {(g) => (
          <>
            <GroupTitle title={g.title} />
            <div class="set-group">
              <For each={g.rows}>{(r) => <Row title={r.label}><kbd>{r.keys}</kbd></Row>}</For>
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
