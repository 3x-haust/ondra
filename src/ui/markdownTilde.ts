import type { Tokens } from "marked";

/** A single ~ is a range ("2~3벌", "12~30장"), never a strikethrough: only ~~ strikes through. */
export function rangeTilde(src: string): Tokens.Del | false {
  if (src[0] === "~" && src[1] !== "~") return { type: "text", raw: "~", text: "~" } as unknown as Tokens.Del;
  return false;
}
