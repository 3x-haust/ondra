// Plumbing for engine processes in `--mode rpc` (JSON lines over stdio).
import { createSignal } from "solid-js";
import { agentAlive, agentSend, engineInfo, onEvent, type EngineInfo } from "../lib/native";
import { t } from "../i18n";

export interface AgentHandlers {
  event: (ev: any) => void;
  exit?: (code: number | null) => void;
}

const handlers = new Map<string, AgentHandlers>();
const waiting = new Map<string, (ev: any) => void>();
const stderrTail = new Map<string, string[]>();
const alive = new Set<string>();
const [infoSig, setInfo] = createSignal<EngineInfo | null>(null);
const empty: EngineInfo = { enginePath: null, engineVersion: null, dataDir: "", home: "" };

export const engine = {
  get info() {
    return infoSig() ?? empty;
  },
  /** Engine binary present (true until checked, so nothing flashes on start). */
  get ready() {
    const i = infoSig();
    return !i || !!i.enginePath;
  },
  get checked() {
    return !!infoSig();
  },
};

/** "~/x" → absolute. */
export const expand = (p: string) => (p === "~" || p.startsWith("~/") ? engine.info.home + p.slice(1) : p);
/** absolute → "~/x" for display. */
export const tilde = (p: string) => {
  const h = engine.info.home;
  return h && p.startsWith(h) ? `~${p.slice(h.length)}` : p;
};

/** Engine event subscriptions live on window so a reloaded module (dev hot
 *  reload, or startRpc called twice) never leaves a second copy listening:
 *  every event would otherwise reach the handlers once per copy. */
type Unlisten = () => void;
const subs = ((globalThis as { __ondraRpcSubs?: Unlisten[] }).__ondraRpcSubs ??= []);

// one start at a time: two overlapping starts (a remount during hot reload)
// would each subscribe after the other had cleared, and every event would arrive twice
let starting: Promise<void> = Promise.resolve();
export function startRpc(): Promise<void> {
  return (starting = starting.catch(() => {}).then(start));
}

async function start() {
  setInfo(await engineInfo());
  for (const id of await agentAlive()) alive.add(id);
  for (const un of subs.splice(0)) un();
  subs.push(await onEvent<{ id: string; ev: any }>("agent:event", ({ id, ev }) => {
    if (ev.type === "response" && ev.id && waiting.has(ev.id)) {
      waiting.get(ev.id)!(ev);
      waiting.delete(ev.id);
      return;
    }
    handlers.get(id)?.event(ev);
  }));
  subs.push(await onEvent<{ id: string; code: number | null }>("agent:exit", ({ id, code }) => {
    alive.delete(id);
    handlers.get(id)?.exit?.(code);
  }));
  subs.push(await onEvent<{ id: string; line: string }>("agent:stderr", ({ id, line }) => {
    const tail = stderrTail.get(id) ?? [];
    tail.push(line);
    stderrTail.set(id, tail.slice(-12));
  }));
}

/** Ask again where the engine is and which version (its component just came in). */
export async function refreshEngine() {
  setInfo(await engineInfo());
}

export const isAlive = (id: string) => alive.has(id);
export const markAlive = (id: string) => alive.add(id);
export const markDead = (id: string) => alive.delete(id);
export const stderrOf = (id: string) => (stderrTail.get(id) ?? []).join("\n");
export const clearStderr = (id: string) => stderrTail.delete(id);
export const listen = (id: string, h: AgentHandlers) => handlers.set(id, h);

let seq = 0;
/** Send a command and wait for its response (the engine echoes our id). */
export function request(agentId: string, command: Record<string, unknown>, timeoutMs?: number): Promise<any> {
  const id = `r${++seq}`;
  // a prompt is answered only after the engine is ready to run it, which can mean
  // compacting the conversation first (a minute or more): don't call that a failure
  timeoutMs ??= command.type === "prompt" ? 15 * 60_000 : command.type === "compact" ? 10 * 60_000 : 30_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(t("{s}초 동안 응답이 없어요 ({cmd})", { s: Math.round(timeoutMs! / 1000), cmd: String(command.type) })));
    }, timeoutMs);
    waiting.set(id, (ev) => {
      clearTimeout(timer);
      ev.success === false ? reject(new Error(ev.error ?? t("{cmd} 실패", { cmd: String(command.type) }))) : resolve(ev.data);
    });
    // a prompt that lands while the engine is still busy (just after stop, a late
    // event) waits its turn instead of failing
    const cmd = command.type === "prompt" && !command.streamingBehavior ? { ...command, streamingBehavior: "followUp" } : command;
    agentSend(agentId, { ...cmd, id }).catch((e) => {
      clearTimeout(timer);
      waiting.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

/** Provider errors → a sentence the user can act on. */
export function explain(message: string): string {
  const m = message.match(/'([^']+)' model is not supported/i);
  if (m) return t("이 계정에서 쓸 수 없는 모델 · {m}", { m: m[1] });
  if (/rate limit|usage limit|429|quota/i.test(message)) return t("사용 한도 도달 · {msg}", { msg: message.slice(0, 90) });
  if (/unauthori[sz]ed|invalid.*token|401|403|log ?in/i.test(message)) return t("로그인이 필요해요 · 설정 › 계정");
  if (/no (api key|credentials)|not configured/i.test(message)) return t("연결된 계정이 없어요 · 설정 › 계정");
  return message.replace(/\s+/g, " ").slice(0, 220);
}

export const isModelError = (message: string) =>
  /model is not supported|model_not_found|does not exist|not available|unknown model|no access to model/i.test(message);
