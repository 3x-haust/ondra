import Foundation
import Darwin
import IOKit
import CryptoKit

struct BootProvisionFailure: Error { let code: String }
func requireBoot(_ condition: Bool, _ code: String) throws {
    if !condition { throw BootProvisionFailure(code: code) }
}
func bootMatches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
}
let bootUUIDPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
let bootHexPattern = "^[0-9a-f]{64}$"
let bootStateDirectory = "/private/var/db/ondra-computer"
let bootGuestHome = "/Users/ondra-computer"
let bootEndpoint = "/usr/local/libexec/ondra-computer-endpoint"
let bootDesktopDirectory = "/usr/local/libexec/ondra-computer/1.1.0"

func decodeBoot<T: Decodable>(_ type: T.Type, data: Data, fields: Set<String>) throws -> T {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == fields else { throw BootProvisionFailure(code: "INVALID_BOOT_DOCUMENT") }
    return try JSONDecoder().decode(type, from: data)
}

struct BootInstallRequest: Codable {
    let version: Int
    let taskId: String
    let hostUuid: String
    let bootNonce: String
    let challenge: String
    let endpointSha256: String
    static func decode(_ data: Data) throws -> Self {
        try decodeBoot(Self.self, data: data, fields: ["version", "taskId", "hostUuid", "bootNonce", "challenge", "endpointSha256"])
    }
}
struct SetupEnrollment: Codable {
    let version: Int
    let hostUuid: String
    let secret: String
    let endpointSha256: String
    static func decode(_ data: Data) throws -> Self {
        try decodeBoot(Self.self, data: data, fields: ["version", "hostUuid", "secret", "endpointSha256"])
    }
    func validate(actualUUID: String) throws {
        try requireBoot(version == 1 && bootMatches(hostUuid, bootUUIDPattern)
            && bootMatches(secret, bootHexPattern) && bootMatches(endpointSha256, bootHexPattern), "INVALID_ENROLLMENT")
        try requireBoot(actualUUID != hostUuid, "HOST_IS_NOT_GUEST")
    }
}

struct AuthenticatedBootRequest: Decodable {
    let secret: String?
    let request: BootInstallRequest
    static func decode(_ data: Data) throws -> Self {
        let value = try decodeBoot(Self.self, data: data, fields: ["secret", "request"])
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let request = object["request"] else { throw BootProvisionFailure(code: "INVALID_BOOT_DOCUMENT") }
        _ = try BootInstallRequest.decode(JSONSerialization.data(withJSONObject: request))
        return value
    }
}

func validateEnrollment(_ envelope: AuthenticatedBootRequest, enrollment: SetupEnrollment, consumed: Bool, actualUUID: String) throws {
    try enrollment.validate(actualUUID: actualUUID)
    try requireBoot(envelope.request.hostUuid == enrollment.hostUuid
        && envelope.request.endpointSha256 == enrollment.endpointSha256, "ENROLLMENT_CHANGED")
    try requireBoot(consumed ? envelope.secret == nil : envelope.secret == enrollment.secret, "ENROLLMENT_SECRET_INVALID")
}

func enrollmentStatus(_ data: Data) throws -> [String: Any] {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == ["op", "challenge"], object["op"] as? String == "status",
          let challenge = object["challenge"] as? String, bootMatches(challenge, bootHexPattern) else {
        throw BootProvisionFailure(code: "INVALID_BOOT_DOCUMENT")
    }
    let directory = "/private/var/db/ondra-computer-enrollment"
    try bootDirectory(directory, mode: 0o700)
    let enrollment = try SetupEnrollment.decode(bootFile(directory + "/enrollment.json", limit: 4096, mode: 0o600))
    let actualUUID = try provisioningHardwareUUID()
    try enrollment.validate(actualUUID: actualUUID)
    return ["version": 1, "challenge": challenge, "hostUuid": enrollment.hostUuid,
        "vmUuid": actualUUID, "bootSessionUuid": try provisioningBootUUID(),
        "endpointSha256": try bootDigest(bootFile(bootEndpoint, limit: 32 * 1024 * 1024, mode: 0o755)),
        "desktopSha256": try bootDigest(bootFile(bootDesktopDirectory + "/agent-desktop", limit: 128 * 1024 * 1024, mode: 0o755)),
        "helperSha256": try bootDigest(bootFile(bootDesktopDirectory + "/agent-desktop-macos-helper", limit: 128 * 1024 * 1024, mode: 0o755)),
        "secretConsumed": try bootFileExists(directory + "/consumed")]
}

