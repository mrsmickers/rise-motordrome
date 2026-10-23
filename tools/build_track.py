"""Build js/track-data.js.

Run: python build_track.py  (needs numpy + scipy)

Inputs in this folder:
- base_centreline.json: the lap traced from u/maxx-usa's 2D reconstruction of the 13 Oct 2026 render
  (r/RaceTrackDesigns), in world metres, 5 m apart, starting at the start of the main straight.
- official_esses.json: the esses-to-forest stretch taken from the official Tilke / Dar / WurzDesign
  render, by fitting a camera to its magenta layout line and projecting that line onto the ground.
  It replaces the traced stretch between the 'from' and 'to' distances.

Heights and banking follow what Alex Wurz and Carsten Tilke have said (The Race, PlanetF1, Oct 2026):
6.0 km, 197 m of climbing a lap, about 1,363 to 1,415 m above sea level, grades of 12 to 15%,
Turn 2 entered downhill at 10.8% into 12% banking that eases to 6% then 4% on a 14 to 15% climb,
over 12% banking on some corners, no off-camber corners, a crest into a double right-hander
with the compression at the apex, and a back straight that drops, compresses and climbs at 12 to 13%.
"""
import json, os
import numpy as np
from scipy.ndimage import gaussian_filter1d

HERE = os.path.dirname(os.path.abspath(__file__))
LENGTH = 6000.0
STEP = 5.0
K = 6000.0 / 5714.0  # height keys and corners below are in the original traced 5,714 m scale


def resample(P, step, closed=True):
    Q = np.vstack([P, P[:1]]) if closed else P
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(Q, axis=0).T))]
    s = np.arange(0, d[-1] - (step * 0.5 if closed else 0), step)
    return np.c_[np.interp(s, d, Q[:, 0]), np.interp(s, d, Q[:, 1])], d[-1]


def adaptive_smooth(M, passes=2):
    # wide smoothing on straights, light smoothing in corners
    for _ in range(passes):
        n = len(M)
        T = np.roll(M, -1, 0) - np.roll(M, 1, 0)
        th = np.unwrap(np.arctan2(T[:, 1], T[:, 0]))
        kk = np.abs(gaussian_filter1d(np.gradient(th), 30, mode='wrap'))
        t = np.clip((kk - 1 / 700) / (1 / 160 - 1 / 700), 0, 1)
        sig = 34 * (1 - t) + 3 * t
        out = np.empty_like(M)
        offs = np.arange(-110, 111)
        for i in range(n):
            w = np.exp(-(offs ** 2) / (2 * sig[i] ** 2))
            out[i] = (M[(i + offs) % n] * w[:, None]).sum(0) / w.sum()
        M = out
    return M


sstep = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))

# ---------- centreline: traced lap with the official esses spliced in ----------
base = np.array(json.load(open(os.path.join(HERE, 'base_centreline.json')))['pts'])
B, _ = resample(base, 1.0)                      # 1 m apart, index = distance on the traced lap
off = json.load(open(os.path.join(HERE, 'official_esses.json')))
iA, iB = int(off['from']), int(off['to'])
sec, _ = resample(np.array(off['section']), 1.0, closed=False)
# the projected line carries pixel noise and a kink where it crosses the slope. Light smoothing for
# the noise, then ease only the points tighter than about a 75 m radius (the esses are fast and
# flowing), with both ends held where they join the traced lap.
sec = np.c_[gaussian_filter1d(sec[:, 0], 5, mode='nearest'), gaussian_filter1d(sec[:, 1], 5, mode='nearest')]
sec, _ = resample(sec, 4.0, closed=False)
def curv(P):
    a, b, c = P[:-2], P[1:-1], P[2:]
    ab, bc, ac = np.hypot(*(b - a).T), np.hypot(*(c - b).T), np.hypot(*(c - a).T)
    cross = (b - a)[:, 0] * (c - b)[:, 1] - (b - a)[:, 1] * (c - b)[:, 0]
    return np.r_[0, 2 * cross / (ab * bc * ac + 1e-9), 0]
for it in range(3000):
    kk = np.abs(curv(sec))
    tight = np.convolve((kk > 1 / 75).astype(float), np.ones(7), 'same') > 0
    tight[:8] = tight[-8:] = False
    if not tight.any(): break
    mid = (np.roll(sec, 1, 0) + np.roll(sec, -1, 0)) / 2
    sec[tight] += 0.3 * (mid[tight] - sec[tight])
