"""Build js/track-data.js from the traced centreline (tools/ordered.json).

Run: python build_track.py  (needs numpy + scipy)
Layout source: maxx-usa's 2D reconstruction of the 13 Oct 2026 render (r/RaceTrackDesigns).
Heights and banking are designed to the published figures: 6.0 km, 197 m climb a lap,
about 1,363-1,415 m above sea level, 12-15% gradients, Turn 2 banked at 12%.
"""
import json, os
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.interpolate import PchipInterpolator

HERE = os.path.dirname(os.path.abspath(__file__))
LENGTH = 6000.0
STEP = 5.0

P = np.array(json.load(open(os.path.join(HERE, 'ordered.json')))['pts'])[::-1]
a, b = P[-1], P[0]
n = int(np.hypot(*(b - a)))
P = np.vstack([P, [a + (b - a) * t for t in np.linspace(0, 1, n + 2)[1:-1]]])

def resample(P, step):
    Q = np.vstack([P, P[:1]])
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(Q, axis=0).T))]
    s = np.arange(0, d[-1] - step * 0.5, step)
    return np.c_[np.interp(s, d, Q[:, 0]), np.interp(s, d, Q[:, 1])], d[-1]

P, _ = resample(P, 1.0)
P = np.c_[gaussian_filter1d(P[:, 0], 3, mode='wrap'), gaussian_filter1d(P[:, 1], 3, mode='wrap')]
P, L = resample(P, 0.5)
M = P * (LENGTH / L)
M -= (M.min(axis=0) + M.max(axis=0)) / 2
M, L = resample(M, 0.25)
M *= LENGTH / L
M, L = resample(M, 1.0)

def adaptive_smooth(M, passes=3):
    # Wide smoothing on straights, light smoothing in corners
    for _ in range(passes):
        n = len(M)
        T = np.roll(M, -1, 0) - np.roll(M, 1, 0)
        th = np.unwrap(np.arctan2(T[:, 1], T[:, 0]))
        kk = np.abs(gaussian_filter1d(np.gradient(th) / 1.0, 30, mode='wrap'))
        t = np.clip((kk - 1 / 700) / (1 / 160 - 1 / 700), 0, 1)
        sig = 34 * (1 - t) + 3 * t
        out = np.empty_like(M)
        r = 110
        offs = np.arange(-r, r + 1)
        for i in range(n):
            w = np.exp(-(offs ** 2) / (2 * sig[i] ** 2))
            idx = (i + offs) % n
            out[i] = (M[idx] * w[:, None]).sum(0) / w.sum()
        M = out
    return M

M = adaptive_smooth(M)
M, L = resample(M, 0.5)
M *= LENGTH / L
M, L = resample(M, STEP)
N = len(M)
s = np.arange(N) * STEP
print('points', N, 'length', round(L, 1), 'extent', M.min(axis=0).round(), M.max(axis=0).round())

# Curvature (rad/m), + = right turn in a y-down/x-east map (world z = south)
T = np.roll(M, -1, 0) - np.roll(M, 1, 0)
h = np.unwrap(np.arctan2(T[:, 1], T[:, 0]))
k = gaussian_filter1d(np.gradient(h) / STEP, 2, mode='wrap')

# Height keys: (distance in the traced 5714 m scale, metres above sea level). Rescaled below.
K = 6000.0 / 5714.0
keys = [
    (0, 1377), (180, 1386), (430, 1397),            # main straight climbs to a crest
    (470, 1396.2), (760, 1363.5),                   # 10.8% plunge into Turn 2 compression
    (800, 1364.2), (1115, 1411.5),                  # 14-15% climb out of Turn 2
    (1250, 1412.5), (1308, 1412), (1440, 1397),     # T3 then down to the T4 hairpin
    (1624, 1410), (1728, 1398.5), (1960, 1405),       # T5, T6, T7 onto the back straight
    (2000, 1403.6), (2240, 1367),                   # back straight drops ...
    (2275, 1367.4), (2560, 1407),                   # ... compresses, then climbs
    (2740, 1400.5), (2980, 1415), (3040, 1415.2),                   # into the braking zone for the T8 hairpin
    (3200, 1401.5), (3410, 1410),                   # T9 "canopy" crest towards the lake
    (3450, 1408.8), (3700, 1382),                   # 10% drop into the compression at T10
    (3820, 1390), (3990, 1376),                   # T10/T11 double-apex left
    (4130, 1393.5),                                 # crest before the T12-T13 double right
    (4290, 1378), (4426, 1388), (4500, 1384),       # T12-T13
    (4574, 1391), (4684, 1379),                     # lakeside esses
    (4848, 1370.5), (5100, 1397),                   # forest climb
    (5424, 1372), (5714, 1377),                     # final hairpin and back to the line
]
ks = np.array([k_[0] for k_ in keys]) * K
kh = np.array([k_[1] for k_ in keys])
# periodic PCHIP: pad one lap either side
ss = np.r_[ks[:-1] - LENGTH, ks[:-1], ks[:-1] + LENGTH]
hh = np.r_[kh[:-1], kh[:-1], kh[:-1]]
elev = np.interp(s, ss, hh)
elev = gaussian_filter1d(elev, 6, mode='wrap')   # round off crests and dips (30 m sigma)
lo, hi = elev.min(), elev.max()
elev = 1363.5 + (elev - lo) * (1415.0 - 1363.5) / (hi - lo)

