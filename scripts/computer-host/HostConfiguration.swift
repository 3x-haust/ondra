import Foundation
import Virtualization
import CryptoKit
import IOKit
import Darwin

struct HostFailure: Error { let code: String }
func requireHost(_ condition: Bool, _ code: String) throws {
    if !condition { throw HostFailure(code: code) }
}
func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

struct LaunchConfiguration: Codable {
    let version: Int
    let vmDirectory: String
    let stateDirectory: String
    let cpuCount: Int
    let memoryBytes: UInt64
    let hardwareModel: Data
    let machineIdentifier: Data
    let macAddress: String
    let width: Int
    let height: Int
    var setupDirectory: String? = nil
    var restoreImage: String? = nil
    var diskBytes: UInt64? = nil

    func validateShape() throws {
        try requireHost(version == 1 && (2...32).contains(cpuCount)
            && memoryBytes >= 4 * 1024 * 1024 * 1024 && memoryBytes <= 128 * 1024 * 1024 * 1024
            && memoryBytes % (1024 * 1024) == 0 && (640...4096).contains(width)
            && (480...4096).contains(height) && !hardwareModel.isEmpty
            && hardwareModel.count <= 4096 && !machineIdentifier.isEmpty
            && machineIdentifier.count <= 4096, "INVALID_CONFIGURATION")
        for path in [vmDirectory, stateDirectory] + [setupDirectory, restoreImage].compactMap({ $0 }) {
            try requireHost(path.hasPrefix("/") && URL(fileURLWithPath: path).standardizedFileURL.path == path
                && URL(fileURLWithPath: path).resolvingSymlinksInPath().path == path,
                "UNSAFE_DIRECTORY")
        }
        guard let mac = VZMACAddress(string: macAddress) else { throw HostFailure(code: "INVALID_MAC") }
        try requireHost(mac.isLocallyAdministeredAddress && mac.isUnicastAddress, "INVALID_MAC")
    }
}

func hostHardwareUUID() throws -> String {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    try requireHost(service != 0, "HOST_IDENTITY_UNAVAILABLE")
    defer { IOObjectRelease(service) }
    guard let value = IORegistryEntryCreateCFProperty(service, "IOPlatformUUID" as CFString,
            kCFAllocatorDefault, 0)?.takeRetainedValue() as? String,
          let uuid = UUID(uuidString: value) else { throw HostFailure(code: "HOST_IDENTITY_UNAVAILABLE") }
    return uuid.uuidString.lowercased()
}

final class LockedFile {
    let fd: Int32
    let path: String
    let initial: stat
    let content: Data?

    /// lock takes an exclusive flock. Virtualization.framework locks the disk image and
    /// auxiliary storage itself and refuses to start if another descriptor holds them.
    init(_ path: String, readContent: Bool = false, writable: Bool = false, lock: Bool = true) throws {
        self.path = path
        fd = open(path, (writable ? O_RDWR : O_RDONLY) | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        try requireHost(fd >= 0, "FILE_UNAVAILABLE")
        var info = stat()
        guard fstat(fd, &info) == 0 && info.st_mode & S_IFMT == S_IFREG
            && info.st_uid == getuid() && info.st_nlink == 1 && info.st_mode & 0o022 == 0
            && (!lock || flock(fd, LOCK_EX | LOCK_NB) == 0) else {
            close(fd)
            throw HostFailure(code: "FILE_BUSY_OR_UNSAFE")
        }
        initial = info
        if readContent {
            guard info.st_size > 0 && info.st_size <= 16384 else {
                close(fd)
                throw HostFailure(code: "CONFIGURATION_LIMIT")
            }
            var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
            let count = pread(fd, &bytes, bytes.count, 0)
            guard count == bytes.count else {
                close(fd)
                throw HostFailure(code: "CONFIGURATION_READ_FAILED")
            }
            content = Data(bytes)
        } else { content = nil }
    }

    func check() throws {
        var current = stat()
        var opened = stat()
        try requireHost(lstat(path, &current) == 0 && fstat(fd, &opened) == 0
            && current.st_dev == initial.st_dev && current.st_ino == initial.st_ino
            && current.st_nlink == 1 && current.st_uid == initial.st_uid
            && current.st_mode == initial.st_mode && opened.st_ino == initial.st_ino,
            "OWNED_FILE_CHANGED")
        if let content {
            try requireHost(current.st_size == initial.st_size, "CONFIGURATION_CHANGED")
            var bytes = [UInt8](repeating: 0, count: content.count)
            try requireHost(pread(fd, &bytes, bytes.count, 0) == bytes.count && Data(bytes) == content,
                            "CONFIGURATION_CHANGED")
        }
    }
    deinit { close(fd) }
}

func privateDirectory(_ path: String) throws {
    var info = stat()
    try requireHost(lstat(path, &info) == 0 && info.st_mode & S_IFMT == S_IFDIR
        && info.st_uid == getuid() && info.st_mode & 0o077 == 0
        && URL(fileURLWithPath: path).resolvingSymlinksInPath().path == path,
        "UNSAFE_DIRECTORY")
}

/// A durable admission fence is created before boot and is never removed automatically.
func reserveMachine(_ configuration: LaunchConfiguration) throws {
    try privateDirectory(configuration.stateDirectory)
    try privateDirectory(configuration.vmDirectory)
    try durableFence(configuration.vmDirectory + "/.ondra-computer.quarantine", directory: configuration.vmDirectory)
    try durableFence(configuration.stateDirectory + "/" + digest(configuration.machineIdentifier) + ".quarantine",
                     directory: configuration.stateDirectory)
}

func durableFence(_ path: String, directory directoryPath: String) throws {
    let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    try requireHost(fd >= 0, "VM_QUARANTINED")
    defer { close(fd) }
    let bytes = Array("owned-run-requires-explicit-recovery\n".utf8)
    try requireHost(bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) } == bytes.count
        && fsync(fd) == 0 && fcntl(fd, F_FULLFSYNC) == 0, "QUARANTINE_WRITE_FAILED")
    let directory = open(directoryPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    try requireHost(directory >= 0, "QUARANTINE_WRITE_FAILED")
    defer { close(directory) }
    try requireHost(fsync(directory) == 0, "QUARANTINE_WRITE_FAILED")
}

