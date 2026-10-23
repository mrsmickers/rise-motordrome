import * as THREE from 'three/webgpu';
import {
  Fn, positionLocal, normalLocal, vec2, vec3, float, mix, smoothstep, step, abs, fract, floor, max, min, sin, cos, atan, length,
  mx_noise_float, mx_worley_noise_float, uniform, clamp, select, uv, time
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Car local frame: +z forward, +x left, +y up, origin on the ground at mid wheelbase.

// Loft a closed body through superellipse sections {z, w, h, y, x?, n?}
function loft(sections, K = 30, cut = null) {
  const pos = [], uvs = [], idx = [];
  const S = sections.length;
  for (let i = 0; i < S; i++) {
    const s = sections[i];
    const n = s.n ?? 3;
    for (let k = 0; k <= K; k++) {
      const a = -Math.PI / 2 + (k / K) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      const px = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * s.w;
      const py = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n) * s.h;
      const flat = s.flat ?? 0; // flatten the underside
      const yy = py < 0 ? py * (1 - flat) : py;
      pos.push((s.x ?? 0) + px, s.y + yy, s.z);
      uvs.push(k / K, i / (S - 1));
    }
  }
  for (let i = 0; i < S - 1; i++) {
    for (let k = 0; k < K; k++) {
      const a = i * (K + 1) + k, b = a + 1, c = a + (K + 1), d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  let side = g.toNonIndexed();
  if (cut) side = cutOpening(side, cut);
  // flat caps with their own normals
  const cp = [], cu = [];
  const capEnd = (i, back) => {
    const s = sections[i];
    const c = [s.x ?? 0, s.y, s.z];
    for (let k = 0; k < K; k++) {
      const a = (i * (K + 1) + k) * 3, b = a + 3;
      const A = pos.slice(a, a + 3), B = pos.slice(b, b + 3);
      if (back) cp.push(...c, ...B, ...A); else cp.push(...c, ...A, ...B);
      cu.push(0.5, 0.5, 0, 0, 1, 0);
    }
  };
  capEnd(0, false); capEnd(S - 1, true);
  const caps = new THREE.BufferGeometry();
  caps.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
  caps.setAttribute('uv', new THREE.Float32BufferAttribute(cu, 2));
  caps.computeVertexNormals();
  return mergeGeometries([side, caps]);
}

// Drop the skin triangles over the cockpit so the driver, wheel and tub show through
function cutOpening(geo, { z0, z1, halfW, yMin }) {
  const keep = [];
  const pos = geo.attributes.position;
  for (let t = 0; t < pos.count; t += 3) {
    let inside = true;
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(t + k), y = pos.getY(t + k), z = pos.getZ(t + k);
      if (!(z >= z0 && z <= z1 && Math.abs(x) <= halfW && y >= yMin)) { inside = false; break; }
    }
    if (!inside) keep.push(t);
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const s = attr.itemSize, arr = new Float32Array(keep.length * 3 * s);
    keep.forEach((t, i) => arr.set(attr.array.subarray(t * s, (t + 3) * s), i * 3 * s));
    out.setAttribute(name, new THREE.BufferAttribute(arr, s));
  }
  return out;
}

// Point on the body surface: half-width of a lofted body at height y and station z
function bodyHalfWidth(sections, z, y) {
  let a = sections[0], b = sections[sections.length - 1];
  for (let i = 0; i < sections.length - 1; i++) {
    if (z <= sections[i].z && z >= sections[i + 1].z) { a = sections[i]; b = sections[i + 1]; break; }
  }
  const t = a.z === b.z ? 0 : (a.z - z) / (a.z - b.z);
  const L = (k, d) => (a[k] ?? d) + ((b[k] ?? d) - (a[k] ?? d)) * t;
  const w = L('w'), h = L('h'), yc = L('y'), n = L('n', 3);
  const r = Math.min(0.92, Math.abs(y - yc) / h);
  return w * Math.pow(1 - Math.pow(r, n), 1 / n);
}

// Open cockpit: dark tub with padded rim, driver's shoulders and arms reaching to the wheel
function cockpit(P, c) {
  const { z0, z1, halfW, floorY, rimY, wheel, shoulderY, shoulderZ } = c;
  const tub = new THREE.BoxGeometry(halfW * 2, rimY - floorY, z1 - z0);
  tub.translate(0, (rimY + floorY) / 2, (z0 + z1) / 2);
  P.tub.push(tub);
  const rim = new THREE.CatmullRomCurve3(Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    const zc = (z0 + z1) / 2, zr = (z1 - z0) / 2;
    return new THREE.Vector3(Math.cos(a) * halfW, rimY + 0.012, zc + Math.sin(a) * zr);
  }), true);
  P.dark.push(new THREE.TubeGeometry(rim, 48, 0.022, 6, true));
  const torso = new THREE.SphereGeometry(1, 16, 10);
  torso.scale(0.2, 0.09, 0.16); torso.translate(0, shoulderY - 0.03, shoulderZ - 0.06);
  P.suit.push(torso);
  for (const s of [1, -1]) {
    const sh = [s * 0.16, shoulderY, shoulderZ];
    const elbow = [s * 0.2, (shoulderY + wheel.y) / 2 - 0.05, (shoulderZ + wheel.z) / 2];
    const hand = [s * 0.135, wheel.y - 0.005, wheel.z - 0.03];
    P.suit.push(strut(sh, elbow, 0.04, 1));
    P.suit.push(strut(elbow, hand, 0.034, 1));
    P.glove.push(new THREE.SphereGeometry(0.038, 10, 8).translate(...hand));
  }
}

