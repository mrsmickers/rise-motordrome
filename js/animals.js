import * as THREE from 'three/webgpu';
import { Fn, attribute, vec3, float, sin, cos, mix, smoothstep, step, max, time, mx_worley_noise_float, mx_noise_float } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lakeSdf } from './terrain.js';
import { LAKE_LEVEL } from './track.js';
import { mulberry32, clamp } from './noise.js';

// Wildlife of the Rwandan savanna, as in Akagera to the east: giraffes, elephants, zebras, impala and hippos,
// in herds back from the track. Each animal walks a little way, stops to graze, and walks on.
// Built from simple shapes; the legs swing and the heads dip in the vertex shader.
// Local frame: +z forward, +y up, origin on the ground under the body.

// ---------- shapes ----------
// Each part carries its colour, a pattern id and how it moves:
// leg = [1 or 2 for the two diagonal pairs, hip height], head = 1 to pitch with the neck, sway = side swing (trunk, tail).
// Packed into two attributes, aLook (r, g, b, pattern) and aRig (leg pair, hip, head, sway), to stay within WebGPU's 8 vertex buffers.
function part(geo, o = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const n = g.attributes.position.count;
  const fill = (k, vals) => {
    const a = new Float32Array(n * vals.length);
    for (let i = 0; i < n; i++) a.set(vals, i * vals.length);
    g.setAttribute(k, new THREE.BufferAttribute(a, vals.length));
  };
  const c = new THREE.Color(o.color ?? 0x888888);
  const leg = o.leg ?? [0, 0];
  fill('aLook', [c.r, c.g, c.b, o.pat ?? 0]);
  fill('aRig', [leg[0], leg[1], o.head ?? 0, o.sway ?? 0]);
  return g;
}
const ell = (rx, ry, rz, x, y, z, rotX = 0, seg = 12) => {
  const g = new THREE.SphereGeometry(1, seg, Math.ceil(seg * 0.7));
  g.scale(rx, ry, rz);
  if (rotX) g.rotateX(rotX);
  return g.translate(x, y, z);
};
// tapered cylinder from point a to point b
const cyl = (a, b, r0, r1, seg = 8) => {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const g = new THREE.CylinderGeometry(r1, r0, A.distanceTo(B), seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
  const m = A.clone().add(B).multiplyScalar(0.5);
  return g.translate(m.x, m.y, m.z);
};
// four legs in a diagonal gait: front left with rear right, front right with rear left
function legs(list, { x, zf, zr, hipF, hipR, r0, r1, knee = 0.5, color, lower, pat = 0, lowerPat = 0, hoof = 0x1a1612, hoofR }) {
  for (const [sx, z, hip, pair] of [[1, zf, hipF, 1], [-1, zr, hipR, 1], [-1, zf, hipF, 2], [1, zr, hipR, 2]]) {
    const kneeY = hip * knee;
    list.push(part(cyl([sx * x, hip + 0.05, z], [sx * x, kneeY, z], r0, (r0 + r1) / 2), { color, pat, leg: [pair, hip] }));
    list.push(part(cyl([sx * x, kneeY, z], [sx * x, 0.04, z], (r0 + r1) / 2, r1), { color: lower ?? color, pat: lowerPat, leg: [pair, hip] }));
    list.push(part(ell(hoofR ?? r1 * 1.15, 0.05, hoofR ?? r1 * 1.15, sx * x, 0.05, z, 0, 8), { color: hoof, leg: [pair, hip] }));
  }
}

// ---------- species ----------
function giraffe() {
  const P = [], tan = 0xc99a52;
  legs(P, { x: 0.22, zf: 0.55, zr: -0.6, hipF: 2.05, hipR: 1.85, r0: 0.09, r1: 0.05, color: tan, pat: 1, lower: 0xe6d6b0 });
  P.push(part(ell(0.36, 0.42, 0.85, 0, 2.05, 0, -0.12), { color: tan, pat: 1 }));
  P.push(part(cyl([0, 2.25, 0.55], [0, 4.2, 1.25], 0.18, 0.09), { color: tan, pat: 1, head: 1 }));
  P.push(part(cyl([0, 2.35, 0.45], [0, 4.1, 1.12], 0.05, 0.035, 6).translate(0, 0.04, -0.06), { color: 0x6b4a2a, head: 1 }));
  P.push(part(ell(0.11, 0.13, 0.3, 0, 4.3, 1.42, 0.35), { color: tan, pat: 1, head: 1 }));
  for (const s of [1, -1]) {
    P.push(part(cyl([s * 0.05, 4.4, 1.3], [s * 0.065, 4.56, 1.27], 0.025, 0.02, 6), { color: 0x3a2a1c, head: 1 }));
    P.push(part(ell(0.09, 0.03, 0.04, s * 0.13, 4.39, 1.33), { color: tan, head: 1 }));
  }
  P.push(part(cyl([0, 2.15, -0.82], [0, 1.25, -0.9], 0.025, 0.02, 6), { color: tan, sway: 1 }));
  P.push(part(ell(0.05, 0.12, 0.05, 0, 1.2, -0.9, 0, 6), { color: 0x2a1e14, sway: 1 }));
  return { geo: mergeGeometries(P), pivotY: 2.25, pivotZ: 0.55, grazeMax: 0.35, swayAmt: 0.12, stride: 2.6, walkSpeed: 1.1, grazer: 0.5 };
}

function elephant() {
  const P = [], grey = 0xa29b93;
  legs(P, { x: 0.55, zf: 0.85, zr: -0.85, hipF: 1.65, hipR: 1.6, r0: 0.3, r1: 0.26, knee: 0.45, color: grey, pat: 2, lowerPat: 2, hoof: 0xb8b0a0, hoofR: 0.29 });
  P.push(part(ell(0.95, 1.05, 1.55, 0, 2.0, 0), { color: grey, pat: 2 }));
  P.push(part(ell(0.62, 0.68, 0.6, 0, 2.55, 1.55), { color: grey, pat: 2, head: 1 }));
  for (const s of [1, -1]) {
    P.push(part(ell(0.07, 0.62, 0.5, s * 0.62, 2.5, 1.25), { color: 0x958e87, pat: 2, head: 1 }));
    P.push(part(cyl([s * 0.2, 2.15, 1.95], [s * 0.26, 1.72, 2.5], 0.065, 0.025), { color: 0xeee6d2, head: 1 }));
  }
  // trunk: three sections, the tip swings most
  P.push(part(cyl([0, 2.4, 2.0], [0, 1.65, 2.32], 0.21, 0.16), { color: grey, pat: 2, head: 1, sway: 0.3 }));
  P.push(part(cyl([0, 1.65, 2.32], [0, 0.95, 2.36], 0.16, 0.12), { color: grey, pat: 2, head: 1, sway: 0.65 }));
  P.push(part(cyl([0, 0.95, 2.36], [0, 0.42, 2.24], 0.12, 0.09), { color: grey, pat: 2, head: 1, sway: 1 }));
  P.push(part(cyl([0, 2.3, -1.5], [0, 1.3, -1.62], 0.04, 0.03, 6), { color: grey, sway: 1 }));
  return { geo: mergeGeometries(P), pivotY: 2.35, pivotZ: 1.15, grazeMax: 0.12, swayAmt: 0.22, stride: 2.0, walkSpeed: 1.0, grazer: 1 };
}

// zebra and impala share a body plan; the impala is smaller and two-tone
function antelope(kind) {
  const P = [];
  const k = kind === 'impala' ? 0.8 : 1; // impala stand about 0.9 m at the shoulder
  const body = kind === 'impala' ? 0xa5622c : 0xf2efe6;
  const pat = kind === 'impala' ? 5 : 3;
  const lp = kind === 'impala' ? 0 : 4;
  const S = (v) => v * k;
  legs(P, { x: S(0.14), zf: S(0.5), zr: S(-0.5), hipF: S(0.98), hipR: S(0.95), r0: S(0.065), r1: S(0.035), color: body, pat, lower: kind === 'impala' ? 0x8a4f24 : body, lowerPat: lp });
  P.push(part(ell(S(0.27), S(0.32), S(0.72), 0, S(1.0), 0), { color: body, pat }));
  P.push(part(cyl([0, S(1.05), S(0.45)], [0, S(1.52), S(0.83)], S(0.14), S(0.09)), { color: body, pat, head: 1 }));
  P.push(part(ell(S(0.09), S(0.11), S(0.27), 0, S(1.5), S(1.02), 0.75), { color: body, pat, head: 1 }));
  P.push(part(ell(S(0.07), S(0.07), S(0.07), 0, S(1.36), S(1.2)), { color: kind === 'impala' ? 0xe8e2d6 : 0x151515, head: 1 }));
  for (const s of [1, -1]) {
    P.push(part(ell(S(0.03), S(0.09), S(0.02), s * S(0.07), S(1.66), S(0.94), 0, 6), { color: body, head: 1 }));
    if (kind === 'impala') P.push(part(cyl([s * S(0.04), S(1.6), S(1.0)], [s * S(0.09), S(1.95), S(0.86)], S(0.022), S(0.01), 5), { color: 0x2a2018, head: 1 }));
  }
  if (kind === 'zebra') P.push(part(cyl([0, S(1.2), S(0.44)], [0, S(1.62), S(0.8)], S(0.03), S(0.025), 5).translate(0, S(0.06), S(-0.06)), { color: 0x151515, head: 1 }));
  P.push(part(cyl([0, S(1.1), S(-0.7)], [0, S(0.62), S(-0.78)], S(0.025), S(0.02), 5), { color: kind === 'impala' ? 0x2a2018 : body, pat, sway: 1 }));
  return { geo: mergeGeometries(P), pivotY: S(1.05), pivotZ: S(0.45), grazeMax: 1.7, swayAmt: 0.06, stride: S(1.5), walkSpeed: kind === 'impala' ? 1.3 : 1.2, grazer: 1, bellyY: S(0.92) };
}

function hippo() {
  const P = [], skin = 0x7c6b6e;
  legs(P, { x: 0.45, zf: 0.8, zr: -0.8, hipF: 0.55, hipR: 0.55, r0: 0.22, r1: 0.2, color: skin, pat: 6, lowerPat: 6 });
  P.push(part(ell(0.85, 0.7, 1.55, 0, 0.82, 0), { color: skin, pat: 6 }));
  P.push(part(ell(0.55, 0.45, 0.6, 0, 1.0, 1.45), { color: skin, pat: 6, head: 1 }));
  P.push(part(ell(0.5, 0.34, 0.36, 0, 0.88, 1.92), { color: skin, pat: 6, head: 1 }));
  for (const s of [1, -1]) {
    P.push(part(ell(0.07, 0.08, 0.06, s * 0.27, 1.43, 1.25, 0, 6), { color: skin, head: 1 }));
    P.push(part(ell(0.09, 0.07, 0.09, s * 0.22, 1.36, 1.55, 0, 6), { color: skin, head: 1 }));
  }
  return { geo: mergeGeometries(P), pivotY: 1.0, pivotZ: 1.0, grazeMax: 0.15, swayAmt: 0, stride: 1.4, walkSpeed: 0.35, grazer: 0.4, bellyY: 0.55 };
}

const SPECIES = {
  // minD and maxD: how far the herd's centre sits from the track centreline, in metres
  giraffe: { make: giraffe, herds: 4, size: [4, 6], young: 0.3, minD: 20, maxD: 90, radius: 14 },
  elephant: { make: elephant, herds: 3, size: [4, 6], young: 0.35, minD: 22, maxD: 90, radius: 14 },
  zebra: { make: () => antelope('zebra'), herds: 3, size: [6, 9], young: 0.15, minD: 14, maxD: 55, radius: 8, near: 1 },
  impala: { make: () => antelope('impala'), herds: 2, size: [8, 12], young: 0.2, minD: 14, maxD: 55, radius: 8, near: 1 },
  hippo: { make: hippo, herds: 2, size: [3, 5], young: 0.2, minD: 18, maxD: 110, radius: 8, water: true }
};

// ---------- material: patterns and motion ----------
function animalMaterial(sp) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.88 });
  const p0 = attribute('position', 'vec3');
  const look = attribute('aLook', 'vec4'), rig = attribute('aRig', 'vec4'), state = attribute('aState', 'vec4'), pose = attribute('aPose', 'vec4');
  const col = look.xyz, pat = look.w;
  const leg = rig.xy, head = rig.z, sway = rig.w;
  // per animal: walking (0 to 1), grazing (0 to 1), phase, scale; and where it stands: x, y, z, heading
  const walk = state.x, graze = state.y, phase = state.z, size = state.w;
  mat.positionNode = Fn(() => {
    const x = p0.x, y = p0.y, z = p0.z;
    // legs swing about the hip while walking, the diagonal pairs in opposite phase
    const cadence = (2 * Math.PI * sp.walkSpeed) / sp.stride;
    const a = sin(time.mul(cadence).add(phase).add(leg.x.mul(Math.PI))).mul(0.38).mul(walk).mul(step(0.5, leg.x));
    const below = max(leg.y.sub(y), 0.0);
    const z1 = z.add(below.mul(sin(a)));
    const y1 = y.add(below.mul(float(1).sub(cos(a))).mul(0.6));
    // head and neck pitch about the shoulder: down to graze, with a slow nod
    const ang = graze.mul(sp.grazeMax).add(sin(time.mul(0.9).add(phase.mul(1.7))).mul(0.05)).mul(head);
    const dy = y1.sub(sp.pivotY), dz = z1.sub(sp.pivotZ), c = cos(ang), s = sin(ang);
    const y2 = dy.mul(c).sub(dz.mul(s)).add(sp.pivotY);
    const z2 = dy.mul(s).add(dz.mul(c)).add(sp.pivotZ);
    // trunk and tail swing side to side
    const x2 = x.add(sway.mul(sin(time.mul(1.6).add(phase.mul(2.3)))).mul(sp.swayAmt));
    // three.js applies the instance matrix before positionNode, so place the animal here: scale, turn, move
    const lx = x2.mul(size), ly = y2.mul(size), lz = z2.mul(size), cy = cos(pose.w), sy = sin(pose.w);
    return vec3(lx.mul(cy).add(lz.mul(sy)).add(pose.x), ly.add(pose.y), lz.mul(cy).sub(lx.mul(sy)).add(pose.z));
  })();
  mat.colorNode = Fn(() => {
    const p = p0;
    const is = (k) => step(k - 0.5, pat).mul(step(pat, k + 0.5));
    // 1 giraffe: brown patches with pale lines between
    const blob = smoothstep(0.34, 0.24, mx_worley_noise_float(p.mul(vec3(6.5, 4.5, 6.5))));
    const giraffeC = mix(col.mul(1.12), vec3(0.3, 0.15, 0.06), blob);
    // 2 grey wrinkled skin
    const skin = col.mul(mx_noise_float(p.mul(9.0)).mul(0.14).add(0.94));
    // 3 zebra body stripes, 4 zebra leg rings
    const st = sin(p.z.mul(24.0).add(p.y.mul(9.0)).add(sin(p.y.mul(7.0)).mul(1.6)));
    const zebraB = mix(col, vec3(0.025), smoothstep(0.05, 0.25, st));
    const zebraL = mix(col, vec3(0.025), smoothstep(0.0, 0.3, sin(p.y.mul(48.0))));
    // 5 impala: red-brown back over a white belly
    const belly = sp.bellyY ?? 0;
    const impala = mix(col, vec3(0.92, 0.9, 0.85), smoothstep(belly + 0.02, belly - 0.06, p.y));
    // 6 hippo: grey back over a pink underside
    const hip = mix(skin, vec3(0.6, 0.42, 0.42), smoothstep(belly + 0.08, belly - 0.15, p.y));
    const plain = float(1).sub(is(1)).sub(is(2)).sub(is(3)).sub(is(4)).sub(is(5)).sub(is(6));
    return col.mul(plain).add(giraffeC.mul(is(1))).add(skin.mul(is(2))).add(zebraB.mul(is(3))).add(zebraL.mul(is(4))).add(impala.mul(is(5))).add(hip.mul(is(6)));
  })();
  return mat;
}

