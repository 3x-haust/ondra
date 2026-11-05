// What the model actually receives for a job or a chat: a bar of how the
// context window fills up, then each part to open and read.
import { createMemo, createResource, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { tilde } from "../engine/rpc";
import { kindLabel, kindOf } from "../engine/memory";
import { setMemoryFocus, setView } from "../state/ui";
import type { Memory } from "../state/types";
import { tokens } from "../ui/bits";
import { Fold } from "../ui/Fold";
import { Icon } from "../ui/Icon";
import { type CtxMessage, type Loaded, loadChat, loadJob } from "./contextData";
import { firstSentence, isKorean, skillSource, skillTokens, toolLine, toolSource } from "./Tools";

type Seg = "engine" | "ondra" | "files" | "skills" | "tools" | "talk";
const SEG_LABEL: Record<Seg, string> = {
  engine: "엔진 기본",
  ondra: "Ondra 지시",
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
  docs: "엔진 문서 안내",
  cwd: "작업 폴더",
};

const pct = (n: number, of: number) => (of ? Math.min(100, (n / of) * 100) : 0);
const share = (n: number, of: number) => {
  const p = of ? (n / of) * 100 : 0;
  return p >= 10 ? `${Math.round(p)}%` : p >= 0.1 ? `${p.toFixed(1)}%` : "0%";
};

/** A part that opens to show what is inside. */
function Part(props: { title: JSX.Element; size?: number; of?: number; meta?: string; seg?: Seg; children: JSX.Element; open?: boolean; nested?: boolean }) {
  const [open, setOpen] = createSignal(!!props.open);
  return (
    <div class="cx-part" classList={{ open: open(), nested: props.nested }}>
      <button class="cx-part-head" onClick={() => setOpen(!open())} aria-expanded={open()}>
        <Icon name="chevron" size={13} class="chev cx-chev" />
        <Show when={props.seg}><i class={`cx-key k-${props.seg}`} /></Show>
        <span class="cx-part-title">{props.title}</span>
        <Show when={props.meta}><span class="cx-part-meta">{props.meta}</span></Show>
        <span class="spacer" />
        <Show when={props.size !== undefined}>
          <span class="cx-part-size">{tokens(props.size!)}</span>
          <Show when={props.of}><span class="cx-part-share">{share(props.size!, props.of!)}</span></Show>
        </Show>
      </button>
      <Fold open={open()}>
        <div class="cx-part-body">{props.children}</div>
      </Fold>
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
            <button class="cx-mem" onClick={() => props.onOpen(m)} title="기억에서 열기">
              <span class="cx-mem-kind">{kindLabel(kindOf(m))}</span>
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
const roleOf = (m: CtxMessage) => (m.role === "toolResult" && m.toolName ? `도구 결과 · ${m.toolName}` : ROLE[m.role] ?? m.role);

function Talk(props: { list: CtxMessage[]; total: number; live: boolean; known?: number }) {
  const groups = createMemo(() => {
    const g = new Map<string, { label: string; n: number; tokens: number }>();
    for (const m of props.list) {
      const label = roleOf(m);
      const x = g.get(label) ?? { label, n: 0, tokens: 0 };
      x.n++;
      x.tokens += m.tokens;
      g.set(label, x);
    }
    return [...g.values()].sort((a, b) => b.tokens - a.tokens);
  });
  const heavy = createMemo(() => [...props.list].sort((a, b) => b.tokens - a.tokens).slice(0, 8));
  return (
    <Show
      when={props.list.length}
      fallback={
        <p class="cx-empty">
          {props.known ? tokens(props.known) : "없어요"}
        </p>
      }
    >
      <div class="cx-talk">
        <For each={groups()}>
          {(g) => (
            <div class="cx-talk-row">
              <span class="cx-talk-label">{g.label}</span>
              <span class="cx-talk-n">{g.n}개</span>
              <span class="cx-talk-track"><i style={{ width: `${pct(g.tokens, props.total)}%` }} /></span>
              <span class="cx-talk-size">{tokens(g.tokens)}</span>
            </div>
          )}
        </For>
      </div>
      <div class="cx-sub-title">가장 큰 것</div>
      <div class="cx-heavy">
        <For each={heavy()}>
          {(m) => (
            <div class="cx-heavy-row" classList={{ bad: m.isError }}>
              <span class="cx-heavy-role">{roleOf(m)}</span>
              <span class="cx-heavy-text selectable">{m.preview || "(내용 없음)"}</span>
              <span class="cx-heavy-size">{tokens(m.tokens)}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function View(props: { data: Loaded; known?: { tokens: number; window: number }; onClose: () => void }) {
  const c = () => props.data.ctx;
  const sec = (name: string) => c().sections.find((s) => s.name === name)?.tokens ?? 0;
  const engineSections = () => c().sections.filter((s) => !["addendum", "project_context", "skills"].includes(s.name));
  const activeTools = () => c().tools.filter((t) => t.active);
  const counted = createMemo(() => {
    const s: Record<Seg, number> = {
      engine: engineSections().reduce((n, x) => n + x.tokens, 0),
      ondra: sec("addendum"),
      files: sec("project_context"),
      skills: sec("skills"),
      tools: activeTools().reduce((n, t) => n + t.schemaTokens, 0),
      talk: c().messages.reduce((n, m) => n + m.tokens, 0),
    };
    // an extension replaced the whole prompt: count it as the engine's
    if (c().forced) s.engine = c().systemPromptTokens;
    return s;
  });
  const real = () => c().contextUsage?.tokens ?? (props.data.live ? null : props.known?.tokens ?? null);
  // the parts are estimates; when the model's own count is known, the total is that number
  // (the same one the status line shows) and each part keeps its share of it
  const segs = createMemo(() => {
    const s = counted();
    const sum = Object.values(s).reduce((a, b) => a + b, 0);
    const r = real();
    if (!r || !sum) return s;
    const k = r / sum;
    return Object.fromEntries(Object.entries(s).map(([key, v]) => [key, Math.round(v * k)])) as Record<Seg, number>;
  });
  const total = () => real() || Object.values(segs()).reduce((a, b) => a + b, 0);
  const win = () => c().contextUsage?.contextWindow || props.known?.window || 0;
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
          <Show when={win()}><span class="cx-big-note">{share(total(), win())}</span></Show>
          <span class="spacer" />
          <Show when={real() !== null && real() !== undefined}>
            <span class="cx-real" title="모델이 마지막 요청에서 알려준 크기">마지막 요청 {tokens(real()!)}</span>
          </Show>
        </div>
        <div class="cx-bar" role="img" aria-label="컨텍스트 구성">
          <For each={order}>
            {(k) => (
              <Show when={segs()[k] > 0}>
                <i class={`cx-seg k-${k}`} style={{ width: `${pct(segs()[k], scale())}%` }} title={`${SEG_LABEL[k]} ${tokens(segs()[k])}`} />
              </Show>
            )}
          </For>
        </div>
        <div class="cx-legend">
          <For each={order}>
            {(k) => (
              <span class="cx-leg">
                <i class={`cx-key k-${k}`} />
                {SEG_LABEL[k]}
                <b>{tokens(segs()[k])}</b>
              </span>
            )}
          </For>
        </div>
      </div>

      <div class="cx-parts">
        <Part title="시스템 프롬프트" size={systemTotal()} of={total()} open>
          <Show when={!c().forced} fallback={<Pre text={c().systemPrompt} />}>
            <Part nested seg="engine" title="엔진 기본" size={segs().engine} of={total()}>
              <For each={engineSections()}>
                {(s) => (
                  <Part nested title={ENGINE_SECTION[s.name] ?? s.name} meta={s.name} size={s.tokens}>
                    <Pre text={s.text} />
                  </Part>
                )}
              </For>
            </Part>
            <Part nested seg="ondra" title="Ondra 지시" size={segs().ondra} of={total()} meta={`${props.data.parts.length}개`}>
              <For each={props.data.parts} fallback={<p class="cx-empty">없어요</p>}>
                {(p) => (
                  <Part nested title={p.title} size={c().appendSystemPrompt.find((a) => a.text === p.text)?.tokens}>
                    <Pre text={p.text} />
                  </Part>
                )}
              </For>
            </Part>
            <Part nested seg="files" title="지시 파일" size={segs().files} of={total()} meta={c().contextFiles.map((f) => f.path.split("/").pop()).join(" · ") || "없음"}>
              <For each={c().contextFiles} fallback={<p class="cx-empty">없어요</p>}>
                {(f) => (
                  <Part nested title={tilde(f.path)} size={f.tokens}>
                    <Pre text={f.content} />
                  </Part>
                )}
              </For>
            </Part>
            <Part nested seg="skills" title="스킬" size={segs().skills} of={total()} meta={`${c().skills.length}개 · 이름과 설명만`}>
              <div class="cx-list">
                <For each={c().skills} fallback={<p class="cx-empty">없어요</p>}>
                  {(s) => (
                    <div class="cx-li" classList={{ off: !s.modelInvocable }}>
                      <b>{s.name}</b>
                      <span title={s.description}>{firstSentence(s.description, 90)}</span>
                      <em>{skillSource(s.path)}</em>
                      <small>{tokens(skillTokens(s))}</small>
                    </div>
                  )}
                </For>
              </div>
            </Part>
          </Show>
        </Part>

        <Part title="기억" meta={`${props.data.recalled.length}`}>
          <MemoryList list={props.data.recalled} empty="없어요" onOpen={openMemory} />
        </Part>

        <Part seg="tools" title="도구" size={segs().tools} of={total()} meta={`${activeTools().length}`}>
          <div class="cx-list">
            <For each={activeTools()}>
              {(t) => (
                <div class="cx-li">
                  <b>{t.name}</b>
                  <span classList={{ en: !isKorean(t) }} title={t.description}>{toolLine(t)}</span>
                  <em>{toolSource(t).label}</em>
                  <small>{tokens(t.schemaTokens)}</small>
                </div>
              )}
            </For>
          </div>
        </Part>

        <Part seg="talk" title="대화" size={segs().talk} of={total()} meta={`메시지 ${c().messages.length}개`} open={c().messages.length > 0}>
          <Talk list={c().messages} total={segs().talk} live={props.data.live} known={props.known?.tokens} />
        </Part>
      </div>
    </>
  );
}

/** The sheet. `agent` is "t:<job id>" or "captain:<chat key>". */
export function ContextSheet(props: { agent: string; accountId: string; known?: { tokens: number; window: number }; onClose: () => void }) {
  const [n, setN] = createSignal(0);
  const [data] = createResource(() => ({ n: n() }), () =>
    props.agent.startsWith("t:") ? loadJob(props.agent.slice(2)) : loadChat(props.agent.replace(/^captain:/, ""), props.accountId),
  );
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onClose();
    }
  };
  onMount(() => window.addEventListener("keydown", key, true));
  onCleanup(() => window.removeEventListener("keydown", key, true));
  return (
    <Portal>
      <div class="backdrop cx-backdrop" onClick={props.onClose}>
        <div class="sheet cx-sheet" role="dialog" aria-label="컨텍스트" onClick={(e) => e.stopPropagation()}>
          <div class="sheet-head">
            컨텍스트
            <span class="spacer" />
            <button class="icon-btn" title="다시 불러오기" disabled={data.loading} onClick={() => setN(n() + 1)}><Icon name="refresh" size={14} /></button>
            <button class="icon-btn" title="닫기 (esc)" onClick={props.onClose}><Icon name="x" size={15} /></button>
          </div>
          <div class="sheet-body cx-body">
            <Show when={!data.error} fallback={<p class="cx-error">불러오지 못했어요 · {String(data.error?.message ?? data.error)}</p>}>
              <Show when={data()} fallback={<div class="cx-wait">엔진에 물어보는 중이에요</div>}>
                <View data={data()!} known={props.known} onClose={props.onClose} />
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
