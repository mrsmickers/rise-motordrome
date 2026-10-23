import * as THREE from 'three/webgpu';
import {
  Fn, positionLocal, positionWorld, normalLocal, vec2, vec3, vec4, float, mix, smoothstep, step, abs, fract, floor, max, min,
  mx_noise_float, mx_cell_noise_float, uniform, sin, cos, atan, clamp, time, select, instanceIndex, hash, uv, length, attribute
} from 'three/tsl';
import { lakeSdf } from './terrain.js';
import { LAKE_LEVEL } from './track.js';

const tmpF = {};

// Matrix for an object at track coordinates: local +z along the track, +x to the left, +y up
function trackMatrix(track, s, d, y, extraYaw = 0) {
  const f = track.frame(s, tmpF);
  const x = f.x + f.lx * d, z = f.z + f.lz * d;
  const yaw = Math.atan2(f.tx, f.tz) + extraYaw;
  const m = new THREE.Matrix4().makeRotationY(yaw);
  m.setPosition(x, y, z);
  return m;
}

function std(opts = {}) {
  const m = new THREE.MeshStandardNodeMaterial(opts);
  return m;
}

export function buildScenery(track, terrain, U, tvSpots = []) {
  const group = new THREE.Group();
  group.name = 'scenery';
  const ctx = { track, terrain, U, group, tvSpots };
  buildGrandstands(ctx);
  buildPitBuilding(ctx);
  buildPaddock(ctx);
  ctx.startLights = buildStartGantry(ctx);
  buildBridge(ctx);
  ctx.poles = buildFloodlights(ctx);
  buildBoards(ctx);
  buildLakeside(ctx);
  buildMarshalPosts(ctx);
  buildAirport(ctx);
  buildVillages(ctx);
  return { group, startLights: ctx.startLights };
}

