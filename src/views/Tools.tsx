// Settings › 도구: everything an agent can use, read from a short-lived engine
// started with what every job gets (built-in tools, Ondra's extensions, skills, MCP).
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { engine, tilde } from "../engine/rpc";
import { setState, state } from "../state/store";
import { tokens } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";
import { estimate, loadWorkerTools, type CtxTool, type EngineContext } from "./contextData";

/** One line in plain Korean for the engine's own tools (the key for t()). */
const KO: Record<string, string> = {
  read: "파일을 읽어요. 이미지도 볼 수 있어요",
  bash: "터미널 명령을 실행해요",
  edit: "파일의 일부를 찾아서 바꿔요",
  write: "파일을 새로 쓰거나 덮어써요",
  grep: "파일 내용에서 글자를 찾아요",
  find: "이름으로 파일을 찾아요",
  ls: "폴더 안 목록을 봐요",
  powershell: "PowerShell 명령을 실행해요",
  memory: "메모리를 저장하거나 바꿔요",
  memory_search: "메모리에서 찾아요",
  memory_save: "메모리를 저장하거나 바꿔요",
  memory_forget: "메모리를 지워요",
  skill_search: "필요한 스킬을 찾아요",
  web_search: "웹에서 검색해요",
  web_fetch: "웹 페이지를 읽어요",
  device: "시뮬레이터와 에뮬레이터를 켜고, 화면을 찍고, 눌러요",
};

/** What an open row says about the engine's own tools: a little more than the one line (keys for t()). */
const KO_MORE: Record<string, string> = {
  read: "텍스트 파일과 이미지(jpg, png, gif, webp, bmp)를 읽어요. 긴 파일은 나눠서 읽어요",
  bash: "작업 폴더에서 셸 명령을 실행하고 출력을 받아요. 기본 시간 제한은 없어요",
  edit: "파일에서 정확히 같은 부분을 찾아 바꿔요. 한 번에 여러 곳을 바꿀 수 있어요",
  write: "파일을 새로 만들거나 덮어써요. 없는 폴더는 함께 만들어요",
  grep: "파일 내용에서 정규식이나 글자를 찾아요. 파일 종류로 좁힐 수 있어요",
  find: "글롭 패턴으로 파일을 찾아요 (예: **/*.ts)",
  ls: "폴더 안 목록을 이름순으로 보여 줘요. 숨김 파일도 보여요",
  powershell: "작업 폴더에서 PowerShell 명령을 실행하고 출력을 받아요",
  memory: "작업하며 알게 된 것을 메모리에 저장하거나 바꿔요. 다음 작업이 참고해요",
  memory_search: "저장된 메모리에서 지금 작업에 맞는 것을 찾아요",
  memory_save: "작업하며 알게 된 것을 메모리에 저장하거나 바꿔요. 다음 작업이 참고해요",
  memory_forget: "더는 맞지 않는 메모리를 지워요",
  skill_search: "작업에 맞는 스킬을 찾아 그 안내를 읽어요",
  web_search: "웹에서 검색하고 결과 목록을 받아요",
  web_fetch: "웹 페이지를 받아 읽을 수 있는 글로 바꿔요",
  device: "iOS 시뮬레이터와 Android 에뮬레이터를 켜고, 화면을 찍고, 누르고, 글자를 입력해요",
};

