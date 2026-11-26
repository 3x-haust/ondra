// Which part of a workspace's agent view is open (대화 · 작업 · 루틴 · 기억), kept per workspace.
// Its own module so a routine card elsewhere can open the agent's routines without importing the view.
import { state } from "../state/store";
import { inSpace, kept } from "../state/viewState";

export type AgentPart = "talk" | "work" | "routines" | "memory";
// each workspace's agent opens on the part it was left on
export const [agentPart, setAgentPart] = kept<AgentPart>(() => inSpace(state.space, "agent.part"), "talk");
