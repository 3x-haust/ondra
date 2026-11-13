/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog project key for usage numbers and feedback (lib/telemetry.ts); none = nothing is sent */
  readonly VITE_POSTHOG_KEY?: string;
  /** the PostHog API survey that feedback lands in */
  readonly VITE_POSTHOG_SURVEY?: string;
}

/** every simple-icons logo, loaded on demand (scripts/simple-icons-all.mjs) */
declare module "virtual:simple-icons-all" {
  /** slug, title, hex colour, other names, shard */
  export const icons: [string, string, string, string[], number][];
  export const shards: (() => Promise<{ default: Record<string, string> }>)[];
}