const hasHangul = (s: string) => /[가-힣]/.test(s);
/** First sentence of a description, short. */
export function firstSentence(s: string, max = 110): string {
  const line = s.replace(/\s+/g, " ").trim();
  const m = line.match(/^(.+?[.!?。])(\s|$)/);
  const one = m ? m[1] : line;
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
/** A tool's one-liner: our Korean line, its own if it is Korean, else its English first sentence. */
export const toolLine = (x: { name: string; description: string }) => (KO[x.name] ? t(KO[x.name]) : firstSentence(x.description || ""));
/** An open row's text in the app's language: our longer line for the engine's own tools, else the tool's own words. */
export const toolMore = (x: { name: string; description: string }) => (KO_MORE[x.name] ? t(KO_MORE[x.name]) : KO[x.name] ? t(KO[x.name]) : x.description);
/** our own line (in the app's language) or a Korean description: shown at full strength */
export const isKorean = (x: { name: string; description: string }) => !!KO[x.name] || hasHangul(x.description || "");

const base = (p: string) => p.split("/").pop()?.replace(/\.(ts|js|mjs)$/, "") ?? p;

/** Where a tool comes from (Korean keys: show them through t()). */
export function toolSource(x: CtxTool): { group: string; label: string } {
  if (x.namespace?.startsWith("mcp__")) return { group: `MCP · ${x.namespace.slice(5)}`, label: "MCP 서버" };
  if (x.sourceInfo.path.startsWith("builtin:")) return { group: "기본 도구", label: "기본" };
  const p = x.sourceInfo.path;
  if (/\/(app-extensions|extensions)\/[^/]+$/.test(p) && (p.includes("/app-extensions/") || p.includes("/ondra/"))) return { group: "Ondra 확장", label: `Ondra 확장 · ${base(p)}` };
  return { group: "다른 확장", label: `확장 · ${base(p)}` };
}

/** Where a skill comes from. */
export function skillSource(path: string): string {
  if (path.includes("/app-skills/") || /\/ondra\/skills\//.test(path)) return t("기본");
  const d = engine.info.dataDir;
  if (d && path.startsWith(`${d}/skill-overrides/`)) return t("기본 · 수정됨");
  if (d && path.startsWith(`${d}/skills/`)) return t("내 스킬");
  if (state.skills.some((s) => path === s.path || path.startsWith(`${s.path.replace(/\/$/, "")}/`))) return t("가져온 스킬");
  const dir = path.replace(/\/[^/]+\/SKILL\.md$/, "");
  return tilde(dir);
}

/** Tokens a skill adds to the system prompt (its name, description and location). */
export const skillTokens = (s: { name: string; description: string; path: string }) => estimate(`<skill><name>${s.name}</name><description>${s.description}</description><location>${s.path}</location></skill>`);

interface Row {
  key: string;
  name: string;
  line: string;
  ko: boolean;
  source: string;
  size: number;
  off?: boolean;
  found?: boolean;
  /** a tool jobs don't get by default: a switch in Settings adds it (state.settings.extraTools) */
  optional?: boolean;
  full: string;
}
interface Group {
  title: string;
  hint?: string;
  rows: Row[];
}

function groupsOf(c: EngineContext): Group[] {
  const groups = new Map<string, Group>();
  const add = (g: string, row: Row, hint?: string) => {
    if (!groups.has(g)) groups.set(g, { title: g, hint, rows: [] });
    groups.get(g)!.rows.push(row);
  };
  const order = ["기본 도구", "Ondra 확장", "다른 확장"];
  for (const x of [...c.tools].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))) {
    const s = toolSource(x);
    // deferred tools sit behind tool_search: declared only once a job looks for them
    const found = !x.active && (x.exposure === "deferred" || x.exposure === "codemode");
    const optional = !x.active && !found;
    add(s.group, { key: `t:${x.name}`, name: x.name, line: toolLine(x), ko: isKorean(x), source: s.label, size: x.schemaTokens, off: optional, found, optional, full: toolMore(x) });
  }
  for (const s of c.skills)
    add("스킬", { key: `s:${s.path}`, name: s.name, line: firstSentence(s.description), ko: hasHangul(s.description), source: skillSource(s.path), size: skillTokens(s), off: !s.modelInvocable, full: s.description });
  return [...groups.values()].sort((a, b) => {
    const ia = order.indexOf(a.title), ib = order.indexOf(b.title);
    const ra = a.title === "스킬" ? 9 : a.title.startsWith("MCP") ? 5 : ia < 0 ? 6 : ia;
    const rb = b.title === "스킬" ? 9 : b.title.startsWith("MCP") ? 5 : ib < 0 ? 6 : ib;
    return ra - rb;
  });
}