// ---------- placement and behaviour ----------
// Herd sites are chosen first, so the trees can leave them open: grassland glades the track can see into,
// back from the track, on gentle ground, preferably a little above it.
const SIGHT_H = { giraffe: 5, elephant: 3, zebra: 1.4, impala: 1, hippo: 0.5 };
export function planHerds(track, terrain) {
  const rand = mulberry32(1994);
  const half = terrain.near.half - 60;
  const pit = { a: track.wrap(track.startLine - 320), b: track.wrap(track.startLine + 420) };
  const c10 = track.corners.find((c) => c.n === 10), c11 = track.corners.find((c) => c.n === 11);
  const forest = c10 && c11 ? { a: track.wrap(c10.s - 250), b: track.wrap(c11.s + 250) } : null;
  const within = (r, s) => (r.a > r.b ? s >= r.a || s <= r.b : s >= r.a && s <= r.b);
  const pts = [], near = {};
  for (let s = 0; s < track.length; s += 6) { const f = track.frame(s, {}); pts.push({ x: f.x, z: f.z, y: f.y, s, tx: f.tx, tz: f.tz }); }
  const nearest = (x, z) => { let b = pts[0], bd = Infinity; for (const p of pts) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; b = p; } } return { p: b, d: Math.sqrt(bd) }; };
  // can a driver at track point p (eye 1.5 m up) see the animals' backs, h tall, at (x, z)? Hills and the lake bank block
  const clearView = (p, x, z, h, water) => {
    const eye = p.y + 1.5, target = (water ? LAKE_LEVEL : terrain.heightAt(x, z)) + h * 0.7;
    for (let t = 0.1; t < 0.95; t += 0.05) {
      const gx = p.x + (x - p.x) * t, gz = p.z + (z - p.z) * t;
      const g = Math.max(terrain.heightAt(gx, gz), lakeSdf(gx, gz) < 0 ? LAKE_LEVEL : -1e9);
      if (g > eye + (target - eye) * t - 0.3) return false;
    }
    return true;
  };
  // Score: how much of the lap the herd sits ahead of the car (within 35 degrees of the way it is going, 25 to 170 m out,
  // either direction of travel), plus how close it comes. Returns null if it is never in view ahead.
  const sight = (x, z, h, water, nearW = 0) => {
    const { p, d } = nearest(x, z);
    // hippos sit low in the water, seen from the lakeside, the TV cameras and the helicopter: just keep them near
    if (water) return { score: (140 - d) * 0.25, p, d, far: p };
    let n = 0, far = null, farD = 0;
    for (let k = 0; k < pts.length; k += 3) {
      const q = pts[k], dx = x - q.x, dz = z - q.z, dd = Math.hypot(dx, dz);
      if (dd < 25 || dd > 170) continue;
      if (Math.abs((dx * q.tx + dz * q.tz) / dd) < 0.82) continue;
      if (!clearView(q, x, z, h, water)) continue;
      n++;
      if (dd > farD) { farD = dd; far = q; }
    }
    if (n < 2) return null;
    // small animals must come close to be seen at all, so nearness counts for more
    return { score: n + (90 - d) * (nearW ? 0.6 : 0.15), p, d, far };
  };
  const herds = {}, taken = [];
  for (const [key, cfg] of Object.entries(SPECIES)) {
    herds[key] = [];
    for (let h = 0; h < cfg.herds; h++) {
      let best = null;
      for (let tries = 0; tries < 5000; tries++) {
        const x = (rand() * 2 - 1) * half, z = (rand() * 2 - 1) * half;
        const info = terrain.infoAt(x, z);
        if (info.dist < cfg.minD || info.dist > cfg.maxD) continue;
        if (cfg.water ? !waterOk(x, z) : !landOk(terrain, x, z, cfg.minD)) continue;
        // the whole range must lie beyond the wall, clear of the fence
        const tn = track.nearest(x, z, near), fr = track.frame(tn.s, {});
        if (Math.abs(tn.d) < (tn.d > 0 ? track.wallL[fr.i] : track.wallR[fr.i]) + 4 + cfg.radius) continue;
        // apart from their own kind; mixed groups (zebra with impala, say) can share ground
        if (taken.some((t) => Math.hypot(t.x - x, t.z - z) < (t.key === key ? 260 : 110))) continue;
        if (!cfg.water) {
          const h0 = terrain.heightAt(x, z);
          if ([[20, 0], [-20, 0], [0, 20], [0, -20]].some(([dx, dz]) => Math.abs(terrain.heightAt(x + dx, z + dz) - h0) > 6)) continue;
        }
        const v = sight(x, z, SIGHT_H[key], cfg.water, cfg.near);
        if (!v || within(pit, v.p.s) || (!cfg.water && forest && within(forest, v.p.s))) continue;
        if (!best || v.score > best.score) best = { key, x, z, r: cfg.radius, score: v.score, views: [v.p, v.far], water: !!cfg.water };
      }
      if (best) { herds[key].push(best); taken.push(best); }
    }
  }
  // glades: the herd's range, and corridors from the nearest point and from the furthest point it is seen ahead
  const all = Object.values(herds).flat().filter((g) => !g.water);
  const inCorridor = (x, z, g, v) => {
    const vx = g.x - v.x, vz = g.z - v.z, L2 = vx * vx + vz * vz;
    const t = clamp(((x - v.x) * vx + (z - v.z) * vz) / L2, 0, 1);
    return Math.hypot(x - (v.x + vx * t), z - (v.z + vz * t)) < 14;
  };
  const clear = (x, z) => all.some((g) => Math.hypot(x - g.x, z - g.z) < g.r + 12 || g.views.some((v) => inCorridor(x, z, g, v)));
  return { herds, clear };
}

