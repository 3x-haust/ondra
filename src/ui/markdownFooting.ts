// What a claim stands on, as a small chip in the prose: (확인함) ran or saw it here,
// (추론) read the code, (추측) neither. The words stay as written; the chip makes a guess
// look like a guess next to a cause that was checked.
import type { TokenizerAndRendererExtension, Tokens } from "marked";

const KINDS: Record<string, "seen" | "read" | "guess"> = {
  확인함: "seen", 측정함: "seen", verified: "seen", measured: "seen",
  추론: "read", inferred: "read",
  추측: "guess", guess: "guess",
};
const LABEL = /^[(（]\s*(확인함|측정함|추론|추측|verified|measured|inferred|guess)\s*[)）]/i;

export const footing: TokenizerAndRendererExtension = {
  name: "footing",
  level: "inline",
  start: (src) => {
    const m = /[(（]\s*(확인함|측정함|추론|추측|verified|measured|inferred|guess)\s*[)）]/i.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const m = LABEL.exec(src);
    return m ? ({ type: "footing", raw: m[0], text: m[1] } as Tokens.Generic) : undefined;
  },
  renderer: (t) => `<span class="md-footing md-footing-${KINDS[String(t.text).toLowerCase()] ?? KINDS[String(t.text)] ?? "read"}">${String(t.text)}</span>`,
};
