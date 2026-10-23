import * as THREE from 'three/webgpu';
import {
  Fn, attribute, positionWorld, vec2, vec3, vec4, float, mix, smoothstep, abs, fract, floor, max, min, step, fwidth,
  mx_noise_float, mod, select, uniform, sin, clamp, positionLocal, uv, bumpMap
} from 'three/tsl';

const RING = 2; // metres between cross-sections

// Collect strips into one indexed geometry
class StripBuilder {
  constructor(attrs = { aTrack: 4 }) {
    this.pos = []; this.attr = {}; this.index = [];
    this.attrSizes = attrs;
    for (const k in attrs) this.attr[k] = [];
    this.count = 0;
  }
  vert(x, y, z, a) {
    this.pos.push(x, y, z);
    for (const k in this.attrSizes) { const v = a[k]; for (let i = 0; i < this.attrSizes[k]; i++) this.attr[k].push(v[i]); }
    return this.count++;
  }
  quad(a, b, c, d) { this.index.push(a, c, b, b, c, d); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    for (const k in this.attrSizes) g.setAttribute(k, new THREE.Float32BufferAttribute(this.attr[k], this.attrSizes[k]));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.index, 1) : new THREE.Uint16BufferAttribute(this.index, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

export function buildTrackMeshes(track, U) {
  const group = new THREE.Group();
  group.name = 'track';
  const L = track.length, nR = Math.round(L / RING);
  const f = {};
  const road = new StripBuilder(), kerb = new StripBuilder(), runoff = new StripBuilder(), grass = new StripBuilder();
  const wall = new StripBuilder({ aTrack: 4 }), fence = new StripBuilder({ aTrack: 4 });
  const roadCols = [-1, -0.5, 0, 0.5, 1];
  const put = (B, s, d, yOff, extra) => {
    const fr = track.frame(s, f);
    const x = fr.x + fr.lx * d, z = fr.z + fr.lz * d;
    const y = track.heightAt(s, d, fr) + yOff;
    return B.vert(x, y, z, extra);
  };
  // ring loops close the circuit by reusing the first ring's indices
  const rings = { road: [], kerbL: [], kerbR: [], runL: [], runR: [], grassL: [], grassR: [], wallL: [], wallR: [], fenceL: [], fenceR: [] };
  for (let r = 0; r < nR; r++) {
    const s = r * RING;
    const fr = track.frame(s, f);
    const i = fr.i;
    const e = fr.half;
    const dLine = track.lineOffset(s);
    const kL = track.kerbL[i], kR = track.kerbR[i];
    const rL = track.runL[i], rR = track.runR[i];
    const wL = track.wallL[i], wR = track.wallR[i];
    // road
    rings.road.push(roadCols.map((c) => put(road, s, c * e, 0.0, { aTrack: [s, c * e, e, dLine] })));
    // kerbs (raised profile) on each side
    const kerbRing = (side, w) => {
      const ds = [0, 0.35, 0.8, 1.0].map((t) => e + t * w);
      const lift = [0.0, 0.045, 0.05, 0.015];
      return ds.map((dd, k) => put(kerb, s, side * dd, lift[k] * Math.min(1, w / 1.2) + 0.004, { aTrack: [s, side * dd, e, w] }));
    };
    rings.kerbL.push(kerbRing(1, kL));
    rings.kerbR.push(kerbRing(-1, kR));
    // paved run-off
    const runRing = (side, k, w) => [0, 0.25, 0.5, 1].map((t) => {
      const dd = e + k + t * w;
      return put(runoff, s, side * dd, 0.0, { aTrack: [s, side * dd, e + k, w] });
    });
    rings.runL.push(runRing(1, kL, rL));
    rings.runR.push(runRing(-1, kR, rR));
    // grass verge to the wall
    const grassRing = (side, from, to) => [0, 0.5, 1].map((t) => {
      const dd = from + t * (to - from);
      return put(grass, s, side * dd, -0.01, { aTrack: [s, side * dd, e, to] });
    });
    rings.grassL.push(grassRing(1, e + kL + rL, wL));
    rings.grassR.push(grassRing(-1, e + kR + rR, wR));
    // walls: tyre barriers where the corner is tight
    const tight = Math.abs(fr.kL) > 1 / 70 ? 1 : 0;
    const wallRing = (side, d0) => {
      const h0 = track.heightAt(s, side * d0, fr) - 0.4;
      const fx = fr.x + fr.lx * side * d0, fz = fr.z + fr.lz * side * d0;
      const bx = fr.x + fr.lx * side * (d0 + 0.45), bz = fr.z + fr.lz * side * (d0 + 0.45);
      const top = h0 + 0.4 + 1.05;
      const outer = (side > 0 ? fr.kL < 0 : fr.kL > 0) ? tight : 0;
      const a = { aTrack: [s, 0, outer, 0] }, b = { aTrack: [s, 1, outer, 0] }, c = { aTrack: [s, 2, outer, 0] }, d = { aTrack: [s, 3, outer, 0] };
      return [wall.vert(fx, h0, fz, a), wall.vert(fx, top, fz, b), wall.vert(bx, top, bz, c), wall.vert(bx, h0, bz, d)];
    };
    rings.wallL.push(wallRing(1, wL));
    rings.wallR.push(wallRing(-1, wR));
    const fenceRing = (side, d0) => {
      const h0 = track.heightAt(s, side * (d0 + 0.2), fr) + 1.05;
      const x = fr.x + fr.lx * side * (d0 + 0.22), z = fr.z + fr.lz * side * (d0 + 0.22);
      return [fence.vert(x, h0, z, { aTrack: [s, 0, 0, 0] }), fence.vert(x, h0 + 3.0, z, { aTrack: [s, 3.0, 0, 0] })];
    };
    rings.fenceL.push(fenceRing(1, wL));
    rings.fenceR.push(fenceRing(-1, wR));
  }
  // stitch rings: order every strip right-to-left so the faces point up
  const stitch = (B, list, reverse) => {
    for (let r = 0; r < nR; r++) {
      const A = list[r], C = list[(r + 1) % nR];
      for (let k = 0; k < A.length - 1; k++) {
        if (!reverse) B.quad(A[k], A[k + 1], C[k], C[k + 1]);
        else B.quad(A[k + 1], A[k], C[k + 1], C[k]);
      }
    }
  };
  stitch(road, rings.road, false);
  stitch(kerb, rings.kerbL, false); stitch(kerb, rings.kerbR, true);
  stitch(runoff, rings.runL, false); stitch(runoff, rings.runR, true);
  stitch(grass, rings.grassL, false); stitch(grass, rings.grassR, true);
  // walls: left wall faces right (towards the track), right wall faces left
  const stitchWall = (list, side) => {
    for (let r = 0; r < nR; r++) {
      const A = list[r], C = list[(r + 1) % nR];
      for (let k = 0; k < 3; k++) {
        if (side > 0) wall.quad(A[k], A[k + 1], C[k], C[k + 1]);
        else wall.quad(A[k + 1], A[k], C[k + 1], C[k]);
      }
    }
  };
  stitchWall(rings.wallL, 1); stitchWall(rings.wallR, -1);
  const stitchFence = (list) => {
    for (let r = 0; r < nR; r++) { const A = list[r], C = list[(r + 1) % nR]; fence.quad(A[0], A[1], C[0], C[1]); }
  };
  stitchFence(rings.fenceL); stitchFence(rings.fenceR);

  const meshes = {
    road: new THREE.Mesh(road.build(), roadMaterial(track, U)),
    kerb: new THREE.Mesh(kerb.build(), kerbMaterial(U)),
    runoff: new THREE.Mesh(runoff.build(), runoffMaterial(U)),
    grass: new THREE.Mesh(grass.build(), grassMaterial(U)),
    wall: new THREE.Mesh(wall.build(), wallMaterial(U)),
    fence: new THREE.Mesh(fence.build(), fenceMaterial(U))
  };
  for (const [k, m] of Object.entries(meshes)) {
    m.name = 'track-' + k;
    m.receiveShadow = true;
    m.castShadow = k === 'wall';
    group.add(m);
  }
  group.add(buildPitLane(track, U));
  return group;
}

// ---------- materials ----------

const asphaltBase = (p) => {
  const g1 = mx_noise_float(vec3(p.mul(3.1), 0.0));
  const g2 = mx_noise_float(vec3(p.mul(37.0), 1.0));
  const g3 = mx_noise_float(vec3(p.mul(0.09), 2.0));
  return float(0.9).add(g1.mul(0.06)).add(g2.mul(0.09)).add(g3.mul(0.07));
};

const aaLine = (dist, width) => {
  const w = fwidth(dist).mul(1.2).add(0.001);
  return float(1).sub(smoothstep(width.sub(w), width.add(w), abs(dist)));
};

function roadMaterial(track, U) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const at = attribute('aTrack', 'vec4');
  const s = at.x, d = at.y, half = at.z, dLine = at.w;
  const p = positionWorld.xz;
  const start = float(track.startLine);
  const paint = Fn(() => {
    // white edge lines
    const edge = aaLine(abs(d).sub(half.sub(0.32)), float(0.11));
    // start / finish line
    const sf = aaLine(s.sub(start), float(0.35));
    // grid slots behind the line, 8 m apart, pole on the left
    const rel = start.sub(8.0).sub(s);
    const k = floor(rel.add(0.4).div(8.0));
    const local = rel.sub(k.mul(8.0));
    const side = select(mod(k, 2.0).lessThan(0.5), float(1.0), float(-1.0));
    const lat = d.mul(side);
    const inGrid = step(-0.4, rel).mul(step(rel, 8.0 * 19 + 1.0));
    const across = aaLine(local.sub(0.1), float(0.11)).mul(step(1.0, lat)).mul(step(lat, 4.6));
    const sideA = aaLine(lat.sub(1.0), float(0.08)).mul(step(local, 1.4)).mul(step(-0.05, local));
    const sideB = aaLine(lat.sub(4.6), float(0.08)).mul(step(local, 1.4)).mul(step(-0.05, local));
    const grid = max(across, max(sideA, sideB)).mul(inGrid);
    return min(1.0, edge.add(sf).add(grid));
  });
  const markings = paint();
  const rubber = smoothstep(1.9, 0.3, abs(d.sub(dLine)));
  const noiseA = asphaltBase(p);
  const skid = mx_noise_float(vec3(s.mul(0.08), d.mul(0.9), 3.0)).mul(0.5).add(0.5);
  const base = vec3(0.078, 0.076, 0.074).mul(noiseA).mul(float(1).sub(rubber.mul(0.3).mul(skid.add(0.5))));
  const col = mix(base, vec3(0.86, 0.86, 0.84), markings);
  mat.colorNode = col;
  mat.roughnessNode = mix(mix(float(0.82), float(0.6), rubber.mul(0.7)), float(0.5), markings);
  mat.metalnessNode = float(0.0);
  mat.normalNode = bumpMap(mx_noise_float(vec3(p.mul(11.0), 0.5)).mul(0.6).add(mx_noise_float(vec3(p.mul(52.0), 1.5)).mul(0.4)), 0.25);
  mat.emissiveNode = col.mul(U.night).mul(U.flood).mul(1.1);
  return mat;
}

function kerbMaterial(U) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const at = attribute('aTrack', 'vec4');
  const s = at.x;
  const stripe = step(0.5, fract(s.div(2.0)));
  const red = vec3(0.62, 0.035, 0.03), white = vec3(0.82, 0.82, 0.8);
  const grime = mx_noise_float(vec3(positionWorld.xz.mul(2.0), 5.0)).mul(0.08).add(0.95);
  const col = mix(red, white, stripe).mul(grime);
  mat.colorNode = col;
  mat.roughnessNode = float(0.48);
  mat.emissiveNode = col.mul(U.night).mul(U.flood);
  return mat;
}

