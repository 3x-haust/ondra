// A job as a small chip under the main reply that started it.
import type { Task } from "../state/types";
import { openTask } from "../state/ui";
import { ago, compact, now } from "../ui/bits";
import { StatusIcon } from "../ui/ForkCard";
import { t as tr } from "../i18n";

export function since(t: Task) {
  if (t.status === "done") return ago(t.finishedAt ?? t.createdAt);
  if (t.status === "queued") return tr("대기");
  return t.startedAt ? compact(now() - t.startedAt) : "";
}

export function BranchChip(props: { t: Task; active?: boolean }) {
  return (
    <button class="br-chip" classList={{ active: props.active }} onClick={() => openTask(props.t.id)}>
      <StatusIcon t={props.t} size="sm" />
      <span class="br-chip-title">{props.t.title}</span>
      <span class="br-chip-meta">{props.t.status === "waiting" ? tr("응답 필요") : since(props.t)}</span>
    </button>
  );
}
