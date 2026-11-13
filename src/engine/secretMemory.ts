// What each secret is for lives in memory, where jobs already look things up. Each saved secret
// gets one piece (key "secret:<project>/<item>"): where it came from, how to use it, and a guess
// at the service from its name. A job that learns more (which command, test or live key) saves
// a better piece with `replaces`, and that one is what later jobs find. Values never go here.
import { addMemory, isLive, removeMemory, retireMemory } from "./memory";
import { state } from "../state/store";
import type { Memory } from "../state/types";
import type { SavedSecrets } from "../lib/native";

/** Services told apart by a name's prefix or words. */
const SERVICES: [RegExp, string][] = [
  [/^STRIPE/, "Stripe"],
  [/^OPENAI/, "OpenAI"],
  [/^ANTHROPIC|^CLAUDE/, "Anthropic"],
  [/^GEMINI|^GOOGLE_AI/, "Google AI"],
  [/^VERCEL/, "Vercel"],
  [/^(GITHUB|GH)_/, "GitHub"],
  [/^AWS_/, "AWS"],
  [/^SUPABASE/, "Supabase"],
  [/^FIREBASE/, "Firebase"],
  [/^GOOGLE/, "Google"],
  [/^SLACK/, "Slack"],
  [/^DISCORD/, "Discord"],
  [/^SENTRY/, "Sentry"],
  [/^POSTHOG/, "PostHog"],
  [/^RESEND/, "Resend"],
  [/^TWILIO/, "Twilio"],
  [/^CLOUDFLARE|^CF_/, "Cloudflare"],
  [/^NPM_/, "npm"],
  [/^APPLE_|^APP_STORE/, "Apple"],
  [/^TAURI_SIGNING/, "Tauri 업데이트 서명"],
  [/(DATABASE|POSTGRES|MYSQL|MONGO|REDIS)|^DB_/, "데이터베이스"],
  [/JWT|SESSION_SECRET|AUTH_SECRET|NEXTAUTH/, "로그인 세션 서명"],
];

export function serviceOf(name: string): string | undefined {
  const bare = name.replace(/^(NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|REACT_APP_|PUBLIC_)/, "");
  return SERVICES.find(([re]) => re.test(bare))?.[1];
}

const publicPrefix = (name: string) => /^(NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|REACT_APP_|PUBLIC_)/.test(name);

/** The first piece about one secret: where it lives and how to use it, never its value. */
export function secretPiece(name: string, place: { project?: string; dir?: string }) {
  const service = serviceOf(name);
  const where = !place.project ? "모든 작업에 쓰는 시크릿이에요" : place.dir ? `${place.project} 프로젝트 ${place.dir}/.env의 시크릿이에요` : `${place.project} 프로젝트의 시크릿이에요`;
  const text = [
    `\`${name}\`: ${where}.`,
    service ? `${service} 키로 보여요.` : "",
    publicPrefix(name) ? "공개 접두사라 빌드하면 브라우저에 그대로 드러나요." : "",
    place.dir ? `${place.dir}에서 실행하는 도구는 그 .env로 읽고, 같은 이름이 더 위에 없으면 $${name}로도 들어가요.` : `명령에서는 $${name}로 써요.`,
  ]
    .filter(Boolean)
    .join(" ");
  const keys = [name, name.toLowerCase(), "시크릿", "secret", "env", "API 키", ...(service ? [service] : [])];
  return { text, keys, about: ["시크릿", ...(service ? [service] : [])] };
}

export const pieceKey = (project: string | undefined, item: string) => `secret:${project ?? "*"}/${item}`;

const split = (item: string) => {
  const i = item.lastIndexOf(":");
  return i < 0 ? { dir: "", name: item } : { dir: item.slice(0, i), name: item.slice(i + 1) };
};

/** Every saved secret gets its piece once (a piece already made, or replaced by a better one, is left alone). */
export function noteSecrets(saved: SavedSecrets, projects: { id: string; name: string; folder: string; space: string }[]): number {
  let made = 0;
  const has = new Set((state.memory ?? []).map((m) => m.key).filter(Boolean));
  const add = (project: string | undefined, item: string, scope: Memory["scope"], opts: { project?: string; space?: string; where?: string }) => {
    const key = pieceKey(project, item);
    if (has.has(key)) return;
    const { dir, name } = split(item);
    const p = secretPiece(name, { project: opts.where, dir });
    if (addMemory(p.text, scope, { key, keys: p.keys, about: p.about, kind: "fact", importance: 2, by: "agent", project: opts.project, space: opts.space, quiet: true })) made++;
  };
  for (const name of saved.global) add(undefined, name, "global", {});
  for (const [id, items] of Object.entries(saved.projects)) {
    const p = projects.find((x) => x.id === id);
    if (!p) continue;
    for (const item of items) add(id, item, "project", { project: p.folder, space: p.space, where: p.name });
  }
  return made;
}

/** A deleted secret's pieces go: the first one, and what replaced it (kept as history). */
export function forgetSecret(project: string | undefined, item: string) {
  const first = (state.memory ?? []).find((m) => m.key === pieceKey(project, item));
  if (!first) return;
  let next = first.supersededBy;
  const seen = new Set<string>();
  while (next && !seen.has(next)) {
    seen.add(next);
    const m = state.memory.find((x) => x.id === next);
    if (!m) break;
    if (isLive(m)) retireMemory(m.id, undefined, "시크릿을 지웠어요");
    next = m.supersededBy;
  }
  removeMemory(first.id);
}
