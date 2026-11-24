// Every lucide icon's elements by name, in one lazily loaded chunk (see icons.ts).
import type { IconNode } from "./icons";

const files = import.meta.glob<{ name: string; node: IconNode }>(["/node_modules/lucide-solid/dist/esm/icons/*.mjs", "!/node_modules/lucide-solid/dist/esm/icons/index.mjs"], { eager: true, import: "__iconData" });

export const ICONS: Record<string, IconNode> = Object.fromEntries(Object.values(files).filter((d) => d?.name && d.node).map((d) => [d.name, d.node]));
