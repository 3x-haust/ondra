import { normPath, windowsHome } from "./farPaths";

/** A native path from the engine, not a path in the remote wire format. */
export const slashes = (path: string) => windowsHome(path) ? path.replace(/\\/g, "/") : path;
export const leaf = (path: string) => slashes(path).split("/").pop() ?? "";
export const folderKey = (path: string) => (windowsHome(path) ? slashes(path).toLowerCase() : path).replace(/\/+$/, "");
export const absoluteFolder = (path: unknown, home: string): path is string => typeof path === "string" && (
  windowsHome(home) ? windowsHome(path) && !!normPath(path, home) : path.startsWith("/")
);

/** The same ancestor walk as on the Mac, stopping before the drive or share root. */
export function instructionFolders(dir: string): string[] {
  const path = slashes(dir).replace(/\/+$/, "");
  const root = /^(?:[A-Za-z]:|\/\/[^/]+\/[^/]+)(?=\/|$)/.exec(path)?.[0] ?? "";
  const out: string[] = [];
  for (let d = path; d.length > root.length;) {
    out.push(d);
    const slash = d.lastIndexOf("/");
    if (slash <= root.length) break;
    d = d.slice(0, slash);
  }
  return out;
}