// Airfoil extruded across the car (span along x)
function wingElement(span, chord, thick, z, y, pitchDeg, x0 = 0) {
  const sh = new THREE.Shape();
  const N = 14;
  // simple cambered profile in (z, y) with z going from leading edge (front) to trailing edge
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const yt = 5 * thick * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1015 * t ** 4);
    const camber = -0.06 * chord * Math.sin(Math.PI * t);
    sh[i === 0 ? 'moveTo' : 'lineTo'](t * chord, camber + yt * chord);
  }
  for (let i = N; i >= 0; i--) {
    const t = i / N;
    const yt = 5 * thick * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1015 * t ** 4);
    const camber = -0.06 * chord * Math.sin(Math.PI * t);
    sh.lineTo(t * chord, camber - yt * chord);
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth: span, bevelEnabled: false, curveSegments: 2 });
  // shape x -> car z, shape y -> car y, extrusion -> car x
  g.rotateY(Math.PI / 2);
  g.translate(-span / 2 + x0, 0, 0);
  g.rotateX(THREE.MathUtils.degToRad(-pitchDeg));
  g.translate(0, y, z);
  return g.index ? g.toNonIndexed() : g;
}

function plate(w, h, t, x, y, z, ry = 0, round = 0.3) {
  const sh = new THREE.Shape();
  const r = Math.min(w, h) * round;
  sh.moveTo(0, 0); sh.lineTo(w - r, 0); sh.quadraticCurveTo(w, 0, w, r); sh.lineTo(w, h - r); sh.quadraticCurveTo(w, h, w - r, h); sh.lineTo(0, h); sh.lineTo(0, 0);
  const g = new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 4 });
  // shape x -> car -z (length), shape y -> car y, depth -> car x
  g.rotateY(Math.PI / 2);
  g.translate(-t / 2, 0, w / 2);
  g.rotateY(ry);
  g.translate(x, y, z);
  return g.index ? g.toNonIndexed() : g;
}

function strut(a, b, r = 0.01, flat = 2.0) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r, r, len, 6, 1);
  g.scale(flat, 1, 1);
  const mid = A.clone().add(B).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  g.applyQuaternion(q);
  g.translate(mid.x, mid.y, mid.z);
  return g.toNonIndexed();
}

function mirrorX(geo) {
  const g = geo.clone();
  g.scale(-1, 1, 1);
  // flip winding after the mirror
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i += 3) {
    for (const attr of Object.values(g.attributes)) {
      const s = attr.itemSize;
      for (let k = 0; k < s; k++) { const a = attr.array[(i + 1) * s + k]; attr.array[(i + 1) * s + k] = attr.array[(i + 2) * s + k]; attr.array[(i + 2) * s + k] = a; }
    }
  }
  g.computeVertexNormals();
  return g;
}

const both = (geo) => [geo, mirrorX(geo)];

function clean(list) {
  // make attribute sets match before merging
  return list.map((g) => {
    let geo = g.index ? g.toNonIndexed() : g;
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!geo.attributes.normal) geo.computeVertexNormals();
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    return geo;
  });
}
const merge = (list) => mergeGeometries(clean(list));

// ---------- materials ----------

function liveryMaterial(livery) {
  const mat = new THREE.MeshPhysicalNodeMaterial();
  const base = uniform(new THREE.Color(livery.base)), accent = uniform(new THREE.Color(livery.accent)), third = uniform(new THREE.Color(livery.third));
  const p = positionLocal;
  const pat = livery.pattern;
  const col = Fn(() => {
    const B = vec3(base), A = vec3(accent), T = vec3(third);
    if (pat === 'flag') {
      const band = smoothstep(0.045, 0.035, abs(p.y.sub(float(0.56).sub(p.z.mul(0.045)))));
      const low = smoothstep(0.4, 0.36, p.y);
      const nose = smoothstep(2.1, 2.2, p.z);
      return mix(mix(mix(B, T, low), A, band), A, nose);
    }
    if (pat === 'zigzag') {
      const tw = abs(fract(p.z.mul(2.4)).sub(0.5));
      const zz = step(0.5, fract(p.y.mul(4.0).add(tw.mul(1.1)).mul(1.0)));
      const low = smoothstep(0.36, 0.32, p.y);
      return mix(mix(B, A, zz), T, low);
    }
    if (pat === 'lava') {
      const n = abs(mx_noise_float(p.mul(3.2)));
      const crack = smoothstep(0.07, 0.02, n);
      const heat = smoothstep(-0.6, -2.2, p.z).mul(smoothstep(0.6, 0.3, p.y));
      return mix(B, mix(A, T, n.mul(4.0)), max(crack, heat.mul(0.8)));
    }
    if (pat === 'wave') {
      const line = smoothstep(0.03, 0.018, abs(p.y.sub(0.52).sub(sin(p.z.mul(3.4)).mul(0.05))));
      const low = smoothstep(0.38, 0.34, p.y);
      return mix(mix(B, T, low.mul(0.85)), A, line);
    }
    if (pat === 'classic') {
      const white = smoothstep(0.04, 0.02, abs(p.y.sub(0.5))).mul(step(-0.6, p.z)).mul(step(p.z, 1.2));
      const low = smoothstep(0.3, 0.27, p.y);
      return mix(mix(B, A, white), T, low);
    }
    // 'band': heritage green, yellow nose band, cream roundel
    const nose = smoothstep(1.45, 1.5, p.z).mul(smoothstep(1.75, 1.7, p.z));
    const disc = smoothstep(0.17, 0.15, length(vec2(p.z.sub(0.85), p.y.sub(0.45))));
    return mix(mix(B, A, nose), T, disc);
  });
  mat.colorNode = col();
  mat.roughnessNode = float(pat === 'lava' ? 0.55 : 0.32);
  mat.metalnessNode = float(pat === 'lava' ? 0.05 : 0.06);
  mat.clearcoatNode = float(pat === 'lava' ? 0.2 : 1.0);
  mat.clearcoatRoughnessNode = float(0.06);
  if (pat === 'lava') {
    const n = abs(mx_noise_float(p.mul(3.2)));
    mat.emissiveNode = vec3(accent).mul(smoothstep(0.03, 0.0, n)).mul(1.5);
  }
  mat.userData.uniforms = { base, accent, third };
  return mat;
}

