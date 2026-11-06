---
name: device-use
description: >
  Drive iOS simulators and Android emulators for a job: make your own device,
  install and open the app, tap / type / swipe by what's on screen, capture proof,
  then shut down and delete what you made. Use when a task says simulator,
  emulator, iPhone, Android, 앱 화면, 시뮬레이터, 에뮬레이터, or needs the mobile app
  checked. The user watches and can drive the same device in the app's 디바이스 hub.
---

# Device use

Prefer the `device` tool (start → do → look → stop): it does all of this for you
and keeps the job on its own device. **Call `stop` before your final answer**,
every time, unless the user asked to keep the device: a device left running
holds memory and CPU on the user's Mac. Use the commands below only if that tool is missing.

Tools: `xcrun simctl` (iOS), `adb` and `emulator` from `~/Library/Android/sdk`
(Android), and `agent-device` (taps, typing, accessibility snapshots on both).
If `agent-device` is missing: `npm i -g agent-device`.

## 1. Your own device, never someone else's

Booted devices may belong to other jobs or to the user's other work. Don't
control, shut down or delete a device you didn't make.

```bash
# iOS: a fresh simulator named after this job
UDID=$(xcrun simctl create "ondra-$APP_WORKER_ID" "iPhone 17")
xcrun simctl boot "$UDID" && xcrun simctl bootstatus "$UDID" -b
# Android: boot an AVD you created, or an existing one nobody runs (check adb devices first)
"$ANDROID_HOME/emulator/emulator" -avd <name> -no-snapshot-save -no-window -gpu auto-no-window -no-audio -no-boot-anim &   # no window: the user sees it in Ondra's device hub; auto-no-window draws on the GPU, not the CPU
~/Library/Android/sdk/platform-tools/adb wait-for-device
```

If `$APP_WORKER_ID` is empty, use a short name for the task (`ondra-login-check`).

## 2. Drive it by meaning, not by pixels

Use one agent-device session per job, named like the device:

```bash
S=ondra-$APP_WORKER_ID
agent-device open com.example.app --platform ios --udid "$UDID" --session $S   # or --platform android --serial emulator-5554
agent-device snapshot -i --session $S          # what's on screen, with @refs
agent-device press @e12 --settle --session $S  # tap by ref
agent-device fill @e7 "test@example.com" --settle --session $S
agent-device scroll down --settle --session $S
agent-device back --settle --session $S
```

Coordinates (`press <x> <y>`, in points) only when the snapshot has no target.
After each action read the diff it returns; snapshot again only when needed.
Install builds with `xcrun simctl install "$UDID" <App.app>` or `adb -s <serial> install -r <apk>`.

## 3. Proof

Save screenshots in `$APP_ARTIFACTS_DIR` and point to them:

```bash
xcrun simctl io "$UDID" screenshot --type=png "$APP_ARTIFACTS_DIR/login-ok.png"
adb -s emulator-5554 exec-out screencap -p > "$APP_ARTIFACTS_DIR/login-ok.png"
```

Then `{"type":"shot","path":"…","caption":"로그인 뒤 홈 화면"}` and the same path as
`{"kind":"shot","ref":"…"}` in the done evidence. The app checks the file exists
and isn't empty.

## 4. Clean up

When the job is done (or handed off with nothing left to check on the device):

```bash
agent-device close --session $S
xcrun simctl shutdown "$UDID" && xcrun simctl delete "$UDID"
adb -s emulator-5554 emu kill            # Android emulator you started
```

Leave a device running only if the user asked to keep it, and say so in the
summary.
