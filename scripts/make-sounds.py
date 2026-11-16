#!/usr/bin/env python3
"""Ondra's own sounds (a job finished, needs an answer, failed), synthesized so nothing is
borrowed: soft mallet notes (a sine with a few inharmonic partials, a 4 ms attack and an
exponential decay) and a short room tail. Writes src-tauri/sounds/<name>.wav
(48 kHz, 16-bit mono). Run: python3 scripts/make-sounds.py  (needs numpy)
"""
from pathlib import Path
import wave

import numpy as np

RATE = 48_000
OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "sounds"


def note(freq: float, dur: float, decay: float, bright: float = 1.0) -> np.ndarray:
    """One mallet hit: the fundamental, a soft octave and a marimba-like 3.9× partial that dies fast."""
    t = np.arange(int(RATE * dur)) / RATE
    partials = [(1.0, 1.0, decay), (2.0, 0.18 * bright, decay * 0.6), (3.9, 0.10 * bright, decay * 0.25)]
    s = sum(a * np.sin(2 * np.pi * freq * k * t) * np.exp(-t / d) for k, a, d in partials)
    attack = np.minimum(1.0, t / 0.004)
    # let it die out instead of stopping mid-ring (a cut is a click)
    release = np.minimum(1.0, (dur - t) / 0.08)
    return s * attack * release


def place(parts: list[tuple[float, np.ndarray]], length: float) -> np.ndarray:
    out = np.zeros(int(RATE * length))
    for at, s in parts:
        i = int(RATE * at)
        n = min(len(s), len(out) - i)
        out[i : i + n] += s[:n]
    return out


def room(s: np.ndarray, mix: float = 0.18) -> np.ndarray:
    """A small, dark room: a few decaying taps, low-passed."""
    wet = np.zeros_like(s)
    for ms, g in [(23, 0.5), (37, 0.4), (53, 0.3), (79, 0.22), (113, 0.15)]:
        d = int(RATE * ms / 1000)
        wet[d:] += g * s[:-d]
    k = 24
    wet = np.convolve(wet, np.ones(k) / k, mode="same")
    return s + mix * wet


def finish(s: np.ndarray, peak: float) -> np.ndarray:
    fade = int(RATE * 0.03)
    s = s.copy()
    s[-fade:] *= np.linspace(1, 0, fade)
    return s / np.max(np.abs(s)) * peak


SOUNDS = {
    # up a fifth, the second note a little brighter: something is ready
    "done": lambda: finish(room(place([(0.0, note(659.25, 0.75, 0.16)), (0.11, note(987.77, 1.0, 0.22, 1.2))], 1.2)), PEAK["done"]),
    # the same note twice, lightly: look here
    "waiting": lambda: finish(room(place([(0.0, note(880.0, 0.5, 0.09, 0.8)), (0.13, note(880.0, 0.7, 0.14, 0.8))], 0.95)), PEAK["waiting"]),
    # down a fourth, low and muted: it stopped
    "failed": lambda: finish(room(place([(0.0, note(392.0, 0.7, 0.14, 0.5)), (0.14, note(293.66, 1.0, 0.2, 0.4))], 1.25)), PEAK["failed"]),
}
# about as loud as macOS's own Glass (−26 LUFS) at full volume; the setting scales it down from there
PEAK = {"done": 0.3, "waiting": 0.27, "failed": 0.25}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, make in SOUNDS.items():
        pcm = (make() * 32767).astype("<i2")
        with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(pcm.tobytes())
        print(OUT / f"{name}.wav", f"{len(pcm) / RATE:.2f}s")


if __name__ == "__main__":
    main()
