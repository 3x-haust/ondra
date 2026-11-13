// What each job left in its artifacts folder (pages, pictures, recordings).
import { createStore } from "solid-js/store";
import type { ArtifactFile } from "../lib/native";
import { artifactsOf } from "../engine/far";
import { taskById } from "./store";

const [artifacts, setArtifacts] = createStore<Record<string, ArtifactFile[]>>({});
export { artifacts };

/** Pages and pictures the job wrote somewhere else (a docs folder, the repo). */
function written(taskId: string): ArtifactFile[] {
  const t = taskById(taskId);
  if (!t) return [];
  const seen = new Map<string, ArtifactFile>();
  for (const e of t.entries) {
    if (e.kind !== "tool" || (e.tool.kind !== "write" && e.tool.kind !== "edit") || e.tool.ok === false) continue;
    const path = (e.tool.detail ?? "").split("\n")[0].trim();
    if (!path.startsWith("/") || !/\.(html?|pdf|svg|png|jpe?g|gif|webp)$/i.test(path)) continue;
    seen.set(path, { path, name: path.split("/").pop()!, size: 0, modified: e.tool.endedAt ?? e.at });
  }
  return [...seen.values()];
}

/** What a person opens and reads: pages, pictures, recordings, documents, builds. Not data or logs. */
export const forPeople = (name: string) =>
  /\.(html?|pdf|svg|png|jpe?g|gif|webp|heic|mp4|mov|webm|m4a|mp3|wav|md|csv|docx?|xlsx?|pptx?|key|pages|numbers|zip|dmg|apk|aab|ipa)$/i.test(name);

export async function loadArtifacts(taskId: string) {
  // a job of another Mac: what it left there
  const own = (await artifactsOf(taskById(taskId)?.host, taskId).catch(() => [])).filter((f) => forPeople(f.name));
  const list = [...own, ...written(taskId).filter((w) => !own.some((o) => o.path === w.path))].sort((a, b) => b.modified - a.modified);
  const now = artifacts[taskId] ?? [];
  if (list.length !== now.length || list[0]?.modified !== now[0]?.modified) setArtifacts(taskId, list);
}

export const kindOf = (name: string) =>
  /\.(html?|pdf|svg)$/i.test(name) ? "page" : /\.(png|jpe?g|gif|webp)$/i.test(name) ? "image" : /\.(mp4|mov|webm)$/i.test(name) ? "video" : /\.(md|txt|json|csv|log)$/i.test(name) ? "text" : "file";
