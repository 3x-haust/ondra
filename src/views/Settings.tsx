// Settings: general, accounts, import from other tools, skills, tools.
import { modelsOf } from "../engine/modelList";
import { ignoredKey, noModifiers, shortcutLabel, viewKey, type ShortcutCommand } from "../lib/shortcuts";
import { appCommands } from "../state/commands";
import { createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
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
import { LoginSheet } from "./Login";
import { SkillsTab } from "./SkillsTab";
import { ToolsTab } from "./Tools";
import { HooksTab } from "./Hooks";
import { Logo } from "../ui/Logos";
import { Sheet } from "../ui/Sheet";
import { getVersion } from "@tauri-apps/api/app";
import { available, checkedAt, checkUpdate, installNow, updateStatus } from "../engine/update";
import { setNotesFor } from "../engine/releaseNotes";


function Stepper(props: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div class="stepper">
      <button disabled={props.value <= props.min} onClick={() => props.onChange(props.value - 1)} aria-label="줄이기">−</button>
      <span>{props.value}</span>
      <button disabled={props.value >= props.max} onClick={() => props.onChange(props.value + 1)} aria-label="늘리기">+</button>
    </div>
  );
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

// ───────────────── general
function General() {
  const [editing, setEditing] = createSignal<SpaceId | "new" | null>(null);
  return (
    <>
      <h2>일반</h2>
      <div class="set-group">
        <Row title="테마">
          <div class="seg">
            <For each={[["system", "시스템"], ["light", "라이트"], ["dark", "다크"]] as const}>
              {([v, l]) => <button classList={{ on: state.settings.theme === v }} onClick={() => setState("settings", "theme", v)}>{l}</button>}
            </For>
          </div>
        </Row>
        <Row title="동시 실행" desc="코드 수정, 조사 같은 일반 작업">
          <Stepper value={state.settings.slots.light} min={1} max={10} onChange={(n) => setState("settings", "slots", "light", n)} />
        </Row>
        <Row title="무거운 일" desc="시뮬레이터, 빌드, 앱 조작 — 한 번에 몇 개까지">
          <Stepper value={state.settings.slots.heavy} min={1} max={3} onChange={(n) => setState("settings", "slots", "heavy", n)} />
        </Row>
        <Row title="일마다 따로 복사해서 일하기" desc="프로젝트 폴더라면 일마다 복사본을 만들어 서로 덮어쓰지 않아요. 끝나면 확인하고 합쳐요">
          <button class="switch" classList={{ on: state.settings.isolate }} role="switch" aria-checked={state.settings.isolate} onClick={() => setState("settings", "isolate", !state.settings.isolate)}><i /></button>
        </Row>
        <Row title="PR 지켜보기" desc="일이 연 PR에 리뷰가 달리거나 검사가 실패하거나 충돌이 나면 그 일이 이어서 처리해요">
          <button class="switch" classList={{ on: !!state.settings.watchPullRequests }} role="switch" aria-checked={!!state.settings.watchPullRequests} onClick={() => setState("settings", "watchPullRequests", !state.settings.watchPullRequests)}><i /></button>
        </Row>
        <Row title="자동으로 기억" desc="자주 하는 요청과 선호를 알아서 기억해요">
          <button class="switch" classList={{ on: state.settings.learn }} role="switch" aria-checked={state.settings.learn} onClick={() => setState("settings", "learn", !state.settings.learn)}><i /></button>
        </Row>
        <Row title="일이 띄운 앱은 뒤에" desc="일이 연 앱이 앞으로 나오면 쓰던 창으로 돌아가요">
          <button class="switch" classList={{ on: state.settings.focusGuard }} role="switch" aria-checked={state.settings.focusGuard} onClick={() => setState("settings", "focusGuard", !state.settings.focusGuard)}><i /></button>
        </Row>
      </div>

      <div class="set-group-title">공통 지시</div>
      <div class="set-group">
        <div class="set-row col">
          <textarea
            class="textarea"
            rows={6}
            value={state.settings.instructions}
            
            onChange={(e) => setState("settings", "instructions", e.currentTarget.value)}
          />
        </div>
      </div>

      <div class="set-group-title" style={{ display: "flex", "align-items": "center" }}>
        공간
        <span class="spacer" />
        <button class="btn ghost sm" onClick={() => setEditing("new")}><Icon name="plus" size={13} />공간 추가</button>
      </div>
      <div class="set-group">
        <For each={state.spaces}>
          {(s) => (
            <button class="sp-row" onClick={() => setEditing(s.id)}>
              <b>{s.label}</b>
              <Show when={state.space === s.id}><span class="sp-now">지금</span></Show>
              <span class="sp-folder"><Icon name="folder" size={12} />{s.folder}</span>
              <span class="sp-n">일 {state.tasks.filter((t) => t.space === s.id).length}</span>
              <Icon name="chevron" size={13} class="sp-go" />
            </button>
          )}
        </For>
      </div>
      <Show when={editing()}>{(id) => <SpaceSheet id={id()} onClose={() => setEditing(null)} />}</Show>

      <div class="set-group-title">업데이트</div>
      <div class="set-group">
        <UpdateRow />
      </div>
    </>
  );
}

function UpdateRow() {
  const [version] = createResource(() => getVersion().catch(() => ""));
  const note = () =>
    updateStatus() === "checking" ? "확인 중…"
    : updateStatus() === "installing" ? "받는 중… 끝나면 다시 시작해요"
    : available() ? `${available()} 나옴`
    : checkedAt() ? `최신 버전 · ${ago(checkedAt())} 확인`
    : "";
  return (
    <Row title={`Ondra ${version() ?? ""}`}>
      <span class="set-note">{note()}</span>
      <button class="btn ghost sm" onClick={() => setNotesFor(available() ?? version() ?? "")}>릴리즈 노트</button>
      <Show
        when={available()}
        fallback={<button class="btn sm" disabled={updateStatus() === "checking" || updateStatus() === "installing"} onClick={() => void checkUpdate(true)}>업데이트 확인</button>}
      >
        <button class="btn primary sm" disabled={updateStatus() === "installing"} onClick={() => void installNow()}>{available()} 설치</button>
      </Show>
    </Row>
  );
}

/** One space in a dialog: a new one, or editing an existing one. */
function SpaceSheet(props: { id: SpaceId | "new"; onClose: () => void }) {
  const cur = props.id === "new" ? undefined : state.spaces.find((x) => x.id === props.id);
  const [label, setLabel] = createSignal(cur?.label ?? "");
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
    if (cur) setState("spaces", (x) => x.id === cur.id, { label: l, folder: folder(), rules: rules() });
    if (cur && (gitName() !== undefined || gitEmail() !== undefined))
      void spaceGitIdentity(cur, gitName() ?? tools()?.git_name ?? "", gitEmail() ?? tools()?.git_email ?? "");
    else setState("spaces", (list) => [...list, { id: uid("sp"), label: l, folder: folder(), rules: rules() }]);
    props.onClose();
  };
  return (
    <Sheet
      title={cur ? cur.label : "새 공간"}
      class="sp-sheet"
      onClose={props.onClose}
      foot={
        <>
          <Show when={cur && cur.id !== "home"}><SpaceDelete id={cur!.id} onDone={props.onClose} /></Show>
          <span class="spacer" />
          <button class="btn ghost sm" onClick={props.onClose}>취소</button>
          <button class="btn primary sm" disabled={!label().trim()} onMouseDown={(e) => e.preventDefault()} onClick={save}>{cur ? "저장" : "만들기"}</button>
        </>
      }
    >
      <div class="sp-form">
        <label class="sp-field">
          <span>이름</span>
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
          <span>기본 폴더</span>
          <button
            class="sp-pick"
            onClick={async () => {
              const p = await pickFolder("기본 폴더");
              if (p) setFolder(tilde(p));
            }}
          >
            <Icon name="folder" size={13} />
            <code>{folder()}</code>
            <span class="spacer" />
            <span class="muted">변경</span>
          </button>
        </div>
        <Show when={cur}>
          <div class="sp-field">
            <span>CLI 로그인</span>
            <button
              class="sp-pick"
              onClick={async () => {
                const p = await pickFolder("이 공간의 CLI 로그인 폴더");
                if (!p) return;
                setState("spaces", (x) => x.id === cur!.id, { cliHome: tilde(p) });
                loadTools();
              }}
            >
              <Icon name="folder" size={13} />
              <code>{tools()?.home ? tilde(tools()!.home!) : "Mac 기본"}</code>
              <span class="spacer" />
              <span class="muted">변경</span>
            </button>
          </div>
          <div class="sp-field">
            <span>GitHub</span>
            <div class="sp-gh">
              <Show when={tools()?.gh_user} fallback={<span class="muted">로그인 안 됨</span>}>
                <code>{tools()!.gh_user}</code>
              </Show>
              <span class="spacer" />
              <button class="btn ghost sm" onClick={() => void spaceGhLogin(state.spaces.find((x) => x.id === cur!.id) ?? cur!)}>{tools()?.gh_user ? "다시 로그인" : "로그인"}</button>
            </div>
          </div>
          <label class="sp-field">
            <span>Aside 계정</span>
            <input
              class="input"
              placeholder="u0"
              value={state.spaces.find((x) => x.id === cur!.id)?.aside ?? ""}
              onChange={(e) => setState("spaces", (x) => x.id === cur!.id, { aside: e.currentTarget.value.trim() || undefined })}
            />
          </label>
          <div class="sp-field sp-git">
            <span>커밋 작성자</span>
            <div class="sp-git-row">
              <input class="input" placeholder="이름" value={gitName() ?? tools()?.git_name ?? ""} onInput={(e) => setGitName(e.currentTarget.value)} />
              <input class="input" placeholder="이메일" value={gitEmail() ?? tools()?.git_email ?? ""} onInput={(e) => setGitEmail(e.currentTarget.value)} />
            </div>
          </div>
        </Show>
        <label class="sp-field">
          <span>규칙</span>
          <textarea class="textarea" rows={5} value={rules()} onInput={(e) => setRules(e.currentTarget.value)} />
        </label>
      </div>
    </Sheet>
  );
}

