// ondra-simhelper — live screen and input for iOS simulators, without Simulator.app.
//
// Adapted from tapflow's ios-agent helpers (https://github.com/jo-duchan/tapflow,
// packages/ios-agent/src/{screencapture,touch,keyboard,rotation}-helper.swift, MIT),
// which include logic derived from baguette (https://github.com/tddworks/baguette),
// licensed under the Apache License, Version 2.0:
//
//   Licensed under the Apache License, Version 2.0 (the "License"); you may not use
//   this file except in compliance with the License. You may obtain a copy of the
//   License at http://www.apache.org/licenses/LICENSE-2.0
//   Unless required by applicable law or agreed to in writing, software distributed
//   under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
//   CONDITIONS OF ANY KIND, either express or implied. See the License for the
//   specific language governing permissions and limitations under the License.
//
// Changes for Ondra: one binary with four modes, JPEG only (downscaled while
// encoding), a "ready" line on stdout for the touch mode, and every mode quits
// when its parent closes stdin.
//
// Build: src-tauri/helpers/build.sh  (→ src-tauri/binaries/ondra-simhelper-<triple>)
//
// Usage:
//   ondra-simhelper stream <udid> <fps> <maxPixels>
//       stdout: [u32 big-endian length][JPEG bytes] ... ; unchanged screens are skipped
//   ondra-simhelper touch <udid>
//       stdout: "ready\n" once input can be sent; stdin: tapflow's touch frames
//         types 1-5,9-11: 9 bytes  [type:u8][a:f32/u32 BE][b:f32/u32 BE]
//         types 6-8     : 17 bytes [type:u8][x1][y1][x2][y2] (f32 BE)
//         1 down, 2 move, 3 up (x,y 0..1) · 4 HID button (page, usage) · 5 legacy button (0 home, 1 lock)
//         6/7/8 pinch · 9 key ([0]=modifiers, [4..8]=usage, page 7) · 10/11 HID button down/up
//   ondra-simhelper keyboard <show|hide> <udid>
//   ondra-simhelper rotate <portrait|landscapeLeft|landscapeRight|portraitUpsideDown> <udid>

import Foundation
import IOSurface
import CoreVideo
import CoreGraphics
import ImageIO
import ObjectiveC

setvbuf(stdout, nil, _IOFBF, 1 << 16)
signal(SIGPIPE, SIG_IGN)

func die(_ msg: String) -> Never {
    fputs("error: \(msg)\n", stderr)
    exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let mode = args.first else { die("usage: ondra-simhelper <stream|touch|keyboard|rotate> ...") }

// MARK: - Frameworks

// Xcode ≤26 ships SimulatorKit inside the developer dir; Xcode 27 moved it to
// Contents/SharedFrameworks. Both are probed on the selected Xcode first, then any
// other Xcode in /Applications.
func simulatorKitCandidates(_ developerDir: String) -> [String] {
    let contents = (developerDir as NSString).deletingLastPathComponent
    return [
        (developerDir as NSString).appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"),
        (contents as NSString).appendingPathComponent("SharedFrameworks/SimulatorKit.framework/SimulatorKit"),
    ]
}

func findSimulatorKit() -> (developerDir: String, path: String?) {
    let defaultDir = "/Applications/Xcode.app/Contents/Developer"
    func probe(_ d: String) -> String? { simulatorKitCandidates(d).first { FileManager.default.fileExists(atPath: $0) } }
    let pipe = Pipe()
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    task.arguments = ["-p"]
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    do { try task.run() } catch { return (defaultDir, probe(defaultDir)) }
    task.waitUntilExit()
    let dir = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !dir.isEmpty, let path = probe(dir) { return (dir, path) }
    // xcode-select may point at the Command Line Tools, which lack SimulatorKit
    let apps = (try? FileManager.default.contentsOfDirectory(atPath: "/Applications")) ?? []
    for app in apps.sorted() where app.hasPrefix("Xcode") && app.hasSuffix(".app") {
        let d = "/Applications/\(app)/Contents/Developer"
        if d != dir, let path = probe(d) { return (d, path) }
    }
    return (dir.isEmpty ? defaultDir : dir, nil)
}

let simulatorKit = findSimulatorKit()
let developerDir = simulatorKit.developerDir

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW | RTLD_GLOBAL) != nil else {
    die("CoreSimulator load failed: \(dlerror().map { String(cString: $0) } ?? "?")")
}

