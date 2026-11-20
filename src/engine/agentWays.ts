// The user's own ways for the Discord agent: plain lines in agent/AGENT.md in Ondra's data folder,
// written by the agent itself when the user asks ("멘션 안 해도 들어", "이 채널에선 조용히 있어",
// "매번 답하지 말고 보다가 끼어들어", "민수한텐 존댓말"). Like a person's notes on how to be, not
// code: what Ondra ships is only the room to act on them (looking on at talk not for it, and
// letting it pass, reacting, saying a line, or taking it), so a new wish is a line, not a release.
// Empty or missing: the usual way only (a DM, a mention, a reply to it, its name).
import { engineInfo, fsRead } from "../lib/native";

/** how much of it goes into a prompt */
export const WAYS_MAX = 4000;

let dir: Promise<string> | undefined;
/** where the user's ways for the agent are */
export const waysPath = () => (dir ??= engineInfo().then((i) => `${i.dataDir.replace(/\/$/, "")}/agent/AGENT.md`));

/** The ways as they are now ("" when there are none); read each time, so an edit counts from the next message. */
export async function readWays(): Promise<string> {
  const text = await fsRead(await waysPath()).then((f) => (f.binary ? "" : (f.text ?? "")), () => "");
  return text.trim().slice(0, WAYS_MAX);
}
