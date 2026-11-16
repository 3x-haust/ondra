// ondra-dictate: the composer's dictation. Records the microphone with AVAudioEngine and
// turns it into text with Apple's Speech framework, on this Mac only: recognition is
// on-device or not at all (a language without an on-device model is an error, never a
// fallback to Apple's servers), so no audio leaves the Mac.
//
//   ondra-dictate --lang ko-KR [--max 120]
//
// One JSON object per line on stdout:
//   {"ready":true}       recording has begun (after any permission prompt)
//   {"level":0.42}       the input level, 0…1, about 20 a second
//   {"partial":"…"}      the words so far
//   {"limit":true}       --max seconds passed: recording stops, a final follows
//   {"final":"…"}        all of it (empty when nothing was heard); the helper exits after it
//   {"error":"mic-denied|speech-denied|no-mic|unavailable|no-on-device|failed","detail":"…"}
// stdin: "stop" (or EOF) ends the recording and waits for the final text; "cancel" quits at once.
//
// A command-line tool has no bundle, so the Info.plist the privacy APIs read their usage
// strings from is linked into the binary (dictate.plist, see build.sh). The prompts
// themselves are the app's: TCC asks for the app that runs the helper (Ondra).
import AVFoundation
import Accelerate
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

/// Every line is written on the main thread, so lines never interleave.
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

func fail(_ code: String, _ error: Error? = nil) -> Never {
    var obj: [String: Any] = ["error": code]
    if let error { obj["detail"] = error.localizedDescription }
    emit(obj)
    exit(1)
}

var lang = "ko-KR"
var maxSeconds = 120.0
var argv = CommandLine.arguments.dropFirst().makeIterator()
while let a = argv.next() {
    switch a {
    case "--lang": lang = argv.next() ?? lang
    case "--max": maxSeconds = Double(argv.next() ?? "") ?? maxSeconds
    case "--version":
        print("ondra-dictate 1.0.0")
        exit(0)
    default: break
    }
}

/// RMS of the input on a -50…0 dBFS scale (speech sits around -35…-10), the loudest of
/// each 50 ms: about 20 lines a second, whatever the buffer size the hardware picks.
final class LevelMeter {
    private var last: UInt64 = 0
    private var peak: Float = 0

    func feed(_ buffer: AVAudioPCMBuffer) -> Double? {
        guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return nil }
        var rms: Float = 0
        vDSP_rmsqv(ch, 1, &rms, vDSP_Length(buffer.frameLength))
        peak = max(peak, rms)
        let now = DispatchTime.now().uptimeNanoseconds
        guard now - last >= 50_000_000 else { return nil }
        last = now
        let db = 20 * log10(max(peak, 1e-6))
        peak = 0
        return (Double(min(1, max(0, (db + 50) / 50))) * 1000).rounded() / 1000
    }
}

final class Dictation {
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    let request = SFSpeechAudioBufferRecognitionRequest()
    var task: SFSpeechRecognitionTask?
    /// the words so far: the text when recognition ends without a final result
    var text = ""
    var recording = false
    var stopping = false
    var done = false

    init(_ recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

    func start() {
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else { fail("no-mic") }
        let meter = LevelMeter()
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [request] buffer, _ in
            request.append(buffer)
            if let level = meter.feed(buffer) {
                DispatchQueue.main.async { emit(["level": level]) }
            }
        }
        engine.prepare()
        do { try engine.start() } catch { fail("no-mic", error) }
        recording = true
        // results come on the main queue (the recognizer's default)
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            self?.handle(result, error)
        }
        emit(["ready": true])
        DispatchQueue.main.asyncAfter(deadline: .now() + maxSeconds) { [weak self] in
            guard let self, !self.stopping, !self.done else { return }
            emit(["limit": true])
            self.stop()
        }
    }

    func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
        if done { return }
        if let result {
            let words = result.bestTranscription.formattedString
            if result.isFinal { return finish(words) }
            if words != text {
                text = words
                emit(["partial": words])
            }
        }
        guard let error else { return }
        // after a stop, an error is how recognition says it heard nothing more ("no speech
        // detected"): what it had is the text
        if stopping { return finish(text) }
        fail("failed", error)
    }

    func stop() {
        if stopping || done { return }
        stopping = true
        guard recording else { return finish("") }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request.endAudio()
        // the last result takes well under a second; the composer never waits on it for long
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self else { return }
            self.finish(self.text)
        }
    }

    func cancel() -> Never {
        task?.cancel()
        if recording { engine.stop() }
        exit(0)
    }

    func finish(_ words: String) {
        if done { return }
        done = true
        emit(["final": words])
        exit(0)
    }
}

// A language the recognizer doesn't know at all shows no prompt. Whether it has an
// on-device model is asked after the prompts, once the recognizer is allowed to answer.
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)) else { fail("unavailable") }
let dictation = Dictation(recognizer)

// stdin is read on its own thread; what it says is done on the main one
Thread.detachNewThread {
    while let line = readLine() {
        switch line.trimmingCharacters(in: .whitespaces) {
        case "cancel": DispatchQueue.main.async { dictation.cancel() }
        case "stop": DispatchQueue.main.async { dictation.stop() }
        default: continue
        }
    }
    // the app went away or closed the pipe: finish what was said
    DispatchQueue.main.async { dictation.stop() }
}

func authorizeMic(_ next: @escaping () -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: next()
    case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            DispatchQueue.main.async { if ok { next() } else { fail("mic-denied") } }
        }
    default: fail("mic-denied")
    }
}

func authorizeSpeech(_ next: @escaping () -> Void) {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: next()
    case .notDetermined:
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async { if status == .authorized { next() } else { fail("speech-denied") } }
        }
    default: fail("speech-denied")
    }
}

authorizeMic {
    authorizeSpeech {
        // a stop or cancel that came while a prompt was up has been handled already
        guard !dictation.stopping, !dictation.done else { return }
        guard recognizer.isAvailable else { fail("unavailable") }
        guard recognizer.supportsOnDeviceRecognition else { fail("no-on-device") }
        dictation.start()
    }
}

RunLoop.main.run()