/// SimulatorKit is needed for the screen and touches, not for keyboard or rotation.
func loadSimulatorKit() -> UnsafeMutableRawPointer {
    guard let path = simulatorKit.path else { die("SimulatorKit not found — is Xcode installed?") }
    guard let h = dlopen(path, RTLD_NOW | RTLD_GLOBAL) else {
        die("SimulatorKit load failed: \(dlerror().map { String(cString: $0) } ?? "?")")
    }
    return h
}

// MARK: - ObjC runtime helpers

func classInvoke(_ cls: AnyClass, _ sel: Selector, _ arg: AnyObject, err: inout NSError?) -> NSObject? {
    guard let meta = object_getClass(cls), let imp = class_getMethodImplementation(meta, sel) else { return nil }
    typealias Fn = @convention(c) (AnyClass, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(cls, sel, arg, &err) as? NSObject
}

func instanceInvoke(_ obj: NSObject, _ sel: Selector, err: inout NSError?) -> NSObject? {
    guard let imp = class_getMethodImplementation(type(of: obj), sel) else { return nil }
    typealias Fn = @convention(c) (AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(obj, sel, &err) as? NSObject
}

func resolveDevice(udid: String) -> NSObject? {
    guard let cls = NSClassFromString("SimServiceContext") else { return nil }
    var err: NSError?
    guard let ctx = classInvoke(cls, NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"), developerDir as NSString, err: &err),
          let set = instanceInvoke(ctx, NSSelectorFromString("defaultDeviceSetWithError:"), err: &err)
    else { return nil }
    let devices = (set.value(forKey: "availableDevices") as? [NSObject]) ?? []
    return devices.first { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }
}

/// Quit when the parent goes away (it closes our stdin, or dies).
func quitOnStdinClose() {
    FileHandle.standardInput.readabilityHandler = { h in
        if h.availableData.isEmpty { exit(0) }
    }
}

// MARK: - stream

func runStream(udid: String, fps: Double, maxPixels: Int) -> Never {
    _ = loadSimulatorKit()
    guard let device = resolveDevice(udid: udid) else { die("device not found (\(udid))") }

    var io: NSObject?
    for _ in 1...10 {
        io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject
        if io != nil { break }
        Thread.sleep(forTimeInterval: 0.3)
    }
    guard let io else { die("device.io unavailable — is the simulator booted?") }

    var ports: [NSObject] = []
    for _ in 1...15 {
        io.perform(NSSelectorFromString("updateIOPorts"))
        ports = (io.value(forKey: "deviceIOPorts") as? [NSObject]) ?? []
        if !ports.isEmpty { break }
        Thread.sleep(forTimeInterval: 0.5)
    }
    guard !ports.isEmpty else { die("no IO ports — is the simulator booted?") }

    let pidSel = NSSelectorFromString("portIdentifier")
    let descSel = NSSelectorFromString("descriptor")
    let surfSel = NSSelectorFromString("framebufferSurface")
    var descriptors: [NSObject] = []
    for port in ports where port.responds(to: pidSel) {
        guard let pid = port.perform(pidSel)?.takeUnretainedValue(), "\(pid)" == "com.apple.framebuffer.display",
              port.responds(to: descSel),
              let desc = port.perform(descSel)?.takeUnretainedValue() as? NSObject,
              desc.responds(to: surfSel)
        else { continue }
        descriptors.append(desc)
    }
    guard !descriptors.isEmpty else { die("no framebuffer display — is the simulator booted?") }

    let queue = DispatchQueue(label: "ondra.capture", qos: .userInteractive)
    var latest: IOSurface?
    var lastWalk: UInt64 = 0
    // the largest surface is the display (a multi-panel device's unfolded one)
    func walk() {
        lastWalk = DispatchTime.now().uptimeNanoseconds
        var best: IOSurface?
        var area = 0
        for d in descriptors {
            guard let obj = d.perform(surfSel)?.takeUnretainedValue() else { continue }
            let s = unsafeBitCast(obj, to: IOSurface.self)
            let a = IOSurfaceGetWidth(s) * IOSurfaceGetHeight(s)
            if a > area { best = s; area = a }
        }
        if let best { latest = best }
    }

    var blocks: [AnyObject] = []
    let regSel = NSSelectorFromString("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:")
    for d in descriptors where d.responds(to: regSel) {
        guard let imp = class_getMethodImplementation(type(of: d), regSel) else { continue }
        let onFrame: @convention(block) () -> Void = {}
        let onSurfaces: @convention(block) () -> Void = { queue.async { walk() } }
        let onProps: @convention(block) () -> Void = {}
        blocks += [onFrame as AnyObject, onSurfaces as AnyObject, onProps as AnyObject]
        typealias RegFn = @convention(c) (AnyObject, Selector, AnyObject, AnyObject, AnyObject, AnyObject, AnyObject) -> Void
        unsafeBitCast(imp, to: RegFn.self)(d, regSel, NSUUID(), queue as AnyObject, onFrame as AnyObject, onSurfaces as AnyObject, onProps as AnyObject)
    }
    queue.sync {
        for _ in 1...10 {
            walk()
            if latest != nil { break }
            Thread.sleep(forTimeInterval: 0.3)
        }
    }

    // Tear-free snapshot: the simulator draws into the surface in place, so copy it and
    // retry when its seed moved during the copy.
    var snap: CVPixelBuffer?
    var snapW = 0, snapH = 0
    func snapshot(_ s: IOSurface) -> CVPixelBuffer? {
        let w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s)
        if snap == nil || w != snapW || h != snapH {
            var pb: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA, nil, &pb)
            snap = pb; snapW = w; snapH = h
        }
        guard let dst = snap else { return nil }
        CVPixelBufferLockBaseAddress(dst, [])
        defer { CVPixelBufferUnlockBaseAddress(dst, []) }
        guard let dstBase = CVPixelBufferGetBaseAddress(dst) else { return nil }
        let dstStride = CVPixelBufferGetBytesPerRow(dst)
        for _ in 0...3 {
            let seed = IOSurfaceGetSeed(s)
            IOSurfaceLock(s, .readOnly, nil)
            let srcStride = IOSurfaceGetBytesPerRow(s)
            let srcBase = IOSurfaceGetBaseAddress(s)
            let row = min(srcStride, dstStride)
            if srcStride == dstStride {
                memcpy(dstBase, srcBase, srcStride * h)
            } else {
                for y in 0..<h { memcpy(dstBase + y * dstStride, srcBase + y * srcStride, row) }
            }
            IOSurfaceUnlock(s, .readOnly, nil)
            if IOSurfaceGetSeed(s) == seed { break }
        }
        return dst
    }

    let rgb = CGColorSpaceCreateDeviceRGB()
    let bitmap = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    func jpeg(_ s: IOSurface) -> Data? {
        guard let buf = snapshot(s) else { return nil }
        CVPixelBufferLockBaseAddress(buf, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }
        let w = CVPixelBufferGetWidth(buf), h = CVPixelBufferGetHeight(buf)
        guard let base = CVPixelBufferGetBaseAddress(buf),
              let ctx = CGContext(data: base, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: rgb, bitmapInfo: bitmap),
              var image = ctx.makeImage()
        else { return nil }
        let longest = max(w, h)
        if maxPixels > 0 && longest > maxPixels {
            let k = Double(maxPixels) / Double(longest)
            let tw = max(1, Int((Double(w) * k).rounded())), th = max(1, Int((Double(h) * k).rounded()))
            guard let small = CGContext(data: nil, width: tw, height: th, bitsPerComponent: 8, bytesPerRow: 0, space: rgb, bitmapInfo: bitmap)
            else { return nil }
            small.interpolationQuality = .high
            small.draw(image, in: CGRect(x: 0, y: 0, width: tw, height: th))
            guard let scaled = small.makeImage() else { return nil }
            image = scaled
        }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.78] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? (out as Data) : nil
    }

    let writeQueue = DispatchQueue(label: "ondra.write", qos: .userInitiated)
    var inFlight = 0  // frames handed to the writer and not yet written (on queue only)
    let lock = NSLock()
    func write(_ data: Data) {
        lock.lock(); inFlight += 1; lock.unlock()
        writeQueue.async {
            var len = UInt32(data.count).bigEndian
            var frame = Data(bytes: &len, count: 4)
            frame.append(data)
            frame.withUnsafeBytes { p in
                var off = 0
                while off < p.count {
                    let n = Darwin.write(1, p.baseAddress! + off, p.count - off)
                    if n <= 0 { exit(0) }  // the reader went away
                    off += n
                }
            }
            lock.lock(); inFlight -= 1; lock.unlock()
        }
    }

    var sentAny = false
    DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
        if !sentAny { die("no frames within 8s") }
    }

    var lastSeed: UInt32 = 0
    var lastSent: UInt64 = 0
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 1.0 / fps)
    timer.setEventHandler {
        let now = DispatchTime.now().uptimeNanoseconds
        if latest == nil || now - lastWalk >= 1_000_000_000 { walk() }
        guard let s = latest else { return }
        // skip an unchanged screen; a keep-alive every 2s
        let seed = IOSurfaceGetSeed(s)
        if seed == lastSeed && now - lastSent < 2_000_000_000 { return }
        // a slow reader: drop frames rather than queue them up
        lock.lock(); let busy = inFlight > 1; lock.unlock()
        if busy { return }
        guard let data = jpeg(s) else { return }
        lastSeed = seed
        lastSent = now
        sentAny = true
        write(data)
    }
    timer.resume()
    quitOnStdinClose()
    withExtendedLifetime(blocks) {
        fputs("info: streaming \(udid) at \(Int(fps))fps\n", stderr)
        RunLoop.main.run()
    }
    exit(0)
}

