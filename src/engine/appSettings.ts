// The settings an agent may read and change for the user (the `ondra` skill's `ondra_settings`
// tool, extensions/ondra.ts → bridge settings_read / settings_write): what the user would switch
// in Settings themselves, by name. Nothing else of the app's state is reachable this way, and no
// secret value ever passes through: the Discord token is moved natively from a saved secret.
import { discordTokenFromSecret, discordTokenHas } from "../lib/native";
import { setState, state } from "../state/store";
import type { Permission } from "../state/types";

type Kind = { type: "bool" } | { type: "int"; min: number; max: number } | { type: "enum"; of: string[] } | { type: "text"; max: number } | { type: "list"; max: number };
interface Entry {
  /** where it is in Settings, as the user sees it */
  where: string;
  kind: Kind;
  get: () => unknown;
  set: (v: never) => void | Promise<void>;
  /** a value it has when the user never set it */
  missing?: unknown;
}

const agent = () => state.settings.agent ?? { on: false, name: "메타몽" };
const setAgent = async (patch: Record<string, unknown>) => {
  const { setAgent: put, startAgent, stopAgent } = await import("./discord");
  put(patch);
  if ("on" in patch) void (patch.on ? startAgent() : stopAgent());
};

export const SETTINGS: Record<string, Entry> = {
  theme: { where: "일반 › 테마", kind: { type: "enum", of: ["system", "dark", "light"] }, get: () => state.settings.theme, set: (v: "system" | "dark" | "light") => setState("settings", "theme", v) },
  language: { where: "일반 › 언어", kind: { type: "enum", of: ["system", "ko", "en"] }, get: () => state.settings.language ?? "system", set: (v: "system" | "ko" | "en") => setState("settings", "language", v) },
  links: { where: "일반 › 링크 열기", kind: { type: "enum", of: ["inside", "outside"] }, get: () => state.settings.links ?? "inside", set: (v: "inside" | "outside") => setState("settings", "links", v) },
  permission: { where: "일반 › 기본 권한 (ask 매번 묻기 · auto 자동 판단 · full 전체 권한)", kind: { type: "enum", of: ["ask", "auto", "full"] }, get: () => state.settings.permission ?? "auto", set: (v: Permission) => setState("settings", "permission", v) },
  "slots.light": { where: "일반 › 동시 작업 수", kind: { type: "int", min: 1, max: 10 }, get: () => state.settings.slots.light, set: (v: number) => setState("settings", "slots", "light", v) },
  "slots.heavy": { where: "일반 › 빌드·시뮬레이터 작업 동시 수", kind: { type: "int", min: 1, max: 3 }, get: () => state.settings.slots.heavy, set: (v: number) => setState("settings", "slots", "heavy", v) },
  isolate: { where: "일반 › 작업마다 새 워크트리", kind: { type: "bool" }, get: () => state.settings.isolate, set: (v: boolean) => setState("settings", "isolate", v) },
  learn: { where: "일반 › 메모리 자동 저장", kind: { type: "bool" }, get: () => state.settings.learn, set: (v: boolean) => setState("settings", "learn", v) },
  appCheck: { where: "일반 › 작업 끝나면 앱에서 직접 확인", kind: { type: "bool" }, missing: true, get: () => state.settings.appCheck !== false, set: (v: boolean) => setState("settings", "appCheck", v) },
  autoMergeFixes: { where: "일반 › 확인된 수정은 묻지 않고 합치기", kind: { type: "bool" }, missing: true, get: () => state.settings.autoMergeFixes !== false, set: (v: boolean) => setState("settings", "autoMergeFixes", v) },
  ruleChecks: { where: "일반 › 두 번 말한 규칙은 자동 검사로", kind: { type: "bool" }, missing: true, get: () => state.settings.ruleChecks !== false, set: (v: boolean) => setState("settings", "ruleChecks", v) },
  watchPullRequests: { where: "일반 › PR 리뷰 자동 대응", kind: { type: "bool" }, get: () => !!state.settings.watchPullRequests, set: (v: boolean) => setState("settings", "watchPullRequests", v) },
  githubWrite: { where: "일반 › GitHub 푸시·PR 허용", kind: { type: "bool" }, get: () => !!state.settings.githubWrite, set: (v: boolean) => setState("settings", "githubWrite", v) },
  browserPip: { where: "일반 › 작업 브라우저 미리보기", kind: { type: "bool" }, missing: true, get: () => state.settings.browserPip !== false, set: (v: boolean) => setState("settings", "browserPip", v) },
  jobSound: { where: "일반 › 작업 끝 소리", kind: { type: "bool" }, missing: true, get: () => state.settings.jobSound !== false, set: (v: boolean) => setState("settings", "jobSound", v) },
  focusGuard: { where: "macOS 권한 › 창 보호", kind: { type: "bool" }, get: () => state.settings.focusGuard, set: (v: boolean) => setState("settings", "focusGuard", v) },
  telemetry: { where: "일반 › 익명 사용 통계 보내기", kind: { type: "bool" }, missing: true, get: () => state.settings.telemetry !== false, set: (v: boolean) => setState("settings", "telemetry", v) },
  skillReflect: { where: "스킬 › 잘 안 된 작업을 보고 스킬 고치기 제안", kind: { type: "bool" }, get: () => !!state.settings.skillReflect, set: (v: boolean) => setState("settings", "skillReflect", v) },
  "agent.on": { where: "에이전트 › 디스코드에서 쓰기 (needs the bot token first)", kind: { type: "bool" }, get: () => agent().on, set: (v: boolean) => setAgent({ on: v }) },
  "agent.name": { where: "에이전트 › 이름", kind: { type: "text", max: 32 }, get: () => agent().name, set: (v: string) => setAgent({ name: v }) },
  "agent.ownerId": { where: "에이전트 › 내 디스코드 ID (digits; empty = the bot's owner)", kind: { type: "text", max: 24 }, get: () => agent().ownerId ?? "", set: (v: string) => setAgent({ ownerId: v.replace(/\D/g, "") || undefined }) },
  "agent.space": { where: "에이전트 › 일을 받을 워크스페이스 (a workspace id)", kind: { type: "enum", of: [] }, get: () => agent().space ?? state.spaces[0]?.id, set: (v: string) => setAgent({ space: v }) },
  "agent.others": { where: "에이전트 › 다른 사람과 대화", kind: { type: "bool" }, missing: true, get: () => agent().others !== false, set: (v: boolean) => setAgent({ others: v }) },
  "agent.account": { where: "에이전트 › AI 계정 (an account id of its workspace, or auto = the workspace's choice)", kind: { type: "enum", of: [] }, missing: "auto", get: () => agent().account ?? "auto", set: (v: string) => setAgent({ account: v === "auto" ? undefined : v }) },
  "agent.channels": { where: "에이전트 › 대화할 채널 (channel ids; empty = wherever it's called)", kind: { type: "list", max: 20 }, get: () => agent().channels ?? [], set: (v: string[]) => setAgent({ channels: v }) },
  "agent.voice": { where: "에이전트 › 말투와 성격 (empty = the default voice)", kind: { type: "text", max: 4000 }, get: () => agent().voice ?? "", set: (v: string) => setAgent({ voice: v }) },
};