func applyIsolatedDevices(_ config: VZVirtualMachineConfiguration, mac: VZMACAddress, width: Int, height: Int) {
    let network = VZVirtioNetworkDeviceConfiguration()
    network.macAddress = mac
    network.attachment = VZNATNetworkDeviceAttachment()
    config.networkDevices = [network]
    let graphics = VZMacGraphicsDeviceConfiguration()
    graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: width, heightInPixels: height,
                                                         pixelsPerInch: 80)]
    config.graphicsDevices = [graphics]
    config.keyboards = [VZUSBKeyboardConfiguration()]
    config.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
    config.directorySharingDevices = []
    config.consoleDevices = []
    config.serialPorts = []
    config.socketDevices = []
    config.audioDevices = []
    config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    config.memoryBalloonDevices = []
    if #available(macOS 15, *) { config.usbControllers = [] }
}

func validateSetupDirectory(_ directory: String, vmDirectory: String) throws {
    try privateDirectory(directory)
    try requireHost(directory == URL(fileURLWithPath: vmDirectory).deletingLastPathComponent().appendingPathComponent("setup").path,
                    "SETUP_DIRECTORY_MISMATCH")
    let required: Set<String> = ["ondra-computer-endpoint", "ondra-computer-provision", "install-setup.sh",
        "agent-desktop", "agent-desktop-macos-helper", "assets.sha256", "client.pub", "provision-client.pub",
        "server-key", "server-key.pub"]
    let names = Set(try FileManager.default.contentsOfDirectory(atPath: directory))
    try requireHost(names == required || names == required.union(["enrollment.json"]), "SETUP_CONTENTS_CHANGED")
    for name in names {
        var info = stat()
        try requireHost(lstat(directory + "/" + name, &info) == 0 && info.st_mode & S_IFMT == S_IFREG
            && info.st_uid == getuid() && info.st_nlink == 1 && info.st_mode & 0o022 == 0, "UNSAFE_SETUP_FILE")
    }
}

func applySetupShare(_ config: VZVirtualMachineConfiguration, directory: String?) throws {
    config.directorySharingDevices = []
    if let directory {
        try privateDirectory(directory)
        let device = VZVirtioFileSystemDeviceConfiguration(tag: VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag)
        device.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: directory), readOnly: true))
        config.directorySharingDevices = [device]
    }
}

func checkSharing(_ devices: [VZDirectorySharingDeviceConfiguration], directory: String?) throws {
    guard let directory else {
        try requireHost(devices.isEmpty, "AUTOMATION_SHARE_FORBIDDEN")
        return
    }
    try privateDirectory(directory)
    guard devices.count == 1, let device = devices[0] as? VZVirtioFileSystemDeviceConfiguration,
          let share = device.share as? VZSingleDirectoryShare else { throw HostFailure(code: "SETUP_SHARE_CHANGED") }
    try requireHost(device.tag == VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag
        && share.directory.isReadOnly && share.directory.url.path == directory, "SETUP_SHARE_CHANGED")
}

