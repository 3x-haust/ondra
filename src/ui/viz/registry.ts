// Charts and figures beyond the built-in blocks. Each family file registers its
// kinds here; Blocks draws any registered kind, and the gallery shows them all.
import type { JSX } from "solid-js";

export type VizFamily = "stat" | "chart" | "relation" | "slide";

export interface VizSpec<B = any> {
  /** the block's "type" the agent writes */
  type: string;
  family: VizFamily;
  /** Korean name, shown in the gallery */
  title: string;
  /** the question it answers, one line */
  when: string;
  render: (b: B) => JSX.Element;
  /** realistic examples: drawn in the gallery and checked in tests */
  examples: B[];
}

const specs = new Map<string, VizSpec>();

export function defineViz<B>(spec: VizSpec<B>): VizSpec<B> {
  if (specs.has(spec.type)) throw new Error(`viz kind registered twice: ${spec.type}`);
  specs.set(spec.type, spec as VizSpec);
  return spec;
}
export const vizOf = (type: string): VizSpec | undefined => specs.get(type);
export const allViz = (): VizSpec[] => [...specs.values()];