print('esses eased in', it, 'passes; tightest radius', round(1 / max(np.abs(curv(sec))[8:-8].max(), 1e-6)), 'm')
sec, _ = resample(sec, 1.0, closed=False)
# ease into and out of the official line over 90 m at each end
n_sec = len(sec)
j = np.arange(n_sec)
w = np.minimum(sstep(0, 90, j), sstep(0, 90, n_sec - 1 - j))[:, None]
near = np.array([B[np.argmin(((B - p) ** 2).sum(1))] for p in sec])
sec = near + (sec - near) * w
M = np.vstack([B[:iA], sec, B[iB:]])
# smooth only around the splice so the rest of the lap keeps its shape
win = np.zeros(len(M))
win[max(0, iA - 150):iA + n_sec + 150] = 1
win = gaussian_filter1d(win, 40)[:, None]
M = M * (1 - win) + adaptive_smooth(M) * win
# index on the spliced lap for a distance on the traced lap
def spliced_index(old):
    old = np.asarray(old, float)
    return np.where(old <= iA, old, np.where(old >= iB, old - iB + iA + n_sec, iA + (old - iA) / (iB - iA) * n_sec))
d = np.r_[0, np.cumsum(np.hypot(*np.diff(np.vstack([M, M[:1]]), axis=0).T))]
L_raw = d[-1]
def remap(old):  # traced-lap distance (6000 m scale) -> distance on the finished lap
    return np.interp(spliced_index(old), np.arange(len(d)), d) * LENGTH / L_raw
M = M * LENGTH / L_raw
M, L = resample(M, STEP)
N = len(M)
s = np.arange(N) * STEP
# traced-lap distance for each finished sample, so the rules below can stay in traced terms
knots_new = remap(np.arange(0, 6001, 1.0))
old_s = np.interp(s, knots_new, np.arange(0, 6001, 1.0))
print('points', N, 'length', round(L, 1), 'spliced section', n_sec, 'm (was', iB - iA, 'm)')

# Curvature (rad/m), + = right turn in a y-down/x-east map (world z = south)
T = np.roll(M, -1, 0) - np.roll(M, 1, 0)
h = np.unwrap(np.arctan2(T[:, 1], T[:, 0]))
k = gaussian_filter1d(np.gradient(h) / STEP, 2, mode='wrap')

# ---------- heights: (distance in traced 5,714 m scale, metres above sea level) ----------
keys = [
    (0, 1377), (180, 1386), (430, 1397),            # main straight climbs to a crest
    (470, 1396.2), (760, 1363.5),                   # 10.8% plunge into the Turn 2 compression
    (800, 1364.2), (1115, 1411.5),                  # 14-15% climb out of Turn 2
    (1250, 1412.5), (1308, 1412), (1440, 1397),     # T3 then down to the T4 hairpin
    (1624, 1412.5), (1728, 1398.5), (1960, 1405),   # T5, T6, T7 onto the back straight
    (2000, 1403.6), (2240, 1370.5),                 # back straight drops at about 12.5% ...
    (2275, 1370.9), (2560, 1407),                   # ... compresses in a short valley, climbs at about 12.5%
    (2740, 1400.5), (2980, 1415), (3040, 1415.2),   # into the heavy braking for the T8 hairpin
    (3200, 1401.5), (3410, 1410),                   # T9, the canopy corner, crests towards the lake
    (3450, 1408.8), (3700, 1382),                   # light over the crest, then a 10% compression
    (3820, 1390), (3990, 1376),                     # T10/T11: the forest corner round the lake
    (4110, 1393),                                   # over a hill ...
    (4215, 1381),                                   # ... into the double right, compression at the apex
    (4426, 1388), (4500, 1384),                     # T13
    (4574, 1391), (4684, 1379),                     # the esses
    (4848, 1370), (5100, 1401),                     # esses climb
    (5424, 1372), (5714, 1377),                     # final hairpin and back to the line
]
ks = np.array([k_[0] for k_ in keys]) * K
kh = np.array([k_[1] for k_ in keys])
ss = np.r_[ks[:-1] - LENGTH, ks[:-1], ks[:-1] + LENGTH]
hh = np.r_[kh[:-1], kh[:-1], kh[:-1]]
elev = np.interp(old_s, ss, hh)
elev = gaussian_filter1d(elev, 6, mode='wrap')   # round off crests and dips (30 m sigma)
lo, hi = elev.min(), elev.max()
elev = 1363.5 + (elev - lo) * (1415.0 - 1363.5) / (hi - lo)

