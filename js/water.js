import * as THREE from 'three/webgpu';
import {
  Fn, reflector, positionWorld, cameraPosition, normalize, vec2, vec3, vec4, float, mix, pow, max, dot, reflect,
  mx_noise_float, time, smoothstep, clamp, uniform
} from 'three/tsl';
import { LAKE_BLOBS, lakeIslands } from './terrain.js';
import { LAKE_LEVEL } from './track.js';

// Lake Kidogo: planar reflection, wind ripples and a sun glint
export function buildLake(U) {
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const [x, z, r] of LAKE_BLOBS) {
    minX = Math.min(minX, x - r - 120); maxX = Math.max(maxX, x + r + 120);
    minZ = Math.min(minZ, z - r - 120); maxZ = Math.max(maxZ, z + r + 120);
  }
  const geo = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const refl = reflector({ resolutionScale: 0.45, generateMipmaps: false, bounces: false });
  refl.target.rotateX(-Math.PI / 2);
  refl.target.position.y = LAKE_LEVEL;

  const mat = new THREE.MeshBasicNodeMaterial();
  const p = positionWorld.xz;
  const t = time.mul(0.35);
  const n1 = mx_noise_float(vec3(p.mul(0.045).add(vec2(t, t.mul(0.6))), 0.0));
  const n2 = mx_noise_float(vec3(p.mul(0.13).sub(vec2(t.mul(1.3), t)), 3.0));
  const n3 = mx_noise_float(vec3(p.mul(0.6).add(vec2(t.mul(2.0), 0.0)), 6.0));
  const nx = n1.mul(0.5).add(n2.mul(0.35)).add(n3.mul(0.15));
  const nz = mx_noise_float(vec3(p.mul(0.05).add(vec2(0.0, t)), 9.0)).mul(0.6).add(n3.mul(0.4));
  const normal = normalize(vec3(nx.mul(0.16), float(1.0), nz.mul(0.16)));
  refl.uvNode = refl.uvNode.add(vec2(nx, nz).mul(0.018));
  mat.colorNode = Fn(() => {
    const view = normalize(cameraPosition.sub(positionWorld));
    const cosT = max(dot(view, normal), 0.0);
    const fres = float(0.02).add(float(0.98).mul(pow(float(1).sub(cosT), 5.0)));
    const deep = mix(vec3(0.018, 0.05, 0.045), vec3(0.004, 0.008, 0.012), U.night);
    const lit = deep.mul(mix(vec3(U.sunColor).mul(0.9), vec3(0.4), U.night));
    const r = refl.rgb;
    const spec = pow(max(dot(reflect(view.negate(), normal), U.sunDir), 0.0), 600.0).mul(float(1).sub(U.night)).mul(40.0);
    const col = mix(lit, r, clamp(fres.mul(1.15).add(0.12), 0.0, 1.0)).add(vec3(U.sunColor).mul(spec));
    return vec4(col, 1.0);
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set((minX + maxX) / 2, LAKE_LEVEL, (minZ + maxZ) / 2);
  mesh.name = 'lake';
  const group = new THREE.Group();
  group.add(mesh, refl.target);
  // papyrus islands: low ragged mats of green just above the water
  const shape = new THREE.Shape();
  for (let i = 0; i <= 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const r = 1 + 0.22 * Math.sin(a * 3 + 1.3) + 0.12 * Math.sin(a * 7 + 0.4);
    shape[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
  }
  const islandGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.06, bevelSegments: 2 });
  islandGeo.rotateX(-Math.PI / 2);
  const islandMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  islandMat.colorNode = vec3(0.07, 0.17, 0.05).mul(mx_noise_float(positionWorld.mul(0.4)).mul(0.25).add(0.9)).mul(mix(float(1), float(0.08), U.night));
  const list = lakeIslands();
  const im = new THREE.InstancedMesh(islandGeo, islandMat, list.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  list.forEach((o, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), o.rot);
    im.setMatrixAt(i, m4.compose(new THREE.Vector3(o.x, LAKE_LEVEL - 0.35, o.z), q, new THREE.Vector3(o.r, 1, o.r * 0.7)));
  });
  im.receiveShadow = true;
  im.name = 'lake-islands';
  group.add(im);
  return group;
}
