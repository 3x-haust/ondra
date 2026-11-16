#!/usr/bin/env python3
"""Ondra's own sounds (a job finished, needs an answer, failed), synthesized so nothing is
borrowed: soft electric-piano notes (two-operator FM: a harmonic body whose brightness fades,
plus a short metallic tine) and a short room tail. Writes src-tauri/sounds/<name>.wav
(48 kHz, 16-bit mono). Run: python3 scripts/make-sounds.py  (needs numpy)
"""
from pathlib import Path
import wave

import numpy as np

RATE = 48_000
OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "sounds"


def note(freq: float, dur: float, bright: float = 1.0) -> np.ndarray:
    """One electric-piano note: an FM body whose brightness fades, and a tine that dies fast."""
    t = np.arange(int(RATE * dur)) / RATE
    index = 1.3 * bright * np.exp(-t / 0.25)
    body = np.sin(2 * np.pi * freq * t + index * np.sin(2 * np.pi * freq * t)) * np.exp(-t / 0.6)
    tine = 0.12 * bright * np.sin(2 * np.pi * freq * 7.0 * t) * np.exp(-t / 0.03)
    attack = np.minimum(1.0, t / 0.002)
    # let it die out instead of stopping mid-ring (a cut is a click)
    release = np.clip((dur - t) / 0.06, 0, 1)
    return (body + tine) * attack * release


def place(parts: list[tuple[float, np.ndarray]], length: float) -> np.ndarray:
    out = np.zeros(int(RATE * length))
    for at, s in parts:
        i = int(RATE * at)
        n = min(len(s), len(out) - i)
        out[i : i + n] += s[:n]
    return out


def room(s: np.ndarray, mix: float = 0.2) -> np.ndarray:
    """A small, dark room: a few decaying taps, low-passed."""
    wet = np.zeros_like(s)
    for ms, g in [(19, 0.5), (31, 0.42), (47, 0.33), (71, 0.25), (103, 0.18), (149, 0.12)]:
        d = int(RATE * ms / 1000)
        wet[d:] += g * s[:-d]
    k = 20
    wet = np.convolve(wet, np.ones(k) / k, mode="same")
    return s + mix * wet


def finish(s: np.ndarray, peak: float) -> np.ndarray:
    fade = int(RATE * 0.03)
    s = s.copy()
    s[-fade:] *= np.linspace(1, 0, fade)
    return s / np.max(np.abs(s)) * peak


C5, E5, G5, A5, C6, E4 = 523.25, 659.25, 783.99, 880.0, 1046.5, 329.63

SOUNDS = {
    # a C major chord rolled upward, the top note a little brighter: something is ready
    "done": lambda: finish(room(place([(0.0, note(C5, 1.2)), (0.06, note(E5, 1.2)), (0.12, note(G5, 1.2)), (0.18, note(C6, 1.3, 1.2))], 1.5)), PEAK["done"]),
    # the same note twice, lightly: look here
    "waiting": lambda: finish(room(place([(0.0, note(A5, 0.6)), (0.18, note(A5, 0.9))], 1.1)), PEAK["waiting"]),
    # down a third, darker: it stopped
    "failed": lambda: finish(room(place([(0.0, note(E4 * 2, 0.9, 0.7)), (0.15, note(C5 * 0.75, 1.2, 0.6))], 1.4)), PEAK["failed"]),
}
PEAK = {"done": 0.28, "waiting": 0.18, "failed": 0.25}


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
