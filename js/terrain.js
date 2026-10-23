import * as THREE from 'three/webgpu';
import {
  Fn, attribute, positionWorld, normalWorld, vec2, vec3, float, mix, smoothstep, clamp, abs, fract, floor, max, min,
  mx_noise_float, mx_cell_noise_float, uniform, dot, sin, cos, step, bumpMap
} from 'three/tsl';
import { fbm, ridged, smoothstep as sstep, clamp as cl, lerp } from './noise.js';
import { LAKE_LEVEL } from './track.js';

// Lake Kidogo, west of the lakeside esses (world metres)
export const LAKE_BLOBS = [
  [-470, -60, 125], [-560, -40, 150], [-780, -100, 300], [-1100, 200, 420], [-1250, -350, 380],
  [-900, 520, 230], [-1500, 100, 500], [-650, -300, 150], [-1700, -600, 520], [-1450, 700, 380]
];

export function lakeSdf(x, z) {
  // smooth union of discs
  let res = 1e9;
  const k = 90;
  for (const [cx, cz, r] of LAKE_BLOBS) {
    const d = Math.hypot(x - cx, z - cz) - r;
    const h = cl(0.5 + (0.5 * (d - res)) / k, 0, 1);
    res = lerp(d, res, h) - k * h * (1 - h);
  }
  // ragged shore
  return res + fbm(x * 0.012, z * 0.012, 3, 91) * 45;
}

const NEAR = { size: 3600, step: 6 };
const FAR = { size: 44000, step: 170 };

export class Terrain {
  constructor(track) {
    this.track = track;
    this.lakeLevel = LAKE_LEVEL;
    this._buildCoarse();
    this._buildNear();
  }