function runoffMaterial(U) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const at = attribute('aTrack', 'vec4');
  const d = at.y, from = at.z, width = at.w;
  const q = abs(d).sub(from);
  const p = positionWorld.xz;
  const beige = vec3(0.6, 0.55, 0.46).mul(asphaltBase(p));
  // painted bands next to the kerb, in Rwandan colours
  const band = floor(q.div(1.3));
  const yellow = vec3(0.78, 0.62, 0.02), terracotta = vec3(0.5, 0.1, 0.06), green = vec3(0.06, 0.32, 0.14), blue = vec3(0.0, 0.32, 0.6);
  const c0 = select(band.lessThan(0.5), yellow, select(band.lessThan(1.5), terracotta, select(band.lessThan(2.5), green, blue)));
  const showBands = step(q, 5.2).mul(step(5.5, width));
  const col = mix(beige, c0, showBands);
  mat.colorNode = col;
  mat.roughnessNode = float(0.8);
  mat.emissiveNode = col.mul(U.night).mul(U.flood);
  return mat;
}

function grassMaterial(U) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const at = attribute('aTrack', 'vec4');
  const s = at.x;
  const p = positionWorld.xz;
  const mow = step(0.5, fract(s.div(12.0)));
  const n1 = mx_noise_float(vec3(p.mul(0.11), 8.0));
  const n2 = mx_noise_float(vec3(p.mul(1.3), 9.0));
  const col = vec3(0.085, 0.175, 0.035).mul(float(0.9).add(mow.mul(0.16)).add(n1.mul(0.1)).add(n2.mul(0.08)));
  mat.colorNode = col;
  mat.roughnessNode = float(0.95);
  mat.normalNode = bumpMap(mx_noise_float(vec3(p.mul(2.4), 3.0)).mul(0.5).add(mx_noise_float(vec3(p.mul(14.0), 4.0)).mul(0.5)), 0.6);
  mat.emissiveNode = col.mul(U.night).mul(U.flood);
  return mat;
}

