"""Sound for a film, synthesized with numpy and placed on the film's own timeline.

Use it as a library from a cue file next to the film:

    import sys; sys.path.insert(0, '<this skill>/scripts'); from sfx import *
    mix = Mix(dur=30.0, bpm=120)
    for b in range(mix.bars(0, 16)): mix.drums.put(mix.bar(b), kick())          # kick on every bar line
    for t in key_times: mix.fx.put(t, key(), pan=-.2)                           # same times as the page's typing
    mix.fx.put(5.0, whoosh(.6), pan_to=(-.6, .6))                               # pans with the movement
    mix.music.put(0, pad(30, chord('Am')), gain=.4)
    mix.sidechain(mix.music, kicks=[mix.bar(b) for b in range(16)])
    mix.write('film.wav')

Buses: music, drums, fx, plus a reverb send (convolution with a synthetic stereo room).
Check section loudness afterwards with loudness.sh; you cannot hear the result, so report measured levels.
Requires numpy and scipy.
"""
import wave
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
_rng = np.random.default_rng(7)


def T(d): return np.arange(int(SR * d)) / SR
def noise(d): return _rng.standard_normal(int(SR * d))
def env(n, a=.004, r=None, curve=4.0):
    t = np.arange(n) / SR; d = n / SR; r = d - a if r is None else r
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-curve * np.maximum(0, t - a) / max(r, 1e-4))
def _sos(kind, f): return butter(2, f, btype=kind, output='sos', fs=SR)
def hp(x, f): return sosfilt(_sos('high', f), x)
def lp(x, f): return sosfilt(_sos('low', f), x)
def bp(x, lo, hi): return sosfilt(butter(2, [lo, min(hi, SR / 2 * .99)], btype='band', output='sos', fs=SR), x)
def norm(x, peak=1.0): return x / (np.abs(x).max() + 1e-9) * peak


# ───────── notes
NOTE = {n: i for i, n in enumerate(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])}
def hz(name, octave=3): return 440 * 2 ** ((NOTE[name] + 12 * (octave + 1) - 69) / 12)
def chord(name, octave=3):
    """'Am', 'F', 'C', 'G', 'Dm7' … → frequencies."""
    root = name[:2] if len(name) > 1 and name[1] == '#' else name[0]
    q = name[len(root):]
    steps = {'': [0, 4, 7, 12], 'm': [0, 3, 7, 12], '7': [0, 4, 7, 10], 'm7': [0, 3, 7, 10], 'maj7': [0, 4, 7, 11], 'sus2': [0, 2, 7, 12]}[q]
    f0 = hz(root, octave); return [f0 * 2 ** (s / 12) for s in steps]


# ───────── instruments (each returns a mono numpy array)
def kick(d=.45, f0=150, f1=45):
    t = T(d); f = f1 + (f0 - f1) * np.exp(-t * 28); return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(len(t), .002, d, 6)
def sub_boom(d=1.6, f0=120, f1=38):
    t = T(d); f = f1 + (f0 - f1) * np.exp(-t * 9); return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(len(t), .003, d, 3.2)
def clap(d=.25):
    x = sum(np.roll(bp(noise(d), 900, 5000) * env(int(SR * d), .001, d, 14), int(SR * k)) for k in (0, .011, .023))
    return x * .5
def hat(d=.06, open_=False):
    d = .3 if open_ else d; return hp(noise(d), 7000) * env(int(SR * d), .001, d, 6 if open_ else 18) * .4
def click(d=.035, bright=1.0):
    """A mouse click: call twice (press, then release ~80 ms later, release quieter)."""
    t = T(d); return hp(noise(d), 2500 * bright) * env(len(t), .0005, d, 9) * .7 + np.sin(2 * np.pi * 180 * t) * env(len(t), .001, d, 14) * .5
def key(heavy=False):
    """A keyboard key; heavy for space and enter."""
    d = .07 if heavy else .045; t = T(d)
    body = np.sin(2 * np.pi * (95 if heavy else 140) * t) * env(len(t), .001, d, 16) * (1 if heavy else .45)
    return body + hp(noise(d), 1800 + _rng.uniform(-300, 600)) * env(len(t), .0005, d, 20) * (.8 if heavy else .55)
def whoosh(d=.6, lo=300, hi=4000, rise=True):
    x = noise(d); n = len(x); out = np.zeros(n); seg = 512
    for s in range(0, n, seg):
        k = s / n if rise else 1 - s / n; f = lo * (hi / lo) ** k
        out[s:s + seg] = bp(x[s:s + seg], max(40, f * .7), f * 1.4)
    return out * np.sin(np.pi * np.linspace(0, 1, n)) ** 1.6
def swell(d=1.2, lo=200, hi=8000):
    """Reverse-cymbal rise that ends exactly at d (place it so it ends on the hit)."""
    x = whoosh(d, lo, hi, True); return norm(x) * np.linspace(0, 1, len(x)) ** 3
def pop(d=.18):
    t = T(d); f = 380 + 900 * (1 - np.exp(-t * 40)); return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(len(t), .002, d, 9)