// ---------- grandstands ----------
function buildGrandstands({ track, U, group }) {
  const rows = 30, tread = 0.82, rise = 0.52, base = 2.4;
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(0, base);
  for (let r = 0; r < rows; r++) {
    shape.lineTo(r * tread, base + r * rise);
    shape.lineTo((r + 1) * tread, base + r * rise);
  }
  const depth = rows * tread;
  shape.lineTo(depth + 1.2, base + rows * rise);
  shape.lineTo(depth + 1.2, -6);
  shape.lineTo(0, -6);
  shape.lineTo(0, 0);
  const standLen = 112;
  const geo = new THREE.ExtrudeGeometry(shape, { depth: standLen, bevelEnabled: false, steps: 1 });
  geo.translate(0, 0, -standLen / 2);
  // spectators: people painted on the risers (what you see from the track), shirts on the treads
  const mat = std();
  const pl = positionLocal, nl = normalLocal;
  const seatW = 0.55;
  const seat = floor(pl.z.div(seatW)), row = floor(pl.y.sub(base).div(rise).add(0.001));
  const h = mx_cell_noise_float(vec3(seat, row, 1.0));
  const h2 = mx_cell_noise_float(vec3(seat, row, 7.0));
  const h3 = mx_cell_noise_float(vec3(seat, row, 13.0));
  const shirt = mix(mix(vec3(0.82, 0.8, 0.74), vec3(0.0, 0.4, 0.72), step(0.45, h)), mix(vec3(0.92, 0.75, 0.04), vec3(0.1, 0.42, 0.2), step(0.5, h2)), step(0.7, h));
  const shirt2 = mix(shirt, vec3(0.7, 0.12, 0.08), step(0.9, h3));
  const skin = mix(vec3(0.2, 0.12, 0.07), vec3(0.42, 0.28, 0.18), h3);
  const seatCol = vec3(0.46, 0.2, 0.11);
  const filled = step(0.12, h2);
  const u = fract(pl.z.div(seatW)), ry = fract(pl.y.sub(base).div(rise));
  const headM = smoothstep(0.3, 0.22, length(vec2(u.sub(0.5).mul(1.7), ry.sub(0.8).mul(2.4))));
  const torso = step(abs(u.sub(0.5)), 0.4).mul(step(ry, 0.6));
  const person = mix(mix(seatCol, shirt2.mul(0.8), torso), skin, headM);
  const riser = step(0.7, abs(nl.x)).mul(step(base + 0.02, pl.y));
  const tread_ = step(0.7, nl.y).mul(step(base - 0.1, pl.y));
  const concrete = vec3(0.64, 0.62, 0.58);
  const onTread = mix(seatCol.mul(0.8), shirt2.mul(0.7), filled.mul(step(0.35, fract(pl.x.div(tread)))));
  const col = mix(mix(concrete, onTread, tread_), mix(seatCol, person, filled), riser);
  mat.colorNode = col;
  mat.roughnessNode = float(0.9);
  mat.emissiveNode = col.mul(U.night).mul(0.45);
  const roofMat = std({ side: THREE.DoubleSide });
  const ru = uv();
  const pillow = abs(sin(ru.x.mul(Math.PI * 9))).mul(abs(sin(ru.y.mul(Math.PI * 3)))).pow(0.5);
  roofMat.colorNode = vec3(0.92, 0.92, 0.9).mul(float(0.9).add(pillow.mul(0.1)));
  roofMat.roughnessNode = float(0.65);
  roofMat.emissiveNode = vec3(0.95, 0.93, 0.85).mul(U.night).mul(0.55);
  const colMat = std({ color: 0xd8d8d4, roughness: 0.6, metalness: 0.3 });
  const centres = [-185, -62, 62, 186];
  for (const c of centres) {
    const s = track.wrap(track.startLine + c);
    const f = track.frame(s, tmpF);
    const e = f.half;
    const y0 = track.heightAt(s, -(e + 13), f) - 0.2;
    const m = trackMatrix(track, s, -(e + 13), y0, Math.PI);
    // local +x now points away from the track (the stand faces the circuit)
    const stand = new THREE.Mesh(geo, mat);
    stand.matrixAutoUpdate = false;
    stand.matrix.copy(m);
    stand.castShadow = stand.receiveShadow = true;
    group.add(stand);
    // membrane roof: rounded plan with soft pillows
    const roof = puffyRoof(standLen + 6, depth + 9, 6);
    roof.translate(depth / 2 - 1, base + rows * rise + 6.5, 0);
    const rm = new THREE.Mesh(roof, roofMat);
    rm.matrixAutoUpdate = false;
    rm.matrix.copy(m);
    rm.castShadow = true; rm.receiveShadow = true;
    group.add(rm);
    for (const z of [-standLen * 0.36, 0, standLen * 0.36]) {
      const colGeo = new THREE.CylinderGeometry(0.35, 0.5, base + rows * rise + 13, 8);
      const cm = new THREE.Mesh(colGeo, colMat);
      cm.matrixAutoUpdate = false;
      const local = new THREE.Matrix4().makeTranslation(depth + 0.6, (base + rows * rise + 13) / 2 - 6, z);
      cm.matrix.multiplyMatrices(m, local);
      group.add(cm);
    }
  }
}

function puffyRoof(len, wid, lobes) {
  const nu = 80, nv = 24;
  const geo = new THREE.PlaneGeometry(1, 1, nu, nv);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) + 0.5, v = pos.getY(i) + 0.5;
    // rounded ends, scalloped long edges
    const ends = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * u - 1), 6)), 0.5);
    const scallop = 1 - 0.13 * Math.pow(Math.abs(Math.sin(u * Math.PI * lobes)), 0.6);
    const across = (v - 0.5) * wid * ends * scallop;
    const along = (u - 0.5) * len;
    const dome = (1 - Math.pow(2 * v - 1, 2)) * (1 - Math.pow(2 * u - 1, 8)) * 3.2;
    const pillow = Math.pow(Math.abs(Math.sin(u * Math.PI * lobes * 1.5)) * Math.abs(Math.sin(v * Math.PI * 2)), 0.6) * 1.1;
    pos.setXYZ(i, across, dome + pillow - (1 - ends) * 1.5, along);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------- pit building ----------
