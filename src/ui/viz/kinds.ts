// Every registered kind, by family. Pure (no JSX) so types and tests can read it.
// A family keeps `export const KINDS = [...] as const` in ./<family>/kinds.ts and adds
// itself to FAMILY_KINDS and to VizKind below.
import { KINDS as CHART } from "./chart/kinds";
import { KINDS as RELATION } from "./relation/kinds";
import { KINDS as SLIDE } from "./slide/kinds";
import { KINDS as STAT } from "./stat/kinds";

export const FAMILY_KINDS: Record<string, readonly string[]> = { chart: CHART, stat: STAT, relation: RELATION, slide: SLIDE };
export type VizKind = (typeof CHART)[number] | (typeof STAT)[number] | (typeof RELATION)[number] | (typeof SLIDE)[number];
