import * as THREE from 'three/webgpu';
import {
  attribute, positionLocal, positionWorld, cameraPosition, normalLocal, vec3, vec4, float, mix, sin, cos, time, hash, instanceIndex,
  smoothstep, mx_noise_float, normalize, dot, max, pow, texture, uv, transformNormalToView
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm, mulberry32, smoothstep as sstep } from './noise.js';
import { lakeIslands } from './terrain.js';

// ---------- leaf atlas drawn on a canvas: left = broad leaves, right = fine acacia foliage ----------
function leafAtlas() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const rnd = mulberry32(99);
  const cluster = (ox, fine) => {
    const cx = ox + 256, cy = 256;
    // twigs
    g.strokeStyle = 'rgba(70,52,34,0.9)';
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2, r = 120 + rnd() * 90;
      g.lineWidth = fine ? 2 : 3;
      g.beginPath(); g.moveTo(cx, cy); g.quadraticCurveTo(cx + Math.cos(a + 0.4) * r * 0.5, cy + Math.sin(a + 0.4) * r * 0.5, cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.stroke();
    }
    const n = fine ? 1400 : 420;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.pow(rnd(), 0.6) * 220;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.92;
      const len = fine ? 7 + rnd() * 7 : 20 + rnd() * 18, wid = fine ? 3 + rnd() * 2 : 8 + rnd() * 7;
      const light = 0.55 + rnd() * 0.45 - (r / 220) * 0.15 + (cy - y) / 900;
      const hue = 82 + rnd() * 28, sat = 35 + rnd() * 25;
      g.fillStyle = `hsl(${hue}, ${sat}%, ${Math.round(14 + light * 26)}%)`;
      g.save(); g.translate(x, y); g.rotate(a + (rnd() - 0.5) * 1.6);
      g.beginPath(); g.ellipse(0, 0, len, wid, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    }
  };
  cluster(0, false);
  cluster(512, true);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

// ---------- geometry ----------
function withPart(geo, part) {
  geo = geo.index ? geo.toNonIndexed() : geo;
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count).fill(part), 1));
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  return geo;
}

function trunk(h, r0, r1, lean = 0) {
  const g = new THREE.CylinderGeometry(r1, r0, h, 7, 3, true);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setX(i, p.getX(i) + lean * (y / h) * (y / h)); }
  g.computeVertexNormals();
  return withPart(g, 0);
}