function buildPitBuilding({ track, U, group }) {
  const len = 360, depth = 20, height = 15;
  const sMid = track.wrap(track.startLine + 10);
  const f = track.frame(sMid, tmpF);
  const e = f.half;
  const y0 = f.y + e * f.bank - 0.1;
  const m = trackMatrix(track, sMid, e + 17 + depth / 2, y0);
  const geo = new THREE.BoxGeometry(depth, height, len);
  geo.translate(0, height / 2, 0);
  const mat = std();
  const pl = positionLocal, nl = normalLocal;
  const facade = Fn(() => {
    const front = step(0.5, abs(nl.x));
    const z = pl.z, y = pl.y;
    // garages on the ground floor, glazing above
    const bay = fract(z.div(14.0));
    const door = step(0.12, bay).mul(step(bay, 0.88)).mul(step(y, 5.2));
    const glassBand = step(6.4, y).mul(step(y, 13.2)).mul(float(1).sub(step(9.5, y).mul(step(y, 10.1))));
    const mull = step(0.94, fract(z.div(2.4)));
    const white = vec3(0.86, 0.86, 0.84);
    const glass = vec3(0.04, 0.07, 0.1).add(vec3(0.05, 0.06, 0.07).mul(smoothstep(6.0, 13.0, y)));
    const garage = vec3(0.16, 0.17, 0.19);
    let c = mix(white, glass, glassBand.mul(float(1).sub(mull)));
    c = mix(c, garage, door);
    return mix(white.mul(0.92), c, front);
  });
  const col = facade();
  mat.colorNode = col;
  mat.roughnessNode = float(0.4);
  mat.metalnessNode = float(0.15);
  // garage and window glow
  const isFront = step(0.5, abs(normalLocal.x));
  const bay = fract(positionLocal.z.div(14.0));
  const door = step(0.12, bay).mul(step(bay, 0.88)).mul(step(positionLocal.y, 5.2)).mul(isFront);
  const win = step(6.4, positionLocal.y).mul(step(positionLocal.y, 13.2)).mul(isFront);
  mat.emissiveNode = vec3(1.0, 0.96, 0.88).mul(door.mul(float(0.35).add(U.night.mul(1.6))).add(win.mul(U.night).mul(0.8)));
  const b = new THREE.Mesh(geo, mat);
  b.matrixAutoUpdate = false; b.matrix.copy(m);
  b.castShadow = b.receiveShadow = true;
  group.add(b);
  // roof terrace overhang towards the track
  const slab = new THREE.Mesh(new THREE.BoxGeometry(depth + 9, 0.8, len + 6), std({ color: 0xeeeeea, roughness: 0.5 }));
  slab.matrixAutoUpdate = false;
  slab.matrix.multiplyMatrices(m, new THREE.Matrix4().makeTranslation(-3.5, height + 0.4, 0));
  slab.castShadow = true;
  group.add(slab);
}

