import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A chat list in some apps (KakaoTalk) answers each row slowly: reading every row of the list,
// also the hundreds out of view, made one look at the screen take a minute. The tree and the
// password check read a table's visible rows only, and the check asks one round trip a element.
const SOURCE = readFileSync(join(__dirname, "../../src-tauri/helpers/cuhost.swift"), "utf8");
const body = (fn: string) => {
  const at = SOURCE.indexOf(`func ${fn}(`);
  expect(at, fn).toBeGreaterThan(-1);
  return SOURCE.slice(at, SOURCE.indexOf("\n}\n", at));
};

describe("reading an app's screen stays quick in long lists", () => {
  it("the tree and the password check go through a table's visible rows only", () => {
    expect(body("visibleChildren")).toContain("kAXVisibleRowsAttribute");
    expect(body("elementNode")).toContain("visibleChildren(el, role: a.role, children: a.children)");
    expect(body("windowSensitivity")).toContain("visibleChildren(el, role: role,");
  });

  it("the password check asks role, subrole, modal and children at once", () => {
    expect(body("windowSensitivity")).toContain("axMany(el, [kAXRoleAttribute, kAXSubroleAttribute, kAXModalAttribute, kAXChildrenAttribute])");
  });
});
