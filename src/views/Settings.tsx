// Settings: general, accounts, import from other tools, skills, tools.
import { effortFor, setModelEffort } from "../engine/models";
import { setZoom, zoom, ZOOMS } from "../state/zoom";
import { accountName } from "../ui/AccountPicker";
import { refreshModels } from "../engine/modelList";
import { binding, chordLabel, shortcutHint, ignoredKey, isShortcutId, modifierHold, noModifiers, overrides, shortcuts, viewKey, type Shortcut, type ShortcutId } from "../lib/shortcuts";
import { assign, changed, chordOf, conflictOf, modifierOnly, moveTo, refusal, reset } from "../lib/keybindings";
import { appCommands } from "../state/commands";
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { setState, state, uid, updateAccount } from "../state/store";
import type { Account, SpaceId } from "../state/types";
import { creditsOf, emails, loadEmail, refreshLimits, usageOf, windowLabel } from "../state/limits";
import { ctxFor, openMenuAt, type MenuEntry } from "../ui/taskMenu";
import { ModelPicker, PERMISSIONS } from "../ui/ModelPicker";
import { openTask, setView, type SettingsTab, toast, view } from "../state/ui";
import { macs } from "../ui/MacBar";
import { allSessions, continueSession, importFrom, scan, scanning, sources } from "../engine/importer";
import { engine, tilde } from "../engine/rpc";
import { componentNote, componentOf } from "../engine/components";
import {
  accountProviders,
  accountRemove,
  inTauri,
  pickFolder,
  toolStatus,
  spaceGhLogin,
  spaceGitIdentity,
  spaceTools,
} from "../lib/native";
import { RemoteSettings } from "./RemoteSettings";
import { askPermission } from "../lib/permissions";
import { ago, agoIn, now } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";
import { canTrack, track } from "../lib/telemetry";
import { LoginSheet } from "./Login";
import { ConnectionSheet } from "./Connection";
import { presetOf } from "../engine/connections";
import { keyText, SHORTCUT_EXTRAS } from "./ShortcutSheet";
import { SkillsTab } from "./SkillsTab";
import { ToolsTab } from "./Tools";
import { HooksTab } from "./Hooks";
import { Logo, logoFor } from "../ui/Logos";
import { appName } from "../lib/brand";
import { Sheet } from "../ui/Sheet";
import { getVersion } from "@tauri-apps/api/app";
import { available, checkedAt, checkUpdate, freshen, installNow, jobsWorking, restartQueued, restartWhenIdle, updateProgress, updateReady, updateStatus } from "../engine/update";
import { setNotesFor } from "../engine/releaseNotes";
import { version as appVersion } from "../../package.json";
import { isBeta } from "../lib/beta";
import { LogIn } from "lucide-solid";
import appIcon from "../../src-tauri/icons/128x128@2x.png";

/** a workspace folder as shown: "~" is the home folder */
const folderName = (f: string | undefined) => (!f || f === "~" ? t("홈 폴더") : f);


function Stepper(props: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div class="stepper">
      <button disabled={props.value <= props.min} onClick={() => props.onChange(props.value - 1)} aria-label={t("줄이기")}>−</button>
      <span>{props.value}</span>
      <button disabled={props.value >= props.max} onClick={() => props.onChange(props.value + 1)} aria-label={t("늘리기")}>+</button>
    </div>
  );
}

export function Switch_(props: { on: boolean; set: (on: boolean) => void; label?: string }) {
  return <button class="switch" classList={{ on: props.on }} role="switch" aria-checked={props.on} aria-label={props.label} onClick={() => props.set(!props.on)}><i /></button>;
}

/** One setting: its name, one plain line on what it does under it, its control at the right. */
export function Row(props: { title: string; desc?: string; children?: any }) {
  return (
    <div class="set-row" classList={{ two: !!props.desc }} data-set={props.title}>
      <div class="set-label">
        <b>{props.title}</b>
        <Show when={props.desc}><span class="set-sub">{props.desc}</span></Show>
      </div>
      <div class="set-value">{props.children}</div>
    </div>
  );
}

/** A tab's head: its icon on a soft tile, its name, and its one action (what the tab is for is left to search). */
export function PageHead(props: { tab: SettingsTab; children?: any }) {
  const tab = () => SETTINGS_TABS.find((x) => x.id === props.tab)!;
  return (
    <header class="set-page-head">
      <span class="set-page-icon"><Icon name={tab().icon} size={18} /></span>
      <div class="set-page-text">
        <h2>{t(tab().label)}</h2>
      </div>
      <Show when={props.children}><div class="set-page-act">{props.children}</div></Show>
    </header>
  );
}

/** Nothing here yet: what would be here, and the one thing to do about it. */
export function EmptyState(props: { icon: string; title: string; desc?: string; children?: any }) {
  return (
    <div class="set-empty">
      <span class="set-empty-icon"><Icon name={props.icon} size={18} /></span>
      <b>{props.title}</b>
      <Show when={props.desc}><p>{props.desc}</p></Show>
      <Show when={props.children}><div class="set-empty-act">{props.children}</div></Show>
    </div>
  );
}

