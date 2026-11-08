// A job as a small chip under the main reply that started it.
import type { Task } from "../state/types";
import { openTask } from "../state/ui";
import { ago, compact, now } from "../ui/bits";
import { bucket, Glyph } from "./Sidebar";
import { discarded } from "../state/progress";
import { t as tr } from "../i18n";

export function since(t: Task) {
  if (discarded(t)) return tr("버림");
  if (t.status === "failed") return tr("실패");
  if (bucket(t) === "review") return tr("검토");
  // when it ended: merged, when it was merged
  if (t.status === "done") return ago((t.worktree?.state === "merged" ? t.mergedAt : undefined) ?? t.finishedAt ?? t.createdAt);
  if (t.status === "queued") return tr("대기");
  if (t.status === "paused") return tr("일시정지");
  return t.startedAt ? compact(now() - t.startedAt) : "";
}

export function BranchChip(props: { t: Task; active?: boolean }) {
  return (
    <button class="br-chip" classList={{ active: props.active, "m-review": bucket(props.t) === "review" }} onClick={() => openTask(props.t.id)}>
      <Glyph t={props.t} />
      <span class="br-chip-title">{props.t.title}</span>
      <span class="br-chip-meta" classList={{ review: props.t.status === "done" && props.t.worktree?.state === "open", discarded: discarded(props.t) }}>{props.t.status === "waiting" ? tr("응답 필요") : since(props.t)}</span>
    </button>
  );
}