/// The validated shutdown request; the caller then starts an orderly guest OS shutdown.
func guestShutdownRequest(_ data: Data) throws -> String {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == ["op", "challenge"], object["op"] as? String == "shutdown",
          let challenge = object["challenge"] as? String, bootMatches(challenge, bootHexPattern) else {
        throw BootProvisionFailure(code: "INVALID_BOOT_DOCUMENT")
    }
    return challenge
}

/// Lets the native owner shut the guest down cleanly on app exit, so its disk is
/// consistent for the next app run. No argument reaches the command.
func shutdownGuest(_ data: Data) throws -> [String: Any] {
    let challenge = try guestShutdownRequest(data)
    let shutdown = Process()
    shutdown.executableURL = URL(fileURLWithPath: "/sbin/shutdown")
    shutdown.arguments = ["-h", "now"]
    shutdown.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
    shutdown.standardInput = FileHandle.nullDevice
    shutdown.standardOutput = FileHandle.nullDevice
    shutdown.standardError = FileHandle.nullDevice
    do { try shutdown.run() } catch { throw BootProvisionFailure(code: "GUEST_SHUTDOWN_FAILED") }
    return ["version": 1, "challenge": challenge, "shutdown": true]
}

func authenticatedGuestBoot(_ envelope: AuthenticatedBootRequest) throws -> [String: Any] {
    let directory = "/private/var/db/ondra-computer-enrollment"
    try bootDirectory(directory, mode: 0o700)
    let enrollment = try SetupEnrollment.decode(bootFile(directory + "/enrollment.json", limit: 4096, mode: 0o600))
    let consumed = try bootFileExists(directory + "/consumed")
    try validateEnrollment(envelope, enrollment: enrollment, consumed: consumed, actualUUID: provisioningHardwareUUID())
    if !consumed {
        try writeBootFile(directory + "/consumed", bytes: Data(envelope.request.challenge.utf8))
        try syncBootDirectory(directory)
    }
    return try installGuestBoot(envelope.request)
}

struct BootProvision: Codable {
    let version: Int
    let taskId: String
    let vmUuid: String
    let hostUuid: String
    let guestUid: UInt32
    static func decode(_ data: Data) throws -> Self {
        try decodeBoot(Self.self, data: data, fields: ["version", "taskId", "vmUuid", "hostUuid", "guestUid"])
    }
}
struct BootState: Codable {
    let version: Int
    let vmUuid: String
    let bootNonce: String
    let bootSessionUuid: String
    static func decode(_ data: Data) throws -> Self {
        try decodeBoot(Self.self, data: data, fields: ["version", "vmUuid", "bootNonce", "bootSessionUuid"])
    }
}
struct BootInstallPlan {
    let provision: BootProvision
    let boot: BootState

    init(request: BootInstallRequest, actualUUID: String, currentBoot: String, guestUid: UInt32,
         endpointDigest: String, previousProvision: BootProvision?, previousBoot: BootState?) throws {
        try requireBoot(request.version == 1 && bootMatches(request.taskId, "^[a-zA-Z0-9_-]{1,128}$")
            && bootMatches(request.hostUuid, bootUUIDPattern) && bootMatches(actualUUID, bootUUIDPattern)
            && bootMatches(currentBoot, bootUUIDPattern) && bootMatches(request.bootNonce, bootHexPattern)
            && bootMatches(request.challenge, bootHexPattern) && request.challenge != request.bootNonce
            && bootMatches(request.endpointSha256, bootHexPattern) && guestUid >= 501, "INVALID_BOOT_REQUEST")
        try requireBoot(request.hostUuid != actualUUID, "HOST_IS_NOT_GUEST")
        try requireBoot(endpointDigest == request.endpointSha256, "ENDPOINT_BUILD_CHANGED")
        try requireBoot((previousProvision == nil) == (previousBoot == nil), "INCOMPLETE_PREVIOUS_INSTALL")
        if let old = previousBoot, let provision = previousProvision {
            try requireBoot(old.version == 1 && provision.version == 1
                && old.vmUuid == actualUUID && provision.vmUuid == actualUUID
                && provision.hostUuid == request.hostUuid && provision.guestUid == guestUid
                && bootMatches(old.bootSessionUuid, bootUUIDPattern) && bootMatches(old.bootNonce, bootHexPattern),
                "PREVIOUS_INSTALL_CHANGED")
            try requireBoot(old.bootSessionUuid != currentBoot, "BOOT_ALREADY_PROVISIONED")
            try requireBoot(old.bootNonce != request.bootNonce, "BOOT_NONCE_REUSED")
        }
        provision = BootProvision(version: 1, taskId: request.taskId, vmUuid: actualUUID,
            hostUuid: request.hostUuid, guestUid: guestUid)
        boot = BootState(version: 1, vmUuid: actualUUID, bootNonce: request.bootNonce, bootSessionUuid: currentBoot)
    }
}

