import Foundation
import Darwin

@main
struct GuestBootInstaller {
    static func input() throws -> Data {
        let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
        var data = Data()
        while data.count <= 4096 {
            let now = DispatchTime.now().uptimeNanoseconds
            try requireBoot(now < deadline, "BOOT_INPUT_TIMEOUT")
            var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, Int32((deadline - now) / 1_000_000))
            if ready < 0 && errno == EINTR { continue }
            try requireBoot(ready > 0, "BOOT_INPUT_TIMEOUT")
            var byte: UInt8 = 0
            let count = Darwin.read(STDIN_FILENO, &byte, 1)
            if count < 0 && errno == EINTR { continue }
            try requireBoot(count >= 0, "BOOT_INPUT_FAILED")
            if count == 0 { return data }
            data.append(byte)
        }
        throw BootProvisionFailure(code: "BOOT_INPUT_LIMIT")
    }
    static func main() {
        umask(0o077)
        signal(SIGPIPE, SIG_IGN)
        do {
            try requireBoot(CommandLine.arguments.count == 2, "INVALID_INVOCATION")
            try requireBoot(getuid() == 0 && geteuid() == 0 && getgid() == 0, "GUEST_ROOT_REQUIRED")
            let receipt: [String: Any]
            switch CommandLine.arguments[1] {
            case "--check-setup":
                let enrollment = try SetupEnrollment.decode(input())
                try enrollment.validate(actualUUID: provisioningHardwareUUID())
                receipt = ["version": 1, "ok": true]
            case "--authenticated-boot":
                let data = try input()
                let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                if object?["op"] as? String == "status" { receipt = try enrollmentStatus(data) }
                else if object?["op"] as? String == "shutdown" { receipt = try shutdownGuest(data) }
                else { receipt = try authenticatedGuestBoot(AuthenticatedBootRequest.decode(data)) }
            case "--install-boot":
                receipt = try installGuestBoot(BootInstallRequest.decode(input()))
            default: throw BootProvisionFailure(code: "INVALID_INVOCATION")
            }
            let data = try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])
            try FileHandle.standardOutput.write(contentsOf: data + Data([10]))
        } catch {
            let code = (error as? BootProvisionFailure)?.code ?? "BOOT_INSTALL_FAILED"
            let response: [String: Any] = ["version": 1, "ok": false, "error": ["code": code]]
            if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) {
                try? FileHandle.standardError.write(contentsOf: data + Data([10]))
            }
            exit(64)
        }
    }
}