function carbonMaterial(gloss = 0.5) {
  const mat = new THREE.MeshPhysicalNodeMaterial();
  const p = positionLocal;
  // twill weave visible up close
  const u = p.x.add(p.z).mul(90.0), v = p.x.sub(p.z).add(p.y).mul(90.0);
  const weave = step(0.5, fract(floor(u).add(floor(v)).mul(0.5)));
  mat.colorNode = mix(vec3(0.018, 0.019, 0.021), vec3(0.04, 0.042, 0.046), weave);
  mat.roughnessNode = float(0.4);
  mat.metalnessNode = float(0.2);
  mat.clearcoatNode = float(gloss);
  mat.clearcoatRoughnessNode = float(0.1);
  return mat;
}

function tyreMaterial(compound, grooved) {
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  const p = positionLocal;
  const r = length(vec2(p.y, p.z));
  const side = step(0.7, abs(normalLocal.x));
  const R = uniform(0.36), RR = uniform(0.23);
  mat.userData.R = R; mat.userData.RR = RR;
  const band = smoothstep(0.012, 0.004, abs(r.sub(R.mul(0.62).add(RR.mul(0.38))))).mul(side);
  const letters = step(0.6, fract(atan(p.y, p.z).mul(3.0))).mul(smoothstep(0.02, 0.0, abs(r.sub(R.mul(0.8).add(RR.mul(0.2)))))).mul(side).mul(0.6);
  const groove = grooved ? step(abs(fract(p.x.mul(14.0)).sub(0.5)), 0.08).mul(float(1).sub(side)) : float(0);
  const rubber = vec3(0.035, 0.035, 0.038).mul(float(1).sub(groove.mul(0.6)));
  mat.colorNode = mix(rubber, vec3(...compound), max(band, letters));
  mat.roughnessNode = mix(float(0.82), float(0.6), side);
  return mat;
}

function rimMaterial(covers) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const p = positionLocal;
  const ang = atan(p.y, p.z);
  const spokes = covers ? float(0) : step(0.55, fract(ang.mul(10.0 / 6.283)));
  const speed = uniform(0);
  mat.userData.speed = speed;
  // spokes blur into a disc as the wheel spins up
  const blur = smoothstep(8.0, 30.0, speed);
  const spokeVis = mix(spokes, float(0.45), blur);
  mat.colorNode = covers ? vec3(0.05, 0.05, 0.055) : mix(vec3(0.03), vec3(0.62, 0.63, 0.66), spokeVis);
  mat.metalnessNode = float(covers ? 0.3 : 0.9);
  mat.roughnessNode = float(covers ? 0.5 : 0.3);
  return mat;
}

// ---------- model builders ----------

