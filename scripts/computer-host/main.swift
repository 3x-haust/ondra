import Foundation
import Virtualization
import Darwin
import AppKit

func frame(timeoutSeconds: Int32) throws -> Data {
    let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeoutSeconds) * 1_000_000_000
    var data = Data()
    while data.count <= 16384 {
        let now = DispatchTime.now().uptimeNanoseconds
        try requireHost(now < deadline, "OWNER_TIMEOUT")
        var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
        let result = poll(&descriptor, 1, Int32(min((deadline - now) / 1_000_000, UInt64(Int32.max))))
        if result < 0 && errno == EINTR { continue }
        try requireHost(result > 0, "OWNER_TIMEOUT")
        var byte: UInt8 = 0
        let count = Darwin.read(STDIN_FILENO, &byte, 1)
        if count < 0 && errno == EINTR { continue }
        try requireHost(count == 1, "OWNER_EOF")
        if byte == 10 { return data }
        data.append(byte)
    }
    throw HostFailure(code: "FRAME_LIMIT")
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { exit(70) }
    do { try FileHandle.standardOutput.write(contentsOf: data + Data([10])) }
    catch { exit(74) }
}

final class Runner: NSObject, VZVirtualMachineDelegate {
    let owned: OwnedConfiguration
    let vm: VZVirtualMachine
    private var stopping = false
    private var viewer: NSWindow?
    private var installer: VZMacOSInstaller?

    func openViewer() throws {
        try requireHost(owned.launch.setupDirectory != nil && vm.state == .running, "SETUP_VIEWER_UNAVAILABLE")
        if viewer == nil {
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let view = VZVirtualMachineView(frame: NSRect(x: 0, y: 0, width: 1024, height: 768))
            view.virtualMachine = vm
            view.capturesSystemKeys = false
            let window = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable, .resizable],
                                  backing: .buffered, defer: false)
            window.title = "Ondra — 최초 게스트 준비"
            window.contentView = view
            window.isReleasedWhenClosed = false
            viewer = window
        }
        viewer?.orderFront(nil)
    }

    init(_ owned: OwnedConfiguration) {
        self.owned = owned
        vm = VZVirtualMachine(configuration: owned.config)
        super.init()
        vm.delegate = self
    }

    func inspect(_ id: String) throws {
        try owned.check()
        let shareCount = owned.launch.setupDirectory == nil ? 0 : 1
        try requireHost(vm.state == .running && vm.directorySharingDevices.count == shareCount
            && vm.consoleDevices.isEmpty && vm.socketDevices.isEmpty, "VM_NOT_OWNED_RUNNING")
        let launch = try JSONSerialization.jsonObject(with: JSONEncoder().encode(owned.launch))
        emit(["version": 1, "id": id, "state": "running", "hostUuid": owned.hostUUID,
              "machineIdentifierSha256": digest(owned.launch.machineIdentifier),
              "configurationSha256": owned.configurationDigest, "sharingDevices": shareCount,
              "macAddress": owned.launch.macAddress, "launch": launch])
    }

    func terminate(_ code: String) {
        guard !stopping else { return }
        stopping = true
        emit(["version": 1, "event": "revoked", "code": code])
        // The fence is durable even if the framework cannot finish stopping.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { exit(75) }
        if vm.canStop { vm.stop { _ in exit(0) } }
        else { exit(75) }
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) { terminate("GUEST_STOPPED") }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        terminate("VM_STOPPED")
    }

    func installThenStart() {
        guard let path = owned.launch.restoreImage else { start(); return }
        let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: URL(fileURLWithPath: path))
        self.installer = installer
        installer.install { result in
            switch result {
            case .failure: self.terminate("OS_INSTALL_FAILED")
            case .success: self.installer = nil; self.start()
            }
        }
    }

    func start() {
        vm.start { result in
            switch result {
            case .failure: self.terminate("VM_START_FAILED")
            case .success:
                do { try self.inspect("ready") }
                catch { self.terminate("OWNERSHIP_CHECK_FAILED"); return }
                DispatchQueue.global(qos: .utility).async {
                    while true {
                        do {
                            let data = try frame(timeoutSeconds: 10)
                            guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                                  Set(value.keys) == ["version", "id", "op"],
                                  let version = value["version"] as? Int, version == 1,
                                  let id = value["id"] as? String, id.count <= 64,
                                  let op = value["op"] as? String, ["inspect", "stop", "viewer"].contains(op) else {
                                throw HostFailure(code: "INVALID_REQUEST")
                            }
                            DispatchQueue.main.sync {
                                if op == "stop" { self.terminate("OWNER_RELEASED") }
                                else {
                                    do {
                                        if op == "viewer" { try self.openViewer() }
                                        try self.inspect(id)
                                    }
                                    catch { self.terminate("OWNERSHIP_CHECK_FAILED") }
                                }
                            }
                        } catch {
                            DispatchQueue.main.async { self.terminate("OWNER_CHANNEL_LOST") }
                            return
                        }
                    }
                }
            }
        }
    }
}

signal(SIGPIPE, SIG_IGN)
umask(0o077)
let ownerPID = getppid()
let ownerWatch = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
ownerWatch.schedule(deadline: .now() + 1, repeating: 1)
ownerWatch.setEventHandler {
    // Parent disappearance revokes ownership even while the OS installer is busy.
    if getppid() != ownerPID { exit(75) }
}
ownerWatch.resume()
// No attach operation or clipboard service. The viewer is setup-only and owner-requested.
var retainedRunner: Runner?
func launchRunner(_ launch: LaunchConfiguration) {
    do {
        let runner = Runner(try OwnedConfiguration(launch))
        retainedRunner = runner
        runner.installThenStart()
    } catch {
        emit(["version": 1, "event": "revoked", "code": (error as? HostFailure)?.code ?? "HOST_START_FAILED"])
        exit(64)
    }
}
do {
    try requireHost(CommandLine.arguments == [CommandLine.arguments[0], "--owned-stdio"], "INVALID_INVOCATION")
    let launch = try JSONDecoder().decode(LaunchConfiguration.self, from: frame(timeoutSeconds: 5))
    if let image = launch.restoreImage {
        try privateDirectory(launch.vmDirectory)
        try requireHost(URL(fileURLWithPath: image).resolvingSymlinksInPath().path == image, "UNSAFE_RESTORE_IMAGE")
        VZMacOSRestoreImage.load(from: URL(fileURLWithPath: image)) { result in
            DispatchQueue.main.async {
                do {
                    let image = try result.get()
                    guard let requirements = image.mostFeaturefulSupportedConfiguration else {
                        throw HostFailure(code: "UNSUPPORTED_RESTORE_IMAGE")
                    }
                    launchRunner(try createMachine(launch, requirements: requirements))
                } catch {
                    emit(["version": 1, "event": "revoked", "code": "MACHINE_CREATE_FAILED"])
                    exit(64)
                }
            }
        }
    } else { launchRunner(launch) }
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.run()
} catch {
    emit(["version": 1, "event": "revoked", "code": (error as? HostFailure)?.code ?? "HOST_START_FAILED"])
    exit(64)
}