// MARK: - touch

func runTouch(udid: String) -> Never {
    let sk = loadSimulatorKit()
    guard let device = resolveDevice(udid: udid) else { die("device not found (\(udid))") }

    typealias IndigoMouseFn = @convention(c) (UnsafePointer<CGPoint>, UnsafePointer<CGPoint>, UInt32, UInt, CGSize, UInt32) -> UnsafeMutableRawPointer?
    typealias IndigoTwoFingerFn = @convention(c) (UnsafePointer<CGPoint>, UnsafePointer<CGPoint>, UInt32, UInt32, UInt32, Double, Double, Double, Double) -> UnsafeMutableRawPointer?
    typealias IndigoArbitraryFn = @convention(c) (UInt32, UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
    typealias IndigoButtonFn = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
    typealias IndigoKeyboardFn = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?
    typealias DigitizerFn = @convention(c) (OpaquePointer?, UInt64, UInt32, UInt32, UInt32, UInt32, UInt32, Double, Double, Double, Double, Double, UInt32, UInt32, UInt32) -> OpaquePointer?
    typealias FingerFn = @convention(c) (OpaquePointer?, UInt64, UInt32, UInt32, UInt32, Double, Double, Double, Double, Double, UInt32, UInt32, UInt32) -> OpaquePointer?
    typealias AppendFn = @convention(c) (OpaquePointer, OpaquePointer, UInt32) -> Void
    typealias TrackpadFn = @convention(c) (OpaquePointer) -> UnsafeMutableRawPointer?

    func sym<T>(_ h: UnsafeMutableRawPointer?, _ name: String, _: T.Type) -> T? {
        dlsym(h, name).map { unsafeBitCast($0, to: T.self) }
    }
    guard let mouse = sym(sk, "IndigoHIDMessageForMouseNSEvent", IndigoMouseFn.self),
          let twoFinger = sym(sk, "IndigoHIDMessageForMouseNSEvent", IndigoTwoFingerFn.self)
    else { die("IndigoHIDMessageForMouseNSEvent not found") }
    let arbitrary = sym(sk, "IndigoHIDMessageForHIDArbitrary", IndigoArbitraryFn.self)
    let button = sym(sk, "IndigoHIDMessageForButton", IndigoButtonFn.self)
    let keyboard = sym(sk, "IndigoHIDMessageForKeyboardArbitrary", IndigoKeyboardFn.self)
    // The digitizer path makes iOS treat a touch as a finger (system gesture layers
    // ignore mouse-class events).
    let iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW | RTLD_GLOBAL)
    let mkDigitizer = sym(iokit, "IOHIDEventCreateDigitizerEvent", DigitizerFn.self)
    let mkFinger = sym(iokit, "IOHIDEventCreateDigitizerFingerEvent", FingerFn.self)
    let append = sym(iokit, "IOHIDEventAppendEvent", AppendFn.self)
    let trackpad = sym(sk, "IndigoHIDMessageForTrackpadEventFromHIDEventRef", TrackpadFn.self)

    // SimDeviceLegacyHIDClient
    guard let cls = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient"),
          let meta = object_getClass(cls),
          let allocImp = class_getMethodImplementation(meta, NSSelectorFromString("alloc"))
    else { die("SimDeviceLegacyHIDClient not found") }
    typealias AllocFn = @convention(c) (AnyClass, Selector) -> AnyObject
    let allocated = unsafeBitCast(allocImp, to: AllocFn.self)(cls, NSSelectorFromString("alloc")) as! NSObject
    let initSel = NSSelectorFromString("initWithDevice:error:")
    guard let initImp = class_getMethodImplementation(type(of: allocated), initSel) else { die("initWithDevice:error: not found") }
    typealias InitFn = @convention(c) (NSObject, Selector, NSObject, AutoreleasingUnsafeMutablePointer<NSError?>) -> NSObject?
    var initErr: NSError?
    guard let client = unsafeBitCast(initImp, to: InitFn.self)(allocated, initSel, device, &initErr) else {
        die("HID client: \(initErr?.localizedDescription ?? "nil")")
    }
    let sendSel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
    guard let sendImp = class_getMethodImplementation(type(of: client), sendSel) else { die("sendWithMessage not found") }
    typealias SendFn = @convention(c) (NSObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
    let sendFn = unsafeBitCast(sendImp, to: SendFn.self)
    func send(_ p: UnsafeMutableRawPointer?) { if let p { sendFn(client, sendSel, p, true, nil, nil) } }

    let down: UInt = 1, up: UInt = 2, dragged: UInt = 6
    let digitizerTarget: UInt32 = 0x32

    func injectMouse(_ x: Double, _ y: Double, _ type: UInt) {
        var p = CGPoint(x: x, y: y)
        var d = CGPoint.zero
        send(mouse(&p, &d, digitizerTarget, type, CGSize(width: 1, height: 1), 0))
    }
    func inject(_ x: Double, _ y: Double, _ type: UInt) {
        guard let mkDigitizer, let mkFinger, let append, let trackpad else { return injectMouse(x, y, type) }
        let ts = mach_absolute_time()
        let isUp = type == up
        let mask: UInt32 = isUp ? 0x06 : 0x07
        let contact: UInt32 = isUp ? 0 : 1
        guard let parent = mkDigitizer(nil, ts, 2, 0, 1, mask, 0, x, y, 0, 0, 0, contact, contact, 0),
              let finger = mkFinger(nil, ts, 1, 1, mask, x, y, 0, 0, 0, contact, contact, 0)
        else { return injectMouse(x, y, type) }
        append(parent, finger, 0)
        guard let msg = trackpad(parent) else { return injectMouse(x, y, type) }
        // routing tag: iOS ignores trackpad messages without it
        msg.storeBytes(of: UInt32(0x32), toByteOffset: 0x6c, as: UInt32.self)
        if malloc_size(msg) >= 0x110 { msg.storeBytes(of: UInt32(0x32), toByteOffset: 0x10c, as: UInt32.self) }
        send(msg)
    }
    func injectTwo(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ dir: UInt32) {
        let type: UInt32 = dir == 1 ? UInt32(down) : dir == 2 ? UInt32(up) : UInt32(dragged)
        var p1 = CGPoint(x: x1, y: y1), p2 = CGPoint(x: x2, y: y2)
        for _ in 0..<12 {
            if let m = twoFinger(&p1, &p2, digitizerTarget, type, dir, 1, 1, 1, 1) { return send(m) }
            Thread.sleep(forTimeInterval: 0.005)
        }
    }
    func hidButton(_ page: UInt32, _ usage: UInt32, _ op: UInt32) {
        send(arbitrary?(digitizerTarget, page, usage, op))
    }
    func legacyButton(_ code: UInt32) {
        send(button?(code, 1, 0x33))
        Thread.sleep(forTimeInterval: 0.05)
        send(button?(code, 2, 0x33))
    }
    func key(_ modifiers: UInt8, _ usage: UInt32) {
        let mods: [(UInt8, UInt32)] = [(0x01, 0xE0), (0x02, 0xE1), (0x04, 0xE2), (0x08, 0xE3), (0x10, 0xE4), (0x20, 0xE5), (0x40, 0xE6), (0x80, 0xE7)]
        // HIDArbitrary on the digitizer target is what arrives (Xcode 27, iOS 26); the
        // keyboard-specific message is only a fallback. Keys go through the device's own
        // input source, like a hardware keyboard.
        func k(_ u: UInt32, _ op: UInt32) {
            if let arbitrary { send(arbitrary(digitizerTarget, 0x07, u, op)) } else if let keyboard { send(keyboard(u, op)) }
        }
        for (bit, u) in mods where modifiers & bit != 0 { k(u, 1) }
        k(usage, 1)
        k(usage, 2)
        for (bit, u) in mods.reversed() where modifiers & bit != 0 { k(u, 2) }
    }

    print("ready")
    fflush(stdout)

    let stdin = FileHandle.standardInput
    func read(_ n: Int) -> Data? {
        let d = stdin.readData(ofLength: n)
        return d.count == n ? d : nil
    }
    func f32(_ d: Data, _ o: Int) -> Double {
        Double(Float(bitPattern: UInt32(d[d.startIndex + o]) << 24 | UInt32(d[d.startIndex + o + 1]) << 16 | UInt32(d[d.startIndex + o + 2]) << 8 | UInt32(d[d.startIndex + o + 3])))
    }
    func u32(_ d: Data, _ o: Int) -> UInt32 {
        UInt32(d[d.startIndex + o]) << 24 | UInt32(d[d.startIndex + o + 1]) << 16 | UInt32(d[d.startIndex + o + 2]) << 8 | UInt32(d[d.startIndex + o + 3])
    }
    var lastX = 0.0, lastY = 0.0
    var pinch = (0.0, 0.0, 0.0, 0.0)
    while true {
        guard let h = read(1) else { exit(0) }
        let type = h[h.startIndex]
        if (6...8).contains(type) {
            guard let r = read(16) else { exit(0) }
            if type != 8 { pinch = (f32(r, 0), f32(r, 4), f32(r, 8), f32(r, 12)) }
            injectTwo(pinch.0, pinch.1, pinch.2, pinch.3, type == 6 ? 1 : type == 7 ? 0 : 2)
            continue
        }
        guard let r = read(8) else { exit(0) }
        switch type {
        case 1: lastX = f32(r, 0); lastY = f32(r, 4); inject(lastX, lastY, down)
        case 2: lastX = f32(r, 0); lastY = f32(r, 4); inject(lastX, lastY, dragged)
        case 3: inject(lastX, lastY, up)
        case 4: hidButton(u32(r, 0), u32(r, 4), 1); Thread.sleep(forTimeInterval: 0.05); hidButton(u32(r, 0), u32(r, 4), 2)
        case 5: legacyButton(u32(r, 0))
        case 9: key(r[r.startIndex], u32(r, 4))
        case 10: hidButton(u32(r, 0), u32(r, 4), 1)
        case 11: hidButton(u32(r, 0), u32(r, 4), 2)
        default: break
        }
    }
}

// MARK: - keyboard (software keyboard on/off = hardware keyboard off/on)

func runKeyboard(action: String, udid: String) -> Never {
    guard let device = resolveDevice(udid: udid) else { die("device not found (\(udid))") }
    let sel = NSSelectorFromString("setHardwareKeyboardEnabled:keyboardType:error:")
    guard let imp = class_getMethodImplementation(type(of: device), sel) else { die("setHardwareKeyboardEnabled not found") }
    typealias Fn = @convention(c) (NSObject, Selector, Bool, Int, AutoreleasingUnsafeMutablePointer<NSError?>) -> Bool
    var err: NSError?
    let ok = unsafeBitCast(imp, to: Fn.self)(device, sel, action == "hide", 0, &err)
    if let err { die(err.localizedDescription) }
    if !ok { die("setHardwareKeyboardEnabled returned false") }
    // re-sync the input source after the switch
    let t = Process()
    t.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    t.arguments = ["simctl", "spawn", udid, "launchctl", "kickstart", "-k", "system/com.apple.kbd"]
    t.standardOutput = FileHandle.nullDevice
    t.standardError = FileHandle.nullDevice
    try? t.run()
    t.waitUntilExit()
    exit(0)
}

// MARK: - rotate (GSEvent over PurpleWorkspacePort)

func runRotate(orientation: String, udid: String) -> Never {
    let values: [String: UInt32] = ["portrait": 1, "portraitUpsideDown": 2, "landscapeRight": 3, "landscapeLeft": 4]
    guard let value = values[orientation] else { die("unknown orientation \(orientation)") }
    guard let device = resolveDevice(udid: udid) else { die("device not found (\(udid))") }
    typealias LookupFn = @convention(c) (NSObject, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>) -> UInt32
    let sel = NSSelectorFromString("lookup:error:")
    guard let imp = class_getMethodImplementation(type(of: device), sel) else { die("lookup:error: not found") }
    var err: NSError?
    let port = unsafeBitCast(imp, to: LookupFn.self)(device, sel, "PurpleWorkspacePort" as NSString, &err)
    guard port != 0 else { die("PurpleWorkspacePort: \(err?.localizedDescription ?? "port=0")") }
    var msg = [UInt8](repeating: 0, count: 112)
    func w32(_ v: UInt32, _ o: Int) {
        msg[o] = UInt8(v & 0xFF); msg[o + 1] = UInt8((v >> 8) & 0xFF); msg[o + 2] = UInt8((v >> 16) & 0xFF); msg[o + 3] = UInt8((v >> 24) & 0xFF)
    }
    w32(0x13, 0x00)              // msgh_bits: COPY_SEND
    w32(108, 0x04)               // msgh_size
    w32(port, 0x08)              // remote port
    w32(0x7B, 0x14)              // GSEventMachMessageID
    w32(50 | 0x20000, 0x18)      // DeviceOrientationChanged | HostFlag
    w32(4, 0x48)                 // record size
    w32(value, 0x4C)             // UIDeviceOrientation
    // a timeout so a wedged simulator can't hold us forever
    let kr = msg.withUnsafeMutableBytes { p in
        mach_msg(p.baseAddress!.assumingMemoryBound(to: mach_msg_header_t.self), MACH_SEND_MSG | MACH_SEND_TIMEOUT, 108, 0,
                 mach_port_t(MACH_PORT_NULL), 3000, mach_port_t(MACH_PORT_NULL))
    }
    if kr != KERN_SUCCESS { die("mach_msg failed (\(kr))") }
    exit(0)
}

// MARK: - main

switch mode {
case "stream":
    guard args.count == 4, let fps = Double(args[2]), fps > 0, let maxPx = Int(args[3]) else { die("usage: stream <udid> <fps> <maxPixels>") }
    runStream(udid: args[1], fps: min(fps, 60), maxPixels: maxPx)
case "touch":
    guard args.count == 2 else { die("usage: touch <udid>") }
    runTouch(udid: args[1])
case "keyboard":
    guard args.count == 3, ["show", "hide"].contains(args[1]) else { die("usage: keyboard <show|hide> <udid>") }
    runKeyboard(action: args[1], udid: args[2])
case "rotate":
    guard args.count == 3 else { die("usage: rotate <orientation> <udid>") }
    runRotate(orientation: args[1], udid: args[2])
default:
    die("unknown mode \(mode)")
}