// ---------- paddock: cone tower and round pavilions ----------
function buildPaddock({ track, terrain, U, group }) {
  const s = track.wrap(track.startLine + 70);
  const f = track.frame(s, tmpF);
  const d = f.half + 100;
  const x = f.x + f.lx * d, z = f.z + f.lz * d;
  const y = terrain.heightAt(x, z) - 0.5;
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const r = 11 * Math.pow(1 - t, 1.35) + 1.3;
    pts.push(new THREE.Vector2(r, t * 64));
  }
  pts.push(new THREE.Vector2(0.01, 64.6));
  const cone = new THREE.LatheGeometry(pts, 64);
  const mat = std();
  const pl = positionLocal;
  const ang = atan(pl.z, pl.x);
  const helix = fract(ang.div(Math.PI * 2).mul(6.0).add(pl.y.div(9.0)));
  const rib = smoothstep(0.0, 0.06, helix).mul(smoothstep(0.24, 0.18, helix));
  mat.colorNode = mix(vec3(0.93, 0.93, 0.9), vec3(0.78, 0.8, 0.82), rib);
  mat.roughnessNode = float(0.35);
  mat.metalnessNode = float(0.1);
  mat.emissiveNode = mix(vec3(0.0), vec3(1.0, 0.85, 0.5).mul(rib.mul(2.2).add(0.15)), U.night);
  const tower = new THREE.Mesh(cone, mat);
  tower.position.set(x, y, z);
  tower.castShadow = tower.receiveShadow = true;
  group.add(tower);

  // round pavilions: white tensile domes and thatched huts on the terraces
  const domeGeo = new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const drumGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
  const thatchGeo = new THREE.ConeGeometry(1, 1, 24, 1, true);
  const domeMat = std({ color: 0xf4f2ec, roughness: 0.7, side: THREE.DoubleSide });
  domeMat.emissiveNode = vec3(1.0, 0.92, 0.75).mul(U.night).mul(0.35);
  const wallMat = std({ color: 0xc9b38f, roughness: 0.9 });
  const thatchMat = std({ roughness: 1 });
  const tp = positionLocal;
  thatchMat.colorNode = vec3(0.42, 0.3, 0.15).mul(float(0.8).add(mx_noise_float(vec3(atan(tp.z, tp.x).mul(30.0), tp.y.mul(40.0), 0.0)).mul(0.2)));
  const domes = [], huts = [];
  const rand = mulberry(42);
  for (let k = 0; k < 46; k++) {
    const ss = track.wrap(track.startLine - 200 + rand() * 470);
    const fr = track.frame(ss, tmpF);
    const dd = fr.half + 52 + rand() * 135;
    const px = fr.x + fr.lx * dd, pz = fr.z + fr.lz * dd;
    if (Math.hypot(px - x, pz - z) < 22) continue;
    let ok = true;
    for (const o of [...domes, ...huts]) if (Math.hypot(o.x - px, o.z - pz) < o.r + 9) { ok = false; break; }
    if (!ok) continue;
    const py = terrain.heightAt(px, pz);
    if (rand() < 0.55) domes.push({ x: px, z: pz, y: py, r: 5 + rand() * 6 });
    else huts.push({ x: px, z: pz, y: py, r: 3 + rand() * 2.5 });
  }
  const mk = (geo, mat, list, fn) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const m4 = new THREE.Matrix4();
    list.forEach((o, i) => { fn(m4, o); im.setMatrixAt(i, m4); });
    im.castShadow = im.receiveShadow = true;
    group.add(im);
  };
  mk(domeGeo, domeMat, domes, (m4, o) => m4.compose(new THREE.Vector3(o.x, o.y - 0.3, o.z), new THREE.Quaternion(), new THREE.Vector3(o.r, o.r * 0.55, o.r)));
  mk(drumGeo, wallMat, huts, (m4, o) => m4.compose(new THREE.Vector3(o.x, o.y + 1.1, o.z), new THREE.Quaternion(), new THREE.Vector3(o.r, 2.6, o.r)));
  mk(thatchGeo, thatchMat, huts, (m4, o) => m4.compose(new THREE.Vector3(o.x, o.y + 2.4 + o.r * 0.55, o.z), new THREE.Quaternion(), new THREE.Vector3(o.r * 1.25, o.r * 1.1, o.r * 1.25)));
}

