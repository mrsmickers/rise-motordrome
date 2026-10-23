import { TRACK } from './track-data.js';
import { clamp, smoothstep } from './noise.js';

// World frame: x = east, z = south, y = up. y = 0 is BASE_ALT metres above sea level.
export const BASE_ALT = 1390;
export const LAKE_LEVEL = 1356 - BASE_ALT;
const DS = 1; // dense sample spacing in metres

const catmull = (p0, p1, p2, p3, t) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};

// Periodic gaussian blur with sigma in samples
export function blurPeriodic(src, sigma) {
  const n = src.length, r = Math.ceil(sigma * 3), w = [];
  let norm = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); w.push(v); norm += v; }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[(i + k + n) % n] * w[k + r];
    out[i] = acc / norm;
  }
  return out;
}

// Periodic sliding max (window in samples, behind = samples before, ahead = samples after)
function windowMax(src, behind, ahead) {
  const n = src.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let k = -behind; k <= ahead; k++) { const v = src[(i + k + n) % n]; if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}

export class Track {
  constructor() {
    const c = TRACK;
    this.length = c.length;
    this.corners = c.corners;
    this.sectors = c.sectors;
    this.startLine = c.startLine;
    const n = c.x.length, step = c.step;
    const M = Math.round(this.length / DS);
    this.M = M;
    this.ds = DS;
    const A = () => new Float32Array(M);
    this.px = A(); this.py = A(); this.pz = A();
    this.tx = A(); this.tz = A(); this.lx = A(); this.lz = A();
    this.kL = A(); this.grade = A(); this.vcurv = A(); this.bank = A(); this.half = A(); this.theta = A();
    const at = (arr, k) => arr[((k % n) + n) % n];
    for (let i = 0; i < M; i++) {
      const u = (i * DS) / step, j = Math.floor(u), t = u - j;
      const f = (arr) => catmull(at(arr, j - 1), at(arr, j), at(arr, j + 1), at(arr, j + 2), t);
      this.px[i] = f(c.x);
      this.pz[i] = f(c.z);
      this.py[i] = f(c.y) - BASE_ALT;
      this.bank[i] = f(c.bank);
      this.half[i] = f(c.width) * 0.5;
    }
    let prev = 0;
    for (let i = 0; i < M; i++) {
      const a = (i - 1 + M) % M, b = (i + 1) % M;
      let dx = this.px[b] - this.px[a], dz = this.pz[b] - this.pz[a];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      this.tx[i] = dx; this.tz[i] = dz;
      this.lx[i] = dz; this.lz[i] = -dx; // left = up x tangent
      let th = Math.atan2(dz, dx);
      if (i > 0) { while (th - prev > Math.PI) th -= 2 * Math.PI; while (th - prev < -Math.PI) th += 2 * Math.PI; }
      this.theta[i] = th; prev = th;
    }
    const kR = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const a = (i - 1 + M) % M, b = (i + 1) % M;
      let dth = this.theta[b] - this.theta[a];
      while (dth > Math.PI) dth -= 2 * Math.PI; while (dth < -Math.PI) dth += 2 * Math.PI;
      kR[i] = dth / (2 * DS);
      this.grade[i] = (this.py[b] - this.py[a]) / (2 * DS);
    }
    const kS = blurPeriodic(kR, 3);
    for (let i = 0; i < M; i++) this.kL[i] = -kS[i];
    const g = blurPeriodic(this.grade, 4);
    this.grade = g;
    for (let i = 0; i < M; i++) {
      const a = (i - 1 + M) % M, b = (i + 1) % M;
      this.vcurv[i] = (g[b] - g[a]) / (2 * DS);
    }
    this.vcurv = blurPeriodic(this.vcurv, 6);