/** the workspace ids, for agent.space */
const spaceIds = () => state.spaces.map((s) => s.id);
/** the accounts of the agent's workspace, for agent.account */
const agentAccountIds = () => ["auto", ...state.accounts.filter((a) => a.space === (agent().space ?? state.spaces[0]?.id)).map((a) => a.id)];
const kindOf = (key: string, e: Entry): Kind => (key === "agent.space" ? { type: "enum", of: spaceIds() } : key === "agent.account" ? { type: "enum", of: agentAccountIds() } : e.kind);

/** Every setting with its value, where it is, and what it takes. */
export async function readSettings(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, e] of Object.entries(SETTINGS)) {
    const kind = kindOf(key, e);
    out[key] = { value: e.get(), where: e.where, takes: kind };
  }
  out["agent.token"] = { value: (await discordTokenHas()) ? "set (in the keychain)" : "not set", where: "에이전트 › 봇 토큰", takes: { type: "secret name", note: "write agent.token with the name of a saved secret (Settings › 시크릿); the value moves natively and is never shown" } };
  return out;
}

/** Check a value against what the setting takes; the value to store, or why not. */
export function checked(key: string, v: unknown): { ok: true; value: unknown } | { ok: false; why: string } {
  const e = SETTINGS[key];
  if (!e) return { ok: false, why: `no setting ${key}` };
  const kind: Kind = kindOf(key, e);
  switch (kind.type) {
    case "bool":
      return typeof v === "boolean" ? { ok: true, value: v } : v === "true" || v === "false" ? { ok: true, value: v === "true" } : { ok: false, why: `${key} takes true or false` };
    case "int": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isInteger(n) && n >= kind.min && n <= kind.max ? { ok: true, value: n } : { ok: false, why: `${key} takes a whole number ${kind.min}–${kind.max}` };
    }
    case "enum":
      return kind.of.includes(String(v)) ? { ok: true, value: String(v) } : { ok: false, why: `${key} takes one of ${kind.of.join(", ")}` };
    case "text":
      return typeof v === "string" && v.length <= kind.max ? { ok: true, value: v.trim() } : { ok: false, why: `${key} takes text up to ${kind.max} characters` };
    case "list": {
      const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[,\s]+/) : null;
      const clean = list?.map((x) => x.trim()).filter(Boolean);
      return clean && clean.length <= kind.max ? { ok: true, value: clean } : { ok: false, why: `${key} takes a list of up to ${kind.max}` };
    }
  }
}

/** Change settings: each key's old and new value, or why it wasn't changed. */
export async function writeSettings(changes: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(changes)) {
    if (key === "agent.token") {
      const name = String(v ?? "").trim();
      try {
        await discordTokenFromSecret(name);
        out[key] = { changed: true, now: `the bot token from secret ${name}` };
        // already on: connect again with the new token
        if (state.settings.agent?.on) void import("./discord").then((m) => m.startAgent());
      } catch (e) {
        out[key] = { changed: false, why: e instanceof Error ? e.message : String(e) };
      }
      continue;
    }
    const c = checked(key, v);
    if (!c.ok) {
      out[key] = { changed: false, why: c.why };
      continue;
    }
    const before = SETTINGS[key].get();
    await SETTINGS[key].set(c.value as never);
    out[key] = { changed: true, was: before, now: SETTINGS[key].get() };
  }
  return out;
}
