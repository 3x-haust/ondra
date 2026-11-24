// A question with things to fill in (an ask block with `fields`): several answers in one card
// instead of a question at a time. The fields are data, checked here; what the user filled in
// goes back to whoever asked as plain lines under the choice they pressed.
import type { Decision, FormField } from "../state/types";

const MAX_FIELDS = 12;
const s = (v: unknown, n: number) => (typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, n) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** the fields an ask block (or main's ask route) carries, checked; undefined when it has none */
export function readFields(raw: unknown): FormField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: FormField[] = [];
  const ids = new Set<string>();
  for (const f of raw.slice(0, MAX_FIELDS)) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const label = s(o.label ?? o.name ?? o.id, 80);
    if (!label) continue;
    let id = s(o.id, 40) || label;
    while (ids.has(id)) id += "'";
    ids.add(id);
    const kind = s(o.kind ?? o.type, 12).toLowerCase();
    const common = { id, label, ...(o.required ? { required: true } : {}), ...(s(o.note, 160) ? { note: s(o.note, 160) } : {}) };
    const choices = (Array.isArray(o.options) ? o.options : []).slice(0, 20).map((x) => s(x && typeof x === "object" ? (x as any).label : x, 80)).filter(Boolean);
    if ((kind === "choice" || kind === "select" || kind === "multi" || (!kind && choices.length)) && choices.length) {
      const multi = kind === "multi" || o.multi === true;
      const value = (Array.isArray(o.value) ? o.value : o.value !== undefined ? [o.value] : []).map((x) => s(x, 80)).filter((x) => choices.includes(x));
      out.push({ ...common, kind: "choice", options: choices, ...(multi ? { multi: true } : {}), ...(value.length ? { value: multi ? value : value.slice(0, 1) } : {}) });
    } else if (kind === "check" || kind === "checkbox" || kind === "bool" || kind === "boolean") {
      out.push({ ...common, kind: "check", ...(o.value === true ? { value: true } : {}) });
    } else if (kind === "number" || kind === "slider" || kind === "range") {
      const min = num(o.min), max = num(o.max), step = num(o.step), value = num(o.value);
      const unit = s(o.unit, 12);
      out.push({ ...common, kind: "number", ...(min !== undefined ? { min } : {}), ...(max !== undefined && (min === undefined || max > min) ? { max } : {}),
        ...(step && step > 0 ? { step } : {}), ...(value !== undefined ? { value } : {}), ...(unit ? { unit } : {}) });
    } else if (kind === "date" || kind === "datetime" || kind === "time") {
      const value = s(o.value, 25);
      out.push({ ...common, kind: "date", ...(kind === "datetime" || kind === "time" || o.time === true ? { time: true } : {}), ...(value ? { value } : {}) });
    } else {
      const value = s(o.value, 2000), placeholder = s(o.placeholder, 120);
      out.push({ ...common, kind: "text", ...(o.long || kind === "textarea" || kind === "long" ? { long: true } : {}), ...(value ? { value } : {}), ...(placeholder ? { placeholder } : {}) });
    }
  }
  return out.length ? out : undefined;
}

export type FormValues = Record<string, string | string[] | boolean | number | undefined>;

/** a field's starting value, as the card shows it */
export function initial(f: FormField): FormValues[string] {
  switch (f.kind) {
    case "choice": return f.multi ? [...(f.value ?? [])] : f.value?.[0];
    case "check": return !!f.value;
    case "number": return f.value ?? (f.min !== undefined && f.max !== undefined ? f.min : undefined);
    default: return f.value;
  }
}

/** a required field left empty, by label; undefined when all are there */
export function missing(form: FormField[], v: FormValues): string | undefined {
  for (const f of form) {
    if (!f.required) continue;
    const x = v[f.id];
    if (x === undefined || x === "" || (Array.isArray(x) && !x.length) || (f.kind === "check" && x !== true)) return f.label;
  }
  return undefined;
}

const shown = (f: FormField, x: FormValues[string]): string => {
  if (x === undefined || x === "" || (Array.isArray(x) && !x.length)) return "(비움)";
  if (f.kind === "check") return x ? "예" : "아니오";
  if (Array.isArray(x)) return x.join(", ");
  if (f.kind === "number") return `${x}${f.unit ?? ""}`;
  return String(x);
};

/** What goes back: the choice pressed, then each field as "label: value" (or the words typed instead) */
export function formAnswer(d: Pick<Decision, "options" | "form">, optionId: string, values?: FormValues): string {
  const label = d.options.find((o) => o.id === optionId)?.label ?? optionId;
  if (!values || !d.form?.length) return label;
  const lines = d.form.map((f) => `- ${f.label}: ${shown(f, values[f.id])}`);
  return [label, ...lines].join("\n");
}