grad = (np.roll(elev, -1) - np.roll(elev, 1)) / (2 * STEP)
climb = np.sum(np.clip(np.diff(np.r_[elev, elev[:1]]), 0, None))
bad = np.where(np.abs(grad) > 0.15)[0]
if len(bad): print('steep at s', sorted(set((s[bad] / K // 10 * 10).astype(int).tolist())))
vc = np.gradient(grad) / STEP   # 1/m, + = dip (compression)
print('tightest crest R', round(1 / max(-vc.min(), 1e-6)), 'at', round(s[np.argmin(vc)] / K), ' tightest dip R', round(1 / max(vc.max(), 1e-6)), 'at', round(s[np.argmax(vc)] / K))
print('elev range', elev.min().round(1), elev.max().round(1), 'climb', climb.round(1),
      'max grad %', (grad.max() * 100).round(1), 'min grad %', (grad.min() * 100).round(1))

# Banking (fraction, + raises the left edge). Positive camber into every corner.
bank = np.clip(np.abs(k) * 2.4, 0, 0.065) * np.sign(k)
t2 = (s > 700 * K) & (s < 1010 * K)
bank[t2] = np.sign(k[t2]) * 0.12
# T2 exit eases 12% -> 6% -> 4%
ex = (s >= 1010 * K) & (s < 1110 * K); bank[ex] = 0.06 * np.sign(k[ex] + 1e-9)
ex2 = (s >= 1110 * K) & (s < 1180 * K); bank[ex2] = 0.04 * np.sign(k[ex2] + 1e-9)
bank = gaussian_filter1d(bank, 5, mode='wrap')
straight = np.abs(k) < 1 / 1200
bank[straight] = np.where(np.abs(bank[straight]) < 0.015, 0.015, bank[straight])  # drainage crossfall

# Width: 15 m normally, 19 m through T1-T3 (wide for attack and defence), 17 m on the main straight
width = np.full(N, 15.0)
width[(s > 5600 * K) | (s < 470 * K)] = 17.0
width[(s > 470 * K) & (s < 1360 * K)] = 19.0
width = gaussian_filter1d(width, 6, mode='wrap')

corners = [  # (number, apex distance in traced scale, direction, name)
    (1, 578, 'L', 'Turn 1'), (2, 784, 'R', 'Turn 2 · Banked compression'), (3, 1308, 'R', 'Turn 3'),
    (4, 1440, 'L', 'Turn 4 · Hairpin'), (5, 1624, 'R', 'Turn 5'), (6, 1728, 'L', 'Turn 6'),
    (7, 1970, 'L', 'Turn 7 · Back straight'), (8, 3006, 'L', 'Turn 8 · Top hairpin'),
    (9, 3374, 'R', 'Turn 9 · Canopy crest'), (10, 3740, 'L', 'Turn 10 · Lake loop'),
    (11, 3910, 'L', 'Turn 11'), (12, 4152, 'R', 'Turn 12 · Double right'), (13, 4426, 'R', 'Turn 13'),
    (14, 4574, 'L', 'Turn 14 · Lakeside esses'), (15, 4684, 'R', 'Turn 15 · Lakeside esses'),
    (16, 4848, 'L', 'Turn 16 · Forest'), (17, 5424, 'L', 'Turn 17 · Final hairpin'),
]

out = {
    'length': LENGTH, 'step': STEP,
    'x': M[:, 0].round(2).tolist(), 'z': M[:, 1].round(2).tolist(),
    'y': (elev).round(2).tolist(),
    'bank': bank.round(4).tolist(), 'width': width.round(2).tolist(),
    'corners': [dict(n=c[0], s=round(c[1] * K, 1), dir=c[2], name=c[3]) for c in corners],
    'sectors': [0, round(1960 * K), round(3990 * K)],
    'startLine': 80.0,
}
js = '// Generated by tools/build_track.py. Do not edit by hand.\nexport const TRACK = ' + json.dumps(out, separators=(',', ':')) + ';\n'
open(os.path.join(HERE, '..', 'js', 'track-data.js'), 'w').write(js)
print('wrote', len(js) // 1024, 'KB')
for c in corners:
    i = int(c[1] * K / STEP)
    print(c[0], c[3], 'h', elev[i].round(1), 'grad%', (grad[i] * 100).round(1), 'R', round(1 / max(abs(k[i]), 1e-6)), 'bank%', (bank[i] * 100).round(1))