// ---------- start gantry and lights ----------
function buildStartGantry({ track, U, group }) {
  const s = track.startLine + 4;
  const f = track.frame(s, tmpF);
  const e = f.half;
  const y = f.y;
  const m = trackMatrix(track, s, 0, y);
  const steel = std({ color: 0x1c2026, roughness: 0.45, metalness: 0.6 });
  const g = new THREE.Group();
  g.matrixAutoUpdate = false; g.matrix.copy(m);
  const post = new THREE.BoxGeometry(0.6, 9, 0.6);
  for (const side of [1, -1]) {
    const p = new THREE.Mesh(post, steel);
    p.position.set(side * (e + 2.2), 4.5, 0);
    g.add(p);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(2 * e + 5, 1.6, 0.9), steel);
  beam.position.set(0, 8.2, 0);
  g.add(beam);
  // banner on the beam in Rwandan colours
  const banner = new THREE.Mesh(new THREE.BoxGeometry(2 * e + 5.2, 0.5, 0.92), std({ roughness: 0.6 }));
  banner.material.colorNode = mix(mix(vec3(0.0, 0.5, 0.78), vec3(0.95, 0.8, 0.0), step(0.33, uv().x)), vec3(0.1, 0.45, 0.24), step(0.66, uv().x));
  banner.position.set(0, 9.25, 0);
  g.add(banner);
  const lights = [];
  const green = uniform(0);
  lights.green = green;
  const podGeo = new THREE.BoxGeometry(0.9, 1.4, 0.5);
  const lampGeo = new THREE.CircleGeometry(0.17, 16);
  for (let i = 0; i < 5; i++) {
    const pod = new THREE.Mesh(podGeo, steel);
    const x = (i - 2) * 1.2;
    pod.position.set(x, 7.0, -0.2);
    g.add(pod);
    const u = uniform(0);
    const lampMat = new THREE.MeshBasicNodeMaterial();
    lampMat.colorNode = mix(vec3(0.08, 0.01, 0.01), vec3(30, 1.2, 0.8), u).add(vec3(0.6, 22, 4).mul(green));
    for (let r = 0; r < 2; r++) {
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(x, 7.3 - r * 0.55, -0.46);
      lamp.rotation.y = Math.PI;
      g.add(lamp);
    }
    lights.push(u);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  group.add(g);
  return lights;
}

// ---------- bridge over the track after the final hairpin ----------
function buildBridge({ track, terrain, group }) {
  const s = track.wrap(track.startLine - 135);
  const f = track.frame(s, tmpF);
  const e = f.half;
  const span = 2 * e + 70;
  const y = f.y + 7.5;
  const m = trackMatrix(track, s, 4, y, 0.18);
  const conc = std({ color: 0xcfcac0, roughness: 0.8 });
  const g = new THREE.Group();
  g.matrixAutoUpdate = false; g.matrix.copy(m);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 0.9, 7), conc);
  g.add(deck);
  const railMat = std({ color: 0x2b3036, roughness: 0.4, metalness: 0.7 });
  for (const zz of [3.4, -3.4]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(span, 1.1, 0.12), railMat);
    rail.position.set(0, 1.0, zz);
    g.add(rail);
  }
  for (const xx of [-(e + 14), e + 20]) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(2.2, 14, 4), conc);
    pier.position.set(xx, -7.4, 0);
    g.add(pier);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.add(g);
}

// ---------- floodlights ----------
function buildFloodlights({ track, terrain, U, group, tvSpots }) {
  const list = [];
  for (let s = 0; s < track.length; s += 34) {
    const f = track.frame(s, tmpF);
    const side = Math.floor(s / 34) % 2 ? 1 : -1;
    const wall = side > 0 ? track.wallL[f.i] : track.wallR[f.i];
    const d = side * (wall + 4.5);
    const x = f.x + f.lx * d, z = f.z + f.lz * d;
    if (tvSpots.some((t) => Math.hypot(t.x - x, t.z - z) < 40)) continue;
    list.push({ x, z, y: terrain.heightAt(x, z) - 0.3, yaw: Math.atan2(-f.lx * side, -f.lz * side) });
  }
  const poleGeo = new THREE.CylinderGeometry(0.16, 0.32, 24, 6);
  poleGeo.translate(0, 12, 0);
  const headGeo = new THREE.BoxGeometry(3.2, 1.2, 0.5);
  headGeo.translate(0, 24.4, 0.4);
  const poleMat = std({ color: 0x8a9096, roughness: 0.5, metalness: 0.7 });
  const headMat = std({ color: 0x30343a, roughness: 0.4, metalness: 0.5 });
  headMat.emissiveNode = vec3(14, 14, 13).mul(U.night).mul(step(0.0, normalLocal.z.negate()).mul(0.0).add(1.0));
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, list.length);
  const heads = new THREE.InstancedMesh(headGeo, headMat, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  list.forEach((o, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), o.yaw);
    m.compose(new THREE.Vector3(o.x, o.y, o.z), q, one);
    poles.setMatrixAt(i, m); heads.setMatrixAt(i, m);
  });
  poles.castShadow = true;
  group.add(poles, heads);
  return list;
}