export function buildCar(car) {
  const root = new THREE.Group();
  root.name = 'car-' + car.id;
  const era = car.era;
  const paint = liveryMaterial(car.livery);
  const carbon = carbonMaterial(0.6);
  const matt = carbonMaterial(0.0);
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x8c9197, metalness: 0.85, roughness: 0.3 });
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x050505, roughness: 0.6 });
  const helmetMat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.25, clearcoat: 1 });
  helmetMat.colorNode = Fn(() => {
    const p = positionLocal;
    const stripe = smoothstep(0.02, 0.012, abs(p.y.sub(0.81)));
    return mix(vec3(new THREE.Color(car.livery.accent)), vec3(new THREE.Color(car.livery.base)), stripe);
  })();
  const visor = new THREE.MeshPhysicalNodeMaterial({ color: 0x0a0d12, roughness: 0.05, metalness: 0.6, clearcoat: 1 });
  const parts = { paint: [], carbon: [], matt: [], metal: [], dark: [], tub: [], suit: [], glove: [] };
  const geo = era === 'classic' ? classicGeometry(parts) : era === 'v10' ? v10Geometry(parts) : modernGeometry(parts);

  const add = (list, mat) => {
    if (!list.length) return;
    const m = new THREE.Mesh(merge(list), mat);
    m.castShadow = true; m.receiveShadow = true;
    root.add(m);
  };
  add(parts.paint, paint); add(parts.carbon, carbon); add(parts.matt, matt); add(parts.metal, metal); add(parts.dark, dark);
  add(parts.tub, new THREE.MeshStandardNodeMaterial({ color: 0x0c0d10, roughness: 0.85, side: THREE.BackSide }));
  add(parts.suit, new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(car.livery.base).multiplyScalar(0.55), roughness: 0.9 }));
  add(parts.glove, new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(car.livery.accent).multiplyScalar(0.7), roughness: 0.8 }));

  // driver helmet
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 24, 16), helmetMat);
  helmet.position.set(0, geo.helmetY, geo.helmetZ);
  helmet.scale.set(1, 1.05, 1.12);
  helmet.castShadow = true;
  root.add(helmet);
  const vis = new THREE.Mesh(new THREE.SphereGeometry(0.137, 20, 8, Math.PI / 2 - 0.95, 1.9, 1.15, 0.5), visor);
  vis.rotation.y = 0;
  vis.position.copy(helmet.position);
  vis.scale.copy(helmet.scale);
  root.add(vis);

  // rear wing flap (opens on straights) and rain light
  let flap = null;
  if (geo.flap) {
    flap = new THREE.Group();
    flap.position.set(0, geo.flap.y, geo.flap.z);
    const fm = new THREE.Mesh(wingElement(geo.flap.span, geo.flap.chord, 0.1, 0, 0, -28), paint);
    fm.castShadow = true;
    flap.add(fm);
    root.add(flap);
  }
  const rainMat = new THREE.MeshBasicNodeMaterial();
  const rainOn = uniform(0);
  rainMat.colorNode = mix(vec3(0.12, 0.0, 0.0), vec3(40, 0.5, 0.3), rainOn);
  let rain = null;
  if (era !== 'classic') {
    rain = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.03), rainMat);
    rain.position.set(0, geo.rainY, geo.rainZ);
    root.add(rain);
  }

  // wheels
  const wheels = [];
  const compound = car.livery.pattern === 'band' ? [0.85, 0.85, 0.8] : [0.85, 0.08, 0.06];
  const tyreMat = tyreMaterial(compound, era === 'v10');
  const rimMat = rimMaterial(car.model.wheelCovers);
  tyreMat.userData.R.value = car.wheelRadius;
  tyreMat.userData.RR.value = car.model.rimRadius;
  for (const w of geo.wheels) {
    const steer = new THREE.Group();
    steer.position.set(w.x, car.wheelRadius, w.z);
    const spin = new THREE.Group();
    steer.add(spin);
    const width = w.front ? car.model.tyreWidthF : car.model.tyreWidthR;
    const tyre = new THREE.Mesh(tyreGeometry(car.wheelRadius, car.model.rimRadius, width), tyreMat);
    tyre.castShadow = true;
    spin.add(tyre);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(car.model.rimRadius, car.model.rimRadius, width * 0.92, 28, 1), rimMat);
    rim.rotation.z = Math.PI / 2;
    spin.add(rim);
    root.add(steer);
    wheels.push({ steer, spin, front: w.front });
  }

  // steering wheel with a small display for the cockpit camera
  const sw = buildSteeringWheel(era);
  sw.group.position.set(0, geo.wheelY, geo.wheelZ);
  root.add(sw.group);

  root.userData = {
    wheels, flap, rainOn, steeringWheel: sw, paint,
    eye: new THREE.Vector3(0, geo.helmetY + 0.085, geo.helmetZ + 0.13),
    tcam: new THREE.Vector3(0, geo.tcamY, geo.tcamZ),
    nose: new THREE.Vector3(0, geo.noseCamY, geo.noseCamZ),
    length: car.model.length
  };
  return root;
}

function tyreGeometry(R, rr, w) {
  const pts = [];
  const hw = w / 2, c = Math.min(0.06, hw * 0.45);
  pts.push(new THREE.Vector2(rr, -hw * 0.92));
  pts.push(new THREE.Vector2(R - c, -hw));
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(R - c + Math.cos(a) * c, -hw + c + Math.sin(a) * c)); }
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(R - c + Math.cos(a) * c, hw - c + Math.sin(a) * c)); }
  pts.push(new THREE.Vector2(rr, hw * 0.92));
  const g = new THREE.LatheGeometry(pts, 40);
  g.rotateZ(Math.PI / 2);
  return g;
}

function buildSteeringWheel(era) {
  const group = new THREE.Group();
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const bodyMat = new THREE.MeshStandardNodeMaterial({ color: 0x111215, roughness: 0.5 });
  if (era === 'classic') {
    const rimG = new THREE.TorusGeometry(0.17, 0.014, 8, 32);
    group.add(new THREE.Mesh(rimG, new THREE.MeshStandardNodeMaterial({ color: 0x3a2a1c, roughness: 0.6 })));
    return { group, canvas, tex, draw: () => {} };
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.04), bodyMat);
  group.add(body);
  for (const s of [1, -1]) {
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.026, 0.085, 4, 10), bodyMat);
    grip.position.set(s * 0.125, -0.012, 0);
    grip.rotation.z = s * 0.12;
    group.add(grip);
  }
  // rotary switches and buttons round the screen
  const knobMat = new THREE.MeshStandardNodeMaterial({ color: 0x8a8f96, metalness: 0.8, roughness: 0.3 });
  const btnCols = [0xff3b30, 0xfad201, 0x22e06b, 0x3b8bff];
  for (let i = 0; i < 4; i++) {
    const k = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.012, 12), knobMat);
    k.rotation.x = Math.PI / 2; k.position.set((i < 2 ? -1 : 1) * 0.07, i % 2 ? -0.04 : 0.042, -0.024);
    group.add(k);
    const bt = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.006, 10), new THREE.MeshStandardNodeMaterial({ color: btnCols[i], roughness: 0.4 }));
    bt.rotation.x = Math.PI / 2; bt.position.set((i - 1.5) * 0.03, -0.047, -0.022);
    group.add(bt);
  }
  const screenMat = new THREE.MeshBasicNodeMaterial({ map: tex });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.05), screenMat);
  screen.position.set(0, 0.008, -0.021);
  screen.rotation.y = Math.PI;
  group.add(screen);
  // tilted back so its face looks up at the driver
  group.rotation.x = 0.55;
  const g = canvas.getContext('2d');
  let last = '';
  const draw = (gear, speed, rpmFrac) => {
    const key = `${gear}|${speed}|${Math.round(rpmFrac * 15)}`;
    if (key === last) return;
    last = key;
    g.fillStyle = '#04060a'; g.fillRect(0, 0, 256, 128);
    const lit = Math.round(rpmFrac * 15);
    for (let i = 0; i < 15; i++) {
      g.fillStyle = i < lit ? (i < 5 ? '#22e06b' : i < 10 ? '#ff3b30' : '#3b8bff') : '#1a1d22';
      g.fillRect(8 + i * 16, 6, 12, 10);
    }
    g.fillStyle = '#fad201'; g.font = '700 70px Barlow Condensed, sans-serif'; g.textAlign = 'center';
    g.fillText(gear, 128, 96);
    g.fillStyle = '#fff'; g.font = '600 34px Barlow Condensed, sans-serif';
    g.textAlign = 'left'; g.fillText(String(speed), 12, 104);
    g.textAlign = 'right'; g.fillStyle = '#8fd1ff'; g.fillText('RW', 244, 104);
    tex.needsUpdate = true;
  };
  return { group, canvas, tex, draw };
}

