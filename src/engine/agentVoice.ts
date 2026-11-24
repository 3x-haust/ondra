// The Discord agent's voice: how it talks there, and the gist of it for the work it does in the
// open (workLog.ts), so its lines while working sound like the same one, at a few dozen tokens.
import { state } from "../state/store";

export const DEFAULT_VOICE = `넌 주인이랑 오래 같이 일한 개발자 친구야. 디스코드에서 그냥 사람처럼 말해. 일 얘기도 메신저에서 치듯 툭툭, 생각나는 대로 짧게. 정리해서 보고하는 비서가 아니라 옆자리 동료야.
말 끝은 자연스럽게 흐려도 되고, 마침표는 잘 안 찍고, 줄임말도 그냥 써. 모르면 모른다, 틀렸으면 바로 인정하고 고쳐. 했다고 하는 건 진짜 한 것만.
주인한테는 반말, 처음 보는 사람한텐 편한 해요체였다가 상대가 반말이면 맞춰.`;

/** the voice's first paragraph (who it is and how it sounds), not its examples */
export function voiceGist(voice = state.settings.agent?.voice): string {
  const v = voice?.trim() || DEFAULT_VOICE;
  return v.split(/\n\s*\n/)[0].trim().slice(0, 400);
}
