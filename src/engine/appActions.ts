// What the user can press in Ondra, main and a job can do too (the `ondra_app` tool,
// extensions/ondra.ts → bridge "app"): each button-only feature is an action here, by name, with
// where it is in the app. Settings the user switches are ondra_settings (appSettings.ts); connected
// services are `services`. A new button-only feature gets its action here (docs/DESIGN.md §9.17).
//
// Kept for the user alone: letting another device in (its pairing ask) and secret values. A job or
// main acts in its own workspace: its jobs and projects, never another workspace's.
import { pathsExist } from "../lib/native";
import { addProject, inOrder, moveProject, projectsIn, projectsShown, removeProject, renameProject, setState, state, taskById, uid, ownSpaces } from "../state/store";
import type { SpaceId, Task } from "../state/types";
import { mirror } from "../state/mirror";
import { goMain, openTask, setView, type SettingsTab } from "../state/ui";
import { switchSpace } from "../state/workspace";
import { callerOf, visibleJobs, type Caller } from "./jobs";
import { expand } from "./rpc";

type Args = Record<string, unknown>;
interface Action {
  /** where it is in the app, as the user sees it */
  where: string;
  /** what it does, for the model */
  about: string;
  /** what it takes: name → what it is ("?" after the name: optional) */
  takes?: Record<string, string>;
  run: (a: Args, who: Caller) => unknown | Promise<unknown>;
}

const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
const fail = (error: string) => ({ error });

/** one of the caller's jobs, by id */
function jobOf(who: Caller, a: Args): Task | { error: string } {
  const id = str(a, "id");
  const t = id ? taskById(id) : undefined;
  if (!t || t.parentId || !visibleJobs(who).includes(t) || t.space !== who.space) return fail(`no job ${id} in this workspace (find it with jobs_search)`);
  return t;
}
/** one of the caller's workspace's projects, by id or name */
function projectOf(who: Caller, a: Args) {
  const key = str(a, "id") || str(a, "name");
  const p = projectsIn(who.space).find((x) => x.id === key) ?? projectsIn(who.space).find((x) => x.name === key);
  return p ?? fail(`no project ${key} in this workspace (project.list shows them)`);
}
const isErr = (v: unknown): v is { error: string } => !!v && typeof v === "object" && "error" in v;

const remoteMod = () => import("./remote");
const hostsMod = () => import("./hosts");

