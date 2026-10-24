import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, vec3, vec4, float, mix, smoothstep, step, max, min, select, mod } from 'three/tsl';

const SPACING = 5; // metres between chevrons

// Racing-line chevrons painted on the road. Colour follows the speed you carry:
// green, keep going; yellow, lift; red, brake now for what is ahead.
export function buildChevrons(track, profile, U) {
  const n = Math.floor(track.length / SPACING);
  // chevron outline pointing forward (+y in the shape, +z on the road)
  const sh = new THREE.Shape();
  // 2.2 m wide, arms 0.45 m deep: big enough to read from the cockpit at speed
  sh.moveTo(-1.1, -0.55); sh.lineTo(0, 0.35); sh.lineTo(1.1, -0.55); sh.lineTo(1.1, -0.1); sh.lineTo(0, 0.8); sh.lineTo(-1.1, -0.1); sh.lineTo(-1.1, -0.55);
  const geo = new THREE.ShapeGeometry(sh);
  geo.rotateX(Math.PI / 2);
  const attrS = new Float32Array(n), attrBrake = new Float32Array(n);
  const prof = profile.v, step5 = track.lineStep, pn = prof.length;
  const speedAt = (s) => {
    const u = track.wrap(s) / step5, i = Math.floor(u) % pn, j = (i + 1) % pn, t = u - Math.floor(u);
    return prof[i] + (prof[j] - prof[i]) * t;
  };
  const mesh = new THREE.InstancedMesh(geo, null, n);
  const m = new THREE.Matrix4(), T = new THREE.Vector3(), L = new THREE.Vector3(), N = new THREE.Vector3(), X = new THREE.Vector3(), P = new THREE.Vector3();
  const f = {};
  for (let k = 0; k < n; k++) {
    const s = k * SPACING;
    const fr = track.frame(s, f);
    const d = track.lineOffset(s);
    // heading of the line itself, so chevrons point along it through the bends
    const slope = (track.lineOffset(s + 2) - track.lineOffset(s - 2)) / 4;
    T.set(fr.tx + fr.lx * slope, fr.grade, fr.tz + fr.lz * slope).normalize();
    L.set(fr.lx, fr.bank, fr.lz).normalize();
    N.crossVectors(T, L).normalize();
    X.crossVectors(N, T).normalize();
    m.makeBasis(X, N, T);
    P.set(fr.x + fr.lx * d, track.heightAt(s, d, fr) + 0.045, fr.z + fr.lz * d);
    m.setPosition(P);
    mesh.setMatrixAt(k, m);
    attrS[k] = s;
    // a braking zone: the line slows by more than 6 m/s² over the next 10 m
    const v0 = speedAt(s), v1 = speedAt(s + 10);
    attrBrake[k] = (v0 * v0 - v1 * v1) / 20 > 6 ? 1 : 0;
  }
  geo.setAttribute('aS', new THREE.InstancedBufferAttribute(attrS, 1));
  geo.setAttribute('aBrake', new THREE.InstancedBufferAttribute(attrBrake, 1));

  const u = {
    carS: uniform(0), length: uniform(track.length),
    mode: uniform(1), // 1 = full line, 2 = braking zones only
    brakeFrom: uniform(1e6), brakeTo: uniform(1e6) // metres ahead of the car: where braking must start and the corner it is for
  };
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const s = attribute('aS', 'float'), brakeZone = attribute('aBrake', 'float');
  const ahead = mod(s.sub(u.carS).add(u.length), u.length);
  // signed distance to the car (negative behind)
  const rel = select(ahead.greaterThan(u.length.mul(0.5)), ahead.sub(u.length), ahead);
  const near = step(rel, 700.0);
  // near the car the colours come from your speed now; further on they show the usual braking zones
  const inBrake = step(u.brakeFrom, rel).mul(step(rel, u.brakeTo));
  const red = max(inBrake.mul(near), brakeZone.mul(float(1).sub(near)));
  const yellow = step(u.brakeFrom.sub(60.0), rel).mul(step(rel, u.brakeFrom)).mul(near);
  const green = vec3(0.04, 1.0, 0.18), amber = vec3(1.0, 0.72, 0.0), redC = vec3(1.0, 0.06, 0.04);
  const col = mix(mix(green, amber, yellow), redC, red);
  mat.colorNode = col.mul(mix(float(1.8), float(2.6), U.night)).mul(float(1).add(red.mul(0.8)));
  // show from 12 m behind to about 1 km ahead; braking-only mode hides everything but red
  const window_ = smoothstep(-12.0, -6.0, rel).mul(float(1).sub(smoothstep(700.0, 1100.0, rel)));
  const show = select(u.mode.equal(2), red, float(1));
  mat.opacityNode = float(0.92).mul(show).mul(window_);

  // Each frame: from the car's speed, find where braking must start for the corners in the next 700 m
  const update = (carS, carV, comfort) => {
    u.carS.value = carS;
    let from = 1e6, to = 1e6;
    const v2 = carV * carV;
    for (let x = 0; x <= 700; x += 5) {
      const vt = speedAt(carS + x);
      if (carV <= vt + 0.5) continue;
      const start = x - (v2 - vt * vt) / (2 * comfort);
      if (start < from) { from = start; to = x; }
    }
    // carry the red on to the slowest point of that corner
    if (from < 1e6) {
      let vmin = speedAt(carS + to);
      for (let x = to; x <= Math.min(700, to + 150); x += 5) { const vt = speedAt(carS + x); if (vt <= vmin) { vmin = vt; to = x; } }
    }
    u.brakeFrom.value = from;
    u.brakeTo.value = to;
  };
  mesh.material = mat;
  mesh.name = 'chevrons';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, u, update };
}
