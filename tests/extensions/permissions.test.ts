import { describe, expect, it } from "vitest";
import { focusSteal, foreignDevice } from "../../extensions/permissions";

const mine = ["11111111-2222-3333-4444-555555555555", "ondra-tabc", "emulator-5556", "acme-test"];
const other = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

describe("foreignDevice", () => {
  it("lets a job drive its own devices", () => {
    expect(foreignDevice(`xcrun simctl io ${mine[0]} screenshot a.png`, mine)).toBeUndefined();
    expect(foreignDevice("adb -s emulator-5556 shell input tap 1 2", mine)).toBeUndefined();
    expect(foreignDevice("emulator -avd acme-test -no-window", mine)).toBeUndefined();
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

describe("focusSteal", () => {
  it("catches open without -g, not open -g", () => {
    expect(focusSteal("open report.html")).toBeTruthy();
    expect(focusSteal("cd out && open -a Preview a.pdf")).toBeTruthy();
    expect(focusSteal("open -g -a Preview a.pdf")).toBeUndefined();
  });
  it("leaves heredoc bodies and quoted text alone", () => {
    const add = `python3 /tmp/r/add.py <<'EOF'\n[{"claim":"a | open source driver","title":"Docs | Cua"}]\nopen questions\nEOF`;
    expect(focusSteal(add)).toBeUndefined();
    expect(focusSteal(`echo "done | open it later"`)).toBeUndefined();
    expect(focusSteal(`cat <<EOF > a.txt\nopen x\nEOF\nopen b.html`)).toBeTruthy();
  });
});