export const ACTIONS: Record<string, Action> = {
  // ───────── 다른 기기 (설정 › 연결)
  "remote.status": {
    where: "설정 › 연결",
    about: "The devices connected to this Mac, both ways: each with whether this Mac is on it now (this one sends it work) and whether it is on this Mac now (it sends work here), and who is asking to connect",
    run: async () => {
      const { remote } = await remoteMod();
      const r = remote();
      const ids = [...new Set([...(state.settings.hosts ?? []).map((h) => h.id), ...r.devices.map((d) => d.id)])];
      return {
        this_mac_ready: !!r.id,
        devices: ids.map((id) => ({
          id,
          name: state.settings.hosts?.find((h) => h.id === id)?.name ?? r.devices.find((d) => d.id === id)?.name,
          using_it: state.settings.hosts?.some((h) => h.id === id) ? (mirror.hosts[id]?.status ?? "connecting") : "not yet (it connects once that device runs a newer Ondra)",
          it_uses_this: Object.values(r.live).some((l) => l.id === id) ? "connected" : r.devices.some((d) => d.id === id) ? "allowed, not connected now" : "not yet",
        })),
        asking: r.asks.map((x) => x.device.name),
        link_open: r.pair && r.pair.until > Date.now() ? `until ${new Date(r.pair.until).toLocaleTimeString()}` : undefined,
      };
    },
  },
  "remote.link": {
    where: "설정 › 연결 › 기기 추가 › 연결 링크 복사",
    about:
      "Make this Mac's connect link (ondra://connect/…, good for 10 minutes and one device) for another device or PC to connect with (there: 설정 › 연결 › 기기 추가, or remote.add on that one). When it connects, the user allows it here themselves (a card in Ondra; you can't), and then each device can use the other",
    run: async () => {
      const { connectLink } = await remoteMod();
      const link = await connectLink();
      return link ? { link, good_for: "10 minutes, one device", then: "the user allows it in Ondra on this Mac when it asks; then both can use each other" } : fail("this Mac isn't reachable yet; try again in a few seconds");
    },
  },
  "remote.add": {
    where: "설정 › 연결 › 기기 추가",
    about:
      "Use another device by its connect link: once its user allows it there, this Mac can use it. It goes one way: that device can't use this Mac by it (letting a device in is the user's: for both ways, remote.link here and the user allows it, or the user pastes the link in 설정 › 연결 › 기기 추가)",
    takes: { link: "the ondra://connect/… link from the other device" },
    run: async (a) => {
      const { addHost } = await hostsMod();
      return (await addHost(str(a, "link"), true)) ? { added: true, then: "that device's user allows it there; remote.status shows when it's connected" } : fail("that isn't a connect link (ondra://connect/<id>?code=…)");
    },
  },
  "remote.remove": {
    where: "설정 › 연결 › 기기 › 제거",
    about: "Remove a connected device, both ways (its projects and jobs go from this list, it can't use this Mac anymore, and it is told to forget this one)",
    takes: { id: "its id from remote.status devices" },
    run: async (a) => {
      const { remote, removeDevice } = await remoteMod();
      const id = str(a, "id");
      if (!(state.settings.hosts ?? []).some((h) => h.id === id) && !remote().devices.some((d) => d.id === id)) return fail(`no device ${id} connected`);
      return (await removeDevice(id)) ? { removed: id } : fail(`couldn't remove ${id}: it may still come in`);
    },
  },

  // ───────── 프로젝트 (사이드바)
  "project.list": {
    where: "사이드바 › 프로젝트",
    about: "This workspace's projects, in the sidebar's order: id, name, folder",
    run: (_a, who) => inOrder(projectsIn(who.space), state.settings.projectOrder).map((p) => ({ id: p.id, name: p.name, folder: p.folder })),
  },
  "project.add": {
    where: "사이드바 › 프로젝트 › +",
    about: "Add a folder on this Mac as a project of this workspace (its own chat; jobs there file under it)",
    takes: { folder: "an absolute or ~ path", "name?": "a shown name (default: the folder's)" },
    run: async (a, who) => {
      const folder = str(a, "folder");
      if (!folder) return fail("folder is empty");
      const [ok] = await pathsExist([expand(folder)]);
      if (!ok) return fail(`no folder ${folder}`);
      const id = addProject(who.space, folder, str(a, "name") || undefined);
      return { project: id };
    },
  },
  "project.move": {
    where: "사이드바 › 프로젝트 (끌어서 옮기기)",
    about: "Put a project at another place in the sidebar's list",
    takes: { id: "a project id or name", to: "its new place, 1 = top (a number larger than the list = bottom)" },
    run: (a, who) => {
      const p = projectOf(who, a);
      if (isErr(p)) return p;
      const to = Number(a.to);
      if (!Number.isInteger(to) || to < 1) return fail("to is a place from 1 (the top)");
      moveProject(who.space, p.id, to - 1);
      return { order: projectsShown(who.space).map((x) => x.name) };
    },
  },
  "project.rename": {
    where: "사이드바 › 프로젝트 › 더보기 › 이름 바꾸기",
    about: "Rename a project (its id and folder stay)",
    takes: { id: "a project id or name", name: "the new name" },
    run: (a, who) => {
      const p = projectOf(who, a);
      if (isErr(p)) return p;
      renameProject(p.id, str(a, "name") || p.name);
      return { renamed: p.id, now: projectsIn(who.space).find((x) => x.id === p.id)?.name };
    },
  },
  "project.remove": {
    where: "사이드바 › 프로젝트 › 더보기 › 삭제",
    about: "Take a project off the list: its jobs stay (under no project), its chat is deleted, the folder itself is untouched",
    takes: { id: "a project id or name" },
    run: (a, who) => {
      const p = projectOf(who, a);
      if (isErr(p)) return p;
      if (who.project === p.id) return fail("that is the project whose chat this is: the user removes it themselves");
      removeProject(p.id);
      return { removed: p.id };
    },
  },

  // ───────── 작업 (사이드바의 행, 작업 화면)
  "job.pin": {
    where: "사이드바 › 작업 행 › 고정",
    about: "Pin or unpin a job at the top of its list",
    takes: { id: "the job's id", "on?": "true pins (default), false unpins" },
    run: (a, who) => {
      const t = jobOf(who, a);
      if (isErr(t)) return t;
      const on = a.on !== false;
      if (!!t.pinned !== on) void import("./tasks").then((m) => m.togglePin(t.id));
      return { pinned: on };
    },
  },
  "job.archive": {
    where: "사이드바 › 작업 행 › 보관",
    about: "Archive a job (out of the list, into 보관함), or bring it back",
    takes: { id: "the job's id", "on?": "true archives (default), false brings it back" },
    run: async (a, who) => {
      const t = jobOf(who, a);
      if (isErr(t)) return t;
      (await import("./tasks")).archiveTask(t.id, a.on !== false, { quiet: true });
      return { archived: a.on !== false };
    },
  },
  "job.stop": {
    where: "작업 화면 › 멈추기",
    about: "Stop a running job (it can be resumed)",
    takes: { id: "the job's id" },
    run: async (a, who) => {
      const t = jobOf(who, a);
      if (isErr(t)) return t;
      if (who.task?.id === t.id) return fail("that is this job");
      (await import("./tasks")).stopTask(t.id);
      return { stopped: t.id };
    },
  },
  "job.resume": {
    where: "작업 화면 › 이어 하기",
    about: "Resume a stopped, paused or failed job where it left off",
    takes: { id: "the job's id" },
    run: async (a, who) => {
      const t = jobOf(who, a);
      if (isErr(t)) return t;
      (await import("./tasks")).resumeTask(t.id);
      return { resumed: t.id };
    },
  },
  "job.rename": {
    where: "작업 화면 › 제목 (두 번 클릭)",
    about: "Rename a job",
    takes: { id: "the job's id", title: "the new title" },
    run: async (a, who) => {
      const t = jobOf(who, a);
      if (isErr(t)) return t;
      (await import("./tasks")).renameTask(t.id, str(a, "title"));
      return { title: taskById(t.id)?.title };
    },
  },

  // ───────── 워크스페이스 (설정 › 계정과 워크스페이스)
  "space.list": {
    where: "사이드바 위 워크스페이스 탭",
    about: "The workspaces: id, name, folder, terminal command; which one is on screen",
    run: () => ({ on_screen: state.space, spaces: ownSpaces().map((s) => ({ id: s.id, name: s.label, folder: s.folder, command: s.command })) }),
  },
  "space.add": {
    where: "설정 › 계정과 워크스페이스 › 워크스페이스 추가",
    about: "Make a workspace (its own accounts, logins, memory and terminal command); logins in it are the user's to do",
    takes: { name: "its name", "folder?": "its folder (default ~)" },
    run: async (a) => {
      const label = str(a, "name").slice(0, 40);
      if (!label) return fail("name is empty");
      if (ownSpaces().some((s) => s.label === label)) return fail(`there is already a workspace ${label}`);
      const id = uid("sp") as SpaceId;
      setState("spaces", (l) => [...l, { id, label, folder: str(a, "folder") || "~", rules: "" }]);
      const made = state.spaces.find((s) => s.id === id)!;
      const r = await (await import("./spaceCli")).installCommand(made).catch((e) => ({ error: String(e) }) as { error: string; command?: string });
      return { space: id, ...(r.command ? { terminal: r.command } : {}), ...(r.error ? { note: r.error } : {}) };
    },
  },

  // ───────── 업데이트 (왼쪽 위 업데이트 버튼)
  "update.check": {
    where: "설정 › 일반 › 업데이트 확인",
    about: "See whether a newer Ondra is out (it downloads in the background)",
    run: async () => {
      const u = await import("./update");
      await u.checkUpdate(false);
      return { available: u.available() ?? undefined, latest: !u.available(), ready: u.updateReady() };
    },
  },
  "update.install": {
    where: "왼쪽 위 › 업데이트 › 다시 시작",
    about: "Install the newer Ondra and restart: at once when no job is working, else once they finish. This chat goes quiet for the restart",
    run: async () => {
      const u = await import("./update");
      if (!u.available()) return fail("no update (update.check first)");
      if (u.jobsWorking()) {
        u.restartWhenIdle();
        return { restart: "when the working jobs finish" };
      }
      setTimeout(() => void u.installNow(), 3000);
      return { restart: "in a few seconds" };
    },
  },

  // ───────── 화면 (보여 주기)
  open: {
    where: "어디든",
    about: "Show the user a place in the app: main, a project's chat, a job, the canvas, devices, memory, results, the agent, or a settings tab",
    takes: { to: 'main | project:<id> | job:<id> | canvas | devices | memory | results | agent | settings[:<tab>] (general, accounts, remote, services, agent, secrets, routines, skills, tools, hooks, pet, shortcuts, import, agent-tools)' },
    run: (a, who) => {
      const to = str(a, "to");
      const [kind, arg] = [to.split(":")[0], to.slice(to.indexOf(":") + 1)];
      if (who.space !== state.space) switchSpace(who.space);
      if (kind === "main") return goMain(), { shown: to };
      if (kind === "project") {
        const p = projectOf(who, { id: arg });
        return isErr(p) ? p : (goMain(p.id), { shown: to });
      }
      if (kind === "job") {
        const t = jobOf(who, { id: arg });
        return isErr(t) ? t : (openTask(t.id), { shown: to });
      }
      if (kind === "canvas") return setView({ name: "board" }), { shown: to };
      if (kind === "devices" || kind === "memory" || kind === "results" || kind === "agent") return setView({ name: kind }), { shown: to };
      if (kind === "settings") return setView({ name: "settings", ...(to.includes(":") ? { tab: arg as SettingsTab } : {}) }), { shown: to };
      return fail(`unknown place ${to}`);
    },
  },
};

/** The `ondra_app` tool: no action lists them; else the action's result, or why not. */
export async function appHands(worker: string | undefined, a: Args): Promise<unknown> {
  const who = callerOf(worker);
  if (!who) return fail("only main or a job can use the app");
  const name = str(a, "action");
  if (!name || name === "list") return { actions: Object.entries(ACTIONS).map(([id, x]) => ({ action: id, where: x.where, does: x.about, ...(x.takes ? { takes: x.takes } : {}) })) };
  const act = ACTIONS[name];
  if (!act) return fail(`no action ${name} (action "list" shows them)`);
  const args = a.args && typeof a.args === "object" ? (a.args as Args) : {};
  for (const k of Object.keys(act.takes ?? {})) if (!k.endsWith("?") && !str(args, k) && typeof args[k] !== "boolean" && typeof args[k] !== "number") return fail(`${name} takes ${k}`);
  return act.run(args, who);
}
