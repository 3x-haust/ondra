import type { Block } from "../state/types";

/** The card's title already asks: drop the question the job's last words end on. */
export function dropAsked(blocks: Block[]): Block[] {
  const last = blocks[blocks.length - 1] as { type?: string; text?: string } | undefined;
  if (last?.type !== "text" || !last.text) return blocks;
  const text = last.text.replace(/(^|[.!。\n]\s*)[^.!?。\n]*\?\s*$/, "$1").trim();
  if (text === last.text) return blocks;
  return text ? [...blocks.slice(0, -1), { ...last, text } as Block] : blocks.slice(0, -1);
}
