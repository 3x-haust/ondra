// What to ask next, written by the model from the work actually going on in a
// space (or one project): unmerged branches, jobs that stopped, next steps of
// what just finished. Kept for a few hours so the empty screen opens instantly.
import { createSignal } from "solid-js";
import { projectById, projectsIn, setState, spaceById, state } from "../state/store";
import { lang, langName } from "../i18n";
import type { SpaceId } from "../state/types";
import { oneShot } from "./aside";
import { readFences } from "./fences";

const FRESH_MS = 3 * 60 * 60_000;
const [loading, setLoading] = createSignal<string | null>(null);
export const suggestLoading = loading;

export const suggestionsFor = (key: string) => state.suggest?.[key]?.items ?? [];

function picture(space: SpaceId, project?: string): string {
  const jobs = state.tasks
    .filter((t) => t.space === space && !t.parentId && !t.answer && (!project || t.project === project))
    .sort((a, b) => (b.finishedAt ?? b.startedAt ?? b.createdAt) - (a.finishedAt ?? a.startedAt ?? a.createdAt))
    .slice(0, 18)
    .map((t) => {
      const branch = t.worktree?.state === "open" ? " · 합치지 않은 브랜치" : "";
      return `- ${t.title} | ${t.status}${branch} | ${projectById(t.project)?.name ?? t.topic} | ${(t.summary || t.error || t.now || "").slice(0, 160)}`;
    });
  const asks = state.captain
    .filter((m) => m.space === space && m.from === "me" && (!project || m.project === project))
    .slice(-10)
    .map((m) => `- ${(m.text ?? "").slice(0, 160)}`);
  const projects = projectsIn(space).map((p) => `- ${p.name} (${p.folder})`);
  return [
    `# Space: ${spaceById(space).label}${project ? ` · project ${projectById(project)?.name}` : ""}`,
    "# Projects",
    ...(projects.length ? projects : ["(none)"]),
    "# Recent jobs (newest first)",
    ...(jobs.length ? jobs : ["(none)"]),
    "# What the user asked lately",
    ...(asks.length ? asks : ["(none)"]),
  ].join("\n");
}

/** Make new suggestions if the kept ones are old (or forced). */
export async function refreshSuggestions(space: SpaceId, project?: string, force = false) {
  const key = project ? `${space}~${project}` : space;
  const have = state.suggest?.[key];
  if (loading() === key || (!force && have && Date.now() - have.at < FRESH_MS)) return;
  if (!state.tasks.some((t) => t.space === space) && !state.captain.some((m) => m.space === space)) return;
  setLoading(key);
  try {
    const raw = await oneShot(
      space,
      projectById(project)?.folder ?? spaceById(space).folder,
      [
        "Suggest 4 things this user would likely ask their agents next, based only on the work below.",
        "Prefer concrete follow-ups of real items: review or merge a branch that is waiting, retry what failed, the next step after what finished, a check that was skipped.",
        `Each is one short ${langName()} request the user could send as is${lang() === "en" ? "" : ", ending like '~해 줘'"}. Name the actual project or job. No generic ideas, no greetings.`,
        `Reply with only a fenced block:\n\`\`\`suggest\n[{"text": "...", "why": "3-8 words, ${langName()}"}]\n\`\`\``,
        "",
        picture(space, project),
      ].join("\n"),
    );
    const items = (readFences(raw, "suggest").items.flat() as { text?: string; why?: string }[])
      .filter((x) => typeof x?.text === "string" && x.text.trim())
      .slice(0, 4)
      .map((x) => ({ text: x.text!.trim(), why: String(x.why ?? "").trim() }));
    if (items.length) setState("suggest", (s) => ({ ...(s ?? {}), [key]: { at: Date.now(), items } }));
  } catch {
    /* keep the old ones */
  } finally {
    setLoading(null);
  }
}
