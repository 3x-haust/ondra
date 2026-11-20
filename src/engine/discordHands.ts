// The Discord agent's own hands on the server, for main (extensions/discord.ts → bridge op
// "discord"): which servers it is in, their channels, making or removing a channel, saying
// something in one. Main is the agent itself, so a request like "필요없는 채널 지우고 채널 하나
// 만들어서 거기서 일해" is main's own work with these, not a feature of its own.
import { discordChannelCreate, discordChannelDelete, discordChannels, discordGuilds, discordSend } from "../lib/native";
import { state } from "../state/store";

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function discordHands(worker: string | undefined, a: Args): Promise<unknown> {
  // main only: a job doesn't speak on the user's server, and nothing runs while the agent is off
  if (!worker?.startsWith("captain:")) return { error: "only main can use the Discord agent's hands" };
  const agent = state.settings.agent;
  if (!agent?.on) return { error: "the Discord agent is off (Settings › 에이전트)" };
  const action = str(a.action);
  switch (action) {
    case "servers":
      return { servers: await discordGuilds() };
    case "channels": {
      const guild = str(a.server);
      if (!guild) return { error: "server is empty: list the servers first" };
      return { channels: await discordChannels(guild) };
    }
    case "create": {
      const guild = str(a.server);
      const name = str(a.name);
      if (!guild || !name) return { error: "server and name are needed" };
      // private by default: seen by the user and the bot only
      const only = a.private === false ? [] : agent.ownerId ? [agent.ownerId] : [];
      const made = await discordChannelCreate(guild, name, { kind: a.kind === "category" ? "category" : "text", category: str(a.category) || undefined, topic: str(a.topic) || undefined, only });
      return { created: made, private: only.length > 0 };
    }
    case "delete": {
      const ids = (Array.isArray(a.channels) ? a.channels : [a.channel]).map(str).filter(Boolean);
      if (!ids.length) return { error: "channel (or channels) is empty" };
      const done: string[] = [];
      const failed: Record<string, string> = {};
      for (const id of ids.slice(0, 30)) {
        try {
          await discordChannelDelete(id);
          done.push(id);
        } catch (e) {
          failed[id] = e instanceof Error ? e.message : String(e);
        }
      }
      return { deleted: done, ...(Object.keys(failed).length ? { failed } : {}) };
    }
    case "send": {
      const channel = str(a.channel);
      const text = str(a.text);
      if (!channel || !text) return { error: "channel and text are needed" };
      return { sent: await discordSend(channel, text) };
    }
  }
  return { error: `unknown action ${action}: servers, channels, create, delete, send` };
}