// 2026 car: low nose, narrow wings, halo, wheel covers
function modernGeometry(P) {
  const fa = 1.7, ra = -1.7;
  const chassis = [
    { z: 2.66, w: 0.05, h: 0.035, y: 0.22, n: 2.6 },
    { z: 2.45, w: 0.09, h: 0.065, y: 0.25, n: 2.8 },
    { z: 2.1, w: 0.135, h: 0.095, y: 0.3, n: 3 },
    { z: 1.7, w: 0.18, h: 0.125, y: 0.36, n: 3 },
    { z: 1.25, w: 0.22, h: 0.165, y: 0.42, n: 3.2 },
    { z: 0.8, w: 0.26, h: 0.2, y: 0.47, n: 3.4 },
    { z: 0.42, w: 0.29, h: 0.22, y: 0.49, n: 3.6, flat: 0.3 },
    { z: 0.0, w: 0.31, h: 0.225, y: 0.49, n: 3.6, flat: 0.3 },
    { z: -0.4, w: 0.33, h: 0.26, y: 0.51, n: 3.4, flat: 0.3 },
    { z: -0.95, w: 0.29, h: 0.25, y: 0.5, n: 3.2 },
    { z: -1.45, w: 0.21, h: 0.21, y: 0.46, n: 3 },
    { z: -1.95, w: 0.13, h: 0.15, y: 0.4, n: 2.8 },
    { z: -2.32, w: 0.07, h: 0.09, y: 0.35, n: 2.6 },
    { z: -2.46, w: 0.02, h: 0.03, y: 0.33, n: 2.4 }
  ];
  P.paint.push(loft(chassis, 30, { z0: -0.13, z1: 0.53, halfW: 0.235, yMin: 0.6 }));
  cockpit(P, { z0: -0.13, z1: 0.53, halfW: 0.235, floorY: 0.3, rimY: 0.705, wheel: { y: 0.67, z: 0.36 }, shoulderY: 0.63, shoulderZ: -0.02 });
  // engine cover and airbox
  P.paint.push(loft([
    { z: -0.06, w: 0.12, h: 0.13, y: 0.86, n: 2.6 },
    { z: -0.25, w: 0.15, h: 0.19, y: 0.82, n: 2.6 },
    { z: -0.7, w: 0.17, h: 0.2, y: 0.76, n: 2.8 },
    { z: -1.25, w: 0.13, h: 0.17, y: 0.68, n: 2.8 },
    { z: -1.75, w: 0.08, h: 0.11, y: 0.58, n: 2.6 },
    { z: -2.15, w: 0.03, h: 0.05, y: 0.5, n: 2.4 }
  ]));
  P.dark.push(loft([{ z: -0.05, w: 0.085, h: 0.075, y: 0.9, n: 2.5 }, { z: -0.07, w: 0.08, h: 0.07, y: 0.9, n: 2.5 }]));
  // shark fin
  P.paint.push(plate(1.2, 0.17, 0.012, 0, 0.88, -1.0, 0, 0.6));
  // sidepods
  for (const s of [1, -1]) {
    const pod = loft([
      { z: 0.78, w: 0.03, h: 0.03, y: 0.43, x: 0.3 },
      { z: 0.66, w: 0.17, h: 0.13, y: 0.44, x: 0.43, n: 3.4 },
      { z: 0.3, w: 0.2, h: 0.16, y: 0.42, x: 0.46, n: 3.6, flat: 0.4 },
      { z: -0.25, w: 0.19, h: 0.15, y: 0.39, x: 0.45, n: 3.4, flat: 0.4 },
      { z: -0.85, w: 0.13, h: 0.11, y: 0.33, x: 0.4, n: 3 },
      { z: -1.35, w: 0.07, h: 0.07, y: 0.28, x: 0.33, n: 2.8 },
      { z: -1.6, w: 0.02, h: 0.03, y: 0.26, x: 0.3, n: 2.4 }
    ]);
    P.paint.push(s > 0 ? pod : mirrorX(pod));
    const inlet = loft([{ z: 0.665, w: 0.15, h: 0.11, y: 0.445, x: 0.43, n: 3.4 }, { z: 0.64, w: 0.14, h: 0.1, y: 0.445, x: 0.43, n: 3.4 }]);
    P.dark.push(s > 0 ? inlet : mirrorX(inlet));
  }
  // floor with tapering edges
  const fl = new THREE.Shape();
  const outline = [[0.3, 1.25], [0.62, 0.95], [0.9, 0.62], [0.92, -1.25], [0.78, -1.7], [0.55, -2.15], [-0.55, -2.15], [-0.78, -1.7], [-0.92, -1.25], [-0.9, 0.62], [-0.62, 0.95], [-0.3, 1.25]];
  outline.forEach(([x, z], i) => fl[i ? 'lineTo' : 'moveTo'](x, -z));
  const floorG = new THREE.ExtrudeGeometry(fl, { depth: 0.035, bevelEnabled: false });
  floorG.rotateX(-Math.PI / 2);
  floorG.translate(0, 0.045, 0);
  P.carbon.push(floorG);
  // diffuser ramps
  for (const x of [-0.42, 0, 0.42]) P.carbon.push(plate(0.55, 0.22, 0.012, x, 0.06, -1.62, 0, 0.1));
  // front wing: four elements and endplates
  const fwSpan = 1.86;
  [[0.24, 2.84, 0.075, -4], [0.17, 2.66, 0.12, -14], [0.13, 2.53, 0.165, -24], [0.1, 2.44, 0.205, -34]].forEach(([c, z, y, a], i) => {
    P[i === 0 ? 'paint' : 'carbon'].push(wingElement(fwSpan, c, 0.08, z, y, a));
  });
  for (const s of [1, -1]) {
    P.paint.push(plate(0.5, 0.25, 0.012, s * 0.93, 0.05, 2.9, 0, 0.45));
    P.carbon.push(strut([s * 0.06, 0.22, 2.55], [s * 0.1, 0.11, 2.62], 0.01, 3));
  }
  // rear wing
  const rwSpan = 1.0;
  P.carbon.push(wingElement(rwSpan, 0.28, 0.1, -2.1, 0.84, -8));
  for (const s of [1, -1]) P.paint.push(plate(0.56, 0.6, 0.014, s * 0.505, 0.46, -2.3, 0, 0.35));
  P.carbon.push(plate(0.22, 0.38, 0.03, 0, 0.5, -2.05, 0, 0.1));
  // suspension
  addSuspension(P, fa, 0.8, 0.5, 0.25, true, false, chassis);
  addSuspension(P, ra, 0.78, 0.48, 0.24, false, false, chassis);
  // halo
  const haloCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.27, 0.66, -0.12), new THREE.Vector3(-0.29, 0.88, 0.1), new THREE.Vector3(-0.2, 0.95, 0.42),
    new THREE.Vector3(0, 0.97, 0.52), new THREE.Vector3(0.2, 0.95, 0.42), new THREE.Vector3(0.29, 0.88, 0.1), new THREE.Vector3(0.27, 0.66, -0.12)
  ]);
  P.paint.push(new THREE.TubeGeometry(haloCurve, 40, 0.024, 8, false));
  P.paint.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.96, 0.52), new THREE.Vector3(0, 0.83, 0.68), new THREE.Vector3(0, 0.68, 0.78)]), 12, 0.026, 8, false));
  // mirrors
  for (const s of [1, -1]) {
    P.paint.push(new THREE.BoxGeometry(0.1, 0.042, 0.03).translate(s * 0.44, 0.68, 0.46));
    P.dark.push(new THREE.BoxGeometry(0.09, 0.034, 0.004).translate(s * 0.44, 0.68, 0.444));
    P.carbon.push(strut([s * 0.3, 0.6, 0.48], [s * 0.42, 0.67, 0.46], 0.006, 2));
  }
  // T-cam on the airbox
  P.dark.push(new THREE.BoxGeometry(0.09, 0.05, 0.12).translate(0, 1.02, -0.2));
  return {
    wheels: [{ x: 0.8, z: fa, front: true }, { x: -0.8, z: fa, front: true }, { x: 0.78, z: ra, front: false }, { x: -0.78, z: ra, front: false }],
    helmetY: 0.77, helmetZ: 0.03, flap: { y: 0.95, z: -2.3, span: 1.0, chord: 0.2 }, rainY: 0.36, rainZ: -2.4,
    wheelY: 0.67, wheelZ: 0.36, tcamY: 1.08, tcamZ: -0.22, noseCamY: 0.42, noseCamZ: 1.9
  };
}

