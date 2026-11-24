// The things to fill in on a question card (an ask block's `fields`): text, choices, a checkbox,
// a number, a date. Values live in the card; they go back with the choice pressed.
import { For, Match, Show, Switch } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import type { FormField } from "../state/types";
import type { FormValues } from "../engine/form";
import { t as tr } from "../i18n";

export function FormFields(props: { form: FormField[]; values: FormValues; set: SetStoreFunction<FormValues>; missing?: string; idBase: string }) {
  const fid = (f: FormField) => `${props.idBase}-${f.id.replace(/[^\w-]/g, "_")}`;
  const toggle = (f: FormField, o: string) => {
    const now = (props.values[f.id] as string[] | undefined) ?? [];
    props.set(f.id, now.includes(o) ? now.filter((x) => x !== o) : [...now, o]);
  };
  // Enter in a one-line field doesn't send the card: the choice buttons do
  const noEnter = (e: KeyboardEvent) => e.key === "Enter" && !e.isComposing && e.preventDefault();
  return (
    <div class="dform">
      <For each={props.form}>
        {(f) => (
          <div class="dform-field" classList={{ missing: props.missing === f.label, [`k-${f.kind}`]: true }}>
            <Show when={f.kind !== "check"}>
              <label class="dform-label" for={fid(f)}>
                {f.label}
                <Show when={f.required}><span class="dform-req" aria-label={tr("필수")}>*</span></Show>
              </label>
            </Show>
            <Switch>
              <Match when={f.kind === "text" && f}>
                {(x) => (
                  <Show
                    when={x().long}
                    fallback={<input id={fid(f)} class="dform-input" value={(props.values[f.id] as string) ?? ""} placeholder={x().placeholder ?? ""} onInput={(e) => props.set(f.id, e.currentTarget.value)} onKeyDown={noEnter} />}
                  >
                    <textarea id={fid(f)} class="dform-input" rows={3} value={(props.values[f.id] as string) ?? ""} placeholder={x().placeholder ?? ""} onInput={(e) => props.set(f.id, e.currentTarget.value)} />
                  </Show>
                )}
              </Match>
              <Match when={f.kind === "choice" && f}>
                {(x) => (
                  <div class="dform-choices" id={fid(f)} role={x().multi ? "group" : "radiogroup"} aria-label={f.label}>
                    <For each={x().options}>
                      {(o) => {
                        const on = () => (x().multi ? ((props.values[f.id] as string[] | undefined) ?? []).includes(o) : props.values[f.id] === o);
                        return (
                          <button
                            type="button"
                            class="dform-choice"
                            classList={{ on: on() }}
                            role={x().multi ? "checkbox" : "radio"}
                            aria-checked={on()}
                            onClick={() => (x().multi ? toggle(f, o) : props.set(f.id, on() ? undefined : o))}
                          >
                            {o}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                )}
              </Match>
              <Match when={f.kind === "check"}>
                <label class="dform-check">
                  <input type="checkbox" id={fid(f)} checked={props.values[f.id] === true} onChange={(e) => props.set(f.id, e.currentTarget.checked)} />
                  <span>{f.label}</span>
                  <Show when={f.required}><span class="dform-req">*</span></Show>
                </label>
              </Match>
              <Match when={f.kind === "number" && f}>
                {(x) => {
                  const slider = () => x().min !== undefined && x().max !== undefined;
                  const set = (v: string) => props.set(f.id, v.trim() === "" ? undefined : Number(v));
                  return (
                    <div class="dform-number">
                      <Show when={slider()}>
                        <input type="range" id={fid(f)} min={x().min} max={x().max} step={x().step ?? "any"} value={(props.values[f.id] as number) ?? x().min} onInput={(e) => set(e.currentTarget.value)} />
                      </Show>
                      <input
                        type="number"
                        class="dform-input"
                        id={slider() ? undefined : fid(f)}
                        aria-label={f.label}
                        min={x().min}
                        max={x().max}
                        step={x().step ?? "any"}
                        value={(props.values[f.id] as number | undefined) ?? ""}
                        onInput={(e) => set(e.currentTarget.value)}
                        onKeyDown={noEnter}
                      />
                      <Show when={x().unit}><span class="dform-unit">{x().unit}</span></Show>
                    </div>
                  );
                }}
              </Match>
              <Match when={f.kind === "date" && f}>
                {(x) => (
                  <input
                    type={x().time ? "datetime-local" : "date"}
                    id={fid(f)}
                    class="dform-input dform-date"
                    value={(props.values[f.id] as string) ?? ""}
                    onInput={(e) => props.set(f.id, e.currentTarget.value || undefined)}
                    onKeyDown={noEnter}
                  />
                )}
              </Match>
            </Switch>
            <Show when={f.note}><span class="dform-note">{f.note}</span></Show>
          </div>
        )}
      </For>
      <Show when={props.missing}>
        <p class="dform-missing" role="alert">{tr("'{label}'을(를) 채워 주세요", { label: props.missing! })}</p>
      </Show>
    </div>
  );
}
