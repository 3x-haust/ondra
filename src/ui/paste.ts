/** Pasted text this long goes in as a file, a card like any attachment, not a wall in the box. */
export const longPaste = (text: string) => text.length >= 1500 || text.split("\n").length >= 25;

/** a file made from pasted text (save_paste names it paste-<time>.txt) */
export const isPastedText = (p: string) => /\/attachments\/paste-\d+\.txt$/.test(p);
