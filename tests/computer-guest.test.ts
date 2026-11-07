import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const requestId = "10000000-0000-4000-8000-000000000001";
const vmUuid = "20000000-0000-4000-8000-000000000002";
const hostUuid = "30000000-0000-4000-8000-000000000003";
const bootSessionUuid = "40000000-0000-4000-8000-000000000004";
const bootNonce = "a".repeat(64);
const provision = { version: 1, taskId: "task", vmUuid, hostUuid, guestUid: 501 };
const boot = { version: 1, vmUuid, bootNonce, bootSessionUuid };
const session = ["--session", "s_test"];
const ref = "@s123abc:e12";

// Admission and synthetic PNG fixtures only; never dispatch Process or the desktop CLI.
const harnessSource = `
import Foundation
import Darwin
@main struct AdmissionCheck {
    static func main() {
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            let input = try object(data)
            var result: Any
            switch input["check"] as? String {
            case "argv": result = try allowedArguments(input["argv"])
            case "image":
                let fd = open(input["directory"] as! String, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                defer { close(fd) }
                result = try screenshotImage(directoryFD: fd, owner: UInt32(input["owner"] as? Int ?? Int(geteuid())))
            case "capture":
                let capture = try ScreenshotCapture(home: input["home"] as! String)
                let argv = try capture.arguments(input["argv"] as! [String])
                if let encoded = input["png"] as? String {
                    let data = Data(base64Encoded: encoded)!
                    let fd = openat(capture.directoryFD, "screenshot.png", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
                    guard fd >= 0 else { throw Refusal("FIXTURE_ERROR") }
                    let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
                    try file.write(contentsOf: data)
                    try file.close()
                }
                result = ["argv": argv, "result": try desktopResult(Data((input["stdout"] as! String).utf8),
                    status: Int32(input["status"] as? Int ?? 0), normalExit: true, command: "screenshot", capture: capture)]
            case "helper":
                var copied: [String: Any] = [:]
                do {
                    let copy = try HelperCopy(Data((input["data"] as! String).utf8), home: input["home"] as! String)
                    var info = stat()
                    _ = lstat(copy.path, &info)
                    copied = ["path": copy.path, "mode": Int(info.st_mode & 0o7777), "owner": Int(info.st_uid),
                              "links": Int(info.st_nlink), "data": String(decoding: FileManager.default.contents(atPath: copy.path)!, as: UTF8.self)]
                }
                copied["removed"] = !FileManager.default.fileExists(atPath: copied["path"] as! String)
                result = copied
            case "fifo":
                guard mkfifo(input["path"] as! String, 0o600) == 0 else { throw Refusal("FIXTURE_ERROR") }
                result = true
            case "request": result = try validateRequest(input["request"] as! [String: Any])
            case "file": result = try secureFile(input["path"] as! String, limit: 4096).count
            case "directory":
                try secureDirectory(input["path"] as! String)
                result = true
            case "result":
                result = try desktopResult(Data((input["stdout"] as! String).utf8),
                    status: Int32(input["status"] as! Int), normalExit: input["normalExit"] as! Bool, command: input["command"] as? String ?? "click")
            default:
                let identity = try validateIdentity(input["provision"] as! [String: Any], input["boot"] as! [String: Any],
                    actualUUID: input["actualUUID"] as! String, currentBoot: input["currentBoot"] as! String,
                    uid: UInt32(input["uid"] as! Int), effectiveUid: UInt32(input["effectiveUid"] as! Int))
                if let claims = input["claims"] as? [String: Any] { try validateClaims(claims, identity) }
                result = identity.response
            }
            let output = try JSONSerialization.data(withJSONObject: ["value": result], options: [.sortedKeys])
            FileHandle.standardOutput.write(output)
        } catch {
            let output = try! JSONSerialization.data(withJSONObject: ["error": (error as? Refusal)?.code ?? "UNEXPECTED_ERROR"])
            FileHandle.standardOutput.write(output)
        }
    }
}
`;