// 2005 car: high nose, narrow tall rear wing, beam wing, no halo
function v10Geometry(P) {
  const fa = 1.55, ra = -1.55;
  const chassis = [
    { z: 2.36, w: 0.06, h: 0.05, y: 0.44, n: 2.4 },
    { z: 2.1, w: 0.11, h: 0.08, y: 0.47, n: 2.6 },
    { z: 1.7, w: 0.16, h: 0.12, y: 0.5, n: 2.8 },
    { z: 1.2, w: 0.21, h: 0.16, y: 0.52, n: 3 },
    { z: 0.7, w: 0.25, h: 0.2, y: 0.52, n: 3.2 },
    { z: 0.3, w: 0.28, h: 0.21, y: 0.5, n: 3.4, flat: 0.3 },
    { z: -0.1, w: 0.3, h: 0.22, y: 0.49, n: 3.4, flat: 0.3 },
    { z: -0.5, w: 0.31, h: 0.25, y: 0.5, n: 3.2, flat: 0.3 },
    { z: -1.0, w: 0.26, h: 0.23, y: 0.48, n: 3 },
    { z: -1.5, w: 0.17, h: 0.18, y: 0.44, n: 2.8 },
    { z: -1.95, w: 0.09, h: 0.11, y: 0.38, n: 2.6 },
    { z: -2.15, w: 0.02, h: 0.03, y: 0.35, n: 2.4 }
  ];
  P.paint.push(loft(chassis, 30, { z0: -0.17, z1: 0.4, halfW: 0.225, yMin: 0.6 }));
  cockpit(P, { z0: -0.17, z1: 0.4, halfW: 0.225, floorY: 0.3, rimY: 0.715, wheel: { y: 0.68, z: 0.25 }, shoulderY: 0.64, shoulderZ: -0.1 });
  P.paint.push(loft([
    { z: -0.15, w: 0.13, h: 0.16, y: 0.86, n: 2.6 },
    { z: -0.45, w: 0.16, h: 0.2, y: 0.8, n: 2.6 },
    { z: -0.95, w: 0.14, h: 0.17, y: 0.72, n: 2.8 },
    { z: -1.5, w: 0.08, h: 0.11, y: 0.6, n: 2.6 },
    { z: -1.95, w: 0.03, h: 0.05, y: 0.5, n: 2.4 }
  ]));
  P.dark.push(loft([{ z: -0.14, w: 0.09, h: 0.08, y: 0.9, n: 2.5 }, { z: -0.16, w: 0.085, h: 0.075, y: 0.9, n: 2.5 }]));
  for (const s of [1, -1]) {
    const pod = loft([
      { z: 0.55, w: 0.03, h: 0.03, y: 0.42, x: 0.3 },
      { z: 0.45, w: 0.19, h: 0.15, y: 0.42, x: 0.45, n: 3.4 },
      { z: 0.0, w: 0.21, h: 0.17, y: 0.4, x: 0.47, n: 3.4, flat: 0.4 },
      { z: -0.6, w: 0.17, h: 0.14, y: 0.37, x: 0.43, n: 3 },
      { z: -1.2, w: 0.09, h: 0.09, y: 0.31, x: 0.35, n: 2.8 },
      { z: -1.5, w: 0.02, h: 0.03, y: 0.28, x: 0.31, n: 2.4 }
    ]);
    P.paint.push(s > 0 ? pod : mirrorX(pod));
    const inlet = loft([{ z: 0.455, w: 0.17, h: 0.13, y: 0.42, x: 0.45, n: 3.4 }, { z: 0.43, w: 0.16, h: 0.12, y: 0.42, x: 0.45, n: 3.4 }]);
    P.dark.push(s > 0 ? inlet : mirrorX(inlet));
    // bargeboards and chimney
    P.carbon.push(plate(0.5, 0.22, 0.01, s * 0.34, 0.08, 1.05, 0.1 * s, 0.4));
    P.carbon.push(new THREE.CylinderGeometry(0.045, 0.06, 0.14, 10).translate(s * 0.42, 0.62, -0.55));
  }
  const fl = new THREE.Shape();
  [[0.32, 1.1], [0.72, 0.6], [0.76, -1.1], [0.5, -1.9], [-0.5, -1.9], [-0.76, -1.1], [-0.72, 0.6], [-0.32, 1.1]].forEach(([x, z], i) => fl[i ? 'lineTo' : 'moveTo'](x, -z));
  const floorG = new THREE.ExtrudeGeometry(fl, { depth: 0.03, bevelEnabled: false });
  floorG.rotateX(-Math.PI / 2);
  floorG.translate(0, 0.05, 0);
  P.carbon.push(floorG);
  // front wing hung from the high nose
  [[0.26, 2.52, 0.1, -6], [0.17, 2.36, 0.15, -18], [0.12, 2.26, 0.2, -28]].forEach(([c, z, y, a], i) => P[i ? 'carbon' : 'paint'].push(wingElement(1.7, c, 0.08, z, y, a)));
  for (const s of [1, -1]) {
    P.paint.push(plate(0.5, 0.26, 0.012, s * 0.85, 0.06, 2.6, 0, 0.4));
    P.carbon.push(plate(0.2, 0.3, 0.012, s * 0.08, 0.18, 2.4, 0, 0.2));
  }
  // tall narrow rear wing plus beam wing
  P.carbon.push(wingElement(0.76, 0.3, 0.1, -1.95, 0.8, -8));
  P.carbon.push(wingElement(0.76, 0.2, 0.1, -2.12, 0.95, -26));
  P.carbon.push(wingElement(0.7, 0.18, 0.1, -1.85, 0.42, -10));
  for (const s of [1, -1]) P.paint.push(plate(0.6, 0.74, 0.014, s * 0.385, 0.34, -2.1, 0, 0.15));
  addSuspension(P, fa, 0.74, 0.55, 0.26, true, false, chassis);
  addSuspension(P, ra, 0.72, 0.48, 0.24, false, false, chassis);
  for (const s of [1, -1]) {
    P.paint.push(new THREE.BoxGeometry(0.12, 0.055, 0.04).translate(s * 0.44, 0.7, 0.35));
    P.carbon.push(strut([s * 0.28, 0.62, 0.38], [s * 0.42, 0.7, 0.35], 0.008, 2));
  }
  P.dark.push(new THREE.BoxGeometry(0.09, 0.05, 0.12).translate(0, 1.02, -0.3));
  return {
    wheels: [{ x: 0.74, z: fa, front: true }, { x: -0.74, z: fa, front: true }, { x: 0.72, z: ra, front: false }, { x: -0.72, z: ra, front: false }],
    helmetY: 0.79, helmetZ: -0.06, flap: null, rainY: 0.32, rainZ: -2.12,
    wheelY: 0.68, wheelZ: 0.25, tcamY: 1.07, tcamZ: -0.32, noseCamY: 0.62, noseCamZ: 1.7
  };
}

