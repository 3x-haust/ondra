// A workspace's terminal command ("work"): typed in the user's own terminal, it opens a shell with
// that space's logins (gh, git, ssh, cloud CLIs, claude and codex configs), as its jobs have them,
// and the user's own shell otherwise; `exit` goes back. Ondra makes it with the space (no setup by
// the user) and keeps it in step; the user only picks the space's CLI home folder and may rename it.
import { spaceCliInstall, spaceCliRemove } from "../lib/native";
import { setState, state } from "../state/store";
import type { Space } from "../state/types";

/** "Client Work" → "client-work"; a name with no latin letters gives "" */
export const commandOf = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 32);

/** the names to try for a space without one: its name in latin letters, then work, work2 … */
export function candidates(s: Space, taken: string[]): string[] {
  const own = commandOf(s.label);
  const list = [own, "work", ...Array.from({ length: 8 }, (_, i) => `work${i + 2}`)].filter(Boolean);
  return [...new Set(list)].filter((c) => !taken.includes(c));
}

const owned = (s: Space) => s.id !== "home" && !s.only && !s.host;

/**
 * Make (or refresh) the space's command. Without a name yet, the first free one is taken; a name
 * the Mac already has (a command of its own, the user's own "work") is skipped. The error of a
 * name the user typed comes back.
 */
export async function installCommand(s: Space, wanted?: string): Promise<{ command?: string; error?: string; offPath?: boolean }> {
  if (!owned(s)) return {};
  const taken = state.spaces.filter((x) => x.id !== s.id && x.command).map((x) => x.command!);
  const tries = wanted !== undefined ? [wanted.trim()] : s.command ? [s.command] : candidates(s, taken);
  if (wanted !== undefined && taken.includes(wanted.trim())) return { error: "다른 워크스페이스가 쓰는 이름이에요" };
  let error: string | undefined;
  for (const command of tries) {
    try {
      const r = await spaceCliInstall(s, command, s.command);
      if (s.command !== command) setState("spaces", (x) => x.id === s.id, "command", command);
      return { command, offPath: r.off_path };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { error };
}

/** Every workspace has its command, up to date with its folders (run at start). */
export async function ensureCommands(): Promise<void> {
  for (const s of state.spaces.filter(owned)) {
    // a space on the user's own CLI setup ("…/home" with its own launcher) gets one only when named
    if (!s.command && s.cliHome?.trim()) continue;
    await installCommand(s).catch(() => undefined);
  }
}

/** a removed space's command goes with it */
export const removeCommand = (s: Space) => (s.command ? spaceCliRemove(s.command) : Promise.resolve());
