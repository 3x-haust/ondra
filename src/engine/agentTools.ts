// What agents can use, counted and described one way: Settings › 도구 / 스킬 and
// a task's context sheet read their numbers and lines from here. No UI in this file.
import { skillList } from "../lib/native";
import { state } from "../state/store";
import type { SpaceId } from "../state/types";
import { t } from "../i18n";
import { engine, tilde } from "./rpc";
import { skillsIn } from "./memory";
import { estimate, type CtxTool, type EngineContext } from "../views/contextData";

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

/** One plain line for the bundled skills (their own descriptions are written for the model). */
const SKILL_LINE: Record<string, string> = {
  "browser-use": "브라우저로 사이트를 열고 다뤄요",
  "code-review": "끝내기 전에 바뀐 코드를 설계와 코드 두 관점으로 검토해요",
  "computer-use": "Mac 앱을 뒤에서 조작해요",
  "deep-research": "여러 출처를 읽고 조사해요",
  "device-use": "시뮬레이터와 에뮬레이터에서 앱을 다뤄요",
  "goal-loop": "목표를 이룰 때까지 고치고 확인해요",
  mimikyu: "Figma 디자인을 코드로 옮기고 맞춰 봐요",
  "modern-web-guidance": "웹 화면 코드를 요즘 방식으로 짜요",
  "motion-graphics": "홍보 영상과 모션그래픽을 만들어요",
  "office-docs": "워드·엑셀·PPT·PDF 파일을 읽고 만들어요",
  secrets: "API 키와 .env를 값을 보지 않고 다뤄요",
  qa: "앱을 직접 써 보며 버그를 찾아요",
  "reverse-engineering": "바이너리와 앱을 분석해요",
  "test-ci": "테스트와 CI를 만들어요",
  "visual-report": "진행과 결과를 차트와 블록으로 보여 줘요",
  "web-design": "사이트와 화면을 디자인해요",
};

const hasHangul = (s: string) => /[가-힣]/.test(s);

/** First sentence of a description, short. */
export function firstSentence(s: string, max = 110): string {
  const line = s.replace(/\s+/g, " ").trim();
  const m = line.match(/^(.+?[.!?。])(\s|$)/);
  const one = m ? m[1] : line;
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** A tool's one-liner: our line in the app's language, else its own first sentence. */
export const toolLine = (x: { name: string; description: string }) => (KO[x.name] ? t(KO[x.name]) : firstSentence(x.description || ""));
/** An open row's text in the app's language: our longer line for the engine's own tools, else the tool's own words. */
export const toolMore = (x: { name: string; description: string }) => (KO_MORE[x.name] ? t(KO_MORE[x.name]) : KO[x.name] ? t(KO[x.name]) : x.description);
/** our own line (in the app's language) or a Korean description: shown at full strength */
export const isKorean = (x: { name: string; description: string }) => !!KO[x.name] || hasHangul(x.description || "");

/**
 * A skill's one-liner: ours (translated) for a skill that ships with Ondra, else
 * the first sentence of its own description. `own` = the user's own or an imported
 * skill (never given our line even when the name matches).
 */
export const skillLine = (s: { name: string; description: string }, own = false) =>
  !own && SKILL_LINE[s.name] ? t(SKILL_LINE[s.name]) : firstSentence(s.description || "", 140);

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
export const skillTokens = (s: { name: string; description: string; path: string }) =>
  estimate(`<skill><name>${s.name}</name><description>${s.description}</description><location>${s.path}</location></skill>`);

// ───────────── the counts

/**
 * The tools an agent has turned on: the ones it declares to the model, plus the
 * ones switched on in Settings › 도구 (`state.settings.extraTools`), less the MCP tools
 * switched off there ("-name"). Tools a job only finds on demand and tools left off
 * are not counted. Settings' header and the context sheet both count this.
 */
export const enabledTools = <T extends Pick<CtxTool, "name" | "active">>(c: { tools: T[] }, extra: readonly string[] = state.settings.extraTools ?? []): T[] =>
  c.tools.filter((x) => !isOff(x.name, extra) && (x.active || extra.includes(x.name)));

/** An MCP tool can be switched off for jobs (the engine leaves it out); other tools can't. */
export const canSwitchOff = (name: string) => /^mcp__[\w.:-]+$/.test(name);
/** switched off in Settings › 도구: kept in extraTools as "-name" */
export const isOff = (name: string, extra: readonly string[] = state.settings.extraTools ?? []) => canSwitchOff(name) && extra.includes(`-${name}`);

/** Tokens the enabled tools add to every request. */
export const enabledToolTokens = (c: Pick<EngineContext, "tools">, extra?: readonly string[]) =>
  enabledTools(c, extra).reduce((n, x) => n + x.schemaTokens, 0);

export interface LoadedSkill {
  name: string;
  description: string;
  /** the SKILL.md, or the folder that holds it */
  path: string;
  /** ships with Ondra (changed or not) */
  bundled: boolean;
}

/**
 * The skills jobs get, as Settings › 스킬 lists them: Ondra's own (the user's copy
 * where they changed one) and the user's own or imported ones. With a workspace,
 * only the user's skills that apply there.
 */
export async function loadedSkills(space?: SpaceId): Promise<LoadedSkill[]> {
  const files = await skillList().catch(() => []);
  const own = space ? skillsIn(space) : state.skills.filter((s) => s.enabled);
  return [
    ...files.map((f) => ({ name: f.name, description: "", path: f.path, bundled: true })),
    ...own.map((s) => ({ name: s.name, description: s.description, path: s.path, bundled: false })),
  ];
}