// ---------- braking boards and corner numbers ----------
function numberTexture(text, bg = '#f4f4f0', fg = '#111') {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 128, 128);
  g.fillStyle = fg;
  g.font = '700 92px "Barlow Condensed", Arial Narrow, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function buildBoards({ track, terrain, U, group }) {
  const heavy = [1, 3, 4, 8, 12, 14, 17];
  const boardGeo = new THREE.BoxGeometry(1.6, 1.6, 0.12);
  boardGeo.translate(0, 1.6, 0);
  for (const n of [3, 2, 1]) {
    const mat = std({ map: numberTexture(String(n)), roughness: 0.6 });
    mat.emissiveNode = vec3(0.8).mul(U.night);
    const list = [];
    for (const c of track.corners) {
      if (!heavy.includes(c.n)) continue;
      const s = track.wrap(c.s - 70 - n * 100);
      const f = track.frame(s, tmpF);
      // boards stand on the outside of the approach
      const side = c.dir === 'L' ? -1 : 1;
      const d = side * (f.half + 3.5);
      list.push(trackMatrix(track, s, d, track.heightAt(s, d, f), Math.PI));
    }
    const im = new THREE.InstancedMesh(boardGeo, mat, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    group.add(im);
  }
  for (const c of track.corners) {
    const s = track.wrap(c.s - 25);
    const f = track.frame(s, tmpF);
    const side = c.dir === 'L' ? -1 : 1;
    const wall = side > 0 ? track.wallL[f.i] : track.wallR[f.i];
    const d = side * (wall + 1.5);
    const mat = std({ map: numberTexture(String(c.n), '#fad201', '#111'), roughness: 0.6 });
    mat.emissiveNode = vec3(0.6).mul(U.night);
    const b = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 0.15), mat);
    b.geometry.translate(0, 3.2, 0);
    b.matrixAutoUpdate = false;
    b.matrix.copy(trackMatrix(track, s, d, track.heightAt(s, d, f), Math.PI));
    group.add(b);
  }
}

// ---------- lakeside hospitality pods and jetties ----------
function buildLakeside({ track, terrain, U, group }) {
  const pods = [];
  // walk shore points between the esses and the lake
  const rand = mulberry(7);
  for (let a = -2.4; a < 1.6; a += 0.075) {
    // ray from the lakeside lobe centre outward to find the shore
    const cx = -560, cz = -40;
    let lastIn = null;
    for (let r = 60; r < 480; r += 4) {
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (lakeSdf(x, z) > 14) { lastIn = { x, z }; break; }
    }
    if (!lastIn) continue;
    const info = terrain.infoAt(lastIn.x, lastIn.z);
    if (info.dist < 25) continue;
    const y = terrain.heightAt(lastIn.x, lastIn.z);
    if (y > LAKE_LEVEL + 16) continue;
    if (pods.some((p) => Math.hypot(p.x - lastIn.x, p.z - lastIn.z) < 26)) continue;
    pods.push({ ...lastIn, y, a, r: 5 + rand() * 2.5 });
  }
  const drum = new THREE.CylinderGeometry(1, 1.05, 1, 28);
  const roofGeo = new THREE.ConeGeometry(1, 1, 28, 1);
  const deckGeo = new THREE.CylinderGeometry(1, 1, 1, 28);
  const wallMat = std({ color: 0xe8dcc4, roughness: 0.85 });
  wallMat.emissiveNode = vec3(1.0, 0.8, 0.5).mul(U.night).mul(0.5);
  const roofMat = std({ roughness: 1 });
  const rp = positionLocal;
  roofMat.colorNode = vec3(0.45, 0.32, 0.17).mul(float(0.78).add(mx_noise_float(vec3(atan(rp.z, rp.x).mul(40.0), rp.y.mul(60.0), 2.0)).mul(0.22)));
  const deckMat = std({ color: 0xb89a74, roughness: 0.8 });
  const plank = std({ color: 0x8a6a48, roughness: 0.85 });
  const n = pods.length;
  if (!n) return;
  const ims = [new THREE.InstancedMesh(drum, wallMat, n), new THREE.InstancedMesh(roofGeo, roofMat, n), new THREE.InstancedMesh(deckGeo, deckMat, n)];
  const jetty = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 0.3, 1), plank, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  pods.forEach((p, i) => {
    const base = Math.max(p.y, LAKE_LEVEL + 1.2);
    ims[2].setMatrixAt(i, m.compose(new THREE.Vector3(p.x, base - 1.5, p.z), q, new THREE.Vector3(p.r + 3, 3, p.r + 3)));
    ims[0].setMatrixAt(i, m.compose(new THREE.Vector3(p.x, base + 1.6, p.z), q, new THREE.Vector3(p.r, 3.2, p.r)));
    ims[1].setMatrixAt(i, m.compose(new THREE.Vector3(p.x, base + 3.2 + p.r * 0.45, p.z), q, new THREE.Vector3(p.r * 1.3, p.r * 0.9, p.r * 1.3)));
    // jetty pointing into the lake
    const dirx = -Math.cos(p.a), dirz = -Math.sin(p.a);
    const len = 34;
    const jq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dirx, dirz));
    jetty.setMatrixAt(i, m.compose(new THREE.Vector3(p.x + dirx * (p.r + len / 2), LAKE_LEVEL + 0.7, p.z + dirz * (p.r + len / 2)), jq, new THREE.Vector3(1, 1, len)));
  });
  for (const im of [...ims, jetty]) { im.castShadow = true; im.receiveShadow = true; group.add(im); }
}

