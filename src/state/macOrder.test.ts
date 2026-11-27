import { reconcile } from "solid-js/store";
import { beforeEach, describe, expect, it } from "vitest";
import { freshState, inOrder, moveMac, setState, state } from "./store";

beforeEach(() => setState(reconcile(freshState())));

describe("the Mac bar's order", () => {
  const bar = ["local", "a", "b"];
  it("moves a device to its new place and keeps the rest in order", () => {
    moveMac(bar, "b", 0);
    expect(state.settings.macOrder).toEqual(["b", "local", "a"]);
    moveMac(bar, "local", 2);
    expect(state.settings.macOrder).toEqual(["a", "b", "local"]);
  });
  it("puts a device added later after the ones ordered", () => {
    moveMac(bar, "a", 0);
    const shown = inOrder([{ id: "local" }, { id: "a" }, { id: "b" }, { id: "c" }], state.settings.macOrder).map((m) => m.id);
    expect(shown).toEqual(["a", "local", "b", "c"]);
  });
  it("leaves the order alone for a device not in the bar", () => {
    moveMac(bar, "gone", 0);
    expect(state.settings.macOrder).toBeUndefined();
  });
});