/** 테마 as three small windows to pick from */
function ThemePick() {
  const cur = () => state.settings.theme ?? "system";
  return (
    <div class="theme-pick" role="radiogroup" aria-label={t("테마")}>
      <For each={[["system", "시스템"], ["light", "라이트"], ["dark", "다크"]] as const}>
        {([v, l]) => (
          <button class="theme-opt" classList={{ on: cur() === v }} role="radio" aria-checked={cur() === v} onClick={() => setState("settings", "theme", v)}>
            <span class={`theme-win ${v}`} aria-hidden="true">
              <i class="tw-side" />
              <i class="tw-line" />
              <i class="tw-line short" />
            </span>
            <span class="theme-name">{t(l)}</span>
          </button>
        )}
      </For>
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

/** the accounts a default model is set for: signed in, the current workspace's first */
const modelAccounts = () =>
  state.accounts.filter((a) => a.providers.length > 0).sort((x, y) => Number(y.space === state.space) - Number(x.space === state.space));

// ───────────────── general
function General() {
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
      <PageHead tab="general" />
      <GroupTitle title={t("화면")} />
      <div class="set-group">
        <Row title={t("테마")}>
          <ThemePick />
        </Row>
        <Row title={t("화면 크기")} desc={t("{a} 크게 · {b} 작게", { a: shortcutHint("zoomIn"), b: shortcutHint("zoomOut") })}>
          <div class="seg">
            <For each={ZOOMS}>
              {(z) => <button classList={{ on: Math.abs(zoom() - z) < 0.001 }} onClick={() => setZoom(z)}>{`${Math.round(z * 100)}%`}</button>}
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
        {/* web links: the panel's browser (signed in once, shared with the jobs) or the Mac's own */}
        <Row title={t("링크 열기")} desc={t("⌘ 클릭하면 기본 브라우저에서 열려요")}>
          <div class="seg">
            <button classList={{ on: (state.settings.links ?? "inside") === "inside" }} onClick={() => setState("settings", "links", "inside")}>{t("{name} 안에서", { name: appName() })}</button>
            <button classList={{ on: state.settings.links === "outside" }} onClick={() => setState("settings", "links", "outside")}>{t("기본 브라우저")}</button>
          </div>
        </Row>
      </div>

      {/* what every new task starts with: the same model and permission the composer shows (one store) */}
      <GroupTitle title={t("새 작업")} />
      <div class="set-group">
        <For each={modelAccounts()}>
          {(a) => (
            <Row title={modelAccounts().length > 1 ? `${t("기본 모델")} · ${accountName(a, true)}` : t("기본 모델")}>
              <ModelPicker
                accountId={a.id}
                model={a.model ?? ""}
                thinking={effortFor(a.id) || ""}
                effortOf={(m) => effortFor(a.id, m) || ""}
                onChange={(m, e) => updateAccount(a.id, (x) => setModelEffort(x, m, e))}
              />
            </Row>
          )}
        </For>
        <Row title={t("기본 권한")} desc={t(PERMISSIONS.find((p) => p.id === (state.settings.permission ?? "edits"))?.desc ?? "")}>
          <div class="seg">
            <For each={PERMISSIONS}>
              {(p) => <button classList={{ on: (state.settings.permission ?? "edits") === p.id }} title={t(p.desc)} onClick={() => setState("settings", "permission", p.id)}>{t(p.label)}</button>}
            </For>
          </div>
        </Row>
        <Row title={t("동시 작업 수")} desc={t("한 번에 같이 도는 작업 수예요")}>
          <Stepper value={state.settings.slots.light} min={1} max={10} onChange={(n) => setState("settings", "slots", "light", n)} />
        </Row>
        <Row title={t("빌드·시뮬레이터 작업 동시 수")} desc={t("빌드, 시뮬레이터, 앱 조작")}>
          <Stepper value={state.settings.slots.heavy} min={1} max={3} onChange={(n) => setState("settings", "slots", "heavy", n)} />
        </Row>
      </div>

      <GroupTitle title={t("작업 방식")} />
      <div class="set-group">
        <Row title={t("작업마다 새 워크트리")} desc={t("작업끼리 파일이 섞이지 않게 따로 폴더를 만들어요")}>
          <Switch_ label={t("작업마다 새 워크트리")} on={state.settings.isolate} set={(v) => setState("settings", "isolate", v)} />
        </Row>
        <Row title={t("PR 리뷰 자동 대응")} desc={t("PR에 리뷰가 달리면 작업이 이어서 고쳐요")}>
          <Switch_ label={t("PR 리뷰 자동 대응")} on={!!state.settings.watchPullRequests} set={(v) => setState("settings", "watchPullRequests", v)} />
        </Row>
        <Row title={t("GitHub 푸시·PR 허용")} desc={t("끄면 읽기만 해요")}>
          <Switch_ label={t("GitHub 푸시·PR 허용")} on={state.settings.githubWrite !== false} set={(v) => setState("settings", "githubWrite", v)} />
        </Row>
        <Row title={t("메모리 자동 저장")} desc={t("작업에서 알게 된 것을 기억에 남겨요")}>
          <Switch_ label={t("메모리 자동 저장")} on={state.settings.learn} set={(v) => setState("settings", "learn", v)} />
        </Row>
        <Row title={t("작업 브라우저 미리보기")} desc={t("작업이 브라우저를 쓰면 구석에 작게 띄워요")}>
          <Switch_ label={t("작업 브라우저 미리보기")} on={state.settings.browserPip !== false} set={(v) => setState("settings", "browserPip", v)} />
        </Row>
      </div>

      <GroupTitle title={t("공통 지침")}>
        <span class="set-saved" classList={{ on: saved() }} aria-hidden={!saved()}>{t("저장됨")}</span>
      </GroupTitle>
      <div class="set-group">
        <div class="set-row col" data-set={t("공통 지침")}>
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

      <GroupTitle title={t("정보|about")} />
      <div class="set-group">
        <UpdateRow />
        <Components />
        {/* counts, versions and model ids only (docs/TELEMETRY.md); never what was asked or a file */}
        <Show when={canTrack}>
          <Row title={t("익명 사용 통계 보내기")} desc={t("무엇을 시켰는지, 파일, 계정은 보내지 않아요")}>
            <Switch_ label={t("익명 사용 통계 보내기")} on={state.settings.telemetry !== false} set={(v) => (v || track("telemetry_off", {}), setState("settings", "telemetry", v))} />
          </Row>
        </Show>
      </div>
    </>
  );
}

/** What Ondra runs with: the agent, the browser, app control, the analyzer. A version when known,
 *  how far its download is while one comes in, 없음 when missing. */
function Components() {
  const [status, { refetch }] = createResource(toolStatus);
  window.addEventListener("focus", refetch);
  onCleanup(() => window.removeEventListener("focus", refetch));
  // a component that just came in: its version shows now
  createEffect(on(() => componentOf("chrome")?.state, (s, was) => s === "ready" && was && was !== "ready" && void refetch()));
  const part = (version: string | null | undefined, ready: boolean | undefined, component?: string) => {
    const note = () => componentNote(component ? componentOf(component) : undefined);
    return (
      <Show when={!note()} fallback={<span class="set-note">{note()}</span>}>
        <Show when={ready} fallback={<span class="pill warn">{t("없음|missing")}</span>}>
          <Show when={version && version !== "dev"} fallback={<span class="set-note">{t("준비됨")}</span>}>
            <span class="set-note">{version}</span>
          </Show>
        </Show>
      </Show>
    );
  };
  const analyzer = () => componentOf("binary-analysis");
  return (
    <>
      <Row title={t("에이전트")}>{part(engine.info.engineVersion, engine.ready, "engine")}</Row>
      <Row title={t("브라우저")}>{part(status()?.browserVersion, !!status()?.browserVersion && status()?.chromeReady, "chrome")}</Row>
      <Row title={t("앱 조작")}>{part(status()?.desktopVersion, !!status()?.desktopVersion)}</Row>
      <Show when={analyzer()}>
        {(c) => <Row title={t("바이너리 분석")}>{part(c().version.split("-")[0], c().state === "ready", "binary-analysis")}</Row>}
      </Show>
    </>
  );
}

function UpdateRow() {
  // outside the app (fixture) the package's own version
  const [version] = createResource(() => getVersion().catch(() => appVersion));
  onMount(freshen);
  const pct = () => { const p = updateProgress(); return p === null || p < 0 ? "" : ` ${p}%`; };
  const note = () => {
    const v = available() ?? "";
    return updateStatus() === "checking" ? t("확인 중")
      : updateProgress() !== null ? t("{v} 받는 중", { v }) + pct()
      : updateStatus() === "installing" ? t("다시 시작하는 중")
      : restartQueued() ? t("작업이 끝나면 다시 시작해요")
      : updateReady() && updateReady() === available() ? t("{v} 준비됨", { v })
      : available() ? t("{v} 있음", { v })
      : checkedAt() ? t("최신 버전")
      : "";
  };
  const busy = () => updateStatus() === "installing";
  return (
    <div class="set-row two about-row" data-set={t("업데이트 확인")}>
      <img class="about-icon" src={appIcon} alt="" />
      <div class="set-label">
        <b>{`${appName()} ${version() ?? appVersion}${isBeta(version() ?? appVersion) ? ` ${t("베타")}` : ""}`}</b>
        <span class="set-sub" title={checkedAt() ? ago(checkedAt()) : undefined}>{note() || t("새 버전은 알아서 받아요")}</span>
      </div>
      <div class="set-value">
      <button class="btn ghost sm" onClick={() => setNotesFor(available() ?? version() ?? "")}>{t("릴리스 노트")}</button>
      <Show when={!busy()}>
        <Show
          when={available()}
          fallback={<button class="btn sm" disabled={updateStatus() === "checking"} onClick={() => void checkUpdate(true)}>{t("업데이트 확인")}</button>}
        >
          {/* a restart cuts the jobs at work: by default it waits for them; queued, it can still go now */}
          <Show
            when={!restartQueued()}
            fallback={<button class="btn sm" onClick={() => void installNow()}>{t("지금 다시 시작")}</button>}
          >
            <button class="btn primary sm" onClick={() => (jobsWorking() ? restartWhenIdle() : void installNow())}>
              {updateReady() !== available() ? t("{v} 설치", { v: available()! }) : jobsWorking() ? t("작업 끝나면 다시 시작") : t("다시 시작|update")}
            </button>
          </Show>
        </Show>
      </Show>
      </div>
    </div>
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
const servicesOf = (a: Account) => (a.connection ? [] : [...new Set(a.providers.map(providerName))]);
/** the name the person gave an account; "" when it still has a made-up one ("기본", "회사", "회사 2") */
const ownLabel = (a: Account) => {
  const made = ["기본", "계정", ...state.spaces.map((s) => s.label)].flatMap((l) => [l, t(l)]);
  return a.label && !made.some((l) => a.label === l || a.label.startsWith(`${l} `)) ? a.label : "";
};
/** signed in = the account has a provider login (the same test the account chip uses) */
const signedIn = (a: Account) => a.providers.length > 0 || !!a.connection;

/** "2시간" / "3일": how long until a plan window starts over */
const resetIn = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return t("{m}분", { m });
  const h = Math.round(m / 60);
  return h < 48 ? t("{n}시간", { n: h }) : t("{n}일", { n: Math.round(h / 24) });
};

/** what the per-account sign-in button says (signed in: another service for this account);
 *  its sheet carries the same title */
const loginWord = (a: Account) => (signedIn(a) ? "서비스 추가" : "로그인");

/** what kind of model source a row is: a plan login, an API key, or a model on this Mac */
const kindOf = (a: Account) => (!a.connection ? t("구독") : presetOf(a.connection.preset).local || /localhost|127\.0\.0\.1|0\.0\.0\.0|\.local\b/.test(a.connection.baseUrl) ? t("로컬") : t("API"));

/**
 * One model source in a workspace's list: its logo, its name with its kind and who it is under,
 * plan use on the right, and the rest (sign in again, edit, move, delete) in its ⋯ menu.
 */
function AccountRow(props: { id: string; onLogin: () => void; onEdit: () => void }) {
  const a = () => state.accounts.find((x) => x.id === props.id)!;
  const [typed, setTyped] = createSignal<string>();
  let nameEl!: HTMLInputElement;
  // the plan windows the composer shows (5시간 / 주간), only while signed in; a direct connection has none
  onMount(() => signedIn(a()) && !a().connection && void refreshLimits(props.id));
  const windows = () => (signedIn(a()) && !a().connection ? usageOf(props.id, now()) : []);
  const credits = () => (signedIn(a()) && !a().connection ? creditsOf(props.id) : undefined);
  // provider + email until the person names it; clearing the name goes back to that
  const made = () => state.spaces.find((s) => s.id === a().space)?.label ?? "계정";
  const auto = () => servicesOf(a()).join(" · ") || (a().connection ? t(presetOf(a().connection!.preset).name) : "") || accountName({ ...a(), label: made() });
  const rename = (v: string) => updateAccount(props.id, (x) => (x.label = v.trim() && v.trim() !== auto() ? v.trim() : made()));
  // the kind, then who it is (the email, unless the name already shows it) or how many models
  const sub = () => {
    const shown = ownLabel(a()) || auto();
    const who = a().connection ? t("모델 {n}개", { n: a().connection!.models.length }) : emails[props.id] && !shown.includes(emails[props.id]) ? emails[props.id] : !signedIn(a()) ? t("로그인 필요") : "";
    return [kindOf(a()), who].filter(Boolean).join(" · ");
  };
  const logo = () => (a().connection ? (logoFor(a().connection!.preset) ? a().connection!.preset : "") : (servicesOf(a())[0] ?? ""));
  const menu = (): MenuEntry[] => [
    a().connection
      ? { id: "edit", label: t("편집"), icon: "pencil", run: props.onEdit }
      : { id: "login", label: t(loginWord(a())), icon: "key", run: props.onLogin },
    { id: "rename", label: t("이름 바꾸기"), icon: "pencil", run: () => requestAnimationFrame(() => (nameEl.focus(), nameEl.select())) },
    ...(state.spaces.length > 1
      ? (["sep", ...state.spaces.filter((s) => s.id !== a().space).map((s) => ({ id: `to-${s.id}`, label: t("{name}(으)로 옮기기", { name: t(s.label) }), icon: "arrow", run: () => updateAccount(props.id, (x) => (x.space = s.id)) }))] as MenuEntry[])
      : []),
    ...(props.id === "default"
      ? []
      : (["sep", {
          id: "delete",
          label: a().connection ? t("연결 삭제") : t("계정 삭제"),
          icon: "trash",
          danger: true,
          run: () => {
            accountRemove(props.id);
            setState("accounts", (l) => l.filter((x) => x.id !== props.id));
          },
        }] as MenuEntry[])),
  ];
  return (
    <div class="prov-row" classList={{ ctx: ctxFor() === `acc:${props.id}` }}>
      <span class="prov-logo" title={a().connection?.baseUrl}>
        <Show when={logo()} fallback={<Icon name={a().connection ? "link" : "key"} size={16} />}>
          <Logo name={logo() === "Claude" ? "claude" : logo()} size={18} />
        </Show>
      </span>
      <div class="prov-text">
        <span class="acc-name-wrap" data-v={typed() ?? (ownLabel(a()) || auto())}>
          <input
            ref={nameEl}
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
        <span class="prov-sub">{sub()}</span>
      </div>
      <span class="spacer" />
      <span class="prov-usage">
        <For each={windows()}>
          {(l) => (
            <span class="acc-lim" classList={{ hot: l.used >= 80 && !credits() }} title={l.resetsAt ? t("{t} 후 초기화", { t: resetIn(l.resetsAt - now()) }) : undefined}>
              {t("{w} {n}%", { w: windowLabel(l.window), n: Math.round(l.used) })}
            </span>
          )}
        </For>
        <Show when={credits()}>
          {(c) => <span class="acc-stat" title={t("요금제 한도 이후 사용")}>{t("크레딧 {n}|left", { n: Number.isFinite(Number(c())) ? Number(c()) : c() })}</span>}
        </Show>
      </span>
      <Show when={!signedIn(a())}>
        <button class="btn sm primary" onClick={props.onLogin}>{t("로그인")}</button>
      </Show>
      <button
        class="icon-btn sm prov-more"
        title={t("더 보기")}
        aria-label={t("더 보기")}
        onClick={(e) => openMenuAt(`acc:${props.id}`, menu, e.currentTarget.getBoundingClientRect())}
      >
        <Icon name="more" size={16} />
      </button>
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

/** a 계정 추가 asked for from outside Settings, waiting for the 계정 tab to pick it up */
const [addFor, setAddFor] = createSignal<SpaceId | null>(null);
/** Opens Settings › 계정 and starts 계정 추가 for this workspace (e.g. from a no-account card). */
export function openAddAccount(space: SpaceId = state.space) {
  setAddFor(space);
  setView({ name: "settings", tab: "accounts" });
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
  // a request from outside (openAddAccount): start it once this tab is up
  createEffect(() => {
    const s = addFor();
    if (!s) return;
    setAddFor(null);
    if (!pending() && state.spaces.some((x) => x.id === s)) add(s);
  });
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
  // each workspace with its own accounts: its name, folder and instructions are set here too
  const [editing, setEditing] = createSignal<SpaceId | "new" | null>(null);
  /** 직접 연결: a new one in a workspace, or an existing one to edit */
  const [conn, setConn] = createSignal<{ space: SpaceId; accountId?: string } | null>(null);
  return (
    <>
      <PageHead tab="accounts">
        <button class="btn sm" onClick={() => setEditing("new")}><Icon name="plus" size={14} />{t("워크스페이스 추가")}</button>
      </PageHead>
      <For each={state.spaces}>
        {(s) => (
          <>
            <GroupTitle title={t(s.label)}>
              <button class="btn ghost sm" onClick={() => setEditing(s.id)} title={`${folderName(s.folder)} · ${t("작업 {n}개", { n: state.tasks.filter((x) => x.space === s.id && !x.parentId && !x.answer && !x.archived).length })}`}>
                <Icon name="gear" size={14} />
                {t("워크스페이스 설정")}
              </button>
            </GroupTitle>
            {/* every model source of this workspace in one list: plan logins, API keys and local models alike */}
            <div class="set-group prov-list">
              <For each={state.accounts.filter((a) => a.space === s.id)}>
                {(a) => <AccountRow id={a.id} onLogin={() => setLogin({ id: a.id, title: loginWord(a) })} onEdit={() => setConn({ space: a.space, accountId: a.id })} />}
              </For>
              <Show when={pending()?.space === s.id}>
                <div class="prov-row">
                  <span class="prov-logo"><span class="spin sm" /></span>
                  <div class="prov-text"><span class="prov-title">{t("새 계정")}</span><span class="prov-sub">{t("로그인 중")}</span></div>
                </div>
              </Show>
              <button
                class="prov-add"
                classList={{ ctx: ctxFor() === `add:${s.id}` }}
                disabled={!!pending()}
                onClick={(e) =>
                  openMenuAt(`add:${s.id}`, () => [
                    { id: "plan", label: t("구독 계정으로 로그인"), icon: "key", run: () => add(s.id) },
                    { id: "api", label: t("API 키 · 로컬 모델 연결"), icon: "link", run: () => setConn({ space: s.id }) },
                  ], e.currentTarget.getBoundingClientRect())
                }
              >
                <Icon name="plus" size={15} />
                {t("연결")}
              </button>
            </div>
          </>
        )}
      </For>
      <Show when={login()}>{(l) => <LoginSheet accountId={l().id} title={t(l().title)} onClose={() => void closed()} />}</Show>
      <Show when={editing()}>{(id) => <SpaceSheet id={id()} onClose={() => setEditing(null)} />}</Show>
      <Show when={conn()}>{(c) => <ConnectionSheet space={c().space} accountId={c().accountId} onClose={() => setConn(null)} />}</Show>
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
      <PageHead tab="import" />
      <Show
        when={found().length}
        fallback={
          <div class="set-group">
            <EmptyState icon="download" title={scanning() ? t("찾는 중") : t("가져올 게 아직 없어요")} desc={t("다른 AI 도구에서 쓰던 지침·스킬·세션을 찾으면 여기에 보여요")}>
              <button class="btn sm" onClick={scan} disabled={scanning()}><Icon name="refresh" size={14} />{t("다시 찾기")}</button>
            </EmptyState>
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
        <For each={sessions()} fallback={<EmptyState icon="message" title={query() ? t("결과 없음") : t("세션 없음")} />}>
          {(s) => (
            <div class="item-row">
              <div class="item-main">
                <b>{s.title || t("제목 없음")}</b>
                <p>{s.sourceName} · {tilde(s.cwd) || t("폴더 모름")} · {agoIn(s.updatedAt)} · {t("메시지 {n}개", { n: s.messages })}</p>
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

// ───────────────── permissions (macOS): what the agent may do lives in 일반 › 에이전트
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
      <PageHead tab="tools" />
      <div class="set-group">
        <Row title={t("손쉬운 사용")} desc={t("작업이 다른 앱을 누르고 입력하려면 필요해요")}>
          {perm(status()?.accessibility, () => void askPermission("accessibility"))}
        </Row>
        <Row title={t("화면 기록")} desc={t("작업이 앱 화면을 보려면 필요해요")}>
          {perm(status()?.screenRecording, () => void askPermission("screen"))}
        </Row>
      </div>
    </>
  );
}

// ───────────────── shortcuts
interface KeyRow { id: ShortcutId; label: string; section: string; note?: string }

/**
 * Every key the app has, in the palette's section order, each one rebindable: the commands,
 * the keys that aren't commands (hints, quick input, quit) and ⌘1–9 by place in the sidebar.
 */
function keyRows(): KeyRow[] {
  const commands = appCommands();
  const rows: KeyRow[] = SHORTCUT_EXTRAS.map(([id, label]) => ({ id, label: t(label), section: t("일반") }));
  const places = () => Array.from({ length: 9 }, (_, i): KeyRow => {
    const space = state.spaces[i];
    return { id: `ws${i + 1}` as ShortcutId, label: t("워크스페이스 {n}", { n: i + 1 }), section: t("워크스페이스"), note: space && t(space.label) };
  });
  const macRows = () => Array.from({ length: 9 }, (_, i): KeyRow => {
    const m = macs()[i];
    return { id: `mac${i + 1}` as ShortcutId, label: t("Mac {n}", { n: i + 1 }), section: t("Mac"), note: m?.name };
  });
  let placed = false;
  let macsPlaced = false;
  for (const c of commands) {
    if (c.id.startsWith("mac-")) {
      if (!macsPlaced) rows.push(...macRows());
      macsPlaced = true;
      continue;
    }
    // a workspace's command is bound by its place: the nine rows stand for them
    if (c.id.startsWith("sp-")) {
      if (!placed) rows.push(...places());
      placed = true;
    } else if (isShortcutId(c.id)) rows.push({ id: c.id, label: c.label, section: c.section });
  }
  if (!placed) rows.push(...places());
  if (!macsPlaced) rows.push(...macRows());
  // an id the table has but no row lists yet still gets one
  for (const id of Object.keys(shortcuts) as ShortcutId[]) if (!rows.some((r) => r.id === id)) rows.push({ id, label: id, section: t("기타") });
  return rows;
}

// while a chip records, the native side lets go of its keys (⌥Space, ⌘Q, ⌘W) so the page gets them (App.tsx)
const [recording, setRecording] = createSignal(false);
export { recording as recordingKeys };

const writeBindings = (next: Record<string, string>) => setState("settings", { keybindings: next });
const mods = (e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) =>
  `${e.ctrlKey ? "⌃" : ""}${e.altKey ? "⌥" : ""}${e.shiftKey ? "⇧" : ""}${e.metaKey ? "⌘" : ""}`;

const modCount = (s: Shortcut) => [s.meta, s.ctrl, s.alt, s.shift].filter(Boolean).length;

type KeyNote = { id: string; text: string; chord?: Shortcut; other?: ShortcutId };

function Shortcuts() {
  const [q, setQ] = createSignal("");
  const [rec, setRec] = createSignal<string | null>(null);
  const [held, setHeld] = createSignal("");
  const [note, setNote] = createSignal<KeyNote | null>(null);
  // a hold of modifiers alone (hints): the most held at once, kept until they are all let go
  let peak: Shortcut | null = null;
  const rows = createMemo(keyRows);
  createEffect(() => setRecording(rec() !== null));
  onCleanup(() => setRecording(false));
  const shown = createMemo(() => {
    const query = q().trim().toLowerCase();
    const out = new Map<string, KeyRow[]>();
    for (const r of rows()) {
      if (query && ![r.label, r.note ?? "", keyText(r.id)].some((s) => s.toLowerCase().includes(query))) continue;
      out.set(r.section, [...(out.get(r.section) ?? []), r]);
    }
    return [...out];
  });
  const anyChanged = () => Object.keys(overrides()).some((id) => changed(overrides(), id));
  const chip = (id: string) => document.getElementById(`kb-${id}`);
  const stop = () => {
    setRec(null);
    setHeld("");
    peak = null;
  };
  const start = (id: string) => {
    setNote(null);
    stop();
    setRec(id);
    // WebKit doesn't focus a button on click: the keys must reach the chip
    chip(id)?.focus();
  };
  const done = (id: string, next: Record<string, string>) => {
    writeBindings(next);
    stop();
    setNote(null);
    queueMicrotask(() => chip(id)?.focus());
  };
  /** the chord for `id`: refused, taken (바꾸기 offered), or set */
  const take = (id: ShortcutId, chord: Shortcut) => {
    const why = refusal(chord, id);
    if (why) return void setNote({ id, text: `${chordLabel(chord)} · ${t(why)}` });
    const other = conflictOf(chord, id, overrides());
    if (!other) return done(id, assign(overrides(), id, chord));
    const label = rows().find((r) => r.id === other)?.label ?? other;
    stop();
    setNote({ id, chord, other, text: `${chordLabel(chord)} · ${t("{name}에 쓰고 있어요", { name: label })}` });
    queueMicrotask(() => document.querySelector<HTMLElement>(".kb-note .btn")?.focus());
  };
  const onKey = (e: KeyboardEvent, id: ShortcutId) => {
    if (rec() !== id) return;
    // bare Tab leaves the row as it would anywhere
    if (e.code === "Tab" && noModifiers(e)) return stop();
    e.preventDefault();
    e.stopPropagation();
    if (modifierOnly(e.code)) {
      const now = chordOf({ code: "", metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey });
      if (!peak || modCount(now) >= modCount(peak)) peak = now;
      return void setHeld(mods(e));
    }
    peak = null;
    if (noModifiers(e) && e.code === "Escape") return (stop(), setNote(null));
    if (noModifiers(e) && (e.code === "Backspace" || e.code === "Delete")) return done(id, assign(overrides(), id, null));
    take(id, chordOf(e));
  };
  const onKeyUp = (e: KeyboardEvent, id: ShortcutId) => {
    if (rec() !== id || !modifierOnly(e.code)) return;
    setHeld(mods(e));
    // modifiers let go with no key between: a hold, for the row that is one
    if (modifierHold(id) && peak && !mods(e)) take(id, peak);
  };
  const cancelNote = (id: string) => {
    setNote(null);
    queueMicrotask(() => chip(id)?.focus());
  };
  return (
    <>
      <div class="set-sticky">
      <PageHead tab="shortcuts">
        <button class="btn sm" disabled={!anyChanged()} onClick={() => (stop(), setNote(null), writeBindings({}), toast(t("기본값으로 되돌렸어요")))}>{t("모두 기본값으로")}</button>
      </PageHead>
      <label class="tl-search">
        <Icon name="search" size={14} />
        <input placeholder={t("검색")} aria-label={t("단축키 검색")} value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      </label>
      </div>
      <For each={shown()} fallback={<div class="set-group"><div class="empty-line">{t("결과 없음")}</div></div>}>
        {([section, list]) => (
          <>
            <GroupTitle title={section} />
            <div class="set-group">
              <For each={list}>
                {(r) => (
                  <>
                    <div class="set-row kb-row" classList={{ rec: rec() === r.id }} data-set={r.label}>
                      <div class="set-label">
                        <b>{r.label}</b>
                        <Show when={r.note}><span class="kb-for">{r.note}</span></Show>
                      </div>
                      <div class="set-value">
                        <Show when={rec() === r.id}>
                          <span class="kb-help">{modifierHold(r.id) ? t("눌렀다 떼면 바뀌어요") : t("esc 취소 · ⌫ 지우기")}</span>
                        </Show>
                        <Show when={changed(overrides(), r.id) && rec() !== r.id}>
                          <button class="btn ghost sm kb-reset" title={`${t("기본값으로")} (${keyText(r.id, shortcuts[r.id])})`} aria-label={t("{name} 기본값으로", { name: r.label })} onClick={() => done(r.id, reset(overrides(), r.id))}>
                            {t("기본값")}
                          </button>
                        </Show>
                        <button
                          id={`kb-${r.id}`}
                          class="kb-chip"
                          classList={{ rec: rec() === r.id, none: !binding(r.id), changed: changed(overrides(), r.id) }}
                          data-shortcuts={rec() === r.id ? "local" : undefined}
                          title={rec() === r.id ? undefined : t("눌러서 바꾸기")}
                          aria-label={`${r.label} ${keyText(r.id) || t("없음")}, ${t("눌러서 바꾸기")}`}
                          aria-pressed={rec() === r.id}
                          aria-describedby={note()?.id === r.id ? "kb-note" : undefined}
                          onClick={() => (rec() === r.id ? stop() : start(r.id))}
                          onKeyDown={(e) => onKey(e, r.id)}
                          onKeyUp={(e) => onKeyUp(e, r.id)}
                          onBlur={() => rec() === r.id && (stop(), note()?.chord || setNote(null))}
                        >
                          {rec() === r.id ? held() || t("키를 누르세요") : keyText(r.id) || t("없음")}
                        </button>
                      </div>
                    </div>
                    <Show when={note()?.id === r.id && note()}>
                      {(n) => (
                        <div id="kb-note" class="kb-note" classList={{ refused: !n().chord }} role="alert" data-shortcuts="local" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), cancelNote(r.id))}>
                          <span>{n().text}</span>
                          <Show when={n().chord}>
                            <button class="btn sm" onClick={() => done(r.id, moveTo(overrides(), r.id, n().chord!))}>{t("바꾸기")}</button>
                            <button class="btn sm ghost" onClick={() => cancelNote(r.id)}>{t("취소")}</button>
                          </Show>
                        </div>
                      )}
                    </Show>
                  </>
                )}
              </For>
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

export const SETTINGS_TABS: { id: SettingsTab; label: string; icon: string; desc: string; group: string }[] = [
  { id: "general", label: "일반", icon: "gear", desc: "화면, 새 작업, 작업 방식을 정해요", group: "" },
  { id: "accounts", label: "계정과 워크스페이스", icon: "key", desc: "워크스페이스마다 쓸 AI 계정과 모델을 연결해요", group: "" },
  { id: "remote", label: "연결", icon: "monitor", desc: "다른 Mac의 프로젝트를 여기서 써요. 오가는 내용은 끝까지 암호화돼요.", group: "" },
  { id: "agent-tools", label: "도구", icon: "tools", desc: "작업이 쓸 수 있는 도구를 켜고 꺼요", group: "에이전트|group" },
  { id: "skills", label: "스킬", icon: "skill", desc: "작업이 필요할 때 꺼내 쓰는 방법 모음이에요", group: "에이전트|group" },
  { id: "hooks", label: "훅", icon: "bolt", desc: "작업 중 정해진 때에 내 명령을 실행해요", group: "에이전트|group" },
  { id: "tools", label: "macOS 권한", icon: "shield", desc: "작업이 화면을 보고 앱을 다루려면 필요해요", group: "이 Mac" },
  { id: "import", label: "가져오기", icon: "download", desc: "다른 AI 도구에서 쓰던 지침·스킬·세션을 가져와요", group: "이 Mac" },
  { id: "shortcuts", label: "단축키", icon: "keyboard", desc: "키를 눌러 바로 바꿔요", group: "이 Mac" },
];

/** Settings the search finds without the tab open: the tab, and the row's name as its Row shows it. */
const FINDABLE: [SettingsTab, string][] = [
  ["general", "테마"], ["general", "화면 크기"], ["general", "언어"], ["general", "링크 열기"],
  ["general", "기본 모델"], ["general", "기본 권한"], ["general", "동시 작업 수"], ["general", "빌드·시뮬레이터 작업 동시 수"],
  ["general", "작업마다 새 워크트리"], ["general", "PR 리뷰 자동 대응"], ["general", "GitHub 푸시·PR 허용"], ["general", "메모리 자동 저장"],
  ["general", "작업 브라우저 미리보기"], ["general", "공통 지침"], ["general", "업데이트 확인"],
  ["general", "익명 사용 통계 보내기"],
  ["tools", "손쉬운 사용"], ["tools", "화면 기록"],
  ["remote", "다른 Mac에서 이 Mac 쓰기"], ["remote", "잠자기 방지"], ["remote", "연결 링크"],
];

/** a row asked for from the search: the tab opens, then the row is brought into view and lit */
const [jump, setJump] = createSignal<string | null>(null);

const settingsTab = () => {
  const v = view();
  return (v.name === "settings" && v.tab) || "general";
};

/** Settings take the whole window. The sidebar becomes the list of sections, with a search on top. */
export function SettingsNav(props: { onBack: () => void }) {
  const [q, setQ] = createSignal("");
  let input!: HTMLInputElement;
  const tabOf = (id: SettingsTab) => SETTINGS_TABS.find((x) => x.id === id)!;
  type Hit = { tab: SettingsTab; label: string; row?: string };
  const hits = createMemo((): Hit[] => {
    const query = q().trim().toLowerCase();
    if (!query) return [];
    const has = (...s: string[]) => s.some((x) => x.toLowerCase().includes(query));
    const out: Hit[] = SETTINGS_TABS.filter((x) => has(t(x.label), t(x.desc))).map((x) => ({ tab: x.id, label: t(x.label) }));
    for (const [tab, k] of FINDABLE) if (has(t(k))) out.push({ tab, label: t(k), row: t(k) });
    for (const r of keyRows()) if (has(r.label)) out.push({ tab: "shortcuts", label: r.label, row: r.label });
    return out.slice(0, 30);
  });
  const go = (h: Hit) => {
    setView({ name: "settings", tab: h.tab });
    setJump(h.row ?? null);
  };
  // ⌘F finds in Settings
  const key = (e: KeyboardEvent) => {
    if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyF") {
      e.preventDefault();
      input.focus();
      input.select();
    }
  };
  onMount(() => window.addEventListener("keydown", key));
  onCleanup(() => window.removeEventListener("keydown", key));
  const groups = () => [...new Set(SETTINGS_TABS.map((x) => x.group))];
  return (
    <aside class="sidebar settings-side">
      <div class="sb-top" data-tauri-drag-region />
      <div class="sb-scroll">
        <button class="sb-row sb-main settings-back" onClick={props.onBack} title={`${t("앱으로 돌아가기")} (Esc)`}>
          <Icon name="back" size={16} />
          <span class="sb-title">{t("앱으로 돌아가기")}</span>
        </button>
        <label class="set-find">
          <Icon name="search" size={14} />
          <input
            ref={input}
            placeholder={t("설정 검색")}
            aria-label={t("설정 검색")}
            value={q()}
            data-shortcuts="local"
            onInput={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                q() ? setQ("") : input.blur();
              } else if (e.key === "Enter" && hits()[0]) go(hits()[0]);
            }}
          />
          <Show when={!q()}><kbd>⌘F</kbd></Show>
        </label>
        <Show
          when={q().trim()}
          fallback={
            <div class="settings-side-list">
              <For each={groups()}>
                {(g) => (
                  <>
                    <Show when={g}><div class="set-nav-group">{t(g)}</div></Show>
                    <For each={SETTINGS_TABS.filter((x) => x.group === g)}>
                      {(tab) => (
                        <button class="sb-row sb-main set-nav" classList={{ on: settingsTab() === tab.id }} onClick={() => setView({ name: "settings", tab: tab.id })}>
                          <span class="set-nav-icon"><Icon name={tab.icon} size={14} /></span>
                          <span class="sb-title">{t(tab.label)}</span>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </div>
          }
        >
          <div class="settings-side-list set-hits">
            <For each={hits()} fallback={<div class="set-nav-none">{t("찾는 설정이 없어요")}</div>}>
              {(h, i) => (
                <button class="sb-row sb-main set-hit" classList={{ first: i() === 0 }} onClick={() => go(h)}>
                  <span class="set-nav-icon"><Icon name={tabOf(h.tab).icon} size={14} /></span>
                  <span class="set-hit-text">
                    <span class="sb-title">{h.label}</span>
                    <Show when={h.row}><span class="set-hit-tab">{t(tabOf(h.tab).label)}</span></Show>
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
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
  // a row found by the search: once its tab is drawn, bring it into view and light it for a moment
  createEffect(on(jump, (row) => {
    if (!row) return;
    setTimeout(() => {
      setJump(null);
      const el = [...body.querySelectorAll<HTMLElement>("[data-set]")].find((x) => x.dataset.set!.startsWith(row));
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("found");
      void el.offsetWidth;
      el.classList.add("found");
      setTimeout(() => el.classList.remove("found"), 1800);
    }, 120);
  }));
  return (
    <div class="settings settings-page">
      <div class="head" data-tauri-drag-region />
      <div class="settings-body" ref={body}>
        <div class="settings-inner">
          <Switch>
            <Match when={settingsTab() === "general"}><General /></Match>
            <Match when={settingsTab() === "shortcuts"}><Shortcuts /></Match>
            <Match when={settingsTab() === "remote"}><RemoteSettings /></Match>
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