func provisioningHardwareUUID() throws -> String {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    try requireBoot(service != 0, "GUEST_IDENTITY_UNAVAILABLE")
    defer { IOObjectRelease(service) }
    guard let value = IORegistryEntryCreateCFProperty(service, "IOPlatformUUID" as CFString,
            kCFAllocatorDefault, 0)?.takeRetainedValue() as? String,
          let uuid = UUID(uuidString: value) else { throw BootProvisionFailure(code: "GUEST_IDENTITY_UNAVAILABLE") }
    return uuid.uuidString.lowercased()
}
func provisioningBootUUID() throws -> String {
    var size = 0
    try requireBoot(sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0 && size > 1 && size <= 128,
                    "BOOT_IDENTITY_UNAVAILABLE")
    var buffer = [CChar](repeating: 0, count: size)
    try requireBoot(sysctlbyname("kern.bootsessionuuid", &buffer, &size, nil, 0) == 0, "BOOT_IDENTITY_UNAVAILABLE")
    let value = String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self).lowercased()
    try requireBoot(bootMatches(value, bootUUIDPattern), "BOOT_IDENTITY_UNAVAILABLE")
    return value
}
func bootDirectory(_ path: String, owner: uid_t = 0, mode: mode_t? = nil) throws {
    var current = ""
    let parts = path.split(separator: "/")
    for (index, part) in parts.enumerated() {
        current += "/" + part
        var info = stat()
        let last = index == parts.count - 1
        try requireBoot(lstat(current, &info) == 0 && info.st_mode & S_IFMT == S_IFDIR
            && info.st_uid == (last ? owner : 0) && info.st_mode & 0o022 == 0, "UNSAFE_INSTALL_DIRECTORY")
        if last, let mode { try requireBoot(info.st_mode & 0o7777 == mode, "UNSAFE_INSTALL_DIRECTORY") }
    }
}
func bootFile(_ path: String, limit: Int, mode: mode_t) throws -> Data {
    try bootDirectory(URL(fileURLWithPath: path).deletingLastPathComponent().path)
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    try requireBoot(fd >= 0, "INSTALL_FILE_UNAVAILABLE")
    defer { close(fd) }
    var info = stat()
    try requireBoot(fstat(fd, &info) == 0 && info.st_mode & S_IFMT == S_IFREG
        && info.st_uid == 0 && info.st_gid == 0 && info.st_mode & 0o7777 == mode
        && info.st_nlink == 1 && info.st_size > 0 && info.st_size <= limit, "UNSAFE_INSTALL_FILE")
    var bytes = [UInt8](repeating: 0, count: Int(info.st_size) + 1)
    let count = pread(fd, &bytes, bytes.count, 0)
    try requireBoot(count == info.st_size, "INSTALL_FILE_CHANGED")
    return Data(bytes.prefix(count))
}
func bootDigest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

// All files are prepared in the protected state directory. A failed transaction
// retains its per-boot fence; it is never retried over a potentially active lease.
func writeBootFile(_ path: String, bytes: Data) throws {
    let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    try requireBoot(fd >= 0, "BOOT_INSTALL_FENCED")
    defer { close(fd) }
    try requireBoot(bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) } == bytes.count
        && fchmod(fd, 0o644) == 0 && fsync(fd) == 0 && fcntl(fd, F_FULLFSYNC) == 0, "BOOT_WRITE_FAILED")
}
func syncBootDirectory(_ path: String) throws {
    let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    try requireBoot(fd >= 0, "BOOT_WRITE_FAILED")
    defer { close(fd) }
    try requireBoot(fsync(fd) == 0, "BOOT_WRITE_FAILED")
}
func bootFileExists(_ path: String) throws -> Bool {
    var info = stat()
    if lstat(path, &info) == 0 { return true }
    try requireBoot(errno == ENOENT, "INSTALL_FILE_UNAVAILABLE")
    return false
}

