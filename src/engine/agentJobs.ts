// The Discord agent's jobs as the device holding its Discord connection sees them: its own, and the
// ones it started on a connected device (that device's workspace), kept here as that device sends
// them (state/mirror.ts). What Discord needs about a job (its room, thread, head line…) lives on the
// job; for one on another device it is set here at once and stored there (its "agentJob" call), so
// the next copy that device sends keeps it.
import { mirroredDecisions } from "../state/mirror";
import { allTasks, setState, state, taskById } from "../state/store";
import type { Decision, Task } from "../state/types";
import { askHost } from "./hosts";

type JobAgent = NonNullable<Task["agent"]>;
/** what may be set on a job of another device's: where it shows on Discord, never whose it is */
export const AGENT_JOB_KEYS = ["room", "quiet", "shots", "thread", "threadIn", "threadClosed", "head", "folded"] as const;

/** set here for another device's job and not yet in the copy it sent back */
const pending = new Map<string, Partial<JobAgent>>();

/** a job's Discord side: its own, with what was set here for one of another device's on top */
export function jobAgent(t: Task | undefined): Task["agent"] {
  if (!t?.agent) return t?.agent;
  const mine = t.host ? pending.get(t.id) : undefined;
  if (!mine) return t.agent;
  // that device has it now: its copy is the one to go by
  if (Object.entries(mine).every(([k, v]) => t.agent![k as keyof JobAgent] === v)) {
    pending.delete(t.id);
    return t.agent;
  }
  return { ...t.agent, ...mine };
}

export function setJobAgent(id: string, patch: Partial<JobAgent>) {
  const t = taskById(id);
  if (!t) return;
  if (!t.host) return void setState("tasks", (x) => x.id === id, "agent", (a) => ({ ...(a ?? {}), ...patch }));
  pending.set(id, { ...pending.get(id), ...patch });
  void askHost(t.host, "agentJob", [id, patch]).catch(() => {});
}

/** the agent's jobs, here and on the connected devices (subagents too) */
export const agentTasks = (): Task[] => allTasks().filter((t) => !!t.agent);

/** the questions of jobs, here and those of its jobs on the connected devices (not another device's main) */
export const jobDecisions = (): Decision[] => [...state.decisions, ...mirroredDecisions().filter((d) => !d.taskId.startsWith("main:"))];
export const decisionById = (id: string) => jobDecisions().find((d) => d.id === id);