function wallMaterial(U) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const at = attribute('aTrack', 'vec4');
  const s = at.x, row = at.y, tyre = at.z;
  const h = positionWorld.y;
  // rows: 0 = foot, 1 = top front, 2 = top back, 3 = foot back
  const isTop = step(0.9, row).mul(step(row, 2.1));
  const concrete = vec3(0.58, 0.58, 0.56).mul(mx_noise_float(vec3(positionWorld.xz.mul(0.9), h.mul(2.0))).mul(0.06).add(0.94));
  const band = smoothstep(0.35, 0.25, row);
  const wallCol = mix(concrete, vec3(0.12, 0.13, 0.14), band);
  const block = step(0.5, fract(s.div(3.0)));
  const tecpro = mix(vec3(0.55, 0.04, 0.04), vec3(0.85, 0.85, 0.85), block);
  const col = mix(wallCol, tecpro, tyre.mul(float(1).sub(isTop.mul(0.3))));
  mat.colorNode = col;
  mat.roughnessNode = float(0.85);
  mat.emissiveNode = col.mul(U.night).mul(U.flood).mul(0.8);
  return mat;
}

function fenceMaterial(U) {
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, transparent: false });
  mat.alphaToCoverage = true;
  const at = attribute('aTrack', 'vec4');
  const s = at.x, h = at.y;
  // diamond wire plus posts every 4 m; far away the mesh averages out to a light veil
  const ga = s.add(h).mul(5.0), gb = s.sub(h).mul(5.0);
  const fw = fwidth(ga).add(0.0001);
  const lineA = float(1).sub(smoothstep(0.06, fw.mul(1.5).add(0.06), abs(fract(ga).sub(0.5)).mul(-1).add(0.5)));
  const lineB = float(1).sub(smoothstep(0.06, fw.mul(1.5).add(0.06), abs(fract(gb).sub(0.5)).mul(-1).add(0.5)));
  const wireSharp = max(lineA, lineB);
  const wire = mix(wireSharp, float(0.3), smoothstep(0.25, 0.8, fw));
  const post = step(fract(s.div(4.0)), 0.025);
  const cable = max(step(abs(h.sub(1.0)), 0.025), step(abs(h.sub(2.95)), 0.04));
  const alpha = max(max(wire, post), cable);
  mat.colorNode = vec3(0.28, 0.3, 0.31);
  mat.opacityNode = alpha;
  mat.alphaTest = 0.5;
  mat.roughnessNode = float(0.5);
  mat.metalnessNode = float(0.7);
  return mat;
}

