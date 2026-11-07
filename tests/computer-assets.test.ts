import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const script = resolve("scripts/computer-assets.mjs");
const names = ["ondra-computer-host", "ondra-computer-endpoint", "ondra-computer-provision", "install-setup.sh", "agent-desktop", "agent-desktop-macos-helper"];
const roles = ["runner", "endpoint", "provisioner", "installer", "desktop", "helper"];
let temporary: string;
beforeAll(() => { temporary = mkdtempSync(join(tmpdir(), "ondra-assets-")); });
afterAll(() => { rmSync(temporary, { recursive: true, force: true }); });
function fixture(label: string) {
  const directory = join(temporary, label);
  mkdirSync(directory);
  for (const name of names.slice(0, 4)) writeFileSync(join(directory, name), `fixture:${name}`);
  for (const name of names.slice(4)) copyFileSync(resolve(`node_modules/agent-desktop/bin/${name}-darwin-arm64`), join(directory, name));
  return directory;
}
function seal(directory: string, profile = "release", target = "aarch64-apple-darwin") {
  const output = join(temporary, "computer_assets.rs");
  rmSync(output, { force: true });
  const result = spawnSync(process.execPath, [script, "seal", directory, output, profile, target], { encoding: "utf8" });
  return { ...result, source: existsSync(output) ? readFileSync(output, "utf8") : "" };
}

describe("컴퓨터 번들 봉인", () => {
  it("6개 최종 파일의 SHA-256을 Rust 상수에 포함한다", () => {
    const directory = fixture("complete");
    const result = seal(directory);
    expect(result.status, result.stderr).toBe(0);
    expect(result.source).toContain("pub const COMPUTER_ASSETS: Option<[(&str, &str, &str); 6]> = Some([");
    names.forEach((name, i) => {
      const digest = createHash("sha256").update(readFileSync(join(directory, name))).digest("hex");
      expect(result.source).toContain(`("${roles[i]}", "computer/${name}", "${digest}")`);
    });
    execFileSync("rustc", ["--crate-type", "lib", join(temporary, "computer_assets.rs"), "-o", join(temporary, "assets.rlib")]);
  });
  it.each(names)("release는 %s 누락을 거부한다", (name) => {
    const directory = fixture(`missing-${name}`);
    rmSync(join(directory, name));
    const result = seal(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(result.source).toBe("");
  });
  it("debug 누락은 빈 해시가 아닌 unavailable 상수를 만든다", () => {
    const result = seal(join(temporary, "absent"), "debug");
    expect(result.status, result.stderr).toBe(0);
    expect(result.source).toContain("= None;");
    expect(result.source).not.toContain("Some");
  });
  it.each(["agent-desktop", "agent-desktop-macos-helper"])("patched %s와 인접 digest/env 주입을 거부한다", (name) => {
    const directory = fixture(`patched-${name}`);
    writeFileSync(join(directory, name), "patched");
    writeFileSync(join(directory, `${name}.sha256`), createHash("sha256").update("patched").digest("hex"));
    const result = seal(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pinned agent-desktop@1.1.0");
    const debug = seal(directory, "debug");
    expect(debug.status).toBe(0);
    expect(debug.source).toContain("= None;");
  });
  it("심볼릭 링크와 빈 파일을 봉인하지 않는다", () => {
    const directory = fixture("invalid-file");
    rmSync(join(directory, names[0]));
    symlinkSync(join(directory, names[1]), join(directory, names[0]));
    const linked = seal(directory);
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toContain("invalid computer asset:");
    rmSync(join(directory, names[0]));
    writeFileSync(join(directory, names[0]), "");
    const empty = seal(directory);
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain("invalid computer asset:");
  });
  it("지원하지 않는 타깃은 debug에서 닫히고 release에서 실패한다", () => {
    const directory = fixture("target");
    expect(seal(directory, "debug", "x86_64-apple-darwin").source).toContain("= None;");
    expect(seal(directory, "release", "x86_64-apple-darwin").status).not.toBe(0);
  });
  it("번들·Rust 빌드가 봉인 스크립트와 리소스를 연결한다", () => {
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(config.bundle.resources["resources/computer/"]).toBe("computer/");
    expect(readFileSync("scripts/bundle.mjs", "utf8")).toContain("stageComputerAssets(root)");
    const build = readFileSync("src-tauri/build.rs", "utf8");
    expect(build).toContain("computer-assets.mjs");
    expect(build).toContain("computer_assets.rs");
    expect(build).toContain("rerun-if-changed");
  });
  it("스테이징은 npm 버전이 다르면 빌드 전 거부한다", () => {
    const root = join(temporary, "wrong-package");
    mkdirSync(join(root, "node_modules/agent-desktop"), { recursive: true });
    writeFileSync(join(root, "node_modules/agent-desktop/package.json"), JSON.stringify({ name: "agent-desktop", version: "1.2.0" }));
    const invocation = `import {stageComputerAssets} from ${JSON.stringify(`file://${script}`)}; stageComputerAssets(${JSON.stringify(root)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", invocation], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("agent-desktop@1.1.0");
  });
});
