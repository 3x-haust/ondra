// Settings › 도구: everything an agent can use, read from a short-lived engine
// started with what every job gets (built-in tools, Ondra's extensions, skills, MCP).
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { setState, state } from "../state/store";
import { tokens } from "../ui/bits";
import { PageHead } from "./Settings";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";
import { loadWorkerTools, type EngineContext } from "./contextData";
import { canSwitchOff, enabledToolTokens, enabledTools, firstSentence, isKorean, isOff, skillSource, skillTokens, toolLine, toolMore, toolSource } from "../engine/agentTools";

// the lines and counts live in engine/agentTools (the context sheet reads them too)
export { firstSentence, isKorean, skillSource, skillTokens, toolLine, toolMore, toolSource } from "../engine/agentTools";

const hasHangul = (s: string) => /[가-힣]/.test(s);

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
  /** an MCP tool every job gets: a switch in Settings leaves it out ("-name" in extraTools) */
  mcp?: boolean;
  /** a tool (a switch when optional or MCP, else a lock); skills have neither */
  tool?: boolean;
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
    add(s.group, { key: `t:${x.name}`, name: x.name, line: toolLine(x), ko: isKorean(x), source: s.label, size: x.schemaTokens, off: optional, found, optional, mcp: !optional && canSwitchOff(x.name), tool: true, full: toolMore(x) });
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
  const isOn = (r: Row) => (r.optional ? extra().includes(r.name) : r.mcp ? !isOff(r.name, extra()) : true);
  // an optional tool is listed by name when on; an MCP tool by "-name" when off
  const turn = (r: Row, on: boolean) => {
    const entry = r.mcp ? `-${r.name}` : r.name;
    const add = r.mcp ? !on : on;
    setState("settings", "extraTools", (l) => (add ? [...new Set([...(l ?? []), entry])] : (l ?? []).filter((n) => n !== entry)));
  };
  // every tool group counts the same way, on/all (the tools sent with every request of all it lists); skills, one number
  const counted = (g: Group) => ({ tools: g.rows.some((r) => r.tool), on: g.rows.filter((r) => r.tool && isOn(r) && !r.found).length });
  const toggle = (key: string) => {
    // selecting text in an open row doesn't fold it
    if (window.getSelection()?.toString()) return;
    setOpen(open() === key ? null : key);
  };
  const srcOf = (r: Row, g: Group) => {
    const s = r.source.replace(/^Ondra 확장 · |^확장 · /, "");
    return r.source && !g.title.startsWith(r.source) && r.source !== "MCP 서버" && s !== r.name ? t(s) : "";
  };
  return (
    <>
      <PageHead tab="agent-tools">
        <Show when={data()}>
          {(c) => <span class="tl-total" title={t("켜진 도구가 요청마다 쓰는 토큰")}>{t("켜진 도구 {n}개 · {tok} 토큰", { n: enabledTools(c()).length, tok: tokens(enabledToolTokens(c())) })}</span>}
        </Show>
        <button class="btn sm" disabled={data.loading} onClick={() => setForce((n) => n + 1)}>
          <Icon name="refresh" size={14} />{t("새로고침")}
        </button>
      </PageHead>
      <label class="tl-search">
        <Icon name="search" size={14} />
        <input placeholder={t("검색")} aria-label={t("도구 검색")} value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      </label>
      <Show when={!data.error} fallback={<div class="set-group"><div class="empty-line">{t("불러오지 못했어요")} · {String(data.error?.message ?? data.error)}</div></div>}>
        <Show when={data()} fallback={<div class="set-group"><div class="empty-line tl-wait">{t("불러오는 중…")}</div></div>}>
          <For each={groups()} fallback={<div class="set-group"><div class="empty-line">{t("결과 없음")}</div></div>}>
            {(g, i) => (
              <>
                <div class="set-group-title tl-gtitle">
                  {t(g.title)}
                  <span class="tl-count" title={counted(g).tools ? t("켜짐 {on} · 전체 {n}", { on: counted(g).on, n: g.rows.length }) : undefined}>
                    {counted(g).tools ? `${counted(g).on}/${g.rows.length}` : g.rows.length}
                  </span>
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
                        <div class="tl-head" onClick={() => toggle(r.key)}>
                          <button class="tl-open" aria-expanded={open() === r.key} onClick={(e) => (e.stopPropagation(), setOpen(open() === r.key ? null : r.key))}>
                            <span class="tl-name">{r.name}</span>
                          </button>
                          {/* the one line, or the whole description when open: never both */}
                          <div class="tl-desc">
                            <div class="tl-fold tl-short"><span class="tl-line" classList={{ en: !r.ko }}>{r.line}</span></div>
                            <div class="tl-fold tl-more"><p class="selectable">{r.full}</p></div>
                          </div>
                          <span class="tl-src">{srcOf(r, g)}</span>
                          <span class="tl-size" title={r.found ? t("필요할 때 찾아 써요") : t("{k} 토큰", { n: r.size, k: tokens(r.size) })}>{r.found ? t("필요 시") : tokens(r.size)}</span>
                          <span class="tl-sw">
                            <Show when={r.tool && (r.optional || r.mcp)}>
                              <button
                                class="switch"
                                classList={{ on: isOn(r) }}
                                role="switch"
                                aria-checked={isOn(r)}
                                aria-label={r.name}
                                onClick={(e) => (e.stopPropagation(), turn(r, !isOn(r)))}
                              >
                                <i />
                              </button>
                            </Show>
                            <Show when={r.tool && !r.optional && !r.mcp}>
                              <span class="tl-lock" title={t("항상 켜짐")} aria-label={t("항상 켜짐")} role="img">
                                <Icon name="lock" size={14} />
                              </span>
                            </Show>
                          </span>
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