// Pit lane on the left of the main straight with entry and exit ramps
function buildPitLane(track, U) {
  const B = new StripBuilder();
  const f = {};
  const a = track.pitStart - 140, b = track.pitEnd + 120;
  const len = track.wrap(b - a);
  const n = Math.round(len / 2);
  const rings = [];
  for (let k = 0; k <= n; k++) {
    const s = track.wrap(a + k * 2);
    const fr = track.frame(s, f);
    const e = fr.half;
    const tIn = Math.min(1, k * 2 / 140), tOut = Math.min(1, (len - k * 2) / 120);
    const t = Math.min(tIn, tOut);
    const ease = t * t * (3 - 2 * t);
    const inner = e + 0.2 + ease * 4.2, outer = inner + 12 * Math.max(0.35, ease);
    const y = fr.y + e * fr.bank - 0.02;
    const cols = [inner, (inner + outer) / 2, outer].map((dd) => {
      const x = fr.x + fr.lx * dd, z = fr.z + fr.lz * dd;
      return B.vert(x, y + (dd - e) * -0.004, z, { aTrack: [s, dd - inner, outer - inner, 0] });
    });
    rings.push(cols);
  }
  for (let k = 0; k < n; k++) {
    const A = rings[k], C = rings[k + 1];
    for (let j = 0; j < 2; j++) B.quad(A[j], A[j + 1], C[j], C[j + 1]);
  }
  const mat = new THREE.MeshStandardNodeMaterial();
  const at = attribute('aTrack', 'vec4');
  const q = at.y, w = at.z;
  const line = max(aaLine(q.sub(w.mul(0.42)), float(0.1)), aaLine(q.sub(0.15), float(0.08)));
  const col = mix(vec3(0.1, 0.1, 0.105).mul(asphaltBase(positionWorld.xz)), vec3(0.85, 0.85, 0.82), line);
  mat.colorNode = col;
  mat.roughnessNode = float(0.75);
  mat.emissiveNode = col.mul(U.night).mul(U.flood).mul(1.1);
  const mesh = new THREE.Mesh(B.build(), mat);
  mesh.receiveShadow = true;
  mesh.name = 'pit-lane';
  return mesh;
}