export function ToolsTab() {
  const [force, setForce] = createSignal(0);
  const [data] = createResource(() => ({ n: force() }), ({ n }) => loadWorkerTools(n > 0));
  const [q, setQ] = createSignal("");
  const [open, setOpen] = createSignal<string | null>(null);
  const groups = createMemo(() => {
    const c = data();
    if (!c) return [];
    const k = q().trim().toLowerCase();
    return groupsOf(c)
      .map((g) => ({ ...g, rows: g.rows.filter((r) => !k || `${r.name} ${r.line} ${r.full} ${r.source}`.toLowerCase().includes(k)) }))
      .filter((g) => g.rows.length);
  });
  // the tools turned on here, on top of what every job gets
  const extra = () => state.settings.extraTools ?? [];
  const isOn = (r: Row) => !r.optional || extra().includes(r.name);
  const turn = (name: string, on: boolean) =>
    setState("settings", "extraTools", (l) => (on ? [...new Set([...(l ?? []), name])] : (l ?? []).filter((n) => n !== name)));
  const declared = () => {
    const c = data();
    if (!c) return 0;
    return c.tools.filter((x) => x.active || extra().includes(x.name)).reduce((n, x) => n + x.schemaTokens, 0);
  };
  return (
    <>
      <div class="set-head">
        <h2>{t("도구")}</h2>
        <Show when={data()}>
          {/* every tool listed below; the tokens are what the tools in use add to each request */}
          <span class="tl-total" title={t("켜진 도구가 요청마다 쓰는 토큰")}>{t("도구 {n}개 · {tok} 토큰", { n: data()!.tools.length, tok: tokens(declared()) })}</span>
        </Show>
        <button class="btn sm" disabled={data.loading} onClick={() => setForce((n) => n + 1)}>
          <Icon name="refresh" size={14} />{t("새로고침")}
        </button>
      </div>
      <label class="tl-search">
        <Icon name="search" size={14} />
        <input placeholder={t("검색")} aria-label={t("도구 검색")} value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      </label>
      <Show when={!data.error} fallback={<div class="set-group"><div class="empty-line">{t("불러오지 못했어요")} · {String(data.error?.message ?? data.error)}</div></div>}>
        <Show when={data()} fallback={<div class="set-group"><div class="empty-line tl-wait">{t("불러오는 중")}</div></div>}>
          <For each={groups()} fallback={<div class="set-group"><div class="empty-line">{t("결과 없음")}</div></div>}>
            {(g, i) => (
              <>
                <div class="set-group-title tl-gtitle">
                  {t(g.title)}
                  <span class="tl-count">{g.rows.length}</span>
                  <Show when={g.hint}><span class="tl-ghint">{g.hint}</span></Show>
                  <Show when={i() === 0}>
                    <span class="spacer" />
                    <span class="tl-unit">{t("토큰")}</span>
                  </Show>
                </div>
                <div class="set-group tl-group">
                  <For each={g.rows}>
                    {(r) => (
                      <div class="tl-row" classList={{ off: !isOn(r), open: open() === r.key }}>
                        <div class="tl-head" onClick={() => setOpen(open() === r.key ? null : r.key)}>
                          <button class="tl-open" aria-expanded={open() === r.key}>
                            <span class="tl-name">{r.name}</span>
                            <span class="tl-line" classList={{ en: !r.ko }} title={r.full}>{r.line}</span>
                            <Show when={r.source && !g.title.startsWith(r.source) && r.source !== "MCP 서버" && r.source.replace(/^Ondra 확장 · |^확장 · /, "") !== r.name}><span class="tl-src">{t(r.source.replace(/^Ondra 확장 · |^확장 · /, ""))}</span></Show>
                          </button>
                          <Show
                            when={r.optional}
                            fallback={<span class="tl-size" title={r.found ? t("필요할 때 찾아 써요") : t("{k} 토큰", { n: r.size, k: tokens(r.size) })}>{r.found ? t("필요 시") : tokens(r.size)}</span>}
                          >
                            {/* off unless turned on here: then every job gets it */}
                            <span class="tl-size">
                              <button
                                class="switch"
                                classList={{ on: isOn(r) }}
                                role="switch"
                                aria-checked={isOn(r)}
                                aria-label={r.name}
                                title={isOn(r) ? t("{k} 토큰", { n: r.size, k: tokens(r.size) }) : t("꺼짐")}
                                onClick={(e) => (e.stopPropagation(), turn(r.name, !isOn(r)))}
                              >
                                <i />
                              </button>
                            </span>
                          </Show>
                        </div>
                        <div class="tl-more" classList={{ open: open() === r.key }}>
                          <div class="tl-more-in">
                            <p class="selectable">{r.full}</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </>
            )}
          </For>
        </Show>
      </Show>
    </>
  );
}