grad = (np.roll(elev, -1) - np.roll(elev, 1)) / (2 * STEP)
climb = np.sum(np.clip(np.diff(np.r_[elev, elev[:1]]), 0, None))
bad = np.where(np.abs(grad) > 0.15)[0]
if len(bad): print('steep at s', sorted(set((s[bad] // 10 * 10).astype(int).tolist())))
print('elev range', elev.min().round(1), elev.max().round(1), 'climb', climb.round(1),
      'max grad %', (grad.max() * 100).round(1), 'min grad %', (grad.min() * 100).round(1))

# ---------- corners ----------
corners = [  # (number, apex in traced scale, direction, name, banking at the apex)
    (1, 578, 'L', 'Turn 1', 0.04), (2, 784, 'R', 'Turn 2 · Banked compression', 0.12), (3, 1308, 'R', 'Turn 3', 0.06),
    (4, 1440, 'L', 'Turn 4 · Hairpin', 0.08), (5, 1624, 'R', 'Turn 5', 0.05), (6, 1728, 'L', 'Turn 6', 0.06),
    (7, 1970, 'L', 'Turn 7 · Back straight', 0.03), (8, 3006, 'L', 'Turn 8 · Top hairpin', 0.125),
    (9, 3374, 'R', 'Turn 9 · Canopy corner', 0.06), (10, 3740, 'L', 'Turn 10 · Forest', 0.125),
    (11, 3910, 'L', 'Turn 11 · Forest', 0.10), (12, 4152, 'R', 'Turn 12 · Double right', 0.07), (13, 4426, 'R', 'Turn 13 · Double right', 0.07),
    (14, 4574, 'L', 'Turn 14 · Esses', 0.05), (15, 4684, 'R', 'Turn 15 · Esses', 0.05),
    (16, 4848, 'L', 'Turn 16 · Esses', 0.05), (17, 5424, 'L', 'Turn 17 · Final hairpin', 0.08),
]
apex = []
for c in corners:
    sn = float(remap(c[1] * K))
    if iA - 60 <= c[1] * K <= iB + 60:
        # the official line moved these corners: put the apex at the tightest point nearby
        sign = 1 if c[2] == 'R' else -1
        i0 = int(sn / STEP)
        cand = [(i0 + o) % N for o in range(-14, 15)]
        best = max(cand, key=lambda i: k[i] * sign)
        sn = best * STEP
    apex.append(sn)

# ---------- banking (fraction, + raises the left edge). Positive camber everywhere ----------
bank = np.clip(np.abs(k) * 2.4, 0, 0.065) * np.sign(k)
for c, sn in zip(corners, apex):
    if c[0] == 2: continue
    sign = 1 if c[2] == 'R' else -1
    dist = np.abs(((s - sn + LENGTH / 2) % LENGTH) - LENGTH / 2)
    wgt = 1 - sstep(45, 95, dist)
    want = sign * c[4] * wgt
    take = np.abs(want) > np.abs(bank)
    bank[take] = want[take]
t2 = (old_s > 700 * K) & (old_s < 1010 * K)
bank[t2] = 0.12
ex = (old_s >= 1010 * K) & (old_s < 1110 * K); bank[ex] = 0.06     # Turn 2 exit: 12% -> 6% -> 4%
ex2 = (old_s >= 1110 * K) & (old_s < 1180 * K); bank[ex2] = 0.04
bank = gaussian_filter1d(bank, 4, mode='wrap')
# drainage crossfall on the straights leans the same way as any bend, so nothing is off-camber
straight = np.abs(bank) < 0.015
bank[straight] = 0.015 * np.where(k[straight] < 0, -1, 1)
off_camber = np.sum((np.abs(k) > 1 / 400) & (np.sign(bank) != np.sign(k)))
print('off-camber samples in corners:', off_camber)

# Width: 15 m normally, 19 m through T1-T3 (wide for attack and defence), 17 m on the main straight
width = np.full(N, 15.0)
width[(old_s > 5600 * K) | (old_s < 470 * K)] = 17.0
width[(old_s > 470 * K) & (old_s < 1360 * K)] = 19.0
width = gaussian_filter1d(width, 6, mode='wrap')

out = {
    'length': LENGTH, 'step': STEP,
    'x': M[:, 0].round(2).tolist(), 'z': M[:, 1].round(2).tolist(),
    'y': elev.round(2).tolist(),
    'bank': bank.round(4).tolist(), 'width': width.round(2).tolist(),
    'corners': [dict(n=c[0], s=round(sn, 1), dir=c[2], name=c[3]) for c, sn in zip(corners, apex)],
    'sectors': [0, round(float(remap(1960 * K))), round(float(remap(3990 * K)))],
    'startLine': round(float(remap(80.0)), 1),
}
js = '// Generated by tools/build_track.py. Do not edit by hand.\nexport const TRACK = ' + json.dumps(out, separators=(',', ':')) + ';\n'
open(os.path.join(HERE, '..', 'js', 'track-data.js'), 'w').write(js)
print('wrote', len(js) // 1024, 'KB')
for c, sn in zip(corners, apex):
    i = int(sn / STEP) % N
    print(f"{c[0]:2d} {c[3]:30s} s {sn:6.0f} h {elev[i]:6.1f} grad {grad[i] * 100:5.1f}% R {1 / max(abs(k[i]), 1e-6):5.0f} bank {bank[i] * 100:5.1f}%")
