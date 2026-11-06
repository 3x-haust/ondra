import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("typebox", () => ({ Type: {} }));
const { cloneAvd, dropAvd } = await import("../../extensions/device");

describe("a job's own emulator", () => {
  it("is a copy of an AVD with none of its data, and only copies are deleted", () => {
    const home = mkdtempSync(join(tmpdir(), "avd-"));
    mkdirSync(join(home, "base.avd", "data"), { recursive: true });
    writeFileSync(join(home, "base.avd", "config.ini"), "AvdId=base\navd.ini.displayname=base\nimage.sysdir.1=system-images/x/\n");
    writeFileSync(join(home, "base.avd", "userdata-qemu.img"), "logins");
    writeFileSync(join(home, "base.ini"), `path=${home}/base.avd\npath.rel=avd/base.avd\ntarget=android-36\n`);
    expect(cloneAvd("base", "ondra-tjob", home)).toBe("ondra-tjob");
    expect(readFileSync(join(home, "ondra-tjob.avd", "config.ini"), "utf8")).toBe("AvdId=ondra-tjob\navd.ini.displayname=ondra-tjob\nimage.sysdir.1=system-images/x/\n");
    expect(readFileSync(join(home, "ondra-tjob.ini"), "utf8")).toContain(`path=${home}/ondra-tjob.avd\npath.rel=avd/ondra-tjob.avd`);
    expect(existsSync(join(home, "ondra-tjob.avd", "userdata-qemu.img"))).toBe(false);
    dropAvd("base", home);
    dropAvd("ondra-../base", home);
    expect(existsSync(join(home, "base.avd", "userdata-qemu.img"))).toBe(true);
    dropAvd("ondra-tjob", home);
    expect(existsSync(join(home, "ondra-tjob.avd")) || existsSync(join(home, "ondra-tjob.ini"))).toBe(false);
  });
});
