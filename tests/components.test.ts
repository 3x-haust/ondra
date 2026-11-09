import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script
import { assetName, pack, plan, releaseUrl, sha256File, treeHash } from "../scripts/components.mjs";

const built = [
  { name: "engine", version: "1.5.0-aaaaaaaaaaaa", sha256: "1".repeat(64), size: 10 },
  { name: "chrome", version: "157.0.8103.38", sha256: "2".repeat(64), size: 20 },
];

describe("component manifest", () => {
  it("points every component at this release when the last one had none", () => {
    const { manifest, upload } = plan(built, null, "v1.0.0");
    expect(upload).toEqual(["engine", "chrome"]);
    expect(manifest.components[1]).toEqual({ ...built[1], url: "https://github.com/3x-haust/ondra/releases/download/v1.0.0/chrome-157.0.8103.38.tar.xz" });
  });

  it("keeps a version users already have where it was, and uploads only what changed", () => {
    const previous = { components: [{ ...built[1], url: releaseUrl("v0.9.0", built[1]) }, { ...built[0], version: "1.4.0-bbbbbbbbbbbb", url: "x" }] };
    const { manifest, upload } = plan(built, previous, "v1.0.0");
    expect(upload).toEqual(["engine"]);
    expect(manifest.components.map((c: { url: string }) => c.url)).toEqual([releaseUrl("v1.0.0", built[0]), releaseUrl("v0.9.0", built[1])]);
  });

  it("refuses a name or version that isn't a plain folder name", () => {
    for (const bad of ["../x", "a/b", ".hidden", ""]) {
      expect(() => plan([{ ...built[0], version: bad }], null, "v1")).toThrow();
      expect(() => plan([{ ...built[0], name: bad }], null, "v1")).toThrow();
    }
    expect(assetName(built[0])).toBe("engine-1.5.0-aaaaaaaaaaaa.tar.xz");
  });
});

describe("packing a component", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.ONDRA_COMPONENT_CACHE;
  });

  it("archives once per version, with a checksum of the archive, and reuses it", () => {
    const work = mkdtempSync(join(tmpdir(), "ondra-pack-"));
    dirs.push(work);
    process.env.ONDRA_COMPONENT_CACHE = join(work, "cache");
    const src = join(work, "src");
    mkdirSync(join(src, "bin"), { recursive: true });
    writeFileSync(join(src, "bin/radare2"), "r2");
    const version = `6.2.6-${treeHash(src)}`;
    let fills = 0;
    const fill = (dir: string) => {
      fills++;
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(dir, "bin/radare2"), readFileSync(join(src, "bin/radare2")));
    };
    const saved = process.env.APPLE_SIGNING_IDENTITY;
    delete process.env.APPLE_SIGNING_IDENTITY;
    try {
      const a = pack({ name: "binary-analysis", version, fill });
      expect(a.sha256).toBe(sha256File(a.archive));
      expect(readFileSync(join(a.tree, "bin/radare2"), "utf8")).toBe("r2");
      const b = pack({ name: "binary-analysis", version, fill });
      expect(b).toEqual(a);
      expect(fills).toBe(1);
    } finally {
      if (saved !== undefined) process.env.APPLE_SIGNING_IDENTITY = saved;
    }
    // the content changes, so does the version
    writeFileSync(join(src, "bin/radare2"), "r3");
    expect(`6.2.6-${treeHash(src)}`).not.toBe(version);
  });
});

describe("the update package holds only the app", () => {
  it("bundles no component and builds the manifest in release builds", () => {
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    const resources = Object.keys(config.bundle.resources);
    for (const big of ["chrome", "binary-analysis", "engine"]) expect(resources.some((r) => r.includes(`resources/${big}`))).toBe(false);
    expect(config.bundle.externalBin).not.toContain("binaries/ondra-engine");
    expect(config.bundle.resources["resources/components.json"]).toBe("components.json");
    expect(config.build.beforeBuildCommand).toContain("bundle --release");
  });
});