func createMachine(_ input: LaunchConfiguration, requirements: VZMacOSConfigurationRequirements) throws -> LaunchConfiguration {
    try privateDirectory(input.vmDirectory)
    try requireHost(input.hardwareModel.isEmpty && input.machineIdentifier.isEmpty
        && input.setupDirectory != nil && input.restoreImage != nil
        && input.cpuCount >= requirements.minimumSupportedCPUCount
        && input.memoryBytes >= requirements.minimumSupportedMemorySize,
        "INVALID_SETUP_CONFIGURATION")
    guard let bytes = input.diskBytes, bytes >= 64 * 1024 * 1024 * 1024,
          bytes <= 1024 * 1024 * 1024 * 1024 else { throw HostFailure(code: "INVALID_DISK_SIZE") }
    let disk = open(input.vmDirectory + "/disk.img", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    try requireHost(disk >= 0, "MACHINE_ALREADY_EXISTS")
    defer { close(disk) }
    try requireHost(ftruncate(disk, off_t(bytes)) == 0 && fsync(disk) == 0, "DISK_CREATE_FAILED")
    let hardware = requirements.hardwareModel
    _ = try VZMacAuxiliaryStorage(creatingStorageAt: URL(fileURLWithPath: input.vmDirectory + "/nvram.bin"),
                                  hardwareModel: hardware, options: [])
    var launch = LaunchConfiguration(version: 1, vmDirectory: input.vmDirectory, stateDirectory: input.stateDirectory,
        cpuCount: input.cpuCount, memoryBytes: input.memoryBytes, hardwareModel: hardware.dataRepresentation,
        machineIdentifier: VZMacMachineIdentifier().dataRepresentation, macAddress: input.macAddress,
        width: input.width, height: input.height)
    launch.setupDirectory = input.setupDirectory
    launch.restoreImage = input.restoreImage
    launch.diskBytes = input.diskBytes
    try launch.validateShape()
    try JSONEncoder().encode(launch).write(to: URL(fileURLWithPath: input.vmDirectory + "/config.json"), options: .withoutOverwriting)
    return launch
}

final class OwnedConfiguration {
    let launch: LaunchConfiguration
    let config: VZVirtualMachineConfiguration
    let files: [LockedFile]
    let hostUUID: String
    let configurationDigest: String

    init(_ launch: LaunchConfiguration) throws {
        try launch.validateShape()
        try privateDirectory(launch.vmDirectory)
        if let directory = launch.setupDirectory { try validateSetupDirectory(directory, vmDirectory: launch.vmDirectory) }
        let configFile = try LockedFile(launch.vmDirectory + "/config.json", readContent: true)
        // The config flock is this runner's ownership; the framework locks disk and NVRAM.
        let disk = try LockedFile(launch.vmDirectory + "/disk.img", writable: true, lock: false)
        let auxiliary = try LockedFile(launch.vmDirectory + "/nvram.bin", writable: true, lock: false)
        guard let hardware = VZMacHardwareModel(dataRepresentation: launch.hardwareModel), hardware.isSupported,
              let machine = VZMacMachineIdentifier(dataRepresentation: launch.machineIdentifier),
              let mac = VZMACAddress(string: launch.macAddress) else { throw HostFailure(code: "INVALID_PLATFORM") }
        self.launch = launch
        files = [configFile, disk, auxiliary]
        hostUUID = try hostHardwareUUID()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        configurationDigest = digest(try encoder.encode(launch))
        let platform = VZMacPlatformConfiguration()
        platform.hardwareModel = hardware
        platform.machineIdentifier = machine
        platform.auxiliaryStorage = VZMacAuxiliaryStorage(contentsOf: URL(fileURLWithPath: auxiliary.path))
        config = VZVirtualMachineConfiguration()
        config.platform = platform
        config.bootLoader = VZMacOSBootLoader()
        config.cpuCount = launch.cpuCount
        config.memorySize = launch.memoryBytes
        config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment:
            try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: disk.path), readOnly: false))]
        applyIsolatedDevices(config, mac: mac, width: launch.width, height: launch.height)
        try applySetupShare(config, directory: launch.setupDirectory)
        try config.validate()
        try check()
        try reserveMachine(launch)
    }

    func check() throws {
        for file in files { try file.check() }
        try requireHost(try hostHardwareUUID() == hostUUID, "HOST_IDENTITY_CHANGED")
        guard let platform = config.platform as? VZMacPlatformConfiguration else {
            throw HostFailure(code: "PLATFORM_CHANGED")
        }
        try checkSharing(config.directorySharingDevices, directory: launch.setupDirectory)
        if let directory = launch.setupDirectory { try validateSetupDirectory(directory, vmDirectory: launch.vmDirectory) }
        try requireHost(platform.machineIdentifier.dataRepresentation == launch.machineIdentifier
            && platform.hardwareModel.dataRepresentation == launch.hardwareModel
            && config.consoleDevices.isEmpty
            && config.serialPorts.isEmpty && config.socketDevices.isEmpty && config.audioDevices.isEmpty
            && config.networkDevices.count == 1
            && config.networkDevices[0].attachment is VZNATNetworkDeviceAttachment
            && config.networkDevices[0].macAddress.string.lowercased() == launch.macAddress.lowercased(),
            "ISOLATION_CHANGED")
    }
}
