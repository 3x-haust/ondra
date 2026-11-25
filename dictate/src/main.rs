// ondra-dictate for Windows and Linux: the composer's dictation, as helpers/dictate.swift does it
// on the Mac, with the same lines in and out. The microphone is turned into text on this computer
// by SenseVoiceSmall (model.rs); no audio leaves it. The model is fetched once, the first time.
//
//   ondra-dictate --lang ko-KR --models <dir> [--max 120]
//
// One JSON object per line on stdout:
//   {"download":0.42}    fetching the model the first time, 0…1 (before anything else)
//   {"ready":true}       recording has begun
//   {"level":0.42}       the input level, 0…1, about 20 a second
//   {"partial":"…"}      the words so far
//   {"limit":true}       --max seconds of recording passed: it stops, a final follows
//   {"final":"…"}        all of it (empty when nothing was heard); the helper exits after it
//   {"error":"mic-denied|no-mic|no-model|failed","detail":"…"}
// stdin: "stop" (or EOF) ends the recording and waits for the final text; "cancel" quits at once.
mod audio;
mod model;

use serde_json::{json, Value};
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use transcribe_rs::onnx::sense_voice::{SenseVoiceModel, SenseVoiceParams};
use transcribe_rs::onnx::Quantization;

/// The open stretch of audio is cut at a pause once it passes this, so each pass stays short.
const CUT_AFTER: usize = 20 * audio::RATE;
/// The pause is looked for this far back from there.
const CUT_FROM: usize = 15 * audio::RATE;
/// New audio that makes a new partial worth it.
const PARTIAL_EVERY: usize = audio::RATE / 2;

fn emit(v: Value) {
    // println! holds stdout for the whole line: lines from the audio thread never interleave
    println!("{v}");
}

fn fail(code: &str, detail: impl ToString) -> ! {
    emit(json!({ "error": code, "detail": detail.to_string() }));
    std::process::exit(1);
}

fn finish(words: &str) -> ! {
    emit(json!({ "final": words }));
    std::process::exit(0);
}

/// The model's language for a BCP 47 tag ("ko-KR" → "ko"); one it doesn't know is guessed.
fn model_lang(tag: &str) -> &'static str {
    match tag.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase().as_str() {
        "ko" => "ko",
        "en" => "en",
        "ja" => "ja",
        "zh" => "zh",
        "yue" => "yue",
        _ => "auto",
    }
}

/// Where to cut `open` (longer than CUT_AFTER): after its quietest 30 ms between CUT_FROM and CUT_AFTER.
fn cut_point(open: &[f32]) -> usize {
    const FRAME: usize = 480;
    (CUT_FROM..CUT_AFTER.min(open.len()).saturating_sub(FRAME) + 1)
        .step_by(FRAME)
        .min_by(|&a, &b| energy(&open[a..a + FRAME]).total_cmp(&energy(&open[b..b + FRAME])))
        .map_or(CUT_AFTER, |at| at + FRAME)
}

fn energy(frame: &[f32]) -> f32 {
    frame.iter().map(|s| s * s).sum()
}

/// No 30 ms of it reaches the bottom of the level meter (-50 dBFS).
fn silent(samples: &[f32]) -> bool {
    samples.chunks(480).all(|f| audio::level_of((energy(f) / f.len() as f32).sqrt()) == 0.0)
}