// ---------- marshal posts ----------
function buildMarshalPosts({ track, terrain, U, group }) {
  const list = [];
  for (let s = 120; s < track.length; s += 330) {
    const f = track.frame(s, tmpF);
    const side = f.kL > 0 ? -1 : 1;
    const wall = side > 0 ? track.wallL[f.i] : track.wallR[f.i];
    const d = side * (wall + 2.2);
    list.push(trackMatrix(track, s, d, track.heightAt(s, d, f) - 0.2));
  }
  const geo = new THREE.BoxGeometry(2.2, 2.6, 2.2);
  geo.translate(0, 1.3, 0);
  const mat = std({ roughness: 0.7 });
  mat.colorNode = mix(vec3(0.95, 0.42, 0.05), vec3(0.92, 0.92, 0.9), step(1.6, positionLocal.y));
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  list.forEach((m, i) => im.setMatrixAt(i, m));
  im.castShadow = true;
  group.add(im);
}

// ---------- Bugesera International Airport, 3.5 km north ----------
function buildAirport({ terrain, group }) {
  const y = terrain.natural(-500, -4300) + 0.4;
  const runway = new THREE.Mesh(new THREE.PlaneGeometry(4200, 60), std({ roughness: 0.9 }));
  runway.material.colorNode = Fn(() => {
    const u = uv();
    const centre = step(abs(u.y.sub(0.5)), 0.006).mul(step(0.5, fract(u.x.mul(140.0))));
    const edge = step(0.47, abs(u.y.sub(0.5)));
    return mix(vec3(0.16, 0.16, 0.17), vec3(0.9), max(centre, edge));
  })();
  runway.rotation.x = -Math.PI / 2;
  runway.rotation.z = 0.12;
  runway.position.set(-500, y, -4300);
  group.add(runway);
  const terminal = new THREE.Mesh(new THREE.BoxGeometry(520, 22, 90), std({ color: 0xd9d6cf, roughness: 0.5, metalness: 0.2 }));
  terminal.position.set(-400, y + 11, -4100);
  terminal.rotation.y = 0.12;
  group.add(terminal);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(70, 70, 540, 24, 1, false, 0, Math.PI), std({ color: 0xe8e4da, roughness: 0.4, metalness: 0.3 }));
  roof.rotation.z = Math.PI / 2;
  roof.rotation.y = 0.12;
  roof.scale.set(1, 1, 0.45);
  roof.position.set(-400, y + 22, -4100);
  group.add(roof);
}

