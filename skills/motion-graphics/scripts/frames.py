"""Frame-difference checks on a video: pops, one-frame flashes, dead stretches, and (with --cuts) its hard cuts.

usage: python3 frames.py <video> [--known 2.0,4.0] [--cuts] [--dead 3.0] [--from 0] [--to end]

  pop    a frame that changes far more than its neighbours (diff > 3x both neighbours and > 2.0):
         an element jumping, a scene starting a frame late, a missing sub-frame
  flash  frame n differs from both neighbours while n-1 and n+1 look alike: the stage background
         or a stray element showing for one frame (the usual scene-change bug)
  dead   longer than --dead seconds with nothing changing (mean diff < 0.15)
  cut    a whole-frame change (diff > 25) in one frame. With --known (the film's CUTS, seconds), a cut more than
         one frame away from every known cut is reported as unexpected
  --cuts list hard cuts (diff > 6 and > 3.5x the local median over +-6 frames): for timing a reference film

Frames are compared as 180x180 greyscale, read through ffmpeg. Exit status 1 on flashes, pops or unexpected cuts.
"""
import argparse, json, subprocess, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('video'); ap.add_argument('--cuts', action='store_true')
ap.add_argument('--dead', type=float, default=3.0)
ap.add_argument('--known', default='', help='expected hard cuts in seconds, comma-separated')
ap.add_argument('--from', dest='t0', type=float, default=0); ap.add_argument('--to', dest='t1', type=float)
a = ap.parse_args()

probe = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate',
                                   '-of', 'json', a.video], capture_output=True, text=True, check=True).stdout)
num, den = probe['streams'][0]['r_frame_rate'].split('/'); fps = float(num) / float(den)
S = 180
cmd = ['ffmpeg', '-v', 'error', '-ss', str(a.t0)] + (['-to', str(a.t1)] if a.t1 else []) + \
      ['-i', a.video, '-vf', f'scale={S}:{S},format=gray', '-f', 'rawvideo', '-']
raw = subprocess.run(cmd, capture_output=True, check=True).stdout
F = np.frombuffer(raw, np.uint8).reshape(-1, S, S).astype(np.float32)
n = len(F)
if n < 3: sys.exit(f'only {n} frames')
d = np.abs(np.diff(F, axis=0)).mean(axis=(1, 2))          # d[i] = change from frame i to i+1
t = lambda i: a.t0 + i / fps

if a.cuts:
    cuts = []
    for i in range(len(d)):
        lo, hi = max(0, i - 6), min(len(d), i + 7)
        med = np.median(np.r_[d[lo:i], d[i + 1:hi]]) if hi - lo > 1 else 0
        if d[i] > 6 and d[i] > 3.5 * max(med, .3): cuts.append(i + 1)
    gaps = np.diff([0] + cuts + [n]) / fps
    print(f'{len(cuts)} cuts in {n / fps:.2f}s ({len(cuts) / (n / fps) * 60:.0f}/min); shot lengths {gaps.min():.2f}–{gaps.max():.2f}s, median {np.median(gaps):.2f}s')
    for c in cuts: print(f'cut at {t(c):.3f}s (frame {c})')
    sys.exit(0)

pops, flashes = [], []
for i in range(1, len(d) - 1):
    if d[i] > 2.0 and d[i] > 3 * d[i - 1] and d[i] > 3 * d[i + 1]: pops.append(i + 1)
for i in range(1, n - 1):
    a_, b_ = np.abs(F[i] - F[i - 1]).mean(), np.abs(F[i] - F[i + 1]).mean()
    same = np.abs(F[i - 1] - F[i + 1]).mean()
    if a_ > 4 and b_ > 4 and same < .35 * min(a_, b_): flashes.append(i)
flash_set = set(flashes)
pops = [p for p in pops if p not in flash_set and p - 1 not in flash_set]
known = [float(x) for x in a.known.split(',') if x.strip()]
hard = [p for p in pops if d[p - 1] > 25]
pops = [p for p in pops if d[p - 1] <= 25]
unexpected = [p for p in hard if known and all(abs(t(p) - k) > 1.01 / fps for k in known)] if known else []
dead, run = [], 0
for i, x in enumerate(np.r_[d, 99]):
    if x < .15: run += 1
    else:
        if run / fps > a.dead: dead.append((i - run, i))
        run = 0

for i in flashes: print(f'flash at {t(i):.3f}s (frame {i})')
for i in pops: print(f'pop   at {t(i):.3f}s (frame {i}), change {d[i - 1]:.1f} vs neighbours {d[i - 2]:.1f}, {d[i] if i < len(d) else 0:.1f}')
for i in hard: print(f'cut   at {t(i):.3f}s (frame {i})' + ('  UNEXPECTED: not in --known' if i in unexpected else ''))
for s, e in dead: print(f'dead  {t(s):.2f}–{t(e):.2f}s ({(e - s) / fps:.1f}s with nothing changing)')
print(f'{n} frames at {fps:g} fps: {len(flashes)} flashes, {len(pops)} pops, {len(hard)} cuts'
      + (f' ({len(unexpected)} unexpected)' if known else '') + f', {len(dead)} dead stretches')
sys.exit(1 if flashes or pops or unexpected else 0)
