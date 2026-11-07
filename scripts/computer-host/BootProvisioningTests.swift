import Foundation
import Darwin

@main
struct BootProvisioningTests {
    static let host = "10000000-0000-4000-8000-000000000001"
    static let guest = "20000000-0000-4000-8000-000000000002"
    static let oldBoot = "30000000-0000-4000-8000-000000000003"
    static let newBoot = "40000000-0000-4000-8000-000000000004"
    static let hash = String(repeating: "a", count: 64)

    static func request(nonce: String = String(repeating: "b", count: 64), hostUuid: String = host) -> BootInstallRequest {
        BootInstallRequest(version: 1, taskId: "task_1", hostUuid: hostUuid, bootNonce: nonce,
            challenge: String(repeating: "c", count: 64), endpointSha256: hash)
    }
    static func refuses(_ code: String, _ action: () throws -> Void) {
        do { try action(); fatalError("거부 누락: \(code)") }
        catch let error as BootProvisionFailure { precondition(error.code == code, error.code) }
        catch { fatalError("예상하지 않은 오류: \(error)") }
    }
    static func main() throws {
        let enrollment = SetupEnrollment(version: 1, hostUuid: host, secret: hash, endpointSha256: hash)
        try validateEnrollment(AuthenticatedBootRequest(secret: hash, request: request()),
            enrollment: enrollment, consumed: false, actualUUID: guest)
        try validateEnrollment(AuthenticatedBootRequest(secret: nil, request: request()),
            enrollment: enrollment, consumed: true, actualUUID: guest)
        refuses("ENROLLMENT_SECRET_INVALID") {
            try validateEnrollment(AuthenticatedBootRequest(secret: nil, request: request()),
                enrollment: enrollment, consumed: false, actualUUID: guest)
        }
        refuses("ENROLLMENT_SECRET_INVALID") {
            try validateEnrollment(AuthenticatedBootRequest(secret: hash, request: request()),
                enrollment: enrollment, consumed: true, actualUUID: guest)
        }
        refuses("HOST_IS_NOT_GUEST") { try enrollment.validate(actualUUID: host) }
        refuses("ENROLLMENT_CHANGED") {
            try validateEnrollment(AuthenticatedBootRequest(secret: hash, request: request(hostUuid: newBoot)),
                enrollment: enrollment, consumed: false, actualUUID: guest)
        }
        print("통과: 최초 일회성 비밀·소비 후 재사용 거부·호스트와 설치 결합")
        let challenge = String(repeating: "e", count: 64)
        let accepted = try guestShutdownRequest(Data(#"{"op":"shutdown","challenge":"\#(challenge)"}"#.utf8))
        precondition(accepted == challenge)
        for bad in [#"{"op":"shutdown"}"#, #"{"op":"shutdown","challenge":"x"}"#,
                    #"{"op":"shutdown","challenge":"\#(challenge)","when":"later"}"#] {
            do { _ = try guestShutdownRequest(Data(bad.utf8)); fatalError("종료 요청 검증 누락") }
            catch let error as BootProvisionFailure { precondition(error.code == "INVALID_BOOT_DOCUMENT") }
        }
        print("통과: 게스트 종료 요청은 정확한 형태만 허용")
        let initial = try BootInstallPlan(request: request(), actualUUID: guest, currentBoot: oldBoot,
            guestUid: 501, endpointDigest: hash, previousProvision: nil, previousBoot: nil)
        let renewed = try BootInstallPlan(request: request(nonce: String(repeating: "d", count: 64)),
            actualUUID: guest, currentBoot: newBoot, guestUid: 501, endpointDigest: hash,
            previousProvision: initial.provision, previousBoot: initial.boot)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        for plan in [initial, renewed] {
            let provision = try object(encoder.encode(plan.provision))
            let boot = try object(encoder.encode(plan.boot))
            let identity = try validateIdentity(provision, boot, actualUUID: guest, currentBoot: plan.boot.bootSessionUuid,
                uid: 501, effectiveUid: 501)
            precondition(identity.taskId == "task_1" && identity.bootNonce == plan.boot.bootNonce && identity.vmUuid == guest)
        }
        do {
            _ = try validateIdentity(object(encoder.encode(initial.provision)), object(encoder.encode(initial.boot)),
                actualUUID: guest, currentBoot: newBoot, uid: 501, effectiveUid: 501)
            fatalError("이전 부팅 신원 허용")
        } catch let refusal as Refusal { precondition(refusal.code == "STALE_BOOT_IDENTITY") }
        print("통과: 설치 상태가 실제 endpoint 계약에 맞고 이전 부팅은 거부됨")

        refuses("HOST_IS_NOT_GUEST") {
            _ = try BootInstallPlan(request: request(), actualUUID: host, currentBoot: oldBoot,
                guestUid: 501, endpointDigest: hash, previousProvision: nil, previousBoot: nil)
        }
        refuses("ENDPOINT_BUILD_CHANGED") {
            _ = try BootInstallPlan(request: request(), actualUUID: guest, currentBoot: oldBoot,
                guestUid: 501, endpointDigest: String(repeating: "0", count: 64), previousProvision: nil, previousBoot: nil)
        }
        refuses("BOOT_ALREADY_PROVISIONED") {
            _ = try BootInstallPlan(request: request(nonce: String(repeating: "d", count: 64)),
                actualUUID: guest, currentBoot: oldBoot, guestUid: 501, endpointDigest: hash,
                previousProvision: initial.provision, previousBoot: initial.boot)
        }
        refuses("BOOT_NONCE_REUSED") {
            _ = try BootInstallPlan(request: request(), actualUUID: guest, currentBoot: newBoot,
                guestUid: 501, endpointDigest: hash, previousProvision: initial.provision, previousBoot: initial.boot)
        }
        refuses("PREVIOUS_INSTALL_CHANGED") {
            _ = try BootInstallPlan(request: request(hostUuid: newBoot), actualUUID: guest, currentBoot: newBoot,
                guestUid: 501, endpointDigest: hash, previousProvision: initial.provision, previousBoot: initial.boot)
        }
        refuses("INCOMPLETE_PREVIOUS_INSTALL") {
            _ = try BootInstallPlan(request: request(), actualUUID: guest, currentBoot: newBoot,
                guestUid: 501, endpointDigest: hash, previousProvision: initial.provision, previousBoot: nil)
        }
        refuses("INVALID_BOOT_REQUEST") {
            _ = try BootInstallPlan(request: request(nonce: "short"), actualUUID: guest, currentBoot: oldBoot,
                guestUid: 501, endpointDigest: hash, previousProvision: nil, previousBoot: nil)
        }
        var injected = try object(encoder.encode(request()))
        injected["verified"] = true
        refuses("INVALID_BOOT_DOCUMENT") {
            _ = try BootInstallRequest.decode(JSONSerialization.data(withJSONObject: injected))
        }
        print("통과: 호스트·변경 빌드·같은 부팅·nonce 재사용·불완전 설치·추가 증거 필드 거부")

        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let path = root.appendingPathComponent("boot.json.next").path
        try writeBootFile(path, bytes: encoder.encode(initial.boot))
        try syncBootDirectory(root.path)
        let stored = try BootState.decode(Data(contentsOf: URL(fileURLWithPath: path)))
        precondition(stored.bootNonce == initial.boot.bootNonce)
        var info = stat()
        precondition(lstat(path, &info) == 0 && info.st_mode & 0o7777 == 0o644)
        refuses("BOOT_INSTALL_FENCED") { try writeBootFile(path, bytes: Data("replacement".utf8)) }
        let link = root.appendingPathComponent("link").path
        precondition(symlink(path, link) == 0)
        refuses("BOOT_INSTALL_FENCED") { try writeBootFile(link, bytes: Data("replacement".utf8)) }
        let finalBytes = try Data(contentsOf: URL(fileURLWithPath: path))
        let expectedBytes = try encoder.encode(initial.boot)
        precondition(finalBytes == expectedBytes)
        print("통과: 임시 파일 durable 쓰기·정확한 mode·중복 및 symlink 덮어쓰기 거부")
    }
}
