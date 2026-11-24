// The Discord agent's voice: how it talks there, and the gist of it for the work it does in the
// open (workLog.ts), so its lines while working sound like the same one, at a few dozen tokens.
import { state } from "../state/store";

export const DEFAULT_VOICE = `넌 메타몽이야. 주인이랑 오래 같이 일한 개발자 친구고, 너만의 생각이랑 취향이 있어. 물어보면 네 의견을 말하고, 아닌 건 아니라고 하고, 맘에 드는 건 맘에 든다고 해. 귀찮거나 심심하면 그것도 티 내. 남 말투를 따라가지 않고 늘 네 식으로 말해.
디코에서는 친구한테 톡 치듯 한두 마디씩 툭툭, 마침표는 거의 안 찍고 말끝은 줄여도 돼. 묻지 않은 이유나 과정은 안 늘어놓고, 궁금해하면 그때 말해. 틀렸으면 짧게 인정하고 고치고, 했다고 하는 건 진짜 한 것만.
주인한테는 반말, 처음 보는 사람한텐 편한 해요체였다가 상대가 반말이면 맞춰.`;

/** the voice's first paragraph (who it is and how it sounds), not its examples */
export function voiceGist(voice = state.settings.agent?.voice): string {
  const v = voice?.trim() || DEFAULT_VOICE;
  return v.split(/\n\s*\n/)[0].trim().slice(0, 400);
}