// ---------- villages: clusters of small houses with tin or tile roofs in the farmland ----------
function buildVillages({ track, terrain, U, group }) {
  const rand = mulberry(314);
  const houses = [];
  for (let c = 0; c < 70; c++) {
    const a = rand() * Math.PI * 2, r = 650 + rand() * 1050;
    const cx = Math.cos(a) * r + 150, cz = Math.sin(a) * r;
    const info = terrain.infoAt(cx, cz);
    if (info.dist < 260 || info.lake < 80) continue;
    if (Math.abs(cz + 4300) < 400) continue;
    const n = 4 + Math.floor(rand() * 18);
    const axis = rand() * Math.PI;
    for (let k = 0; k < n; k++) {
      const along = (rand() - 0.5) * 160, across = (rand() - 0.5) * 50;
      const x = cx + Math.cos(axis) * along - Math.sin(axis) * across, z = cz + Math.sin(axis) * along + Math.cos(axis) * across;
      const i2 = terrain.infoAt(x, z);
      if (i2.dist < 220 || i2.lake < 60) continue;
      if (houses.some((h) => Math.hypot(h.x - x, h.z - z) < 13)) continue;
      houses.push({ x, z, y: terrain.heightAt(x, z), yaw: axis + (rand() < 0.5 ? 0 : Math.PI / 2) + (rand() - 0.5) * 0.3, w: 5 + rand() * 4, l: 7 + rand() * 6, tint: rand(), roof: rand() });
    }
  }
  if (!houses.length) return;
  const wallGeo = new THREE.BoxGeometry(1, 1, 1); wallGeo.translate(0, 0.5, 0);
  const roofShape = new THREE.Shape(); roofShape.moveTo(-0.58, 0); roofShape.lineTo(0.58, 0); roofShape.lineTo(0, 0.42); roofShape.lineTo(-0.58, 0);
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 1.08, bevelEnabled: false }); roofGeo.translate(0, 0, -0.54);
  const wallMat = std({ roughness: 0.9 });
  const tint = attributeless(houses.map((h) => h.tint));
  wallMat.colorNode = mix(mix(vec3(0.78, 0.72, 0.62), vec3(0.55, 0.42, 0.3), step(0.55, tint)), vec3(0.62, 0.74, 0.8), step(0.85, tint));
  wallMat.emissiveNode = vec3(1.0, 0.78, 0.45).mul(U.night).mul(step(0.6, tint)).mul(0.12);
  const roofMat = std({ roughness: 0.45, metalness: 0.5 });
  const roofTint = attributeless(houses.map((h) => h.roof));
  roofMat.colorNode = mix(vec3(0.55, 0.56, 0.58), vec3(0.45, 0.16, 0.1), step(0.6, roofTint));
  const walls = new THREE.InstancedMesh(wallGeo, wallMat, houses.length);
  const roofs = new THREE.InstancedMesh(roofGeo, roofMat, houses.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  houses.forEach((h, i) => {
    q.setFromAxisAngle(up, h.yaw);
    walls.setMatrixAt(i, m.compose(new THREE.Vector3(h.x, h.y - 0.5, h.z), q, new THREE.Vector3(h.w, 3.3, h.l)));
    roofs.setMatrixAt(i, m.compose(new THREE.Vector3(h.x, h.y + 2.8, h.z), q, new THREE.Vector3(h.w, h.w * 0.9, h.l)));
  });
  walls.geometry = wallGeo.clone(); walls.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(houses.map((h) => h.tint)), 1));
  roofs.geometry = roofGeo.clone(); roofs.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(houses.map((h) => h.roof)), 1));
  walls.castShadow = roofs.castShadow = true;
  walls.receiveShadow = roofs.receiveShadow = true;
  walls.name = 'village-walls'; roofs.name = 'village-roofs';
  group.add(walls, roofs);
}

function attributeless() { return attribute('aTint', 'float'); }

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