/** Removing a space keeps its work: jobs, projects, accounts and memory move to 개인. */
function SpaceDelete(props: { id: SpaceId; onDone?: () => void }) {
  const [sure, setSure] = createSignal(false);
  const n = () => state.tasks.filter((t) => t.space === props.id).length + (state.projects ?? []).filter((p) => p.space === props.id).length;
  const remove = () => {
    const to = "home";
    setState("tasks", (t) => t.space === props.id, "space", to);
    setState("projects", (p) => p.space === props.id, "space", to);
    setState("accounts", (a) => a.space === props.id, "space", to);
    setState("memory", (m) => m.space === props.id, "space", to);
    setState("captain", (m) => m.space === props.id, "space", to);
    if (state.space === props.id) setState("space", to);
    setState("spaces", (l) => l.filter((s) => s.id !== props.id));
    toast("공간을 지웠어요");
    props.onDone?.();
  };
  return (
    <button
      class="btn ghost sm"
      classList={{ danger: sure() }}
      onClick={() => (sure() ? remove() : setSure(true))}
      onBlur={() => setSure(false)}
      title={n() ? `일 · 프로젝트 ${n()}개는 개인으로 옮겨요` : undefined}
    >
      {sure() ? "정말 지울까요?" : "지우기"}
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
  const used = () => a().stats.input + a().stats.cacheRead + a().stats.cacheWrite + a().stats.output;
  return (
    <div class="item-row" style={{ "align-items": "flex-start", "flex-wrap": "wrap" }}>
      <div class="item-main" style={{ display: "grid", gap: "var(--s-6)" }}>
        <div style={{ display: "flex", "align-items": "center", gap: "var(--s-8)" }}>
          <input class="input" style={{ width: "150px", height: "var(--h-sm)" }} value={a().label} onChange={(e) => updateAccount(props.id, (x) => (x.label = e.currentTarget.value.trim() || x.label))} />
          <For each={[...new Set(a().providers.map(providerName))]} fallback={<span class="pill warn">로그인 필요</span>}>
            {(p) => (
              <span class="pill svc" title={props.id === "default" ? `${p} · 이 Mac의 기본 로그인이에요 (~/.pi)` : p}>
                <Logo name={p === "Claude" ? "claude" : p} size={13} />
                {p}
              </span>
            )}
          </For>
        </div>
        <div style={{ display: "flex", "align-items": "center", gap: "var(--s-8)", "flex-wrap": "wrap" }}>
          <select class="select" value={a().model} onChange={(e) => updateAccount(props.id, (x) => (x.model = e.currentTarget.value))}>
            <option value="" disabled>모델 고르기</option>
            <For each={models() ?? (a().model ? [a().model] : [])}>{(m) => <option value={m}>{prettyModel(m)}</option>}</For>
          </select>
          <select
            class="select"
            value={a().effort || "high"}
            onChange={(e) => {
              updateAccount(props.id, (x) => (x.effort = e.currentTarget.value));
            }}
          >
            <For each={EFFORTS}>{(x) => <option value={x.id}>{x.label}</option>}</For>
          </select>
          <select class="select" value={a().space} onChange={(e) => updateAccount(props.id, (x) => (x.space = e.currentTarget.value as SpaceId))}>
            <For each={state.spaces}>{(s) => <option value={s.id}>{s.label}</option>}</For>
          </select>
          <Show when={used()} fallback={<span class="muted acc-usage">사용 기록 없음</span>}>
            <span class="acc-usage" title="앞부분을 다시 써서 아낀 비율이에요">
              <span class="cache-bar"><i style={{ width: `${Math.round((cacheShare(a()) ?? 0) * 100)}%` }} /></span>
              캐시 {Math.round((cacheShare(a()) ?? 0) * 100)}%
              <span class="muted">· {tokens(used())} 토큰</span>
            </span>
          </Show>
        </div>
      </div>
      <div class="set-value">
        <button class="btn sm" onClick={props.onLogin}><Icon name="key" size={13} />{a().providers.length ? "다른 서비스 추가" : "로그인"}</button>
        <Show when={props.id !== "default"}>
          <Show when={confirm()} fallback={<button class="icon-btn" title="삭제" onClick={() => setConfirm(true)}><Icon name="trash" size={14} /></button>}>
            <button
              class="btn sm danger"
              onClick={() => {
                accountRemove(props.id);
                setState("accounts", (l) => l.filter((x) => x.id !== props.id));
              }}
            >
              로그인 정보까지 삭제
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
      { id, space, label: `${state.spaces.find((s) => s.id === space)?.label ?? "계정"} ${n}`, providers: [], model: "", badModels: [], stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
    setLogin(id);
  };
  return (
    <>
      <h2>계정</h2>
      <For each={state.spaces}>
        {(s) => (
          <>
            <div class="set-group-title" style={{ display: "flex", "align-items": "center" }}>
              {s.label}
              <span class="spacer" />
              <button class="btn ghost sm" onClick={() => add(s.id)}><Icon name="plus" size={13} />계정 추가</button>
            </div>
            <div class="set-group">
              <For each={state.accounts.filter((a) => a.space === s.id)} fallback={<div class="empty-line">없음</div>}>
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
function Import() {
  const [pick, setPick] = createSignal({ rules: true, skills: true, memories: true });
  const [query, setQuery] = createSignal("");
  const [importing, setImporting] = createSignal<string | null>(null);
  onMount(() => !sources().length && scan());
  const found = () => sources().filter((s) => s.found);
  const sessions = createMemo(() => {
    const q = query().trim().toLowerCase();
    const imported = new Set(state.tasks.map((t) => t.origin?.path));
    return allSessions()
      .filter((s) => !q || `${s.title} ${s.cwd} ${s.sourceName}`.toLowerCase().includes(q))
      .map((s) => ({ ...s, done: imported.has(s.path) }))
      .slice(0, 80);
  });
  const run = () => {
    const r = importFrom(found(), pick());
    toast(`가져옴 · 지시 ${r.rules} · 스킬 ${r.skills} · 기억 ${r.memories}`);
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
      <h2>가져오기</h2>
      <div class="set-group-title" style={{ display: "flex", "align-items": "center" }}>
        발견한 도구
        <span class="spacer" />
        <button class="btn ghost sm" onClick={scan} disabled={scanning()}><Icon name="refresh" size={13} />{scanning() ? "검색 중" : "다시 검색"}</button>
      </div>
      <div class="src-grid">
        <For each={sources()} fallback={<div class="muted">{scanning() ? "검색 중…" : "발견한 도구 없음"}</div>}>
          {(s) => (
            <div class="src" classList={{ off: !s.found }}>
              <div class="src-head">
                {s.name}
                <span class="spacer" />
                <Show when={s.found} fallback={<span class="pill">없음</span>}>
                  <Show when={s.loggedIn}><span class="pill ok">로그인됨</span></Show>
                </Show>
              </div>
              <div class="src-counts">
                지시 {s.rules.length} · 스킬 {s.skills.length} · 기억 {s.memories.length} · 세션 {s.sessions.length}
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={found().length}>
      <div class="set-group">
        <div class="set-row">
          <label class="check"><input type="checkbox" checked={pick().rules} onChange={(e) => setPick({ ...pick(), rules: e.currentTarget.checked })} />지시 (CLAUDE.md, AGENTS.md)</label>
          <label class="check"><input type="checkbox" checked={pick().skills} onChange={(e) => setPick({ ...pick(), skills: e.currentTarget.checked })} />스킬</label>
          <label class="check"><input type="checkbox" checked={pick().memories} onChange={(e) => setPick({ ...pick(), memories: e.currentTarget.checked })} />기억</label>
          <span class="spacer" />
          <button class="btn primary sm" disabled={!found().length} onClick={run}>가져오기</button>
        </div>
      </div>
      </Show>

      <div class="set-group-title">세션 이어받기</div>
      <input class="input" placeholder="세션 검색 (제목, 폴더, 도구)" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} style={{ "margin-bottom": "var(--s-8)" }} />
      <div class="set-group">
        <For each={sessions()} fallback={<div class="empty-line">세션 없음</div>}>
          {(s) => (
            <div class="item-row">
              <div class="item-main">
                <b>{s.title || "(제목 없음)"}</b>
                <p>{s.sourceName} · {tilde(s.cwd) || "폴더 모름"} · {ago(s.updatedAt)} · 메시지 {s.messages}</p>
              </div>
              <Show when={!s.done} fallback={<span class="pill">가져옴</span>}>
                <button class="btn sm" disabled={importing() === s.path} onClick={() => pickUp(s)}>{importing() === s.path ? "읽는 중" : "이어받기"}</button>
              </Show>
            </div>
          )}
        </For>
      </div>
    </>
  );
}

// ───────────────── tools & permissions
function Tools() {
  const [status, { refetch }] = createResource(toolStatus);
  const timer = setInterval(() => !document.hidden && refetch(), 3000);
  onCleanup(() => clearInterval(timer));
  const ok = (b?: boolean) => <span class={`pill ${b ? "ok" : "warn"}`}>{b ? "준비됨" : "필요"}</span>;
  return (
    <>
      <h2>권한</h2>
      <div class="set-group">
        <Row title="에이전트 엔진" desc={`3xhaustPi ${engine.info.engineVersion ?? ""}`}>{ok(engine.ready)}</Row>
        <Row title="브라우저" desc={`agent-browser ${status()?.browserVersion ?? ""} · 내장 Chrome`}>{ok(!!status()?.browserVersion && status()?.chromeReady)}</Row>
        <Row title="앱 조작" desc={`agent-desktop ${status()?.desktopVersion ?? ""}`}>{ok(!!status()?.desktopVersion)}</Row>
      </div>
      <div class="set-group-title">macOS 권한</div>
      <div class="set-group">
        <Row title="손쉬운 사용" desc="다른 앱의 버튼을 찾아 누를 때 필요해요">
          {ok(status()?.accessibility)}
          <Show when={!status()?.accessibility}>
            <button class="btn sm" onClick={async () => { await requestAccessibility(); openPrivacySettings("accessibility"); }}>허용</button>
          </Show>
        </Row>
        <Row title="화면 기록" desc="앱 화면을 찍어 결과로 보여줄 때 필요해요">
          {ok(status()?.screenRecording)}
          <Show when={!status()?.screenRecording}>
            <button class="btn sm" onClick={() => openPrivacySettings("screen")}>허용</button>
          </Show>
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
      <h2>단축키</h2>
      <div class="set-group">
        <Row title="버튼마다 단축키 보기"><kbd>⌘ 길게</kbd></Row>
        <Row title="어디서든 요청 보내기"><kbd>⌥ Space</kbd></Row>
        <Row title="종료"><kbd>⌘Q 길게</kbd></Row>
      </div>
      <For each={groups()}>
        {([section, list]) => (
          <>
            <div class="set-group-title">{section}</div>
            <div class="set-group">
              <For each={list}>{(c) => <Row title={c.label}><kbd>{shortcutLabel(c.shortcut!)}</kbd></Row>}</For>
            </div>
          </>
        )}
      </For>
      <div class="set-group-title">터미널</div>
      <div class="set-group">
        <Row title="터미널에서 보내기"><code class="muted">throw.sh "요청"</code></Row>
      </div>
    </>
  );
}

export const SETTINGS_TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "general", label: "일반", icon: "gear" },
  { id: "shortcuts", label: "단축키", icon: "list" },
  { id: "accounts", label: "계정", icon: "key" },
  { id: "import", label: "가져오기", icon: "download" },
  { id: "agent-tools", label: "도구", icon: "tools" },
  { id: "skills", label: "스킬", icon: "skill" },
  { id: "hooks", label: "훅", icon: "bolt" },
  { id: "tools", label: "권한", icon: "shield" },
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
        <button class="sb-row sb-main settings-back" onClick={props.onBack} title="앱으로 돌아가기 (esc)">
          <Icon name="back" size={15} />
          <span class="sb-title">앱으로 돌아가기</span>
        </button>
        <div class="settings-side-list">
          <For each={SETTINGS_TABS}>
            {(t) => (
              <button class="sb-row sb-main" classList={{ on: settingsTab() === t.id }} onClick={() => setView({ name: "settings", tab: t.id })}>
                <Icon name={t.icon} size={15} />
                <span class="sb-title">{t.label}</span>
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
  return (
    <div class="settings settings-page">
      <div class="head" data-tauri-drag-region />
      <div class="settings-body">
        <div class="settings-inner">
          <Switch>
            <Match when={settingsTab() === "general"}><General /></Match>
            <Match when={settingsTab() === "shortcuts"}><Shortcuts /></Match>
            <Match when={settingsTab() === "accounts"}><Accounts /></Match>
            <Match when={settingsTab() === "import"}><Import /></Match>
            <Match when={settingsTab() === "agent-tools"}><ToolsTab /></Match>
            <Match when={settingsTab() === "skills"}><SkillsTab /></Match>
            <Match when={settingsTab() === "hooks"}><HooksTab /></Match>
            <Match when={settingsTab() === "tools"}><Tools /></Match>
          </Switch>
        </div>
      </div>
    </div>
  );
}

export { LoginSheet };
