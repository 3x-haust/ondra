// macOS gives the arrow and function keys characters of their own (U+F700–U+F7FF: → is U+F703).
// They are never text, but WebKit can let one into a field, pressing → right after typing Korean
// for one, and it shows as □. Any that get into a text field are taken back out at once, before
// the field's own handler reads the value, with the cursor kept where it was.

const STRAY = /[-]/g;
const HAS_STRAY = /[-]/;

/** the text without the key characters, and where a position in it moves to */
export function withoutStrays(text: string, at: number): { text: string; at: number } {
  if (!HAS_STRAY.test(text)) return { text, at };
  const before = text.slice(0, at).replace(STRAY, "");
  return { text: before + text.slice(at).replace(STRAY, ""), at: before.length };
}

type Field = { tagName: string; type?: string; value: string; selectionEnd: number | null; setSelectionRange(a: number, b: number): void };
const field = (t: unknown): t is Field => {
  const f = t as Field | null;
  return !!f && typeof f.value === "string" && (f.tagName === "TEXTAREA" || (f.tagName === "INPUT" && /^(text|search|url|email|tel|password|)$/.test(f.type ?? "")));
};

/** Keep them out of every text field: refused when they come as typing, taken out when they got in anyway. */
export function keepStrayKeysOut(doc: Pick<Document, "addEventListener"> = document) {
  doc.addEventListener(
    "beforeinput",
    (e) => {
      const ev = e as InputEvent;
      if (ev.cancelable && ev.data && HAS_STRAY.test(ev.data) && !ev.data.replace(STRAY, "")) e.preventDefault();
    },
    true,
  );
  doc.addEventListener(
    "input",
    (e) => {
      const t = e.target;
      if (!field(t) || !HAS_STRAY.test(t.value)) return;
      const end = t.selectionEnd ?? t.value.length;
      const clean = withoutStrays(t.value, end);
      t.value = clean.text;
      t.setSelectionRange(clean.at, clean.at);
    },
    true,
  );
}