// 1967 car: cigar body, exposed V8, no wings
function classicGeometry(P) {
  const fa = 1.21, ra = -1.21;
  const chassis = [
    { z: 1.95, w: 0.13, h: 0.11, y: 0.36, n: 2 },
    { z: 1.8, w: 0.2, h: 0.17, y: 0.38, n: 2 },
    { z: 1.3, w: 0.27, h: 0.23, y: 0.42, n: 2.2 },
    { z: 0.6, w: 0.32, h: 0.27, y: 0.45, n: 2.4 },
    { z: 0.0, w: 0.34, h: 0.28, y: 0.45, n: 2.4 },
    { z: -0.45, w: 0.33, h: 0.27, y: 0.44, n: 2.4 },
    { z: -0.75, w: 0.27, h: 0.18, y: 0.36, n: 2.4 }
  ];
  P.paint.push(loft(chassis, 36, { z0: -0.47, z1: 0.3, halfW: 0.24, yMin: 0.6 }));
  cockpit(P, { z0: -0.47, z1: 0.3, halfW: 0.24, floorY: 0.28, rimY: 0.7, wheel: { y: 0.74, z: 0.12 }, shoulderY: 0.74, shoulderZ: -0.2 });
  P.dark.push(loft([{ z: 1.96, w: 0.1, h: 0.08, y: 0.36, n: 2 }, { z: 1.955, w: 0.095, h: 0.075, y: 0.36, n: 2 }]));
  // cockpit opening and windscreen
  const screen = new THREE.CylinderGeometry(0.26, 0.26, 0.13, 18, 1, true, -1.2, 2.4);
  screen.rotateY(Math.PI / 2 + Math.PI);
  screen.translate(0, 0.79, 0.35);
  P.metal.push(screen);
  // V8 with pipes, gearbox, oil tank
  P.metal.push(new THREE.BoxGeometry(0.5, 0.3, 0.6).translate(0, 0.42, -1.05));
  for (const s of [1, -1]) {
    P.metal.push(new THREE.BoxGeometry(0.16, 0.2, 0.55).rotateZ(s * 0.6).translate(s * 0.2, 0.6, -1.05));
    for (let i = 0; i < 4; i++) {
      const pipe = new THREE.CatmullRomCurve3([new THREE.Vector3(s * 0.2, 0.55, -0.85 - i * 0.12), new THREE.Vector3(s * 0.34, 0.68, -1.1 - i * 0.05), new THREE.Vector3(s * 0.22, 0.8, -1.55), new THREE.Vector3(s * 0.12 + s * i * 0.03, 0.82, -1.95)]);
      P.metal.push(new THREE.TubeGeometry(pipe, 12, 0.022, 6, false));
    }
  }
  P.matt.push(new THREE.BoxGeometry(0.28, 0.24, 0.42).translate(0, 0.36, -1.55));
  // roll hoop
  P.metal.push(new THREE.TorusGeometry(0.17, 0.016, 6, 16, Math.PI).translate(0, 0.78, -0.42));
  addSuspension(P, fa, 0.72, 0.48, 0.24, true, true, chassis);
  addSuspension(P, ra, 0.72, 0.46, 0.22, false, true, chassis);
  for (const s of [1, -1]) P.metal.push(new THREE.BoxGeometry(0.08, 0.05, 0.03).translate(s * 0.33, 0.74, 0.32));
  return {
    wheels: [{ x: 0.72, z: fa, front: true }, { x: -0.72, z: fa, front: true }, { x: 0.72, z: ra, front: false }, { x: -0.72, z: ra, front: false }],
    helmetY: 0.9, helmetZ: -0.15, flap: null, rainY: 0, rainZ: 0,
    wheelY: 0.74, wheelZ: 0.12, tcamY: 1.1, tcamZ: -0.3, noseCamY: 0.58, noseCamZ: 1.6
  };
}