  // Coarse fields: track-informed base height and distance to the track
  _buildCoarse() {
    const tr = this.track;
    const R = 3200, st = 50, n = Math.round((2 * R) / st) + 1;
    this.coarse = { R, st, n, h: new Float32Array(n * n), dist: new Float32Array(n * n) };
    const sx = [], sz = [], sy = [];
    for (let i = 0; i < tr.M; i += 10) { sx.push(tr.px[i]); sz.push(tr.pz[i]); sy.push(tr.py[i]); }
    const K = sx.length;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -R + i * st, z = -R + j * st;
        let wsum = 0, hsum = 0, dmin = 1e9;
        for (let k = 0; k < K; k++) {
          const dd = (x - sx[k]) ** 2 + (z - sz[k]) ** 2;
          if (dd < dmin) dmin = dd;
          const w = 1 / Math.pow(dd + 160 * 160, 1.6);
          wsum += w; hsum += w * sy[k];
        }
        const regional = this.regional(x, z);
        const w0 = (1 / Math.pow(1100 * 1100, 1.6)) * K * 0.08;
        this.coarse.h[j * n + i] = (hsum + w0 * regional) / (wsum + w0);
        this.coarse.dist[j * n + i] = Math.sqrt(dmin);
      }
    }
  }

  // Bugesera: rolling hills that grow away from the circuit, then distant ranges
  regional(x, z) {
    const r = Math.hypot(x, z);
    const grow = sstep(900, 4000, r);
    return -6 + fbm(x / 3200, z / 3200, 3, 5) * (22 + 40 * grow) + fbm(x / 900, z / 900, 4, 9) * (6 + 22 * grow) + ridged(x / 1500, z / 1500, 3, 41) * 30 * grow;
  }

  _coarseSample(arr, x, z) {
    const c = this.coarse;
    const u = cl((x + c.R) / c.st, 0, c.n - 1.001), v = cl((z + c.R) / c.st, 0, c.n - 1.001);
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const a = arr[j * c.n + i], b = arr[j * c.n + i + 1], d = arr[(j + 1) * c.n + i], e = arr[(j + 1) * c.n + i + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (d * (1 - fu) + e * fu) * fv;
  }

  trackDistCoarse(x, z) {
    const c = this.coarse;
    if (Math.abs(x) > c.R || Math.abs(z) > c.R) return Math.hypot(x, z);
    return this._coarseSample(c.dist, x, z);
  }

  // Natural ground with no track shaping
  natural(x, z) {
    const c = this.coarse;
    const r = Math.hypot(x, z);
    let base;
    if (Math.abs(x) < c.R && Math.abs(z) < c.R) {
      base = this._coarseSample(c.h, x, z);
      const edge = sstep(c.R * 0.75, c.R, Math.max(Math.abs(x), Math.abs(z)));
      base = lerp(base, this.regional(x, z), edge);
    } else base = this.regional(x, z);
    const dist = this.trackDistCoarse(x, z);
    const amp = 3 + 24 * sstep(90, 1100, dist);
    let h = base + fbm(x / 640, z / 640, 4, 3) * amp + fbm(x / 160, z / 160, 3, 13) * (1.2 + 2.5 * sstep(60, 600, dist));
    // distant ranges
    const far = sstep(3500, 14000, r);
    if (far > 0) h += far * (ridged(x / 5200, z / 5200, 5, 21) * 420 + ridged(x / 1800, z / 1800, 4, 33) * 90 - 60);
    // the lake basin
    const sdf = lakeSdf(x, z);
    if (sdf < 140) {
      // banks ease down to the water over about 140 m
      const bank = sstep(140, 0, sdf);
      h = lerp(h, this.lakeLevel + 1.4 + Math.max(0, sdf) * 0.06, bank * 0.85);
      const t = sstep(10, -90, sdf);
      h = lerp(Math.max(h, this.lakeLevel + 1.2), this.lakeLevel - 9, t);
    } else if (r < 9000) {
      h = Math.max(h, this.lakeLevel + 1.6);
    }
    return h;
  }

  // Near terrain, shaped around the circuit by stamping track cross-sections
  _buildNear() {
    const tr = this.track;
    const { size, step } = NEAR;
    const n = Math.round(size / step) + 1;
    this.near = { n, step, half: size / 2 };
    const N = n * n;
    const best1 = new Float32Array(N).fill(1e9), s1 = new Float32Array(N), best2 = new Float32Array(N).fill(1e9), s2 = new Float32Array(N);
    const half = size / 2;
    const idx = (x, z) => {
      const i = Math.round((x + half) / step), j = Math.round((z + half) / step);
      if (i < 0 || j < 0 || i >= n || j >= n) return -1;
      return j * n + i;
    };
    const BLEND = 75;
    for (let k = 0; k < tr.M; k++) {
      const x0 = tr.px[k], z0 = tr.pz[k], lx = tr.lx[k], lz = tr.lz[k];
      const dl = tr.wallL[k] + BLEND, dr = tr.wallR[k] + BLEND;
      for (let d = -dr; d <= dl; d += 2) {
        const id = idx(x0 + lx * d, z0 + lz * d);
        if (id < 0) continue;
        const ad = Math.abs(d);
        const s = k;
        if (ad < best1[id]) {
          // keep the old best in slot 2 if it belongs to another part of the lap
          let dsec = Math.abs(s1[id] - s); dsec = Math.min(dsec, tr.M - dsec);
          if (best1[id] < 1e9 && dsec > 150) { best2[id] = best1[id]; s2[id] = s1[id]; }
          best1[id] = ad; s1[id] = s;
        } else {
          let dsec = Math.abs(s1[id] - s); dsec = Math.min(dsec, tr.M - dsec);
          if (dsec > 150 && ad < best2[id]) { best2[id] = ad; s2[id] = s; }
        }
      }
    }
    const H = new Float32Array(N), info = new Float32Array(N * 4);
    const f = {};
    const proj = (k, x, z) => {
      const dx = x - tr.px[k], dz = z - tr.pz[k];
      return { s: k + dx * tr.tx[k] + dz * tr.tz[k], d: dx * tr.lx[k] + dz * tr.lz[k] };
    };
    const target = (k, x, z) => {
      const p = proj(k, x, z);
      const fr = tr.frame(p.s, f);
      const wl = tr.wallL[fr.i], wr = tr.wallR[fr.i];
      const dc = cl(p.d, -wr, wl);
      const h = tr.heightAt(p.s, dc, fr) - 0.7;
      const out = p.d > wl ? p.d - wl : p.d < -wr ? -wr - p.d : 0;
      return { h, out, s: p.s, d: p.d, wl, wr, half: fr.half };
    };
    const pitA = tr.pitStart, pitB = tr.pitEnd;
    const inRange = (s, a, b) => (a > b ? s >= a || s <= b : s >= a && s <= b);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const id = j * n + i;
        const x = -half + i * step, z = -half + j * step;
        let h = this.natural(x, z);
        let dist = 1e9, zone = 0;
        if (best1[id] < 1e9) {
          const a = target(s1[id], x, z);
          let c1 = 1 - sstep(2, BLEND, a.out);
          let hh = a.h;
          dist = a.out;
          if (best2[id] < 1e9) {
            const b = target(s2[id], x, z);
            const c2 = 1 - sstep(2, BLEND, b.out);
            if (c1 + c2 > 0) hh = (a.h * c1 + b.h * c2) / (c1 + c2);
            c1 = Math.max(c1, c2);
            dist = Math.min(dist, b.out);
          }
          h = lerp(h, hh, c1 * c1 * (3 - 2 * c1));
          // paddock terraces on the left of the main straight, stands on the right
          const s = tr.wrap(a.s);
          if (inRange(s, tr.wrap(pitA - 80), tr.wrap(pitB + 60))) {
            const fr = tr.frame(s, f);
            const base = fr.y + fr.half * fr.bank;
            if (a.d > a.half + 6 && a.d < a.half + 200) {
              const dd = a.d - (a.half + 6);
              const terrace = Math.floor(dd / 34) * 1.4 + sstep(0, 3, (dd % 34) - 30) * 1.4;
              const w = sstep(a.half + 200, a.half + 150, a.d) * sstep(0, 50, Math.min(tr.wrap(s - pitA + 80), tr.wrap(pitB + 60 - s)));
              h = lerp(h, base - 0.6 + terrace, w);
              if (a.d > a.half + 48) zone = 1;
            } else if (a.d < -(a.half + 6) && a.d > -(a.half + 110)) {
              const w = sstep(a.half + 110, a.half + 80, -a.d) * sstep(0, 40, Math.min(tr.wrap(s - pitA + 80), tr.wrap(pitB + 60 - s)));
              h = lerp(h, fr.y - fr.half * fr.bank - 0.6, w);
              if (-a.d > a.half + 12) zone = 2;
            }
          }
        } else {
          dist = this.trackDistCoarse(x, z);
        }
        H[id] = h;
        info[id * 4] = Math.min(dist, 3000);
        info[id * 4 + 1] = zone;
        info[id * 4 + 2] = lakeSdf(x, z);
        info[id * 4 + 3] = 0;
      }
    }
    this.near.H = H;
    this.near.info = info;
  }

  // Ground height anywhere (near grid inside, natural outside)
  heightAt(x, z) {
    const { n, step, half, H } = this.near;
    const u = (x + half) / step, v = (z + half) / step;
    if (u < 0 || v < 0 || u >= n - 1 || v >= n - 1) return this.natural(x, z);
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const a = H[j * n + i], b = H[j * n + i + 1], c = H[(j + 1) * n + i], d = H[(j + 1) * n + i + 1];
    // match the triangle split used by PlaneGeometry
    return fu + fv < 1 ? a + (b - a) * fu + (c - a) * fv : d + (c - d) * (1 - fu) + (b - d) * (1 - fv);
  }

  infoAt(x, z) {
    const { n, step, half, info } = this.near;
    const i = Math.round((x + half) / step), j = Math.round((z + half) / step);
    if (i < 0 || j < 0 || i >= n || j >= n) return { dist: this.trackDistCoarse(x, z), zone: 0, lake: lakeSdf(x, z) };
    const id = (j * n + i) * 4;
    return { dist: info[id], zone: info[id + 1], lake: info[id + 2] };
  }

  buildMeshes(uniforms) {
    const group = new THREE.Group();
    const material = createTerrainMaterial(uniforms);
    // near
    {
      const { n, step, half, H, info } = this.near;
      const geo = gridGeometry(n, step, -half, -half, (i, j) => H[j * n + i]);
      geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      mesh.name = 'terrain-near';
      group.add(mesh);
    }
    // far ring, sunk under the near patch
    {
      const { size, step } = FAR;
      const n = Math.round(size / step) + 1, half = size / 2;
      const nh = this.near.half - 30;
      const info = new Float32Array(n * n * 4);
      const geo = gridGeometry(n, step, -half, -half, (i, j) => {
        const x = -half + i * step, z = -half + j * step;
        const inside = Math.abs(x) < nh && Math.abs(z) < nh;
        const id = (j * n + i) * 4;
        info[id] = this.trackDistCoarse(x, z); info[id + 1] = 0; info[id + 2] = lakeSdf(x, z);
        return inside ? this.heightAt(x, z) - 6 : this.natural(x, z);
      });
      geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      mesh.name = 'terrain-far';
      group.add(mesh);
    }
    return group;
  }
}