function branch(from, to, r) {
  const A = new THREE.Vector3(...from), B = new THREE.Vector3(...to);
  const g = new THREE.CylinderGeometry(r * 0.6, r, A.distanceTo(B), 5, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
  const m = A.clone().add(B).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  g.computeVertexNormals();
  return withPart(g, 0);
}

// Leaf cards scattered through an ellipsoid; normals point away from its centre for soft volume shading
function canopy(cx, cy, cz, rx, ry, rz, cards, size, cell, seed) {
  const rnd = mulberry32(seed);
  const pos = [], nor = [], uvs = [];
  const c = new THREE.Vector3(cx, cy, cz);
  const u0 = cell * 0.5;
  for (let i = 0; i < cards; i++) {
    const dir = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    const r = 0.45 + 0.55 * Math.sqrt(rnd());
    const p = new THREE.Vector3(c.x + dir.x * rx * r, c.y + dir.y * ry * r, c.z + dir.z * rz * r);
    const n = dir.clone().add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.9)).normalize();
    const t1 = new THREE.Vector3(0, 1, 0).cross(n);
    if (t1.lengthSq() < 0.01) t1.set(1, 0, 0);
    t1.normalize();
    const t2 = n.clone().cross(t1).normalize();
    const rot = rnd() * Math.PI;
    const a = t1.clone().multiplyScalar(Math.cos(rot)).add(t2.clone().multiplyScalar(Math.sin(rot)));
    const b = n.clone().cross(a).normalize();
    const s = size * (0.75 + rnd() * 0.5);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => p.clone().addScaledVector(a, u * s).addScaledVector(b, v * s));
    const cu = [[u0, 0], [u0 + 0.5, 0], [u0 + 0.5, 1], [u0, 1]];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const q = corners[k];
      pos.push(q.x, q.y, q.z);
      const sn = q.clone().sub(c).normalize().lerp(new THREE.Vector3(0, 1, 0), 0.25).normalize();
      nor.push(sn.x, sn.y, sn.z);
      uvs.push(cu[k][0], cu[k][1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return withPart(g, 1);
}

const KINDS = {
  acacia: {
    h: 8, tint: [0.92, 0.95, 0.72], bark: [0.24, 0.19, 0.14],
    geo: () => mergeGeometries([
      trunk(4.6, 0.3, 0.15, 0.5),
      branch([0.4, 4.2, 0], [2.6, 5.6, 1.2], 0.12), branch([0.4, 4.2, 0], [-2.0, 5.5, -1.4], 0.12), branch([0.4, 4.4, 0], [1.4, 5.8, -2.2], 0.1),
      canopy(0.5, 6.0, 0, 4.8, 0.9, 4.4, 26, 1.5, 1, 1),
      canopy(-2.1, 5.6, 1.3, 2.8, 0.7, 2.6, 12, 1.2, 1, 2),
      canopy(2.6, 5.5, -1.5, 2.8, 0.65, 2.8, 12, 1.2, 1, 3)
    ])
  },
  broadleaf: {
    h: 10, tint: [0.62, 0.78, 0.55], bark: [0.21, 0.17, 0.13],
    geo: () => mergeGeometries([
      trunk(4.4, 0.42, 0.24, 0.2),
      branch([0, 3.8, 0], [1.8, 5.6, 1.0], 0.16), branch([0, 3.8, 0], [-1.7, 5.7, -0.9], 0.16),
      canopy(0, 6.8, 0, 3.6, 3.0, 3.6, 34, 1.55, 0, 4),
      canopy(1.9, 5.6, 1.1, 2.6, 2.3, 2.6, 18, 1.35, 0, 5),
      canopy(-1.8, 5.8, -1.0, 2.5, 2.2, 2.5, 18, 1.35, 0, 6),
      canopy(0.2, 8.8, -0.3, 2.1, 1.8, 2.1, 12, 1.2, 0, 7)
    ])
  },
  eucalyptus: {
    h: 22, tint: [0.7, 0.78, 0.62], bark: [0.42, 0.4, 0.35],
    geo: () => mergeGeometries([
      trunk(16, 0.36, 0.13, 0.4),
      canopy(0.3, 17.2, 0, 2.4, 5.0, 2.4, 26, 1.35, 1, 8),
      canopy(-0.7, 12.4, 0.5, 1.7, 3.0, 1.7, 12, 1.1, 1, 9)
    ])
  },
  shrub: {
    h: 2.2, tint: [0.6, 0.7, 0.48], bark: [0.2, 0.16, 0.1],
    geo: () => mergeGeometries([canopy(0, 1.0, 0, 1.9, 1.1, 1.9, 14, 0.95, 0, 10), canopy(1.1, 0.8, 0.5, 1.2, 0.8, 1.2, 7, 0.8, 0, 11)])
  },
  papyrus: {
    h: 4, tint: [0.75, 0.95, 0.6], bark: [0.25, 0.36, 0.12],
    geo: () => {
      const parts = [];
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2, r = 0.4 + (i % 3) * 0.3, h = 2.6 + (i % 4) * 0.5;
        const stem = new THREE.CylinderGeometry(0.025, 0.04, h, 3, 1, true);
        stem.translate(Math.cos(a) * r, h / 2, Math.sin(a) * r);
        parts.push(withPart(stem, 0));
        parts.push(canopy(Math.cos(a) * r, h + 0.1, Math.sin(a) * r, 0.5, 0.15, 0.5, 2, 0.45, 1, 20 + i));
      }
      return mergeGeometries(parts);
    }
  }
};

