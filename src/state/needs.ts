// What a job needs from the user: the bucket the sidebar, 내 차례, ⌘. and the board sort by.
import { discarded } from "./progress";
import { kidsOf } from "./store";
import type { Task } from "./types";

export type Bucket = "you" | "failed" | "review" | "work" | "done";

/** What a job needs from you. A subagent waiting on you pulls its job up.
 *  Failed is its own bucket: never counted or shown as 응답 필요. */
export function bucket(t: Task): Bucket {
  // its changes were thrown away: nothing left to do or look at
  if (discarded(t)) return "done";
  const kids = kidsOf(t.id);
  if (t.status === "waiting" || kids.some((k) => k.status === "waiting")) return "you";
  // a subagent that failed under a job that has finished anyway needs nothing from you
  if (t.status === "failed" || (t.status !== "done" && kids.some((k) => k.status === "failed"))) return "failed";
  if (t.status === "done") return awaitsMerge(t) ? "review" : "done";
  return "work";
}
/** 병합 필요: finished, its branch still here, not left as it is, not in a pull request */
export const awaitsMerge = (t: Task) => t.status === "done" && t.worktree?.state === "open" && !t.worktree.kept && !t.worktree.pr;
/** needs you: a reply, a failure to look at, or a merge (내 차례). One the user put away (보관) doesn't:
 *  the count, ⌘. and the click on 내 차례 with one waiting all go by this. */
export const needsYou = (t: Task) => !t.archived && !t.agent && (bucket(t) === "you" || bucket(t) === "failed" || bucket(t) === "review");
