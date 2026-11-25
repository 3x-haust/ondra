import { afterEach, expect, it, vi } from "vitest";
import * as native from "../lib/native";
import { mainTools } from "./captain";

afterEach(() => vi.restoreAllMocks());

it.each([true, false])("loads the allowed Windows extensions and their secret filter (lazy: %s)", async lazy => {
  const allowed = [...(lazy ? ["lazy-core.ts"] : []), "web.ts", "skills.ts", "secrets.ts", "jobs.ts", "use.ts"].map(name => `C:\\Program Files\\Ondra\\${name}`);
  vi.spyOn(native, "workerExtensions").mockResolvedValue([...allowed, "C:\\x\\not-secrets.ts", "/ext/disguised\\secrets.ts"]);
  const args = await mainTools();
  expect(args.slice(0, lazy ? 1 : 2)).toEqual(lazy ? ["--no-builtin-tools"] : ["--exclude-tools", "edit,write"]);
  expect(args.filter((_, i) => args[i - 1] === "--extension")).toEqual(allowed);
});