// Indexed grid with analytic normals from the height samples
function gridGeometry(n, step, x0, z0, heightFn) {
  const pos = new Float32Array(n * n * 3);
  const nor = new Float32Array(n * n * 3);
  const H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = heightFn(i, j);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const id = j * n + i;
      pos[id * 3] = x0 + i * step; pos[id * 3 + 1] = H[id]; pos[id * 3 + 2] = z0 + j * step;
      const hl = H[j * n + Math.max(0, i - 1)], hr = H[j * n + Math.min(n - 1, i + 1)];
      const hd = H[Math.max(0, j - 1) * n + i], hu = H[Math.min(n - 1, j + 1) * n + i];
      let nx = hl - hr, ny = 2 * step, nz = hd - hu;
      const l = Math.hypot(nx, ny, nz);
      nor[id * 3] = nx / l; nor[id * 3 + 1] = ny / l; nor[id * 3 + 2] = nz / l;
    }
  }
  const index = new Uint32Array((n - 1) * (n - 1) * 6);
  let p = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      index[p++] = a; index[p++] = c; index[p++] = b;
      index[p++] = b; index[p++] = c; index[p++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}

function createTerrainMaterial(U) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const info = attribute('aInfo', 'vec4');
  const p = positionWorld.xz;
  const colour = Fn(() => {
    const dist = info.x, zone = info.y, lake = info.z;
    const nBig = mx_noise_float(vec3(p.mul(0.0021), 0.0));
    const nMid = mx_noise_float(vec3(p.mul(0.017), 1.3));
    const nFine = mx_noise_float(vec3(p.mul(0.21), 2.7));
    const nGrain = mx_noise_float(vec3(p.mul(1.7), 4.1));
    const lush = vec3(0.075, 0.15, 0.035);
    const verge = vec3(0.085, 0.175, 0.035);
    const dry = vec3(0.27, 0.24, 0.1);
    const savanna = vec3(0.4, 0.33, 0.17);
    const scrub = vec3(0.075, 0.12, 0.04);
    const earth = vec3(0.34, 0.15, 0.08);
    const wet = vec3(0.07, 0.15, 0.06);
    const mud = vec3(0.16, 0.13, 0.09);
    const d = dist.add(nMid.mul(55)).add(nBig.mul(140));
    const c = mix(verge, lush, smoothstep(10.0, 50.0, dist)).toVar();
    c.assign(mix(c, dry, smoothstep(60.0, 320.0, d).mul(0.75)));
    c.assign(mix(c, savanna, smoothstep(380.0, 1400.0, d)));
    // patchwork farm plots further out
    const ang = float(0.42);
    const ruv = vec2(p.x.mul(cos(ang)).sub(p.y.mul(sin(ang))), p.x.mul(sin(ang)).add(p.y.mul(cos(ang)))).div(vec2(46.0, 78.0));
    const cell = floor(ruv);
    const cid = mx_cell_noise_float(vec3(cell, 0.0));
    const crop = mix(mix(vec3(0.14, 0.24, 0.06), vec3(0.4, 0.33, 0.14), cid), mix(vec3(0.3, 0.13, 0.06), vec3(0.2, 0.3, 0.08), cid.mul(cid)), step(0.62, cid));
    const edge = smoothstep(0.0, 0.05, fract(ruv.x)).mul(smoothstep(0.0, 0.05, fract(ruv.y)));
    const farm = smoothstep(420.0, 700.0, dist).mul(smoothstep(-0.1, 0.25, nBig)).mul(smoothstep(60.0, 160.0, lake));
    c.assign(mix(c, mix(scrub, crop, edge), farm.mul(0.85)));
    // scrub and tree shadow patches
    c.assign(mix(c, scrub, smoothstep(0.25, 0.65, nMid).mul(smoothstep(35.0, 90.0, dist)).mul(0.55)));
    // red earth paths and the paddock terraces
    const path = smoothstep(0.022, 0.0, abs(mx_noise_float(vec3(p.mul(0.0035), 7.0)))).mul(smoothstep(50.0, 120.0, dist));
    c.assign(mix(c, earth, max(path.mul(0.85), smoothstep(0.5, 0.9, zone).mul(step(zone, 1.5)).mul(0.9))));
    c.assign(mix(c, vec3(0.5, 0.48, 0.44), step(1.5, zone).mul(0.8)));
    // lake shore: papyrus green then mud
    c.assign(mix(c, wet, smoothstep(70.0, 10.0, lake)));
    c.assign(mix(c, mud, smoothstep(5.0, -15.0, lake)));
    // steep banks show the laterite underneath
    const slope = float(1.0).sub(normalWorld.y);
    c.assign(mix(c, earth.mul(0.9), smoothstep(0.18, 0.42, slope).mul(0.8)));
    c.mulAssign(float(0.86).add(nFine.mul(0.12)).add(nGrain.mul(0.06)));
    return c;
  });
  const col = colour();
  // at night only the floodlit band around the circuit catches the light
  const nightFade = mix(float(1), smoothstep(320.0, 50.0, info.x).mul(0.9).add(0.06), U.night);
  mat.colorNode = col.mul(nightFade);
  mat.roughnessNode = float(0.96);
  mat.metalnessNode = float(0.0);
  mat.normalNode = bumpMap(mx_noise_float(vec3(p.mul(0.9), 5.0)).mul(0.5).add(mx_noise_float(vec3(p.mul(5.5), 6.0)).mul(0.35)), 0.8);
  // floodlight spill near the circuit at night
  mat.emissiveNode = col.mul(U.night).mul(smoothstep(160.0, 5.0, info.x)).mul(U.flood);
  return mat;
}
