import { mirrorPath, windowsHome } from "./farPaths";

/** The snapshot and its incremental patches use the same path spelling. Only the copy sent
 * to the viewer changes; the local job, its tool input and the text it runs with do not. */
export function mirrorReplacer(home: string) {
  if (!windowsHome(home)) return undefined;
  const path = (p: string) => mirrorPath(p, home);
  return function (this: { kind?: string }, key: string, value: unknown) {
    if (typeof value !== "string") return value;
    if (/^(cwd|path|repo|shot|image|ref|beforeImage|afterImage)$/.test(key)) return path(value);
    if (key === "sub") return value.replace(/\\/g, "/");
    if (key === "detail" && (this.kind === "write" || this.kind === "edit")) return value.replace(/^[^\n]+/, path);
    if (key !== "text") return value;
    // The old renderer recognizes slash paths in Markdown links and Composer's attachment list.
    return value.replace(/(\]\(<?)([^\n)<>]+)(>?\))/g, (_, open, target, close) => open + path(target) + close)
      .replace(/^(- (?:\[Image #\d+\] )?)([^\n]+)$/gm, (_, bullet, target) => bullet + path(target));
  };
}