function treeMaterial(kind, U, atlas) {
  const k = KINDS[kind];
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.42 });
  mat.alphaToCoverage = true;
  const part = attribute('aPart', 'float');
  const v = attribute('aVar', 'vec3'); // x: tint, y: brightness, z: floodlight
  const tex = texture(atlas, uv());
  const shade = smoothstep(0.0, k.h, positionLocal.y).mul(0.4).add(0.6);
  const tint = mix(vec3(...k.tint), vec3(...k.tint).mul(vec3(1.12, 1.0, 0.72)), v.x);
  const leaf = tex.rgb.mul(tint).mul(v.y).mul(shade);
  const barkN = mx_noise_float(positionLocal.mul(vec3(9.0, 1.5, 9.0))).mul(0.15).add(0.92);
  const col = mix(vec3(...k.bark).mul(barkN), leaf, part);
  mat.colorNode = col.mul(mix(float(1), v.z.mul(0.9).add(0.07), U.night));
  mat.opacityNode = mix(float(1), tex.a, part);
  mat.roughnessNode = float(0.85);
  mat.normalNode = normalize(transformNormalToView(normalLocal));
  // light through the leaves when looking towards the sun
  const view = normalize(positionWorld.sub(cameraPosition));
  const through = pow(max(dot(view, U.sunDir), 0.0), 5.0).mul(float(1).sub(U.night)).mul(0.55).mul(part);
  mat.emissiveNode = leaf.mul(vec3(U.sunColor)).mul(through).add(col.mul(U.night).mul(U.flood).mul(v.z));
  // wind sway grows with height
  const phase = hash(instanceIndex).mul(6.283);
  const h = positionLocal.y.div(k.h);
  const sway = h.mul(h).mul(part.mul(0.7).add(0.3));
  const w = time.mul(1.1).add(phase);
  const flutter = sin(time.mul(7.0).add(positionLocal.x.mul(3.0)).add(phase)).mul(0.03).mul(part);
  mat.positionNode = positionLocal.add(vec3(sin(w).mul(0.2).add(flutter), 0.0, cos(w.mul(0.8)).mul(0.14)).mul(sway.add(part.mul(0.3))).mul(U.wind));
  return mat;
}

