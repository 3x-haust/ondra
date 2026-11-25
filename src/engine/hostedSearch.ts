// A search the model's own provider ran (the built-in web_search of a Claude or Codex account,
// see PI_HOSTED_WEB_SEARCH): it comes inside the model's message, not as a tool of ours. Turned
// into the engine's tool events, a job and main show it like any other step ("웹에서 찾는 중").

/** The tool events a hosted search stands for. Claude sends the call and then its result; Codex only
 *  the call, so a search still open when the message ends ends with it. `open` is the caller's own. */
export function hostedToolEvents(ev: any, open: Set<string>): any[] {
  if (ev?.type === "message_update" && ev.assistantMessageEvent?.type === "servertool_end") {
    const st = ev.assistantMessageEvent.serverTool;
    if (!st?.id || st.name !== "web_search") return [];
    const toolCallId = `srv:${st.id}`;
    if (st.phase === "call" && !open.has(toolCallId)) {
      open.add(toolCallId);
      return [{ type: "tool_execution_start", toolName: "web_search", toolCallId, args: { query: String(st.input?.query ?? "") } }];
    }
    if (st.phase === "result" && open.delete(toolCallId)) return [{ type: "tool_execution_end", toolCallId, isError: !!st.errorCode }];
    return [];
  }
  if (ev?.type === "message_end" && open.size) {
    const out = [...open].map((toolCallId) => ({ type: "tool_execution_end", toolCallId, isError: false }));
    open.clear();
    return out;
  }
  return [];
}
