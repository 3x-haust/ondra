/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog project key for usage numbers and feedback (lib/telemetry.ts); none = nothing is sent */
  readonly VITE_POSTHOG_KEY?: string;
  /** the PostHog API survey that feedback lands in */
  readonly VITE_POSTHOG_SURVEY?: string;
}