def tink(f=2600, d=1.2):
    t = T(d); return sum(np.sin(2 * np.pi * f * k * t) / k ** 1.3 for k in (1, 2.01, 3.03, 4.2)) * env(len(t), .001, d, 5.5) * .5
def blip(f=880, d=.08):
    t = T(d); return np.sin(2 * np.pi * f * t) * env(len(t), .002, d, 10) * .5
def shimmer(d=1.4, f=6000): return hp(noise(d), f) * env(int(SR * d), .01, d, 4) * .35
def pluck(f, d=.6):
    t = T(d); x = sum(np.sin(2 * np.pi * f * k * t) * .6 ** k for k in range(1, 6)); return lp(x, 3000) * env(len(t), .002, d, 7) * .4
def pad(d, freqs, cutoff=1200, detune=.004, fade=.8):
    t = T(d)
    x = sum(np.sin(2 * np.pi * f * (1 + s * detune) * t + i) for i, f in enumerate(freqs) for s in (-1, 0, 1)) / (3 * len(freqs))
    e = np.minimum(1, t / fade) * np.minimum(1, (d - t) / fade); return hp(lp(x, cutoff), 150) * e
def bass(f, d):
    t = T(d); x = np.sin(2 * np.pi * f * t) + .3 * np.sin(2 * np.pi * 2 * f * t); return lp(x, 400) * env(len(t), .01, d, 1.5) * .6


# ───────── mixing
class Bus:
    def __init__(self, n): self.L = np.zeros(n); self.R = np.zeros(n)
    def put(self, t0, x, gain=1.0, pan=0.0, pan_to=None):
        """Place x at t0 s. pan in -1..1; pan_to=(a, b) moves across the sound (whooshes follow the motion)."""
        i = int(t0 * SR); n = min(len(x), len(self.L) - i)
        if n <= 0 or i < 0: return
        p = np.linspace(pan_to[0], pan_to[1], n) if pan_to else np.full(n, pan)
        self.L[i:i + n] += x[:n] * gain * np.sqrt((1 - p) / 2) * 1.414
        self.R[i:i + n] += x[:n] * gain * np.sqrt((1 + p) / 2) * 1.414


class Mix:
    def __init__(self, dur, bpm=120):
        self.n = int(SR * dur); self.bpm = bpm; self.beat = 60 / bpm
        self.music, self.drums, self.fx, self.verb = (Bus(self.n) for _ in range(4))
    def bar(self, i, beat=0): return (i * 4 + beat) * self.beat
    def bars(self, t0, t1): return range(int(t0 / (self.beat * 4)), int(t1 / (self.beat * 4)))
    def send(self, bus, amount=.25):
        """Copy a bus into the reverb send."""
        self.verb.L += bus.L * amount; self.verb.R += bus.R * amount
    def sidechain(self, bus, kicks, depth=.55, release=.22):
        """Duck a bus under each kick (music breathing with the drums)."""
        g = np.ones(self.n); r = int(SR * release)
        for k in kicks:
            i = int(k * SR); m = min(r, self.n - i)
            if m > 0: g[i:i + m] = np.minimum(g[i:i + m], 1 - depth * (1 - np.linspace(0, 1, m)) ** 2)
        bus.L *= g; bus.R *= g
    def _room(self, d=2.2):
        n = int(SR * d)
        return [lp(noise(d), 6000) * np.exp(-np.arange(n) / SR * 3.2) * .02 for _ in range(2)]
    def write(self, path, peak_db=-1.0):
        irL, irR = self._room()
        wl = fftconvolve(self.verb.L, irL)[:self.n]; wr = fftconvolve(self.verb.R, irR)[:self.n]
        L = self.music.L + self.drums.L + self.fx.L + wl
        R = self.music.R + self.drums.R + self.fx.R + wr
        peak = max(np.abs(L).max(), np.abs(R).max(), 1e-9); g = 10 ** (peak_db / 20) / peak
        data = (np.stack([L, R], 1) * g * 32767).astype('<i2')
        with wave.open(path, 'wb') as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(data.tobytes())
        print('wrote', path, f'{self.n / SR:.2f}s')


if __name__ == '__main__':   # a 4-bar smoke test: python3 sfx.py out.wav
    import sys
    m = Mix(8.0, 120)
    ks = [m.bar(b, k) for b in range(4) for k in range(4)]
    for k in ks: m.drums.put(k, kick(), .9)
    for b in range(4): m.drums.put(m.bar(b, 1), clap(), .5); m.drums.put(m.bar(b, 3), clap(), .5)
    for i, c in enumerate(['Am', 'F', 'C', 'G']): m.music.put(m.bar(i), pad(2.1, chord(c)), .5)
    m.fx.put(5.8, swell(1.2)); m.fx.put(1.0, whoosh(.6), pan_to=(-.7, .7))
    m.send(m.music, .3); m.sidechain(m.music, ks)
    m.write(sys.argv[1] if len(sys.argv) > 1 else 'sfx-test.wav')