const landOk = (terrain, x, z, minD) => {
  const info = terrain.infoAt(x, z);
  return info.dist >= minD && info.lake > 20 && info.zone < 0.5 && info.crowd < 0.01;
};
const waterOk = (x, z) => { const l = lakeSdf(x, z); return l < -7 && l > -40; };

export function buildAnimals(track, terrain, plan) {
  const rand = mulberry32(2030);
  const group = new THREE.Group();
  group.name = 'animals';
  const animals = [], meshes = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  for (const [key, cfg] of Object.entries(SPECIES)) {
    const sp = cfg.make();
    const list = [];
    for (const c of plan.herds[key] || []) {
      const herd = { x: c.x, z: c.z, r: cfg.radius };
      const n = cfg.size[0] + Math.floor(rand() * (cfg.size[1] - cfg.size[0] + 1));
      for (let k = 0; k < n; k++) {
        let x = c.x, z = c.z;
        for (let t = 0; t < 20; t++) {
          const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * herd.r * 0.8;
          const tx = c.x + Math.cos(a) * r, tz = c.z + Math.sin(a) * r;
          if (cfg.water ? waterOk(tx, tz) : landOk(terrain, tx, tz, 20)) { x = tx; z = tz; break; }
        }
        const young = rand() < cfg.young;
        list.push({
          x, z, yaw: rand() * Math.PI * 2, speed: 0, pace: 0.8 + rand() * 0.4, target: null, timer: rand() * 8,
          graze: rand(), grazeT: 1, herd, scale: (young ? 0.55 : 0.88) + rand() * (young ? 0.1 : 0.22), phase: rand() * 6.28,
          bob: rand() * 6.28
        });
      }
    }
    if (!list.length) continue;
    const geo = sp.geo;
    const aState = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
    const aPose = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
    list.forEach((a, i) => { aState.array[i * 4 + 2] = a.phase; aState.array[i * 4 + 3] = a.scale; });
    geo.setAttribute('aState', aState);
    geo.setAttribute('aPose', aPose);
    const mesh = new THREE.InstancedMesh(geo, animalMaterial(sp), list.length);
    mesh.name = 'animals-' + key;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    const entry = { key, cfg, sp, list, mesh, aState, aPose };
    meshes.push(entry);
    for (const a of list) animals.push({ a, entry });
  }

  // the herd sites keep their whole range beyond the wall, so animals only need to stay near home
  const valid = (e, x, z, a) => {
    if (Math.hypot(x - a.herd.x, z - a.herd.z) > a.herd.r * 1.15) return false;
    return e.cfg.water ? waterOk(x, z) : landOk(terrain, x, z, 20);
  };
  const place = (e, a, i) => {
    const y = e.cfg.water ? LAKE_LEVEL - 1.12 * a.scale + Math.sin(performance.now() * 0.0009 + a.bob) * 0.04 : terrain.heightAt(a.x, a.z) - 0.03;
    q.setFromAxisAngle(up, a.yaw);
    // the instance matrix still turns the normals; the shader places the vertices from aPose
    e.mesh.setMatrixAt(i, m.compose(pos.set(a.x, y, a.z), q, scl.setScalar(a.scale)));
    e.aPose.array.set([a.x, y, a.z, a.yaw], i * 4);
  };
  meshes.forEach((e) => { e.list.forEach((a, i) => place(e, a, i)); e.aPose.needsUpdate = true; });

  const update = (dt) => {
    dt = Math.min(dt, 0.1);
    for (const e of meshes) {
      const { cfg, sp, list } = e;
      list.forEach((a, i) => {
        a.timer -= dt;
        if (a.timer <= 0) {
          if (a.target) { a.target = null; a.timer = 5 + rand() * 12; }
          else {
            // walk to a new spot in the herd's range
            const ang = rand() * Math.PI * 2, r = Math.sqrt(rand()) * a.herd.r;
            const tx = a.herd.x + Math.cos(ang) * r, tz = a.herd.z + Math.sin(ang) * r;
            if (valid(e, tx, tz, a)) { a.target = { x: tx, z: tz }; a.timer = 40; } else a.timer = 1;
          }
        }
        let want = 0;
        if (a.target) {
          const dx = a.target.x - a.x, dz = a.target.z - a.z, dist = Math.hypot(dx, dz);
          if (dist < 1.2) { a.target = null; a.timer = 5 + rand() * 12; }
          else {
            let dyaw = Math.atan2(dx, dz) - a.yaw;
            dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
            a.yaw += clamp(dyaw, -0.7 * dt, 0.7 * dt);
            // walk once roughly facing the way
            want = Math.abs(dyaw) < 1.2 ? sp.walkSpeed * a.pace * (a.scale < 0.7 ? 1.15 : 1) : 0.15;
          }
        }
        a.speed += (want - a.speed) * Math.min(1, dt * 1.5);
        if (a.speed > 0.01) {
          const nx = a.x + Math.sin(a.yaw) * a.speed * dt, nz = a.z + Math.cos(a.yaw) * a.speed * dt;
          if (valid(e, nx, nz, a)) { a.x = nx; a.z = nz; } else { a.target = null; a.timer = 1 + rand() * 3; }
        }
        // heads go down to graze while standing still
        a.grazeT = a.target ? 0 : sp.grazer;
        a.graze += (a.grazeT - a.graze) * Math.min(1, dt * 0.8);
        e.aState.array[i * 4] = clamp(a.speed / (sp.walkSpeed * a.scale + 0.01), 0, 1.2);
        e.aState.array[i * 4 + 1] = a.graze;
        place(e, a, i);
      });
      e.mesh.instanceMatrix.needsUpdate = true;
      e.aState.needsUpdate = true;
      e.aPose.needsUpdate = true;
    }
  };
  return { group, update, counts: Object.fromEntries(meshes.map((e) => [e.key, e.list.length])), meshes };
}