describe.skipIf(process.platform !== "darwin")("게스트 실행기 입장 검증", () => {
  let directory: string;
  let endpoint: string;
  let admission: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "ondra-computer-guest-test-"));
    endpoint = join(directory, "endpoint");
    admission = join(directory, "admission");
    const source = resolve("scripts/computer-guest/main.swift");
    const harness = join(directory, "Admission.swift");
    writeFileSync(harness, harnessSource);
    const flags = ["swiftc", "-parse-as-library", "-swift-version", "6", "-warnings-as-errors"];
    execFileSync("/usr/bin/xcrun", [...flags, source, "-o", endpoint], { timeout: 60_000 });
    execFileSync("/usr/bin/xcrun", [...flags, "-D", "COMPUTER_GUEST_LIBRARY", source, harness, "-o", admission], { timeout: 60_000 });
  }, 120_000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  function check(input: object) {
    return JSON.parse(execFileSync(admission, [], { input: JSON.stringify(input), encoding: "utf8", timeout: 5000 }));
  }
  function identity(overrides: object = {}) {
    return check({ check: "identity", provision, boot, actualUUID: vmUuid, currentBoot: bootSessionUuid,
      uid: 501, effectiveUid: 501, ...overrides });
  }
  function unprovisioned(input: string) {
    // Refuse to run the production entrypoint on any provisioned machine.
    expect(existsSync("/private/var/db/ondra-computer")).toBe(false);
    return spawnSync(endpoint, [], { input, encoding: "utf8", timeout: 7000,
      env: { HOME: directory, PATH: directory, AGENT_DESKTOP_MACOS_HELPER_PATH: "/not/allowed" } });
  }

  it("사전 provision 없는 호스트에서 신원을 반환하지 않는다", () => {
    const result = unprovisioned(JSON.stringify({ version: 1, op: "identity", requestId }));
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ version: 1,
      error: { code: "UNPROVISIONED_GUEST", delivery: "not_delivered", retry: "never" } });
  });

  it("호스트에서 유효한 명령도 provision 전에 거부한다", () => {
    const result = unprovisioned(JSON.stringify({ version: 1, op: "exec", requestId,
      taskId: "task", vmUuid, bootNonce, argv: ["session", "start", "--no-trace"] }));
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("UNPROVISIONED_GUEST");
  });

  it.each([
    ["잘못된 JSON", "{", "INVALID_JSON"],
    ["과도한 입력", " ".repeat(256 * 1024 + 1), "INPUT_LIMIT"],
    ["신원 주장 덧붙임", JSON.stringify({ version: 1, op: "identity", requestId, taskId: "echo" }), "INVALID_REQUEST"],
    ["불리언 버전", JSON.stringify({ version: true, op: "identity", requestId }), "INVALID_REQUEST"],
  ])("%s 입력을 거부한다", (_, input, code) => {
    const result = unprovisioned(input);
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe(code);
  });

  it("검증된 provision에서만 응답 신원을 만든다", () => {
    expect(identity()).toEqual({ value: { version: 1, taskId: "task", vmUuid, bootNonce } });
  });

  it.each([
    ["실제 하드웨어 불일치", { actualUUID: hostUuid }, "GUEST_UUID_MISMATCH"],
    ["호스트와 동일 UUID", { provision: { ...provision, hostUuid: vmUuid } }, "GUEST_UUID_MISMATCH"],
    ["다른 부팅", { currentBoot: hostUuid }, "STALE_BOOT_IDENTITY"],
    ["다른 VM의 nonce", { boot: { ...boot, vmUuid: hostUuid } }, "GUEST_UUID_MISMATCH"],
    ["일반 사용자 불일치", { uid: 502 }, "GUEST_USER_MISMATCH"],
    ["루트 실행", { uid: 0, effectiveUid: 0 }, "GUEST_USER_MISMATCH"],
    ["setuid 실행", { effectiveUid: 0 }, "GUEST_USER_MISMATCH"],
    ["줄바꿈 nonce", { boot: { ...boot, bootNonce: bootNonce + "\n" } }, "INVALID_PROVISION"],
    ["과거 nonce 주장", { claims: { taskId: "task", vmUuid, bootNonce: "b".repeat(64) } }, "GUEST_IDENTITY_MISMATCH"],
    ["다른 작업 주장", { claims: { taskId: "other", vmUuid, bootNonce } }, "GUEST_IDENTITY_MISMATCH"],
    ["다른 VM 주장", { claims: { taskId: "task", vmUuid: hostUuid, bootNonce } }, "GUEST_IDENTITY_MISMATCH"],
  ])("%s을 거부한다", (_, overrides, error) => {
    expect(identity(overrides)).toEqual({ error });
  });

  it("사용자 소유 상태 파일과 디렉터리 및 심볼릭 링크를 거부한다", () => {
    expect(process.getuid?.()).not.toBe(0);
    const file = join(directory, "provision.json");
    const link = join(directory, "linked.json");
    writeFileSync(file, JSON.stringify(provision), { mode: 0o644 });
    symlinkSync(file, link);
    expect(check({ check: "file", path: file })).toEqual({ error: "UNSAFE_FILE" });
    expect(check({ check: "file", path: link })).toEqual({ error: "UNPROVISIONED_GUEST" });
    expect(check({ check: "directory", path: directory })).toEqual({ error: "UNSAFE_DIRECTORY" });
  });

  it.each([0, 1, 2])("구조화된 CLI 응답을 종료 코드 %i에서 보존한다", status => {
    const envelope = status === 0
      ? { version: "2.6", command: "click", ok: true, data: { disposition: { delivery: "delivered_unverified", retry: "unsafe" } } }
      : { version: "2.6", command: "click", ok: false, error: { code: "STALE_REF", message: "stale",
          disposition: { delivery: "not_delivered", retry: "safe" } } };
    expect(check({ check: "result", stdout: JSON.stringify(envelope), status, normalExit: true })).toEqual({ value: envelope });
  });

  it.each([
    ["잘못된 JSON", "banner {}", 0, true, "INVALID_DESKTOP_RESPONSE"],
    ["숫자형 성공값", JSON.stringify({ version: "2.6", command: "click", ok: 1, data: {} }), 0, true, "INVALID_DESKTOP_RESPONSE"],
    ["다른 명령", JSON.stringify({ version: "2.6", command: "launch", ok: true, data: {} }), 0, true, "INVALID_DESKTOP_RESPONSE"],
    ["비정상 종료", JSON.stringify({ version: "2.6", command: "click", ok: true, data: {} }), 1, true, "DESKTOP_EXIT"],
    ["시그널 종료", "", 9, false, "DESKTOP_SIGNAL"],
  ])("%s 응답을 성공으로 취급하지 않는다", (_, stdout, status, normalExit, error) => {
    expect(check({ check: "result", stdout, status, normalExit })).toEqual({ error });
  });

  it("명령마다 호출 사용자 소유의 비공개 helper 사본을 만들고 정리한다", () => {
    const home = mkdtempSync(join(tmpdir(), "computer-helper-"));
    const copied = check({ check: "helper", home, data: "verified helper bytes" }).value;
    expect(copied).toMatchObject({ mode: 0o700, owner: process.getuid!(), links: 1, data: "verified helper bytes", removed: true });
    expect(copied.path.startsWith(home + "/.ondra-helper-")).toBe(true);
    expect(readdirSync(home)).toEqual([]);
  });

  it("화면 목록만 배열 데이터를 허용한다", () => {
    const displays = { version: "2.6", command: "list-displays", ok: true, data: [{ id: "1", is_primary: true }] };
    expect(check({ check: "result", command: "list-displays", stdout: JSON.stringify(displays), status: 0, normalExit: true })).toEqual({ value: displays });
    const snapshot = { ...displays, command: "snapshot" };
    expect(check({ check: "result", command: "snapshot", stdout: JSON.stringify(snapshot), status: 0, normalExit: true })).toEqual({ error: "INVALID_DESKTOP_RESPONSE" });
  });

  it("캡처 소유권 없는 스크린샷 성공 경로를 이미지로 전달하지 않는다", () => {
    const envelope = { version: "2.6", command: "screenshot", ok: true, data: { path: "/guest/capture.png" } };
    expect(check({ check: "result", command: "screenshot", stdout: JSON.stringify(envelope), status: 0, normalExit: true }))
      .toEqual({ error: "INVALID_SCREENSHOT_CONTEXT" });
  });

  function pngFixture(width: number, height: number) {
    function chunk(type: string, data: Buffer) {
      const bytes = Buffer.concat([Buffer.from(type), data]);
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
      return Buffer.concat([length, bytes, checksum]);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
  }
  const png = pngFixture(1, 1);
  const screenshotArgv = [...session, "screenshot", "--app", "Calculator"];
  function imageFixture(bytes: Buffer = png, mode = 0o600) {
    const home = mkdtempSync(join(directory, "capture-"));
    const path = join(home, "screenshot.png");
    writeFileSync(path, bytes, { mode });
    chmodSync(path, mode); // the umask may have taken bits off
    return { home, path };
  }
  function screenshotEnvelope(ok = true) {
    return { version: "2.6", command: "screenshot", ok,
      ...(ok ? { data: { path: "/never/read/this/path.png" } } : { error: { code: "PERMISSION_DENIED" } }) };
  }

  it("고정 캡처 PNG를 base64로 반환하고 CLI 경로는 읽거나 반환하지 않는다", () => {
    const home = mkdtempSync(join(directory, "endpoint-"));
    const response = check({ check: "capture", home, argv: screenshotArgv, png: png.toString("base64"),
      stdout: JSON.stringify(screenshotEnvelope()) });
    expect(response.value?.result).toEqual({ version: "2.6", command: "screenshot", ok: true,
      data: { image: { mimeType: "image/png", data: png.toString("base64"), width: 1, height: 1 } } });
    expect(response.value.argv.slice(0, 5)).toEqual(screenshotArgv);
    expect(response.value.argv).toHaveLength(6);
    expect(response.value.argv[5].startsWith(home + "/")).toBe(true);
    expect(response.value.argv[5].slice(home.length)).toMatch(/^\/\.ondra-capture-[A-Za-z0-9]+\/screenshot\.png$/);
    expect(readdirSync(home)).toEqual([]);
  });

  it("CLI 오류이면 이미지를 읽지 않고 오류를 보존하며 캡처 디렉터리를 정리한다", () => {
    const home = mkdtempSync(join(directory, "endpoint-error-"));
    const envelope = screenshotEnvelope(false);
    expect(check({ check: "capture", home, argv: screenshotArgv, stdout: JSON.stringify(envelope), status: 1 })
      .value?.result).toEqual(envelope);
    expect(readdirSync(home)).toEqual([]);
  });

  it("누락된 캡처를 다른 경로로 대체하지 않고 실패 후 정리한다", () => {
    const home = mkdtempSync(join(directory, "endpoint-missing-"));
    expect(check({ check: "capture", home, argv: screenshotArgv, stdout: JSON.stringify(screenshotEnvelope()) }))
      .toEqual({ error: "SCREENSHOT_READ_ERROR" });
    expect(readdirSync(home)).toEqual([]);
  });

  it.each([
    ["빈 파일", Buffer.alloc(0), "SCREENSHOT_LIMIT"],
    ["4 MiB 초과", Buffer.alloc(4 * 1024 * 1024 + 1), "SCREENSHOT_LIMIT"],
    ["PNG 아닌 내용", Buffer.from("guest fixture"), "INVALID_SCREENSHOT_PNG"],
    ["PNG 시그니처만", png.subarray(0, 8), "INVALID_SCREENSHOT_PNG"],
    ["잘린 PNG", png.subarray(0, 40), "INVALID_SCREENSHOT_PNG"],
  ] as const)("%s을 거부한다", (_, bytes, error) => {
    const { home } = imageFixture(bytes);
    expect(check({ check: "image", directory: home })).toEqual({ error });
  });

  it.each([[8193, 1], [1, 8193], [4097, 4096]])("PNG 헤더의 %i×%i 크기를 디코딩 전에 거부한다", (width, height) => {
    const { home } = imageFixture(pngFixture(width, height));
    expect(check({ check: "image", directory: home })).toEqual({ error: "SCREENSHOT_DIMENSION_LIMIT" });
  });

  it("다른 소유자와 공개 읽기 파일을 거부한다", () => {
    const { home } = imageFixture();
    expect(check({ check: "image", directory: home, owner: process.getuid!() + 1 }))
      .toEqual({ error: "UNSAFE_SCREENSHOT_DIRECTORY" });
    const publicFile = imageFixture(png, 0o644);
    expect(check({ check: "image", directory: publicFile.home })).toEqual({ error: "UNSAFE_SCREENSHOT_FILE" });
  });

  it.each(["symlink", "hardlink", "directory", "fifo"])("%s 캡처 파일을 거부한다", kind => {
    const home = mkdtempSync(join(directory, "unsafe-"));
    const path = join(home, "screenshot.png");
    const target = imageFixture();
    if (kind === "symlink") symlinkSync(target.path, path);
    if (kind === "hardlink") linkSync(target.path, path);
    if (kind === "directory") mkdirSync(path, { mode: 0o700 });
    if (kind === "fifo") check({ check: "fifo", path });
    expect(check({ check: "image", directory: home })).toEqual({ error:
      kind === "symlink" ? "SCREENSHOT_READ_ERROR" : "UNSAFE_SCREENSHOT_FILE" });
  });

  it("캡처 디렉터리 심볼릭 링크를 거부한다", () => {
    const { home } = imageFixture();
    const link = join(directory, "capture-directory-link");
    symlinkSync(home, link);
    expect(check({ check: "image", directory: link })).toEqual({ error: "UNSAFE_SCREENSHOT_DIRECTORY" });
  });

  const allowed = [
    ["session", "start", "--no-trace"],
    [...session, "session", "end", "s_test"],
    [...session, "launch", "Calculator"],
    [...session, "snapshot", "--app", "계산기"],
    [...session, "screenshot", "--app", "Calculator"],
    [...session, "click", ref],
    [...session, "set-value", ref, "--", "--headed $(touch /tmp/no); 한글\n"],
    [...session, "set-value", ref, "--", ""],
    [...session, "press", "cmd+shift+a", "--app", "Calculator"],
    [...session, "screenshot", "--screen", "0"],
    [...session, "list-displays"],
    [...session, "type", ref, "--", "--headed $(id) 한글"],
    [...session, "clipboard-set", "--", "-x"],
    [...session, "scroll", ref, "--direction", "left", "--amount", "50"],
    [...session, "mouse-click", "--xy=0,99999", "--button", "right", "--count", "2", "--headed"],
    [...session, "mouse-wheel", "--x=10", "--y=20", "--dx=-50", "--dy=0", "--headed"],
    [...session, "drag", "--from", ref, "--to", ref, "--headed"],
    [...session, "drag", "--from-xy=1,2", "--to-xy=3,4", "--headed"],
    [...session, "drag", "--from", ref, "--to-xy=3,4", "--headed"],
  ];
  it.each(allowed.map(argv => [JSON.stringify(argv), argv] as const))("허용 형식을 변경 없이 유지한다: %s", (_, argv) => {
    expect(check({ check: "argv", argv })).toEqual({ value: argv });
  });

  const denied = [
    ["/bin/sh", "-c", "id"], ["session", "start", "--cursor"], ["snapshot", "--app", "Calculator"],
    [...session, "launch", "Calculator", "--activate"], [...session, "launch", "/bin/sh"],
    [...session, "launch", "Calculator", "--env", "DYLD_INSERT_LIBRARIES=evil"],
    [...session, "--headed", "click", ref], [...session, "click", "@e12"],
    [...session, "click", ref + "\n"], [...session, "click", ref, "--timeout-ms", "0"],
    [...session, "snapshot", "--app", "--headed"],
    [...session, "screenshot", "--app", "Calculator", "/tmp/arbitrary.png"],
    [...session, "screenshot", "--app", "Calculator", "--output", "/tmp/arbitrary.png"],
    [...session, "read", "/tmp/arbitrary.png"],
    [...session, "press", "return"], [...session, "press", "cmd+cmd+a", "--app", "Calculator"],
    [...session, "press", "cmd+a", "--app", "Calculator", "--force"],
    [...session, "set-value", ref, "--headed"], [...session, "set-value", ref, "--", "\0"],
    [...session, "set-value", ref, "--", "x".repeat(65537)],
    [...session, "session", "end", "another"], [...session, "batch", "[]"],
    ["--session", "../escape", "click", ref],
    [...session, "screenshot", "--screen", "1"], [...session, "screenshot"], [...session, "list-displays", "--json"],
    [...session, "type", ref, "text"], [...session, "type", ref, "--", "\0"], [...session, "clipboard-set", "x"],
    [...session, "clipboard-set", "--image", "/tmp/x.png"], [...session, "clipboard-get"],
    [...session, "scroll", ref, "--direction", "in", "--amount", "3"], [...session, "scroll", ref, "--direction", "up", "--amount", "51"],
    [...session, "scroll", ref, "--direction", "up", "--amount", "0"],
    [...session, "mouse-click", "--xy=-1,2", "--button", "left", "--count", "1", "--headed"],
    [...session, "mouse-click", "--xy=1,2", "--button", "middle", "--count", "1", "--headed"],
    [...session, "mouse-click", "--xy=1,2", "--button", "left", "--count", "3", "--headed"],
    [...session, "mouse-click", "--xy=1,2", "--button", "left", "--count", "1"],
    [...session, "mouse-wheel", "--x=10", "--y=20", "--dx=51", "--dy=0", "--headed"],
    [...session, "drag", "--from", ref, "--headed"], [...session, "drag", "--from", ref, "--to", ref],
    [...session, "drag", "--to", ref, "--from", ref, "--headed"], [...session, "drag", "--from", "/tmp/x", "--to", ref, "--headed"],
    [...session, "drag", "--from", ref, "--to", ref, "--duration", "1", "--headed"],
    [...session, "mouse-move", "--xy=1,1", "--headed"], [...session, "key-down", "cmd"],
  ];
  it.each(denied.map((argv, i) => [i, argv] as const))("허용되지 않은 인자 형식 %i을 거부한다", (_, argv) => {
    expect(check({ check: "argv", argv })).toEqual({ error: "INVALID_ARGV" });
  });
});
