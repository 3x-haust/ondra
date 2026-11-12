import type { Tokenizer, Tokens } from "marked";

// Korean, Japanese, Chinese letters and their full-width punctuation
const CJK = /[ᄀ-ᇿ　-ヿ㄰-㆏㐀-䶿一-鿿가-힯＀-￯]/;
const STRONG = /^\*\*(?![\s*])((?:\\[\s\S]|[^\\*]|\*(?!\*))+?)\*\*(?!\*)/;

/**
 * **"이렇게"**를: markdown won't close a bold whose last letter is punctuation when a word
 * follows straight on, which is how Korean puts a particle after a quote. Next to CJK letters
 * the bold closes anyway; elsewhere marked reads it as it always does.
 */
export function cjkStrong(this: Tokenizer, src: string, _masked: string, prevChar = ""): Tokens.Strong | false {
  const m = STRONG.exec(src);
  if (!m || /[\s*]$/.test(m[1])) return false;
  if (!CJK.test(prevChar) && !CJK.test(src[m[0].length] ?? "")) return false;
  return { type: "strong", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
}