// tvSpots: [{x, z}] kept clear so broadcast cameras see the track
export function buildVegetation(track, terrain, U, tvSpots = []) {
  const group = new THREE.Group();
  group.name = 'vegetation';
  const atlas = leafAtlas();
  const rnd = mulberry32(2026);
  const lists = {};
  for (const k of Object.keys(KINDS)) lists[k] = { near: [], far: [] };
  const half = terrain.near.half - 40;
  const cell = 8;
  const pit = { a: track.wrap(track.startLine - 320), b: track.wrap(track.startLine + 420) };
  const inPit = (s) => (pit.a > pit.b ? s >= pit.a || s <= pit.b : s >= pit.a && s <= pit.b);
  const near = {};
  // the forest corner: Turns 10-11 round the lake, "only forest and the track"
  const c10 = track.corners.find((c) => c.n === 10), c11 = track.corners.find((c) => c.n === 11);
  const forestS = track.wrap(track.forwardS((c10.s + c11.s) / 2));
  const tvGrid = new Map();
  for (const t of tvSpots) tvGrid.set(`${Math.floor(t.x / 40)},${Math.floor(t.z / 40)}`, t);
  const nearTv = (x, z) => {
    const gx = Math.floor(x / 40), gz = Math.floor(z / 40);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const t = tvGrid.get(`${gx + i},${gz + j}`);
      if (t && Math.hypot(t.x - x, t.z - z) < 30) return true;
    }
    return false;
  };
  for (let gz = -half; gz < half; gz += cell) {
    for (let gx = -half; gx < half; gx += cell) {
      const x = gx + rnd() * cell, z = gz + rnd() * cell;
      const info = terrain.infoAt(x, z);
      if (info.dist < 6 || info.zone > 0.5 || info.crowd > 0.05) continue;
      const sdf = info.lake;
      if (sdf < 6) {
        if (sdf > -18 && rnd() < 0.55) lists.papyrus[info.dist < 150 ? 'near' : 'far'].push({ x, z, s: 0.8 + rnd() * 0.6 });
        continue;
      }
      const forest = fbm(x / 420, z / 420, 4, 77);
      const clump = fbm(x / 90, z / 90, 3, 78);
      let density = 0.05 + Math.max(0, forest) * 0.55 + Math.max(0, clump) * 0.25;
      density += sstep(90, 10, sdf) * 0.55; // gallery forest along the shore
      const savanna = sstep(350, 900, info.dist);
      density *= 1 - savanna * 0.65;
      if (info.dist < 120) {
        const tn = track.nearest(x, z, near);
        const fr = track.frame(tn.s);
        if (inPit(tn.s) && tn.d > -(fr.half + 110) && tn.d < fr.half + 230) continue;
        let df = Math.abs(tn.s - forestS); df = Math.min(df, track.length - df);
        density += sstep(300, 80, df) * 0.9;
        density *= sstep(4, 18, info.dist);
        if (nearTv(x, z)) continue;
      }
      if (Math.abs(z + 4300) < 260 && Math.abs(x + 500) < 2400) continue;
      if (rnd() > density) continue;
      let kind;
      const r = rnd();
      if (sdf < 90 && r < 0.7) kind = 'broadleaf';
      else if (savanna > 0.5) kind = r < 0.62 ? 'acacia' : r < 0.82 ? 'shrub' : 'broadleaf';
      else if (fbm(x / 160, z / 160, 2, 91) > 0.32) kind = 'eucalyptus';
      else kind = r < 0.35 ? 'acacia' : r < 0.75 ? 'broadleaf' : 'shrub';
      lists[kind][info.dist < 140 ? 'near' : 'far'].push({ x, z, s: 0.7 + rnd() * 0.65 });
    }
  }
  // papyrus on the lake islands
  for (const o of lakeIslands()) {
    const n = Math.round(o.r * o.r * 0.05);
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * o.r * 0.85;
      lists.papyrus.far.push({ x: o.x + Math.cos(a) * r, z: o.z + Math.sin(a) * r * 0.7, s: 0.9 + rnd() * 0.7, water: true });
    }
  }
  let total = 0;
  for (const [kind, sets] of Object.entries(lists)) {
    const geo = KINDS[kind].geo();
    const mat = treeMaterial(kind, U, atlas);
    for (const [band, list] of Object.entries(sets)) {
      if (!list.length) continue;
      const g = geo.clone();
      const im = new THREE.InstancedMesh(g, mat, list.length);
      const vars = new Float32Array(list.length * 3);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
      list.forEach((t, i) => {
        const y = t.water ? terrain.lakeLevel + 0.1 : terrain.heightAt(t.x, t.z) - 0.25;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
        const squash = 0.85 + rnd() * 0.3;
        sc.set(t.s, t.s * squash, t.s);
        m.compose(p.set(t.x, y, t.z), q, sc);
        im.setMatrixAt(i, m);
        const info = terrain.infoAt(t.x, t.z);
        vars[i * 3] = rnd(); vars[i * 3 + 1] = 0.8 + rnd() * 0.4; vars[i * 3 + 2] = sstep(160, 10, info.dist);
      });
      g.setAttribute('aVar', new THREE.InstancedBufferAttribute(vars, 3));
      im.castShadow = band === 'near' && kind !== 'papyrus';
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.name = `trees-${kind}-${band}`;
      group.add(im);
      total += list.length;
    }
  }
  group.userData.count = total;
  return group;
}
