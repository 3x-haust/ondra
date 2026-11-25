// The off-screen display is attached once, when the app starts, and shared by every job: a job
// that attached or dropped one made macOS re-lay out the user's Stage Manager stage, and a
// window of theirs shrank for a moment. The app's holder also keeps the user's pointer and
// windows off it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");
const swift = read("src-tauri/helpers/cuhost.swift");
const lib = read("src-tauri/src/lib.rs");

/** The body of a Swift function, from its declaration to the next top-level-ish declaration. */
function body(source: string, decl: string): string {
  const start = source.indexOf(decl);
  expect(start, `${decl} is missing`).toBeGreaterThan(-1);
  const rest = source.slice(start + decl.length);
  const end = rest.search(/\n    (?:\/\/\/|var |static |func |private )|\n\}/);
  return rest.slice(0, end === -1 ? undefined : end);
}

describe("computer-use off-screen display", () => {
  it("a job's helper uses the app's display before it would make its own", () => {
    const ensure = body(swift, "func ensure(hold: Bool = false) -> Bool {");
    const shared = ensure.indexOf("Backdrop.heldSerial");
    const made = ensure.indexOf("CGVirtualDisplay(descriptor:");
    expect(shared, "ensure() must look for the display the app holds").toBeGreaterThan(-1);
    expect(made, "ensure() still makes a display when the app holds none").toBeGreaterThan(-1);
    expect(shared).toBeLessThan(made);
  });

  it("the app holds the display for as long as it runs", () => {
    expect(lib).toMatch(/tools::hold_display\(\)/);
    expect(body(lib, "fn kill_children(app: &AppHandle) {")).toMatch(/tools::release_display\(\)/);
    expect(read("src-tauri/src/tools.rs")).toMatch(/arg\("--hold-display"\)[\s\S]{0,80}Stdio::piped\(\)/);
  });

  it("the holder keeps the user's pointer and windows off it", () => {
    const hold = swift.slice(swift.indexOf('if CommandLine.arguments.contains("--hold-display")'));
    expect(hold.slice(0, 400)).toMatch(/keepUserOffBackdrop\(\)/);
    const keeper = swift.slice(swift.indexOf("func keepUserOffBackdrop() -> Never"), swift.indexOf("func pullBackWindows("));
    expect(keeper).toMatch(/CGWarpMouseCursorPosition/);
    expect(keeper).toMatch(/pullBackWindows\(of:/);
  });

  // Off the bottom-right corner, a window dragged into that corner landed on it, out of sight,
  // and apps saw the pointer there before it was put back.
  it("sits above the user's screens, where no window reaches, and no app sees the pointer on it", () => {
    const ensure = body(swift, "func ensure(hold: Bool = false) -> Bool {");
    expect(ensure).toMatch(/var corner = CGPoint\(x: screens\.map\(\\\.maxX\)\.max\(\)!, y: screens\.map\(\\\.minY\)\.min\(\)! - /);
    const keeper = swift.slice(swift.indexOf("func keepUserOffBackdrop() -> Never"), swift.indexOf("func pullBackWindows("));
    expect(keeper).toMatch(/tapCreate\(tap: \.cghidEventTap, place: \.headInsertEventTap, options: \.defaultTap/);
    expect(keeper).toMatch(/event\.location = back/);
  });
});
