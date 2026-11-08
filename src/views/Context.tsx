// What the model actually receives for a job or a chat: a bar of how the
// context window fills up, then each part to open and read.
import { enabledToolTokens, enabledTools, skillLine } from "../engine/agentTools";
import { createMemo, createResource, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { ignoredKey, noModifiers } from "../lib/shortcuts";
import { tilde } from "../engine/rpc";
import { kindLabel, kindOf } from "../engine/memory";
import { setMemoryFocus, setView } from "../state/ui";
import type { Block, Memory } from "../state/types";
import { ctxShare, tokens } from "../ui/bits";
import { ctx as ctxNow } from "../state/ctx";
import { inTauri } from "../lib/native";
import { inChat } from "../engine/captain";
import { state, taskById } from "../state/store";
import { fsRead, skillList } from "../lib/native";
import { Fold } from "../ui/Fold";
import { Icon } from "../ui/Icon";
import { type CtxMessage, estimate, type Loaded, loadChat, loadJob } from "./contextData";
import { isKorean, skillSource, skillTokens, toolLine, toolSource } from "./Tools";
import { parseSkill } from "./SkillsTab";
import { t } from "../i18n";

type Seg = "engine" | "ondra" | "files" | "skills" | "tools" | "talk";
const SEG_LABEL: Record<Seg, string> = {
  engine: "기본 지침",
  ondra: "내 지침",
  files: "지시 파일",
  skills: "스킬",
  tools: "도구",
  talk: "대화",
};
/** system prompt sections the engine writes itself */
const ENGINE_SECTION: Record<string, string> = {
  preamble: "역할",
  tools: "도구 목록",
  rules: "기본 규칙",
  docs: "문서 안내",
  cwd: "작업 폴더",
};

/** where a tool comes from, in the app's language; not its own name again ("Ondra 확장 · device" for device → "Ondra 확장") */
const sourceText = (label: string, name: string) => {
  const [head, ...rest] = label.split(" · ");
  return [t(`${head}|one`), ...rest.filter((r) => r !== name)].join(" · ");
};
const pct = (n: number, of: number) => (of ? Math.min(100, (n / of) * 100) : 0);
/** whole percents, as everywhere else: 10%, <1% */
const share = (n: number, of: number) => {
  const p = of ? (n / of) * 100 : 0;
  return p <= 0 ? "0%" : p < 1 ? "<1%" : `${Math.round(p)}%`;
};

/** Split `total` in proportion to `parts`, in whole numbers that add up to it exactly. */
export function apportion(parts: number[], total: number): number[] {
  const sum = parts.reduce((a, b) => a + b, 0);
  if (!sum || total <= 0) return parts.map(() => 0);
  const exact = parts.map((v) => (v * total) / sum);
  const out = exact.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  for (const i of exact.map((_, i) => i).sort((a, b) => exact[b] - out[b] - (exact[a] - out[a]))) {
    if (rest <= 0) break;
    out[i]++;
    rest--;
  }
  return out;
}

/** A message's opening as plain words: no markdown marks, one line. The preview may already be
 *  flattened to one line, so a quote, heading or list mark is dropped mid-line too. */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\w-]*\n?/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:>\s?)+/gm, "")
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/^\s*([-*_=]\s*){3,}$/gm, " ")
    .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, " ")
    .replace(/^\s*\|(.+)\|\s*$/gm, (_m, x: string) => x.split("|").map((c) => c.trim()).filter(Boolean).join(" · "))
    // marks left inside a line that was flattened: " > ", " ## ", " - "
    .replace(/(^|\s)(?:>\s?)+(?=\S)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\s)[-*+]\s+\[[ xX]\]\s+/g, "$1")
    .replace(/(^|[.!?:。]\s+)[-*+]\s+(?=\S)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s\|\s/g, " · ")
    .replace(/\*\*|`|^\||\|$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}


/**
 * The skills agents can load, as Settings › 스킬 lists them: the bundled ones and the user's.
 */
async function settingsSkills(): Promise<{ name: string; description: string; path: string; own: boolean }[]> {
  const files = await skillList().catch(() => []);
  const bundled = await Promise.all(
    files.map(async (f) => ({ name: f.name, path: f.path, own: false, description: parseSkill((await fsRead(f.path).catch(() => ({ text: "" }))).text ?? "").description ?? "" })),
  );
  return [...bundled, ...state.skills.filter((s) => s.enabled).map((s) => ({ name: s.name, path: s.path, description: s.description, own: true }))];
}

/** A part that opens to show what is inside; an empty one is a plain row. */
function Part(props: { title: JSX.Element; size?: number; of?: number; meta?: string; note?: string; seg?: Seg; children?: JSX.Element; open?: boolean; nested?: boolean; empty?: boolean }) {
  const [open, setOpen] = createSignal(!!props.open);
  return (
    <div class="cx-part" classList={{ open: open() && !props.empty, nested: props.nested, empty: props.empty }}>
      <button class="cx-part-head" disabled={props.empty} onClick={() => setOpen(!open())} aria-expanded={props.empty ? undefined : open()}>
        <Show when={!props.empty} fallback={<span class="cx-chev-room" />}>
          <Icon name="chevron" size={13} class="chev cx-chev" />
        </Show>
        <Show when={props.seg}><i class={`cx-key k-${props.seg}`} /></Show>
        <span class="cx-part-title">{props.title}</span>
        <Show when={props.meta}><span class="cx-part-meta">{props.meta}</span></Show>
        <span class="spacer" />
        {/* nothing of it sits in the prompt yet: what happens instead, in place of "0 · 0%" */}
        <Show when={props.note} fallback={
          <Show when={props.size !== undefined}>
            <span class="cx-part-size">{tokens(props.size!)}</span>
            <Show when={props.of}><span class="cx-part-share">{share(props.size!, props.of!)}</span></Show>
          </Show>
        }>
          <span class="cx-part-note">{props.note}</span>
        </Show>
      </button>
      <Show when={!props.empty}>
        <Fold open={open()}>
          <div class="cx-part-body">{props.children}</div>
        </Fold>
      </Show>
    </div>
  );
}

const Pre = (props: { text: string }) => <pre class="cx-pre selectable">{props.text}</pre>;

function MemoryList(props: { list: Memory[]; empty: string; onOpen: (m: Memory) => void }) {
  return (
    <Show when={props.list.length} fallback={<p class="cx-empty">{props.empty}</p>}>
      <div class="cx-mems">
        <For each={props.list}>
          {(m) => (
            <button class="cx-mem" onClick={() => props.onOpen(m)} title={t("메모리에서 열기")}>
              <span class="cx-mem-kind">{t(kindLabel(kindOf(m)))}</span>
              <span class="cx-mem-text">{m.text}</span>
              <Icon name="arrow" size={12} class="cx-mem-go" />
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

const ROLE: Record<string, string> = {
  user: "요청",
  assistant: "답변",
  toolResult: "도구 결과",
  bashExecution: "직접 실행한 명령",
  compactionSummary: "정리한 요약",
  branchSummary: "갈래 요약",
  custom: "알림",
  system: "시스템 변경",
};
/** a tool's output in plain words, by what the tool does */
const RESULT: Record<string, string> = {
  bash: "실행 결과",
  read: "읽은 파일",
  edit: "수정 결과",
  write: "쓴 파일",
  grep: "검색 결과",
  find: "검색 결과",
  ls: "폴더 목록",
  card: "카드",
};
const roleOf = (m: CtxMessage) =>
  m.role === "toolResult" ? t(RESULT[m.toolName ?? ""] ?? "도구 결과") : ROLE[m.role] ? t(ROLE[m.role]) : t("기타");

function Talk(props: { list: CtxMessage[]; total: number; recalled: Memory[]; onOpen: (m: Memory) => void }) {
  // each message's size is an estimate. When the model counted more, the rest is a row of its
  // own (나머지); when it counted less, the rows shrink to fit. Either way they add up to 대화.
  const raw = () => props.list.reduce((n, m) => n + m.tokens, 0);
  const scale = () => (raw() > props.total ? props.total / raw() : 1);
  const rest = () => Math.max(0, props.total - raw());
  const groups = createMemo(() => {
    const g = new Map<string, { label: string; n: number; tokens: number }>();
    for (const m of props.list) {
      const label = roleOf(m);
      const x = g.get(label) ?? { label, n: 0, tokens: 0 };
      x.n++;
      x.tokens += m.tokens;
      g.set(label, x);
    }
    const list = [...g.values()].sort((a, b) => b.tokens - a.tokens);
    if (raw() <= props.total) return list;
    const sized = apportion(list.map((x) => x.tokens), props.total);
    return list.map((x, i) => ({ ...x, tokens: sized[i] }));
  });
  const heavy = createMemo(() => [...props.list].sort((a, b) => b.tokens - a.tokens).slice(0, 8));
  const [memOpen, setMemOpen] = createSignal(false);
  const memTokens = () => props.recalled.reduce((n, m) => n + estimate(m.text), 0);
  /** the rows, largest first: memory, each kind of message, and 나머지 (memory last on a tie) */
  const order = createMemo(() => {
    const rows: [string, number][] = [...groups().map((g): [string, number] => [`g:${g.label}`, g.tokens])];
    if (rest() > 0) rows.push(["rest", rest()]);
    rows.push(["mem", memTokens()]);
    return rows.sort((a, b) => b[1] - a[1]).map(([k]) => k);
  });
  return (
    <>
      <div class="cx-talk">
        <For each={order()}>
          {(key) =>
            key === "mem" ? (
              <>
                {/* memory goes in with a message: a row of the conversation like the others */}
                <button
                  class="cx-talk-row cx-talk-mem"
                  classList={{ open: memOpen() }}
                  disabled={!props.recalled.length}
                  aria-expanded={props.recalled.length ? memOpen() : undefined}
                  onClick={() => setMemOpen(!memOpen())}
                >
                  <span class="cx-talk-label">
                    {t("메모리")}
                    <Show when={props.recalled.length}><Icon name="chevron" size={12} class="cx-chev" /></Show>
                  </span>
                  <span class="cx-talk-n">{t("{n}개", { n: props.recalled.length })}</span>
                  {/* the same columns as the other rows, empty when nothing was recalled */}
                  <span class="cx-talk-track"><i style={{ width: `${pct(memTokens(), props.total)}%` }} /></span>
                  <span class="cx-talk-size">{tokens(memTokens())}</span>
                </button>
                <Show when={props.recalled.length}>
                  <Fold open={memOpen()}>
                    <div class="cx-talk-mems">
                      <MemoryList list={props.recalled} empty={t("없음")} onOpen={props.onOpen} />
                    </div>
                  </Fold>
                </Show>
              </>
            ) : key === "rest" ? (
              <div class="cx-talk-row cx-talk-rest" title={t("위 메시지에 없는 토큰")}>
                <span class="cx-talk-label">{t("나머지|context")}</span>
                <span class="cx-talk-n" />
                <span class="cx-talk-track"><i style={{ width: `${pct(rest(), props.total)}%` }} /></span>
                <span class="cx-talk-size">{tokens(rest())}</span>
              </div>
            ) : (
              <Show when={groups().find((g) => `g:${g.label}` === key)}>
                {(g) => (
                  <div class="cx-talk-row">
                    <span class="cx-talk-label">{g().label}</span>
                    <span class="cx-talk-n">{t("{n}개", { n: g().n })}</span>
                    <span class="cx-talk-track"><i style={{ width: `${pct(g().tokens, props.total)}%` }} /></span>
                    <span class="cx-talk-size">{tokens(g().tokens)}</span>
                  </div>
                )}
              </Show>
            )
          }
        </For>
      </div>
      <Show when={props.list.length}>
        <div class="cx-sub-title">{t("가장 큰 항목")}</div>
        <div class="cx-heavy">
          <For each={heavy()}>
            {(m) => (
              <div class="cx-heavy-row" classList={{ bad: m.isError }}>
                <span class="cx-heavy-role">{roleOf(m)}</span>
                <span class="cx-heavy-text selectable">{plainPreview(m.preview) || t("(내용 없음)")}</span>
                <span class="cx-heavy-size">{tokens(Math.round(m.tokens * scale()))}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

function View(props: { data: Loaded; known?: { tokens: number; window: number }; onClose: () => void }) {
  const c = () => props.data.ctx;
  const sec = (name: string) => c().sections.find((s) => s.name === name)?.tokens ?? 0;
  const engineSections = () => c().sections.filter((s) => !["addendum", "project_context", "skills"].includes(s.name));
  const activeTools = () => enabledTools(c());
  /** the skills Settings lists; agents search them, so their text is in the prompt only when the engine put it there */
  const loadedSkills = () => props.data.skills ?? [];
  const inPrompt = (name: string) => (sec("skills") > 0 ? c().skills.find((s) => s.name === name && s.modelInvocable) : undefined);
  const counted = createMemo(() => {
    const s: Record<Seg, number> = {
      engine: engineSections().reduce((n, x) => n + x.tokens, 0),
      ondra: sec("addendum"),
      files: sec("project_context"),
      skills: sec("skills"),
      // the same figure as Settings › 도구
      tools: enabledToolTokens(c()),
      talk: c().messages.reduce((n, m) => n + m.tokens, 0),
    };
    // an extension replaced the whole prompt: count it as the engine's
    if (c().forced) s.engine = c().systemPromptTokens;
    return s;
  });
  // the input's strip and this sheet read one number: what the engine last reported for this conversation
  const real = () => props.known?.tokens ?? c().contextUsage?.tokens ?? null;
  // when the model's own count is known, the total is that number (the one the status line
  // shows). The prompt's parts are what was sent, so they keep their own sizes (each the sum of
  // its rows, the tools as Settings counts them) and 대화 is the rest of the count
  const segs = createMemo(() => {
    const s = counted();
    const r = real();
    if (!r) return s;
    const fixed = s.engine + s.ondra + s.files + s.skills + s.tools;
    if (r >= fixed) return { ...s, talk: r - fixed };
    // the model counted less than the estimates: they shrink to fit, the tools keep their number
    const keys: Seg[] = ["engine", "ondra", "files", "skills"];
    const sized = apportion(keys.map((key) => s[key]), Math.max(0, r - s.tools));
    return { ...(Object.fromEntries(keys.map((key, i) => [key, sized[i]])) as Record<Seg, number>), tools: Math.min(s.tools, r), talk: 0 };
  });
  const total = () => real() || Object.values(segs()).reduce((a, b) => a + b, 0);
  const win = () => props.known?.window || c().contextUsage?.contextWindow || 0;
  // the bar is the whole window: each part takes its share, the rest stays empty
  const scale = () => Math.max(win(), total()) || 1;
  const order: Seg[] = ["engine", "ondra", "files", "skills", "tools", "talk"];
  const systemTotal = () => segs().engine + segs().ondra + segs().files + segs().skills;

  const openMemory = (m: Memory) => {
    setMemoryFocus(m.id);
    setView({ name: "memory" });
    props.onClose();
  };

  return (
    <>
      <div class="cx-summary">
        <div class="cx-big">
          <b>{tokens(total())}</b>
          <Show when={win()}><span>/ {tokens(win())}</span></Show>
          <Show when={win()}><span class="cx-big-note">{ctxShare(total(), win())}</span></Show>
          <span class="spacer" />
          <Show when={real() !== null && real() !== undefined}>
            <span class="cx-real">{t("마지막 요청 {n}", { n: tokens(real()!) })}</span>
          </Show>
        </div>
        <div class="cx-bar" role="img" aria-label={t("컨텍스트")}>
          <For each={order}>
            {(k) => (
              <Show when={segs()[k] > 0}>
                <i class={`cx-seg k-${k}`} style={{ width: `${pct(segs()[k], scale())}%` }} title={`${t(SEG_LABEL[k])} ${tokens(segs()[k])}`} />
              </Show>
            )}
          </For>
        </div>
        <div class="cx-legend">
          <For each={order.filter((k) => segs()[k] > 0)}>
            {(k) => (
              <span class="cx-leg">
                <i class={`cx-key k-${k}`} />
                {t(SEG_LABEL[k])}
                <b>{tokens(segs()[k])}</b>
              </span>
            )}
          </For>
        </div>
      </div>

      <div class="cx-parts">
        <Show when={!c().forced} fallback={
          <Part seg="engine" title={t("기본 지침")} size={systemTotal()} of={total()}>
            <Pre text={c().systemPrompt} />
          </Part>
        }>
          <Part seg="engine" title={t("기본 지침")} size={segs().engine} of={total()}>
            <For each={engineSections()}>
              {(s) => (
                <Part nested seg="engine" title={ENGINE_SECTION[s.name] ? t(ENGINE_SECTION[s.name]) : t("기타")} size={s.tokens}>
                  <Pre text={s.text} />
                </Part>
              )}
            </For>
          </Part>
          <Part seg="ondra" title={t("내 지침")} size={segs().ondra} of={total()} meta={`${props.data.parts.length}`} empty={!props.data.parts.length}>
            <For each={props.data.parts}>
              {(p) => (
                <Part nested seg="ondra" title={p.title} size={c().appendSystemPrompt.find((a) => a.text === p.text)?.tokens}>
                  <Pre text={p.text} />
                </Part>
              )}
            </For>
          </Part>
          <Part seg="files" title={t("지시 파일")} size={segs().files} of={total()} meta={c().contextFiles.map((f) => f.path.split("/").pop()).join(" · ") || "0"} empty={!c().contextFiles.length}>
            <For each={c().contextFiles}>
              {(f) => (
                <Part nested seg="files" title={tilde(f.path)} size={f.tokens}>
                  <Pre text={f.content} />
                </Part>
              )}
            </For>
          </Part>
          <Part seg="skills" title={t("스킬")} size={segs().skills} of={total()} note={loadedSkills().length && !segs().skills ? t("검색해서 불러옴") : undefined} meta={`${loadedSkills().length}`} empty={!loadedSkills().length}>
            <div class="cx-list">
              <For each={loadedSkills()}>
                {(s) => (
                  <div class="cx-li">
                    <b>{s.name}</b>
                    <span title={s.description}>{skillLine(s, s.own)}</span>
                    {/* where it comes from, by name (기본, 내 스킬); never a folder path */}
                    <em>{/^[~/]/.test(skillSource(s.path)) ? "" : skillSource(s.path)}</em>
                    <small>{inPrompt(s.name) ? tokens(skillTokens(inPrompt(s.name)!)) : ""}</small>
                  </div>
                )}
              </For>
            </div>
          </Part>
        </Show>

        <Part seg="tools" title={t("도구")} size={segs().tools} of={total()} meta={`${activeTools().length}`} empty={!activeTools().length}>
          <div class="cx-list">
            <For each={activeTools()}>
              {(t) => (
                <div class="cx-li">
                  <b>{t.name}</b>
                  <span classList={{ en: !isKorean(t) }} title={t.description}>{toolLine(t)}</span>
                  <em>{sourceText(toolSource(t).label, t.name)}</em>
                  <small>{tokens(t.schemaTokens)}</small>
                </div>
              )}
            </For>
          </div>
        </Part>

        <Part
          seg="talk"
          title={t("대화")}
          size={segs().talk}
          of={total()}
          meta={t("메시지 {n}개", { n: c().messages.length })}
          open={c().messages.length > 0}
          empty={!c().messages.length && !props.data.recalled.length}
        >
          <Talk list={c().messages} total={segs().talk} recalled={props.data.recalled} onOpen={openMemory} />
        </Part>
      </div>
    </>
  );
}

/** A card in a few words: its takeaway, its title, or what it lists. */
function cardLine(b: Block): string {
  const x = b as Block & { title?: unknown; files?: { path?: string }[] };
  if (b.say) return b.say;
  if (typeof x.title === "string" && x.title) return x.title;
  if (Array.isArray(x.files)) return x.files.map((f) => f.path ?? "").filter(Boolean).join(", ");
  return b.type;
}

/** The sheet. `agent` is "t:<job id>" or "captain:<chat key>". */
/** Without the engine (the preview build) the probe's sample talk stands in: show this conversation's own. */
function ownTalk(agent: string): CtxMessage[] {
  const m = (role: string, text: string, toolName?: string): CtxMessage => ({ role, tokens: estimate(text), preview: text.trim().slice(0, 200), toolName });
  if (agent.startsWith("t:")) {
    const x = taskById(agent.slice(2));
    if (!x) return [];
    const TOOL: Record<string, string> = { read: "read", search: "grep", edit: "edit", write: "write", bash: "bash", test: "bash" };
    return [
      ...(x.entries.some((e) => e.kind === "user") ? [] : [m("user", x.ask)]),
      ...x.entries.flatMap((e) =>
        e.kind === "user"
          ? [m("user", e.text)]
          : e.kind === "text"
            ? [m("assistant", e.text)]
            : e.kind === "tool"
              ? [m("toolResult", e.tool.detail || e.tool.target, TOOL[e.tool.kind])]
              : e.kind === "block"
                ? [{ ...m("toolResult", JSON.stringify(e.block), "card"), preview: cardLine(e.block) }]
                : [],
      ),
    ];
  }
  const key = agent.replace(/^captain:/, "");
  return state.captain
    .filter((x) => inChat(x, key) && !x.pending)
    .map((x) => (x.from === "me" ? m("user", x.text ?? "") : m("assistant", [x.reply, ...(x.routes ?? []).map((r) => (r.kind === "answer" ? r.text : ""))].filter(Boolean).join("\n\n"))))
    .filter((x) => x.preview);
}

export function ContextSheet(props: { agent: string; accountId: string; known?: { tokens: number; window: number }; onClose: () => void }) {
  const [n, setN] = createSignal(0);
  const [data] = createResource(() => ({ n: n() }), async () => {
    const [d, skills] = await Promise.all([
      props.agent.startsWith("t:") ? loadJob(props.agent.slice(2)) : loadChat(props.agent.replace(/^captain:/, ""), props.accountId),
      settingsSkills(),
    ]);
    return inTauri ? { ...d, skills } : { ...d, skills, ctx: { ...d.ctx, messages: ownTalk(props.agent) } };
  });
  // the same number the input's strip shows, kept current while the sheet is open
  const known = () => {
    const x = ctxNow[props.agent];
    return x ? { tokens: x.tokens, window: x.window } : props.known;
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !ignoredKey(e) && noModifiers(e)) {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  };
  onMount(() => window.addEventListener("keydown", key, true));
  onCleanup(() => window.removeEventListener("keydown", key, true));
  return (
    <Portal>
      <div class="backdrop cx-backdrop" onClick={props.onClose}>
        <div class="sheet cx-sheet" role="dialog" aria-label={t("컨텍스트")} onClick={(e) => e.stopPropagation()}>
          <div class="sheet-head">
            {t("컨텍스트")}
            <span class="spacer" />
            <button class="icon-btn" title={t("새로고침")} disabled={data.loading} onClick={() => setN(n() + 1)}><Icon name="refresh" size={16} /></button>
            <button class="icon-btn" title={`${t("닫기")} (esc)`} onClick={props.onClose}><Icon name="x" size={16} /></button>
          </div>
          <div class="sheet-body cx-body">
            <Show when={!data.error} fallback={<p class="cx-error">{t("불러오지 못했어요")} · {String(data.error?.message ?? data.error)}</p>}>
              <Show when={data()} fallback={<div class="cx-wait">{t("불러오는 중")}</div>}>
                <View data={data()!} known={known()} onClose={props.onClose} />
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
