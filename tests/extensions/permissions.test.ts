import { describe, expect, it } from "vitest";
import { foreignDevice } from "../../extensions/permissions";

const mine = ["11111111-2222-3333-4444-555555555555", "ondra-tabc", "emulator-5556", "yomates-test"];
const other = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

describe("foreignDevice", () => {
  it("lets a job drive its own devices", () => {
    expect(foreignDevice(`xcrun simctl io ${mine[0]} screenshot a.png`, mine)).toBeUndefined();
    expect(foreignDevice("adb -s emulator-5556 shell input tap 1 2", mine)).toBeUndefined();
    expect(foreignDevice("emulator -avd yomates-test -no-window", mine)).toBeUndefined();
    expect(foreignDevice("pnpm test && git status", mine)).toBeUndefined();
  });
  it("refuses a device of another space", () => {
    expect(foreignDevice(`xcrun simctl boot ${other}`, mine)).toBe(other);
    expect(foreignDevice("cd app && adb -s emulator-5554 install a.apk", mine)).toBe("emulator-5554");
    expect(foreignDevice("ANDROID_SERIAL=emulator-5554 adb shell ls", mine)).toBe("emulator-5554");
    expect(foreignDevice("emulator -avd ym-shared -no-window", mine)).toBe("ym-shared");
    expect(foreignDevice("agent-device open com.x --serial emulator-5554", mine)).toBe("emulator-5554");
    expect(foreignDevice("xcrun simctl shutdown all", mine)).toBe("all");
    expect(foreignDevice("xcrun simctl io booted screenshot a.png", mine)).toBe("booted");
    expect(foreignDevice("adb shell input tap 1 2", mine)).toBe("adb");
    expect(foreignDevice("adb devices", mine)).toBeUndefined();
    expect(foreignDevice("adb wait-for-device", mine)).toBeUndefined();
  });
});
