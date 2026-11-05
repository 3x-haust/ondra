// Official logos for services and tools (simple-icons, CC0; marks belong to their
// owners). Only the ones below are bundled. Names are matched loosely: "Postgres",
// "pg", "postgresql" all find the same logo; nothing found → no logo.
import { Show } from "solid-js";
import {
  siAndroid, siAnthropic, siApachekafka, siApple, siAmazondynamodb, siAmazons3, siAmazonsqs, siBun, siClaude, siCloudflare, siDeno, siDiscord, siDjango,
  siDocker, siDrizzle, siElasticsearch, siElectron, siExpo, siExpress, siFastapi, siFigma, siFirebase, siFlutter, siGithub, siGithubactions, siGithubcopilot,
  siGo, siGooglecloud, siGooglegemini, siGrafana, siGraphql, siHono, siHuggingface, siJavascript, siKotlin, siKubernetes, siLinear, siMeta, siMongodb,
  siMysql, siNextdotjs, siNginx, siNodedotjs, siNotion, siOllama, siOpenai, siPlanetscale, siPostgresql, siPrisma, siPrometheus, siPython, siRabbitmq,
  siReact, siRedis, siRust, siSentry, siSlack, siSolid, siSqlite, siStripe, siSupabase, siSvelte, siSwift, siTailwindcss, siTauri, siTerraform, siTurso,
  siTypescript, siVercel, siVite, siVuedotjs, siAwslambda,
  type SimpleIcon,
} from "simple-icons";

const ALL: SimpleIcon[] = [
  siAndroid, siAnthropic, siApachekafka, siApple, siAmazondynamodb, siAmazons3, siAmazonsqs, siBun, siClaude, siCloudflare, siDeno, siDiscord, siDjango,
  siDocker, siDrizzle, siElasticsearch, siElectron, siExpo, siExpress, siFastapi, siFigma, siFirebase, siFlutter, siGithub, siGithubactions, siGithubcopilot,
  siGo, siGooglecloud, siGooglegemini, siGrafana, siGraphql, siHono, siHuggingface, siJavascript, siKotlin, siKubernetes, siLinear, siMeta, siMongodb,
  siMysql, siNextdotjs, siNginx, siNodedotjs, siNotion, siOllama, siOpenai, siPlanetscale, siPostgresql, siPrisma, siPrometheus, siPython, siRabbitmq,
  siReact, siRedis, siRust, siSentry, siSlack, siSolid, siSqlite, siStripe, siSupabase, siSvelte, siSwift, siTailwindcss, siTauri, siTerraform, siTurso,
  siTypescript, siVercel, siVite, siVuedotjs, siAwslambda,
];
const BY_SLUG = new Map(ALL.map((i) => [i.slug, i]));

/** other names people use → simple-icons slug */
const ALIAS: Record<string, string> = {
  postgres: "postgresql", pg: "postgresql", psql: "postgresql",
  k8s: "kubernetes", kube: "kubernetes",
  next: "nextdotjs", nextjs: "nextdotjs", node: "nodedotjs", nodejs: "nodedotjs", vue: "vuedotjs", vuejs: "vuedotjs",
  ts: "typescript", js: "javascript", golang: "go", solidjs: "solid", tailwind: "tailwindcss",
  kafka: "apachekafka", s3: "amazons3", sqs: "amazonsqs", dynamodb: "amazondynamodb", dynamo: "amazondynamodb", lambda: "awslambda",
  gcp: "googlecloud", gemini: "googlegemini", google: "googlegemini", copilot: "githubcopilot", "github-copilot": "githubcopilot",
  chatgpt: "openai", codex: "openai", "openai-codex": "openai", gpt: "openai",
  elastic: "elasticsearch", es: "elasticsearch", rabbit: "rabbitmq", mongo: "mongodb", gh: "github", actions: "githubactions",
};

const key = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9-]+/g, "").trim();

/** the logo for a service / tool name, if we have it */
export function logoFor(name?: string): SimpleIcon | undefined {
  if (!name) return undefined;
  const k = key(name);
  const direct = BY_SLUG.get(ALIAS[k] ?? k) ?? BY_SLUG.get(k.replace(/-/g, ""));
  if (direct) return direct;
  // "order-api (Node)" or "Postgres 16": try each word
  for (const w of name.toLowerCase().split(/[\s/·,()]+/)) {
    const kw = key(w);
    const hit = kw.length >= 2 && (BY_SLUG.get(ALIAS[kw] ?? kw) ?? undefined);
    if (hit) return hit;
  }
  return undefined;
}

/** dark marks (OpenAI, GitHub, Vercel…) would vanish on a dark screen: those take the text colour */
const dark = (hex: string) => {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 70;
};

export function Logo(props: { name?: string; icon?: SimpleIcon; size?: number; mono?: boolean; class?: string }) {
  const icon = () => props.icon ?? logoFor(props.name);
  return (
    <Show when={icon()}>
      {(i) => (
        <svg
          class={`logo ${props.class ?? ""}`}
          viewBox="0 0 24 24"
          width={props.size ?? 14}
          height={props.size ?? 14}
          role="img"
          aria-label={i().title}
          style={{ color: props.mono || dark(i().hex) ? "currentColor" : `#${i().hex}`, "flex-shrink": 0 }}
        >
          <path d={i().path} fill="currentColor" />
        </svg>
      )}
    </Show>
  );
}

/** in SVG diagrams: the path and colour only (placed by the caller) */
export function logoPath(name?: string): { d: string; color: string } | undefined {
  const i = logoFor(name);
  return i ? { d: i.path, color: dark(i.hex) ? "var(--ink)" : `#${i.hex}` } : undefined;
}