fn joined(done: &[String], open: &str) -> String {
    done.iter().map(String::as_str).chain([open]).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

struct Recognizer {
    model: SenseVoiceModel,
    params: SenseVoiceParams,
}

impl Recognizer {
    fn text(&mut self, samples: &[f32]) -> String {
        // the model makes up a word or a lone "." out of silence
        if silent(samples) {
            return String::new();
        }
        match self.model.transcribe_with(samples, &self.params) {
            Ok(r) if r.text.chars().any(char::is_alphanumeric) => r.text.trim().to_string(),
            Ok(_) => String::new(),
            Err(e) => fail("failed", e),
        }
    }
}

/// What was heard, cut into stretches each recognized once, and the open one after them.
struct Heard {
    audio: Vec<f32>,
    /// where the open stretch begins
    cut: usize,
    done: Vec<String>,
}

impl Heard {
    /// Recognize the stretches that grew long enough to close, then the open one: all of it.
    fn text(&mut self, r: &mut Recognizer) -> String {
        while self.audio.len() - self.cut > CUT_AFTER {
            let at = self.cut + cut_point(&self.audio[self.cut..]);
            self.done.push(r.text(&self.audio[self.cut..at]));
            self.cut = at;
        }
        let open = r.text(&self.audio[self.cut..]);
        joined(&self.done, &open)
    }
}

fn main() {
    let mut lang = "ko-KR".to_string();
    let mut max = 120u64;
    let mut models: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--lang" => lang = args.next().unwrap_or(lang),
            "--max" => max = args.next().and_then(|m| m.parse().ok()).unwrap_or(max),
            "--models" => models = args.next().map(PathBuf::from),
            "--version" => {
                println!("ondra-dictate {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            _ => {}
        }
    }
    let Some(models) = models else { fail("failed", "no --models folder") };

    // stdin on its own thread: "cancel" quits at once, "stop" or the pipe closing ends the recording
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line.as_deref().map(str::trim) {
                Ok("cancel") => std::process::exit(0),
                Ok("stop") => break,
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        let _ = stop_tx.send(());
    });
    // a stop before recording began: nothing was said
    let stopped = |rx: &mpsc::Receiver<()>| !matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty));

    let mut beat = Instant::now() - Duration::from_secs(1);
    let dir = model::ensure(&models, &mut |p| {
        if stopped(&stop_rx) {
            finish("");
        }
        if beat.elapsed() >= Duration::from_millis(250) {
            beat = Instant::now();
            emit(json!({ "download": (p * 1000.0).floor() / 1000.0 }));
        }
    })
    .unwrap_or_else(|e| fail("no-model", e));
    if stopped(&stop_rx) {
        finish("");
    }

    // the model loads (a second or two) while recording already runs: nothing said is lost
    let params = SenseVoiceParams { language: Some(model_lang(&lang).to_string()), use_itn: Some(true) };
    let loader = std::thread::spawn(move || SenseVoiceModel::load(&dir, &Quantization::Int8).map(|model| Recognizer { model, params }).map_err(|e| e.to_string()));
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<f32>>();
    let mic = audio::open(audio_tx, |level| emit(json!({ "level": level }))).unwrap_or_else(|(code, detail)| fail(code, detail));
    emit(json!({ "ready": true }));
    let started = Instant::now();
    let max = Duration::from_secs(max);

    let mut heard = Heard { audio: vec![], cut: 0, done: vec![] };
    let mut loader = Some(loader);
    let mut recognizer: Option<Recognizer> = None;
    let mut last = String::new();
    let mut seen = 0;
    loop {
        let stop = !matches!(stop_rx.recv_timeout(Duration::from_millis(100)), Err(RecvTimeoutError::Timeout));
        heard.audio.extend(audio_rx.try_iter().flatten());
        if stop {
            break;
        }
        if started.elapsed() >= max {
            emit(json!({ "limit": true }));
            break;
        }
        if recognizer.is_none() && loader.as_ref().is_some_and(|l| l.is_finished()) {
            recognizer = Some(join(loader.take()));
        }
        // the next pass as soon as the last one is over and there is something new to hear
        if let Some(r) = recognizer.as_mut() {
            if heard.audio.len() >= seen + PARTIAL_EVERY {
                seen = heard.audio.len();
                let words = heard.text(r);
                if words != last {
                    emit(json!({ "partial": words }));
                    last = words;
                }
            }
        }
    }
    drop(mic);
    heard.audio.extend(audio_rx.try_iter().flatten());
    let mut r = recognizer.unwrap_or_else(|| join(loader.take()));
    let words = heard.text(&mut r);
    finish(&words);
}

fn join(loader: Option<std::thread::JoinHandle<Result<Recognizer, String>>>) -> Recognizer {
    match loader.map(|l| l.join()) {
        Some(Ok(Ok(r))) => r,
        Some(Ok(Err(e))) => fail("failed", e),
        _ => fail("failed", "the model didn't load"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_map_to_the_models() {
        assert_eq!(model_lang("ko-KR"), "ko");
        assert_eq!(model_lang("en-US"), "en");
        assert_eq!(model_lang("EN_gb"), "en");
        assert_eq!(model_lang("de-DE"), "auto");
        assert_eq!(model_lang(""), "auto");
    }

    #[test]
    fn a_long_stretch_is_cut_at_its_quietest_spot() {
        let mut open = vec![0.5f32; 22 * audio::RATE];
        let quiet = 17 * audio::RATE;
        open[quiet..quiet + 960].fill(0.0);
        let at = cut_point(&open);
        assert!((quiet..=quiet + 960).contains(&at), "{at}");
        // all equally loud: the first frame looked at
        assert_eq!(cut_point(&vec![0.5f32; 22 * audio::RATE]), CUT_FROM + 480);
    }

    #[test]
    fn silence_is_not_heard() {
        assert!(silent(&[]));
        assert!(silent(&vec![0.001f32; 16_000]));
        let mut some = vec![0.0f32; 16_000];
        some[8000..8480].fill(0.1);
        assert!(!silent(&some));
    }

    #[test]
    fn stretches_join_with_spaces() {
        assert_eq!(joined(&["안녕하세요.".into(), " ".into()], " 반가워요 "), "안녕하세요. 반가워요");
        assert_eq!(joined(&[], ""), "");
    }
}