function addSuspension(P, z, track, yUp, yLo, front, classic = false, chassis = null) {
  const list = classic ? P.metal : P.carbon;
  // inner pickups sit on the chassis skin, outer ends on an upright inside the wheel
  const inX = (zz, y) => (chassis ? bodyHalfWidth(chassis, zz, y) - 0.004 : 0.2);
  const yIn = yUp - 0.04, yInL = yLo + 0.03;
  for (const s of [1, -1]) {
    const hub = s * (track - 0.09);
    list.push(strut([s * inX(z + 0.18, yIn), yIn, z + 0.18], [hub, yUp - 0.02, z], 0.012));
    list.push(strut([s * inX(z - 0.18, yIn), yIn, z - 0.18], [hub, yUp - 0.02, z], 0.012));
    list.push(strut([s * inX(z + 0.24, yInL), yInL, z + 0.24], [hub, yLo, z], 0.012));
    list.push(strut([s * inX(z - 0.24, yInL), yInL, z - 0.24], [hub, yLo, z], 0.012));
    // push or pull rod to the rocker inside the body, and the steering arm at the front
    const rz = z + (front ? -0.06 : 0.06);
    list.push(strut([s * inX(rz, yUp - 0.02) * 0.9, yUp - 0.01, rz], [hub * 0.97, yLo + 0.03, z], 0.01, 1.4));
    if (front) list.push(strut([s * inX(z + 0.1, (yUp + yLo) / 2), (yUp + yLo) / 2, z + 0.1], [hub, (yUp + yLo) / 2, z + 0.07], 0.009, 1.2));
    // upright
    P.matt.push(new THREE.BoxGeometry(0.06, yUp - yLo + 0.08, 0.1).translate(hub, (yUp + yLo) / 2, z));
  }
}
