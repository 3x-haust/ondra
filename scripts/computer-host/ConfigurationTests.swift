import Foundation
import Virtualization
import Darwin

@main
struct ConfigurationTests {
    static func main() throws {
        let config = VZVirtualMachineConfiguration()
        config.directorySharingDevices = [VZVirtioFileSystemDeviceConfiguration(tag: "test")]
        config.consoleDevices = [VZVirtioConsoleDeviceConfiguration()]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        applyIsolatedDevices(config, mac: VZMACAddress(string: "02:11:22:33:44:55")!, width: 1024, height: 768)
        precondition(config.directorySharingDevices.isEmpty && config.consoleDevices.isEmpty
            && config.serialPorts.isEmpty && config.socketDevices.isEmpty && config.audioDevices.isEmpty)
        precondition(config.networkDevices.count == 1 && config.networkDevices[0].attachment is VZNATNetworkDeviceAttachment)
        precondition(config.graphicsDevices.count == 1)
        print("통과: 실제 VZ 구성에 NAT만 적용하고 공유 장치 제거")
        do { try checkSharing([VZVirtioFileSystemDeviceConfiguration(tag: "unexpected")], directory: nil)
            fatalError("자동화 공유 허용")
        } catch let error as HostFailure { precondition(error.code == "AUTOMATION_SHARE_FORBIDDEN") }

        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let setup = root.appendingPathComponent("setup")
        try FileManager.default.createDirectory(at: setup, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        for name in ["ondra-computer-endpoint", "ondra-computer-provision", "install-setup.sh", "agent-desktop",
                     "agent-desktop-macos-helper", "assets.sha256", "client.pub", "provision-client.pub", "server-key", "server-key.pub"] {
            precondition(FileManager.default.createFile(atPath: setup.appendingPathComponent(name).path,
                contents: Data("fixture".utf8), attributes: [.posixPermissions: 0o600]))
        }
        try validateSetupDirectory(setup.path, vmDirectory: root.appendingPathComponent("machine").path)
        precondition(FileManager.default.createFile(atPath: setup.appendingPathComponent("identity").path,
            contents: Data("not a real key".utf8), attributes: [.posixPermissions: 0o600]))
        do { try validateSetupDirectory(setup.path, vmDirectory: root.appendingPathComponent("machine").path)
            fatalError("호스트 private client key 공유 허용")
        } catch let error as HostFailure { precondition(error.code == "SETUP_CONTENTS_CHANGED") }
        print("통과: 준비 폴더 전용 파일 목록만 허용하고 host private client key는 거부")
        try applySetupShare(config, directory: root.path)
        try checkSharing(config.directorySharingDevices, directory: root.path)
        precondition(config.directorySharingDevices.count == 1)
        let setupDevice = config.directorySharingDevices[0] as! VZVirtioFileSystemDeviceConfiguration
        setupDevice.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: root, readOnly: false))
        do { try checkSharing(config.directorySharingDevices, directory: root.path); fatalError("쓰기 공유 허용") }
        catch let error as HostFailure { precondition(error.code == "SETUP_SHARE_CHANGED") }
        try applySetupShare(config, directory: nil)
        try checkSharing(config.directorySharingDevices, directory: nil)
        precondition(config.directorySharingDevices.isEmpty)
        print("통과: 준비 전용 RO 공유, RW 변조 거부, 자동화 전환 뒤 공유 장치 0")
        let path = root.appendingPathComponent("config.json").path
        FileManager.default.createFile(atPath: path, contents: Data("{}".utf8), attributes: [.posixPermissions: 0o600])
        let locked = try LockedFile(path, readContent: true)
        do { _ = try LockedFile(path); fatalError("배타 잠금 누락") }
        catch let error as HostFailure { precondition(error.code == "FILE_BUSY_OR_UNSAFE") }
        try locked.check()
        try Data("[]".utf8).write(to: URL(fileURLWithPath: path))
        do { try locked.check(); fatalError("구성 변경 감지 누락") }
        catch let error as HostFailure { precondition(error.code == "CONFIGURATION_CHANGED") }
        print("통과: 실제 flock 중복 거부 및 열린 구성 변경 감지")

        let launch = LaunchConfiguration(version: 1, vmDirectory: root.path, stateDirectory: root.path,
            cpuCount: 2, memoryBytes: 4 * 1024 * 1024 * 1024, hardwareModel: Data([1]),
            machineIdentifier: Data([2]), macAddress: "02:11:22:33:44:55", width: 1024, height: 768)
        try launch.validateShape()
        try reserveMachine(launch)
        do { try reserveMachine(launch); fatalError("영속 격리 누락") }
        catch let error as HostFailure { precondition(error.code == "VM_QUARANTINED") }
        precondition(FileManager.default.fileExists(atPath: root.path + "/" + digest(launch.machineIdentifier) + ".quarantine"))
        let other = root.appendingPathComponent("other")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let copiedMachine = LaunchConfiguration(version: 1, vmDirectory: other.path, stateDirectory: root.path,
            cpuCount: 2, memoryBytes: 4 * 1024 * 1024 * 1024, hardwareModel: Data([1]),
            machineIdentifier: Data([2]), macAddress: "02:11:22:33:44:55", width: 1024, height: 768)
        do { try reserveMachine(copiedMachine); fatalError("다른 디렉터리로 격리 우회") }
        catch let error as HostFailure { precondition(error.code == "VM_QUARANTINED") }
        print("통과: 영속 격리 후 같은 VM 및 다른 디렉터리의 동일 머신 재예약 거부")
    }
}
