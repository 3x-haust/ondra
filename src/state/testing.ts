// Tests start from a fresh state with one account to run on: id "default" in the home workspace,
// as the built-in account older versions made (a fresh install has none until a sign-in).
import { accountBase, freshState } from "./store";
import type { AppState } from "./types";

export const testState = (): AppState => ({ ...freshState(), accounts: [{ ...accountBase(), id: "default", space: "home", label: "기본" }] });
