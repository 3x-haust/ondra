// Every registered kind, by family. Pure (no JSX) so types and tests can read it.
// A family keeps `export const KINDS = [...] as const` in ./<family>/kinds.ts and adds
// itself to FAMILY_KINDS and to VizKind below.
import { KINDS as CHART } from "./chart/kinds";

export const FAMILY_KINDS: Record<string, readonly string[]> = { chart: CHART };
export type VizKind = (typeof CHART)[number];
