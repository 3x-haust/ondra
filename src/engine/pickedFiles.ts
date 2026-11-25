// Local file selections belong to the task they were sent to (or the jobs main
// routes that message to). The transcript is display text, not proof of selection.
import { farReal } from "../lib/native";
import { setState, updateTask } from "../state/store";
import type { PickedFile } from "../state/types";
import { normPath, realPath } from "./farPaths";
import { engine } from "./rpc";

export async function rememberPickedFiles(kind: "task" | "main", id: string, files?: readonly string[]) {
  if (!id || !files?.length) return;
  const home = engine.info.home;
  const paths = files.flatMap((f) => normPath(f, home) ?? []);
  // A missing file doesn't prevent sending the user's local message, but can't be shared.
  const resolved = await farReal(paths).catch(() => []);
  const picks = paths.flatMap((path, i) => {
    const real = realPath(resolved[i], home);
    return real ? [{ path, real }] : [];
  });
  if (!picks.length) return;
  const merge = (old: PickedFile[] = []) => [...old.filter((f) => !picks.some((n) => n.path === f.path)), ...picks];
  if (kind === "task") updateTask(id, (t) => { if (!t.host) t.pickedFiles = merge(t.pickedFiles); });
  else setState("captain", (m) => m.id === id, "pickedFiles", merge);
}
