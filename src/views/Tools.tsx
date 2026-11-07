// Settings › 도구: everything an agent can use, read from a short-lived engine
// started with what every job gets (built-in tools, Ondra's extensions, skills, MCP).
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { engine, tilde } from "../engine/rpc";
import { state } from "../state/store";
import { tokens } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { estimate, loadWorkerTools, type CtxTool, type EngineContext } from "./contextData";
import { ComputerSetupPanel } from "./ComputerSetup";

/** One line in plain Korean for the engine's own tools. */
const KO: Record<string, string> = {
  read: "파일을 읽어요. 이미지도 볼 수 있어요",
  bash: "터미널 명령을 실행해요",
  edit: "파일의 일부를 찾아서 바꿔요",
  write: "파일을 새로 쓰거나 덮어써요",
  grep: "파일 내용에서 글자를 찾아요",
  find: "이름으로 파일을 찾아요",
  ls: "폴더 안 목록을 봐요",
  powershell: "PowerShell 명령을 실행해요",
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
export const toolLine = (t: { name: string; description: string }) => KO[t.name] ?? firstSentence(t.description || "");
export const isKorean = (t: { name: string; description: string }) => !!KO[t.name] || hasHangul(t.description || "");

const base = (p: string) => p.split("/").pop()?.replace(/\.(ts|js|mjs)$/, "") ?? p;

/** Where a tool comes from. */
export function toolSource(t: CtxTool): { group: string; label: string } {
  if (t.namespace?.startsWith("mcp__")) return { group: `MCP · ${t.namespace.slice(5)}`, label: "MCP 서버" };
  if (t.sourceInfo.path.startsWith("builtin:")) return { group: "엔진 기본 도구", label: "엔진 기본" };
  const p = t.sourceInfo.path;
  if (/\/(app-extensions|extensions)\/[^/]+$/.test(p) && (p.includes("/app-extensions/") || p.includes("/ondra/"))) return { group: "Ondra 확장", label: `Ondra 확장 · ${base(p)}` };
  return { group: "다른 확장", label: `확장 · ${base(p)}` };
}

/** Where a skill comes from. */
export function skillSource(path: string): string {
  if (path.includes("/app-skills/") || /\/ondra\/skills\//.test(path)) return "Ondra 기본";
  const d = engine.info.dataDir;
  if (d && path.startsWith(`${d}/skill-overrides/`)) return "Ondra 기본 · 고침";
  if (d && path.startsWith(`${d}/skills/`)) return "내 스킬";
  if (state.skills.some((s) => path === s.path || path.startsWith(`${s.path.replace(/\/$/, "")}/`))) return "가져온 스킬";
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
  const order = ["엔진 기본 도구", "Ondra 확장", "다른 확장"];
  for (const t of [...c.tools].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))) {
    const s = toolSource(t);
    // deferred tools sit behind tool_search: declared only once a job looks for them
    const found = !t.active && (t.exposure === "deferred" || t.exposure === "codemode");
    add(s.group, { key: `t:${t.name}`, name: t.name, line: toolLine(t), ko: isKorean(t), source: s.label, size: t.schemaTokens, off: !t.active && !found, found, full: t.description });
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
  const declared = () => {
    const c = data();
    if (!c) return 0;
    return c.tools.filter((t) => t.active).reduce((n, t) => n + t.schemaTokens, 0);
  };
  return (
    <>
      <h2>도구</h2>
      <ComputerSetupPanel />
      <div class="tl-bar">
        <label class="tl-search">
          <Icon name="search" size={14} />
          <input placeholder="이름이나 설명으로 찾기" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
        </label>
        <Show when={data()}>
          <span class="tl-total">도구 {data()!.tools.filter((t) => t.active).length}개 · {tokens(declared())} 토큰</span>
        </Show>
        <button class="btn sm ghost" disabled={data.loading} onClick={() => setForce((n) => n + 1)} title="엔진에 다시 물어봐요">
          <Icon name="refresh" size={13} />새로고침
        </button>
      </div>
      <Show when={!data.error} fallback={<div class="set-group"><div class="empty-line">목록을 못 불러왔어요 · {String(data.error?.message ?? data.error)}</div></div>}>
        <Show when={data()} fallback={<div class="set-group"><div class="empty-line tl-wait">엔진에 물어보는 중이에요</div></div>}>
          <For each={groups()} fallback={<div class="set-group"><div class="empty-line">찾는 게 없어요</div></div>}>
            {(g) => (
              <>
                <div class="set-group-title tl-gtitle">
                  {g.title}
                  <span class="tl-count">{g.rows.length}</span>
                  <Show when={g.hint}><span class="tl-ghint">{g.hint}</span></Show>
                </div>
                <div class="set-group tl-group">
                  <For each={g.rows}>
                    {(r) => (
                      <div class="tl-row" classList={{ off: r.off, open: open() === r.key }}>
                        <button class="tl-head" onClick={() => setOpen(open() === r.key ? null : r.key)} aria-expanded={open() === r.key}>
                          <span class="tl-name">{r.name}</span>
                          <span class="tl-line" classList={{ en: !r.ko }} title={r.full}>{r.line}</span>
                          <span class="tl-src">{r.source}</span>
                          <span class="tl-size">{r.off ? "꺼짐" : r.found ? "검색" : `${tokens(r.size)}`}</span>
                        </button>
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
