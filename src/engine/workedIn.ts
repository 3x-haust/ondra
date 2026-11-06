// Where a job really did its git work: the repo it committed or pushed in and the
// branch, read from its commands. A job may make its own worktree or work in
// another repo than the one it was started in; main should know which.
import type { Task } from "../state/types";

const unquote = (s: string) => s.replace(/^["']|["']$/g, "");
/** a plain path (no variables or globs) */
const plain = (p?: string) => (p && !/[$*`]/.test(p) ? unquote(p) : undefined);

export function workedIn(t: Pick<Task, "entries">): { repo?: string; branch?: string } {
  let repo: string | undefined;
  let branch: string | undefined;
  for (const e of t.entries) {
    if (e.kind !== "tool" || !["bash", "test"].includes(e.tool.kind) || e.tool.ok === false) continue;
    const cmd = e.tool.detail ?? e.tool.target ?? "";
    if (!/\bgit\b/.test(cmd)) continue;
    let here: string | undefined;
    for (const raw of cmd.split(/&&|\|\||;|\n/)) {
      const part = raw.trim();
      const cd = part.match(/^cd\s+("[^"]+"|'[^']+'|\S+)/);
      if (cd) {
        here = plain(cd[1]);
        continue;
      }
      const git = part.match(/^git\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?(.*)$/);
      if (!git) continue;
      const dir = plain(git[1]) ?? here;
      const rest = git[2];
      const wt = rest.match(/^worktree\s+add\s+(?:(?:-q|--quiet|-f|--force)\s+)*(?:-[bB]\s+(\S+)\s+)?(?:(?:-q|--quiet|-f|--force)\s+)*("[^"]+"|'[^']+'|\S+)/);
      if (wt) {
        if (wt[1]) branch = wt[1];
        const path = plain(wt[2]);
        if (path && !path.startsWith("-")) repo = path.startsWith("/") || path.startsWith("~") || !dir ? path : `${dir.replace(/\/$/, "")}/${path}`;
        continue;
      }
      const nb = rest.match(/^(?:checkout\s+-[bB]|switch\s+-[cC])\s+(\S+)/);
      if (nb) {
        branch = nb[1];
        if (dir) repo = dir;
        continue;
      }
      if (/^commit\b/.test(rest) && dir) repo = dir;
      const push = rest.match(/^push\b(.*)$/);
      if (push) {
        if (dir) repo = dir;
        const args = push[1].split(/\s+/).filter((a) => a && !a.startsWith("-"));
        const ref = args[1];
        if (ref && !/[$]/.test(ref)) branch = ref.includes(":") ? ref.split(":").pop() : ref;
      }
    }
  }
  return { repo, branch: branch?.replace(/^refs\/heads\//, "") };
}
