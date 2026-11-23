import { agentSend } from "../lib/native";
import { setState, state, taskById, uid } from "../state/store";
import type { Decision } from "../state/types";
import { isAlive } from "./rpc";

const replies = new Map<string, (option: string) => Promise<boolean>>();
type UiConnection = { clear(): void; close(): void; event(ev: any): void };
const connections = new Map<string, UiConnection>();

/** UI replies belong to the listener that received them, never to a later engine with the same id. */
export function extensionUi(owner: string, agent: string, live: () => boolean): UiConnection {
  connections.get(owner)?.close();
  const pending = new Map<string, ReturnType<typeof setTimeout> | undefined>();
  const tools = new Set<string>();
  function drop(id: string) {
    clearTimeout(pending.get(id));
    pending.delete(id);
    replies.delete(id);
    setState("decisions", (list) => list.filter((d) => d.id !== id));
    if (taskById(owner)?.status === "waiting" && !state.decisions.some((d) => d.taskId === owner))
      setState("tasks", (t) => t.id === owner, "status", "running");
  }
  const ui = {
    clear() {
      tools.clear();
      for (const id of pending.keys()) drop(id);
      // Restored cards have no live response callback.
      if (connections.get(owner) === ui && state.decisions.some((d) => d.taskId === owner && d.ui))
        setState("decisions", (list) => list.filter((d) => d.taskId !== owner || !d.ui));
    },
    close() {
      ui.clear();
      if (connections.get(owner) === ui) connections.delete(owner);
    },
    event(ev: any) {
      if (connections.get(owner) !== ui) return;
      if (ev.type === "tool_execution_start") tools.add(ev.toolCallId);
      if (ev.type === "tool_execution_end") tools.delete(ev.toolCallId);
      // RPC has no dialog-cancel event. Once its tools end, no dialog from them is still live.
      if ((ev.type === "tool_execution_end" && !tools.size) || ev.type === "agent_settled") ui.clear();
      if (ev.type !== "extension_ui_request" || !["confirm", "select", "input"].includes(ev.method)) return;
      const d: Decision = {
        id: uid("d"), taskId: owner, at: Date.now(), kind: "ask",
        question: [ev.title, ev.message].filter(Boolean).join(" — ") || "확인 필요",
        options: ev.method === "confirm"
          ? [{ id: "yes", label: "허용", primary: true }, { id: "no", label: "거부" }]
          : ev.method === "select"
            ? (ev.options ?? []).map((o: string, i: number) => ({ id: o, label: o, primary: i === 0 }))
            : [{ id: "cancel", label: "취소" }],
        context: [], ui: { requestId: ev.id, method: ev.method },
      };
      const expires = typeof ev.timeout === "number" ? d.at + ev.timeout : undefined;
      pending.set(d.id, expires === undefined ? undefined : setTimeout(() => drop(d.id), ev.timeout));
      replies.set(d.id, async (option) => {
        drop(d.id);
        if (connections.get(owner) !== ui || !isAlive(agent) || !live() || (expires !== undefined && Date.now() >= expires)) return false;
        await agentSend(agent, {
          type: "extension_ui_response", id: ev.id,
          ...(ev.method === "confirm" ? { confirmed: option === "yes" }
            : ev.method === "select" ? { value: option } : { cancelled: true }),
        });
        return true;
      });
      setState("decisions", (list) => [...list, d]);
      if (taskById(owner)) setState("tasks", (t) => t.id === owner, { status: "waiting", unread: true });
    },
  };
  connections.set(owner, ui);
  return ui;
}

export const clearExtensionUi = (owner: string) => connections.get(owner)?.clear();
export const answerExtensionUi = (d: Decision, option: string): Promise<boolean> => replies.get(d.id)?.(option) ?? Promise.resolve(false);
