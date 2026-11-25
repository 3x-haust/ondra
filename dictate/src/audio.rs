//! The microphone: the system's default input, as 16 kHz mono for the model, and its level for
//! the composer's meter.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use std::sync::mpsc::Sender;
use std::time::Instant;

pub const RATE: usize = 16_000;

/// Box-filter resampling to 16 kHz: each output sample is the mean of the input samples it
/// covers (a rough low-pass, plenty for speech); slower inputs hold their last sample.
pub struct Resampler {
    step: f64,
    next: f64,
    at: f64,
    sum: f32,
    n: u32,
    last: f32,
}

impl Resampler {
    pub fn new(from: u32) -> Self {
        let step = from as f64 / RATE as f64;
        Resampler { step, next: step, at: 0.0, sum: 0.0, n: 0, last: 0.0 }
    }

    pub fn push(&mut self, x: f32, out: &mut Vec<f32>) {
        self.sum += x;
        self.n += 1;
        self.at += 1.0;
        if self.at >= self.next {
            self.last = self.sum / self.n as f32;
            self.sum = 0.0;
            self.n = 0;
        }
        while self.at >= self.next {
            out.push(self.last);
            self.next += self.step;
        }
    }
}

/// RMS of the input on a -50…0 dBFS scale (speech sits around -35…-10), the loudest of each
/// 50 ms, as helpers/dictate.swift measures it on the Mac.
pub struct LevelMeter {
    last: Option<Instant>,
    peak: f32,
}

impl LevelMeter {
    pub fn new() -> Self {
        LevelMeter { last: None, peak: 0.0 }
    }

    pub fn feed(&mut self, samples: &[f32]) -> Option<f64> {
        if samples.is_empty() {
            return None;
        }
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
        self.peak = self.peak.max(rms);
        if self.last.is_some_and(|t| t.elapsed().as_millis() < 50) {
            return None;
        }
        self.last = Some(Instant::now());
        let level = level_of(self.peak);
        self.peak = 0.0;
        Some(level)
    }
}

pub fn level_of(rms: f32) -> f64 {
    let db = 20.0 * rms.max(1e-6).log10();
    ((((db + 50.0) / 50.0).clamp(0.0, 1.0) as f64) * 1000.0).round() / 1000.0
}

/// Why the microphone can't be used: the error code the composer knows, and the detail.
pub type MicError = (&'static str, String);

fn mic_error(e: cpal::Error) -> MicError {
    let detail = e.to_string();
    // Windows' microphone privacy setting answers E_ACCESSDENIED, which cpal passes on as a
    // backend error with the system's (localized) message and its code
    let denied = e.kind() == cpal::ErrorKind::PermissionDenied || ["-2147024891", "80070005", "os error 5)"].iter().any(|c| detail.contains(c));
    (if denied { "mic-denied" } else { "no-mic" }, detail)
}

/// Recording; it stops when dropped.
pub struct Mic {
    _stream: cpal::Stream,
}

/// Open the default input and start it. 16 kHz samples go to `tx`; each level goes to `level`.
pub fn open(tx: Sender<Vec<f32>>, level: impl FnMut(f64) + Send + 'static) -> Result<Mic, MicError> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or(("no-mic", "no default input device".to_string()))?;
    let config = device.default_input_config().map_err(mic_error)?;
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let stream = match format {
        cpal::SampleFormat::I8 => build::<i8>(&device, &config, tx, level),
        cpal::SampleFormat::I16 => build::<i16>(&device, &config, tx, level),
        cpal::SampleFormat::I32 => build::<i32>(&device, &config, tx, level),
        cpal::SampleFormat::U8 => build::<u8>(&device, &config, tx, level),
        cpal::SampleFormat::U16 => build::<u16>(&device, &config, tx, level),
        cpal::SampleFormat::F32 => build::<f32>(&device, &config, tx, level),
        cpal::SampleFormat::F64 => build::<f64>(&device, &config, tx, level),
        other => return Err(("no-mic", format!("unsupported sample format {other}"))),
    }
    .map_err(mic_error)?;
    stream.play().map_err(mic_error)?;
    Ok(Mic { _stream: stream })
}

fn build<T>(device: &cpal::Device, config: &cpal::StreamConfig, tx: Sender<Vec<f32>>, mut level: impl FnMut(f64) + Send + 'static) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let rate = (config.sample_rate as usize).max(1);
    let mut resampler = Resampler::new(config.sample_rate);
    let mut meter = LevelMeter::new();
    device.build_input_stream::<T, _, _>(
        *config,
        move |data: &[T], _: &_| {
            let mono: Vec<f32> = data.chunks(channels).map(|f| f.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / f.len() as f32).collect();
            if let Some(l) = meter.feed(&mono) {
                level(l);
            }
            let mut out = Vec::with_capacity(mono.len() * RATE / rate + 1);
            for x in mono {
                resampler.push(x, &mut out);
            }
            let _ = tx.send(out);
        },
        // a stream that breaks (the device unplugged) just goes quiet; what was heard stays
        |_| {},
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_to_16_khz() {
        for from in [48_000u32, 44_100, 16_000, 8_000] {
            let mut r = Resampler::new(from);
            let mut out = vec![];
            for i in 0..from {
                r.push((i % 7) as f32, &mut out);
            }
            assert!((out.len() as i64 - RATE as i64).abs() <= 1, "{from}: {}", out.len());
        }
        // a constant stays itself
        let mut r = Resampler::new(48_000);
        let mut out = vec![];
        for _ in 0..4800 {
            r.push(0.5, &mut out);
        }
        assert!(out.iter().all(|x| (x - 0.5).abs() < 1e-6));
    }

    #[test]
    fn level_is_on_the_macs_scale() {
        assert_eq!(level_of(0.0), 0.0);
        assert_eq!(level_of(1.0), 1.0);
        // -20 dBFS
        assert_eq!(level_of(0.1), 0.6);
    }
}