func installGuestBoot(_ request: BootInstallRequest) throws -> [String: Any] {
    try requireBoot(getuid() == 0 && geteuid() == 0 && getgid() == 0, "GUEST_ROOT_REQUIRED")
    let actualUUID = try provisioningHardwareUUID()
    let currentBoot = try provisioningBootUUID()
    // Refuse the host before creating directories or reading installed assets.
    try requireBoot(actualUUID != request.hostUuid, "HOST_IS_NOT_GUEST")
    guard let account = getpwnam("ondra-computer"), account.pointee.pw_uid >= 501,
          String(cString: account.pointee.pw_dir) == bootGuestHome else {
        throw BootProvisionFailure(code: "GUEST_ACCOUNT_REQUIRED")
    }
    let guestUid = account.pointee.pw_uid
    try bootDirectory(bootGuestHome, owner: guestUid, mode: 0o700)
    let endpointDigest = try bootDigest(bootFile(bootEndpoint, limit: 32 * 1024 * 1024, mode: 0o755))
    #if arch(arm64)
    let expectedDesktop = "a89c781a3b2cf29bc0467c30a4e1063b6f564858540f2dc58a75c79ce2c9d9f3"
    let expectedHelper = "d81e5aa7ad8edb0e3eda72f010b1947ce7d6ad6d6d4ae95a69f4cce39bbbfe63"
    #else
    throw BootProvisionFailure(code: "UNSUPPORTED_GUEST_ARCHITECTURE")
    #endif
    let desktopDigest = try bootDigest(bootFile(bootDesktopDirectory + "/agent-desktop", limit: 128 * 1024 * 1024, mode: 0o755))
    let helperDigest = try bootDigest(bootFile(bootDesktopDirectory + "/agent-desktop-macos-helper", limit: 128 * 1024 * 1024, mode: 0o755))
    try requireBoot(desktopDigest == expectedDesktop && helperDigest == expectedHelper, "DESKTOP_BUILD_CHANGED")
    // Validate before the first filesystem mutation, including first enrollment.
    _ = try BootInstallPlan(request: request, actualUUID: actualUUID, currentBoot: currentBoot,
        guestUid: guestUid, endpointDigest: endpointDigest, previousProvision: nil, previousBoot: nil)
    try bootDirectory("/private/var/db")
    if mkdir(bootStateDirectory, 0o755) == 0 {
        try requireBoot(chmod(bootStateDirectory, 0o755) == 0, "BOOT_WRITE_FAILED")
    } else { try requireBoot(errno == EEXIST, "BOOT_WRITE_FAILED") }
    try bootDirectory(bootStateDirectory, mode: 0o755)
    let lock = open(bootStateDirectory + "/.provision.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
    try requireBoot(lock >= 0, "BOOT_INSTALL_BUSY")
    defer { close(lock) }
    var info = stat()
    try requireBoot(fstat(lock, &info) == 0 && info.st_mode & S_IFMT == S_IFREG && info.st_uid == 0
        && info.st_gid == 0 && info.st_mode & 0o7777 == 0o600 && info.st_nlink == 1
        && flock(lock, LOCK_EX | LOCK_NB) == 0, "BOOT_INSTALL_BUSY")
    let provisionPath = bootStateDirectory + "/provision.json"
    let bootPath = bootStateDirectory + "/boot.json"
    let oldProvision = try bootFileExists(provisionPath) ? BootProvision.decode(bootFile(provisionPath, limit: 4096, mode: 0o644)) : nil
    let oldBoot = try bootFileExists(bootPath) ? BootState.decode(bootFile(bootPath, limit: 4096, mode: 0o644)) : nil
    let plan = try BootInstallPlan(request: request, actualUUID: actualUUID, currentBoot: currentBoot,
        guestUid: guestUid, endpointDigest: endpointDigest, previousProvision: oldProvision, previousBoot: oldBoot)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    try writeBootFile(bootStateDirectory + "/.installed-" + currentBoot, bytes: Data("reserved\n".utf8))
    try syncBootDirectory(bootStateDirectory)
    try writeBootFile(provisionPath + ".next", bytes: encoder.encode(plan.provision))
    try writeBootFile(bootPath + ".next", bytes: encoder.encode(plan.boot))
    try requireBoot(try provisioningHardwareUUID() == actualUUID && provisioningBootUUID() == currentBoot,
                    "BOOT_CHANGED_DURING_INSTALL")
    try requireBoot(rename(provisionPath + ".next", provisionPath) == 0, "BOOT_WRITE_FAILED")
    try syncBootDirectory(bootStateDirectory)
    // The previous boot is already invalid. boot.json is the last commit point.
    try requireBoot(rename(bootPath + ".next", bootPath) == 0, "BOOT_WRITE_FAILED")
    try syncBootDirectory(bootStateDirectory)
    return ["version": 1, "challenge": request.challenge, "vmUuid": actualUUID,
        "bootSessionUuid": currentBoot, "endpointSha256": endpointDigest,
        "desktopSha256": desktopDigest, "helperSha256": helperDigest]
}
