// Every registered kind, by family. Pure (no JSX) so types and tests can read it.
// A family keeps `export const KINDS = [...] as const` in ./<family>/kinds.ts and adds
// itself to FAMILY_KINDS and to VizKind below.
export const FAMILY_KINDS: Record<string, readonly string[]> = {};
// "viz.none" keeps the union non-empty until a family is added (it never matches a block)
export type VizKind = "viz.none";