    // Coarse spatial hash for nearest-point queries (every 4 m)
    this.cell = 24;
    this.grid = new Map();
    for (let i = 0; i < M; i += 4) {
      const key = this._key(this.px[i], this.pz[i]);
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      list.push(i);
    }
    this.computeRacingLine();
  }

  _key(x, z) {
    return Math.floor(x / this.cell) * 73856093 ^ Math.floor(z / this.cell) * 19349663;
  }

  wrap(s) {
    const L = this.length;
    s %= L;
    return s < 0 ? s + L : s;
  }

  // Linear interpolation of a dense array at distance s
  get(arr, s) {
    const u = this.wrap(s) / DS;
    const i = Math.floor(u), t = u - i;
    const a = arr[i % this.M], b = arr[(i + 1) % this.M];
    return a + (b - a) * t;
  }

  // Fill a frame object for distance s
  frame(s, f = {}) {
    const u = this.wrap(s) / DS;
    const i = Math.floor(u) % this.M, j = (i + 1) % this.M, t = u - Math.floor(u);
    const L = (arr) => arr[i] + (arr[j] - arr[i]) * t;
    f.x = L(this.px); f.y = L(this.py); f.z = L(this.pz);
    let tx = L(this.tx), tz = L(this.tz);
    const n = Math.hypot(tx, tz) || 1;
    tx /= n; tz /= n;
    f.tx = tx; f.tz = tz; f.lx = tz; f.lz = -tx;
    f.kL = L(this.kL); f.grade = L(this.grade); f.vcurv = L(this.vcurv);
    f.bank = L(this.bank); f.half = L(this.half); f.theta = L(this.theta);
    f.i = i;
    return f;
  }

  // Ground height at track coordinates (d > 0 = left of the direction of travel)
  heightAt(s, d, f = this.frame(s, _tmpFrame)) {
    const e = f.half;
    if (Math.abs(d) <= e) return f.y + d * f.bank;
    const sd = Math.sign(d);
    const edge = f.y + sd * e * f.bank;
    return edge - (Math.abs(d) - e) * 0.02;
  }

  // Nearest track coordinates to a world point. hint narrows the search.
  nearest(x, z, out = {}) {
    let best = -1, bestD = Infinity;
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let r = 1; r <= 6 && best < 0; r += 2) {
      for (let gx = cx - r; gx <= cx + r; gx++) {
        for (let gz = cz - r; gz <= cz + r; gz++) {
          const list = this.grid.get(gx * 73856093 ^ gz * 19349663);
          if (!list) continue;
          for (const i of list) {
            const dd = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2;
            if (dd < bestD) { bestD = dd; best = i; }
          }
        }
      }
    }
    if (best < 0) {
      for (let i = 0; i < this.M; i += 8) {
        const dd = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2;
        if (dd < bestD) { bestD = dd; best = i; }
      }
    }
    // refine on the dense polyline
    let bi = best, bd = Infinity;
    for (let k = -6; k <= 6; k++) {
      const i = (best + k + this.M) % this.M;
      const dd = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2;
      if (dd < bd) { bd = dd; bi = i; }
    }
    const dx = x - this.px[bi], dz = z - this.pz[bi];
    const along = dx * this.tx[bi] + dz * this.tz[bi];
    out.s = this.wrap(bi * DS + along);
    out.d = dx * this.lx[bi] + dz * this.lz[bi];
    out.dist = Math.hypot(dx, dz);
    out.i = bi;
    return out;
  }

  // Minimum-curvature style racing line on 5 m samples, stored as lateral offset per dense sample
  computeRacingLine() {
    const step = 5, n = Math.round(this.length / step);
    const cx = new Float32Array(n), cz = new Float32Array(n), lx = new Float32Array(n), lz = new Float32Array(n), lim = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = i * step;
      cx[i] = this.px[k]; cz[i] = this.pz[k]; lx[i] = this.lx[k]; lz[i] = this.lz[k];
      lim[i] = this.half[k] - 1.35;
    }
    let d = new Float32Array(n);
    const X = new Float32Array(n), Z = new Float32Array(n);
    for (let it = 0; it < 2600; it++) {
      for (let i = 0; i < n; i++) { X[i] = cx[i] + d[i] * lx[i]; Z[i] = cz[i] + d[i] * lz[i]; }
      for (let i = 0; i < n; i++) {
        const a2 = (i - 2 + n) % n, a1 = (i - 1 + n) % n, b1 = (i + 1) % n, b2 = (i + 2) % n;
        const tx = (-X[a2] + 4 * X[a1] + 4 * X[b1] - X[b2]) / 6;
        const tz = (-Z[a2] + 4 * Z[a1] + 4 * Z[b1] - Z[b2]) / 6;
        const dn = (tx - cx[i]) * lx[i] + (tz - cz[i]) * lz[i];
        d[i] = clamp(d[i] + 0.6 * (dn - d[i]), -lim[i], lim[i]);
      }
    }
    d = blurPeriodic(d, 1.2);
    // Curvature of the line itself
    const kl = new Float32Array(n);
    for (let i = 0; i < n; i++) { X[i] = cx[i] + d[i] * lx[i]; Z[i] = cz[i] + d[i] * lz[i]; }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      const ax = X[i] - X[a], az = Z[i] - Z[a], bx = X[b] - X[i], bz = Z[b] - Z[i];
      const cross = ax * bz - az * bx;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), lc = Math.hypot(X[b] - X[a], Z[b] - Z[a]);
      kl[i] = -(2 * cross) / (la * lb * lc + 1e-6); // + = left
    }
    this.lineStep = step;
    this.lineN = n;
    this.lineD = d;
    this.lineK = blurPeriodic(kl, 1.5);
    // ds along the line per 5 m of centreline
    const seg = new Float32Array(n);
    for (let i = 0; i < n; i++) { const b = (i + 1) % n; seg[i] = Math.hypot(X[b] - X[i], Z[b] - Z[i]); }
    this.lineSeg = seg;
  }

  lineOffset(s) {
    const u = this.wrap(s) / this.lineStep;
    const i = Math.floor(u) % this.lineN, j = (i + 1) % this.lineN, t = u - Math.floor(u);
    return this.lineD[i] + (this.lineD[j] - this.lineD[i]) * t;
  }

  // Kerbs, run-off, grass and walls on each side, derived from corner speed. speedProfile gives m/s per 5 m.
  computeLayout(speedProfile) {
    const M = this.M;
    const kerbL = new Float32Array(M), kerbR = new Float32Array(M);
    const runL = new Float32Array(M), runR = new Float32Array(M);
    const vAt = (i) => speedProfile[Math.floor(i / 5) % speedProfile.length];
    // approach speed: fastest point in the 260 m before
    const v = new Float32Array(M);
    for (let i = 0; i < M; i++) v[i] = vAt(i);
    const vApproach = windowMax(v, 260, 0);
    const corner = new Float32Array(M);
    for (let i = 0; i < M; i++) corner[i] = Math.abs(this.kL[i]) > 1 / 420 ? 1 : 0;
    const cornerZone = windowMax(corner, 40, 30);
    for (let i = 0; i < M; i++) {
      if (cornerZone[i] < 0.5) continue;
      const left = this.kL[i] > 0; // left turn: outside is right
      const k = 1.6;
      kerbL[i] = k; kerbR[i] = k;
      const out = clamp(4 + (vApproach[i] * 3.6 - 100) * 0.09, 4, 24);
      if (left) { runR[i] = out; runL[i] = 3; } else { runL[i] = out; runR[i] = 3; }
    }
    // Run-off extends past the exit and into braking zones
    const rL = blurPeriodic(windowMax(runL, 30, 90), 10), rR = blurPeriodic(windowMax(runR, 30, 90), 10);
    const kL = blurPeriodic(windowMax(kerbL, 6, 12), 2), kR = blurPeriodic(windowMax(kerbR, 6, 12), 2);

    // Free space to the next part of the circuit along each normal
    const freeL = new Float32Array(M).fill(80), freeR = new Float32Array(M).fill(80);
    for (let i = 0; i < M; i += 4) {
      for (const side of [1, -1]) {
        let free = 80;
        for (let dd = this.half[i] + 2; dd < 80; dd += 2) {
          const x = this.px[i] + this.lx[i] * dd * side, z = this.pz[i] + this.lz[i] * dd * side;
          const hit = this._otherSectionNear(x, z, i, 6);
          if (hit) { free = dd; break; }
        }
        const arr = side > 0 ? freeL : freeR;
        for (let k = 0; k < 4 && i + k < M; k++) arr[i + k] = free;
      }
    }
    const fL = blurPeriodic(windowMax(freeL.map((x) => -x), 8, 8).map((x) => -x), 4);
    const fR = blurPeriodic(windowMax(freeR.map((x) => -x), 8, 8).map((x) => -x), 4);

    const wallL = new Float32Array(M), wallR = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const e = this.half[i];
      const kl = this.kL[i];
      let wl = e + kL[i] + rL[i] + 6;
      let wr = e + kR[i] + rR[i] + 6;
      // straights keep a grass verge of about 10 m
      wl = Math.max(wl, e + 10); wr = Math.max(wr, e + 10);
      // never cross the inside of the curve or the neighbouring section
      if (kl > 0) wl = Math.min(wl, 0.8 / kl); else if (kl < 0) wr = Math.min(wr, 0.8 / -kl);
      wl = Math.min(wl, fL[i] * 0.5 - 1); wr = Math.min(wr, fR[i] * 0.5 - 1);
      wallL[i] = Math.max(wl, e + 2.5); wallR[i] = Math.max(wr, e + 2.5);
    }
    this.kerbL = kL; this.kerbR = kR;
    this.wallL = blurPeriodic(wallL, 6); this.wallR = blurPeriodic(wallR, 6);
    // run-off cannot pass the wall
    this.runL = new Float32Array(M); this.runR = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const e = this.half[i];
      this.runL[i] = clamp(rL[i], 0, Math.max(0, this.wallL[i] - e - this.kerbL[i] - 1.5));
      this.runR[i] = clamp(rR[i], 0, Math.max(0, this.wallR[i] - e - this.kerbR[i] - 1.5));
    }
    this._pitWall();
  }

  // The pit wall sits on the left of the main straight.
  _pitWall() {
    const a = this.wrap(this.startLine - 260), b = this.wrap(this.startLine + 330);
    this.pitStart = a; this.pitEnd = b;
    for (let i = 0; i < this.M; i++) {
      const s = i * DS;
      const inPit = a > b ? (s >= a || s <= b) : (s >= a && s <= b);
      if (!inPit) continue;
      const e = this.half[i];
      const edgeDist = Math.min(this.wrap(s - a), this.wrap(b - s));
      const t = smoothstep(0, 60, edgeDist);
      this.wallL[i] = this.wallL[i] + (e + 3.2 - this.wallL[i]) * t;
      this.kerbL[i] *= 1 - t; this.runL[i] *= 1 - t;
    }
  }

  _otherSectionNear(x, z, i0, radius) {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    const r2 = radius * radius;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const list = this.grid.get(gx * 73856093 ^ gz * 19349663);
        if (!list) continue;
        for (const i of list) {
          let ds = Math.abs(i - i0); ds = Math.min(ds, this.M - ds);
          if (ds < 120) continue;
          const dx = this.px[i] - x, dz = this.pz[i] - z;
          const rr = radius + this.half[i];
          if (dx * dx + dz * dz < rr * rr) return true;
        }
      }
    }
    return false;
  }

  // Corner the car is approaching (within lookahead metres)
  nextCorner(s, lookahead = 450) {
    let best = null, bestDs = Infinity;
    for (const c of this.corners) {
      const ds = this.wrap(c.s - s + 60) - 60;
      if (ds > -40 && ds < lookahead && ds < bestDs) { bestDs = ds; best = c; }
    }
    return best ? { corner: best, distance: bestDs } : null;
  }

  sectorAt(s) {
    const t = this.wrap(s - this.startLine);
    const b1 = this.wrap(this.sectors[1] - this.startLine), b2 = this.wrap(this.sectors[2] - this.startLine);
    return t < b1 ? 0 : t < b2 ? 1 : 2;
  }
}

const _tmpFrame = {};
