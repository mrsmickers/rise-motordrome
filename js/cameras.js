import * as THREE from 'three/webgpu';
import { clamp } from './noise.js';

export const CAMERAS = [
  { id: 'chase', label: 'Chase' },
  { id: 'tcam', label: 'T-cam' },
  { id: 'cockpit', label: 'Cockpit' },
  { id: 'nose', label: 'Nose' },
  { id: 'tv', label: 'TV' },
  { id: 'heli', label: 'Helicopter' }
];

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

// Broadcast positions: on raised platforms just behind the wall on the outside of each section
export function placeTvCameras(track, terrain) {
  const tr = track, list = [];
  const f = {};
  const pitA = tr.wrap(tr.startLine - 300), pitB = tr.wrap(tr.startLine + 440);
  const inPit = (s) => (pitA > pitB ? s >= pitA || s <= pitB : s >= pitA && s <= pitB);
  let k = 0;
  for (let s = 60; s < tr.length; s += 230, k++) {
    const fr = tr.frame(s, f);
    let side, d, lift;
    if (inPit(s)) {
      // in front of the grandstands on the main straight
      side = -1; d = -(fr.half + 11.5); lift = 4.5;
    } else {
      const look = tr.frame(s + 90, {});
      side = look.kL > 0 ? -1 : look.kL < 0 ? 1 : (k % 2 ? 1 : -1);
      const wall = side > 0 ? tr.wallL[fr.i] : tr.wallR[fr.i];
      d = side * (wall + 4.5);
      lift = 8 + (k % 3) * 2.5;
    }
    const x = fr.x + fr.lx * d, z = fr.z + fr.lz * d;
    const ground = Math.max(terrain.heightAt(x, z), tr.heightAt(s, d, fr));
    list.push({ s, x, z, pos: new THREE.Vector3(x, ground + lift, z) });
  }
  return list;
}

export class CameraRig {
  constructor(camera, dom, track, terrain) {
    this.camera = camera;
    this.track = track;
    this.terrain = terrain;
    this.index = 0;
    this.yaw = 0; this.pitch = 0; this.zoom = 1;
    this.lastInput = -10;
    this.smoothPos = new THREE.Vector3();
    this.smoothLook = new THREE.Vector3();
    this.first = true;
    this.shakeT = 0;
    this.tvIndex = -1;
    this.heliAngle = 0;
    this.cinematic = false;
    this._bindPointer(dom);
    this.tvCams = placeTvCameras(track, terrain);
  }

  get id() { return CAMERAS[this.index].id; }
  get label() { return this.cinematic ? 'Broadcast' : CAMERAS[this.index].label; }

  set(i) {
    this.index = ((i % CAMERAS.length) + CAMERAS.length) % CAMERAS.length;
    this.yaw = 0; this.pitch = 0;
    this.first = true;
    this.tvIndex = -1;
  }
  next(dir = 1) { this.set(this.index + dir); }

  _bindPointer(dom) {
    const pointers = new Map();
    let pinch = 0;
    dom.addEventListener('pointerdown', (e) => {
      if (e.target !== dom) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d0 = Math.hypot(a.x - b.x, a.y - b.y);
        p.x = e.clientX; p.y = e.clientY;
        const [c, d] = [...pointers.values()];
        const d1 = Math.hypot(c.x - d.x, c.y - d.y);
        if (pinch) this.zoom = clamp(this.zoom * (d0 / Math.max(1, d1)), 0.45, 2.6);
        pinch = 1;
        return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      this.yaw -= dx * 0.005;
      this.pitch = clamp(this.pitch - dy * 0.004, -0.5, 1.2);
      this.lastInput = performance.now() / 1000;
    });
    const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = 0; };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.001), 0.45, 2.6);
    }, { passive: false });
  }

  // Cameras sit at fixed spots on the forward lap; pick the next one in the direction of travel
  _pickTv(veh) {
    const tr = this.track;
    const vt = veh.track;
    const sF = vt.forwardS(veh.s), dir = vt.reversed ? -1 : 1;
    let best = 0, bestDs = Infinity;
    this.tvCams.forEach((c, i) => {
      const ds = dir > 0 ? tr.wrap(c.s - sF + 90) : tr.wrap(sF - c.s + 90);
      if (ds < bestDs) { bestDs = ds; best = i; }
    });
    return best;
  }

  _clampAboveGround(p, clearance = 0.6) {
    const g = this.terrain.heightAt(p.x, p.z) + clearance;
    if (p.y < g) p.y = g;
  }

  update(dt, pose, veh) {
    const cam = this.camera;
    const now = performance.now() / 1000;
    const speed = Math.abs(veh.v);
    // drifting look offsets settle back after a pause
    if (now - this.lastInput > 2.2 && this.id !== 'heli') {
      this.yaw *= Math.exp(-dt * 2.2);
      this.pitch *= Math.exp(-dt * 2.2);
    }
    this.shakeT += dt * (8 + speed * 0.35);
    const shakeAmp = (Math.min(1, speed / 90) * 0.004 + veh.kerb * 0.012 + (veh.surface === 'grass' ? 0.02 : 0) + veh.wallHit * 0.03);
    const shake = _v2.set(Math.sin(this.shakeT * 1.7) + Math.sin(this.shakeT * 3.1) * 0.5, Math.sin(this.shakeT * 2.3 + 1) + Math.sin(this.shakeT * 4.7) * 0.4, 0).multiplyScalar(shakeAmp);
    let fov = 60;
    const id = this.cinematic ? this._cinematicId(veh) : this.id;
    if (id === 'chase') {
      const dist = 7.2 * this.zoom, height = 2.0 * Math.sqrt(this.zoom);
      const fwd = _v.copy(pose.forwardFlat);
      const yaw = this.yaw, cs = Math.cos(yaw), sn = Math.sin(yaw);
      const back = new THREE.Vector3(-(fwd.x * cs - fwd.z * sn), 0, -(fwd.x * sn + fwd.z * cs));
      const desired = pose.pos.clone().addScaledVector(back, dist * Math.cos(this.pitch * 0.6)).add(new THREE.Vector3(0, height + Math.sin(Math.max(0, this.pitch)) * dist * 0.8, 0));
      this._clampAboveGround(desired, 0.5);
      if (this.first) { this.smoothPos.copy(desired); this.first = false; }
      const k = 1 - Math.exp(-dt * 9);
      this.smoothPos.lerp(desired, k);
      // keep the distance honest at speed
      const off = this.smoothPos.clone().sub(pose.pos);
      const len = off.length();
      if (len > dist * 1.6) this.smoothPos.copy(pose.pos).addScaledVector(off, (dist * 1.6) / len);
      const look = pose.pos.clone().addScaledVector(pose.forwardFlat, 4).add(new THREE.Vector3(0, 0.9, 0));
      cam.position.copy(this.smoothPos);
      cam.up.set(0, 1, 0);
      cam.lookAt(look);
      fov = 58 + Math.min(14, speed * 0.12);
    } else if (id === 'tcam' || id === 'cockpit' || id === 'nose') {
      const ud = pose.model.userData;
      const local = id === 'tcam' ? ud.tcam : id === 'nose' ? ud.nose : ud.eye;
      cam.position.copy(local).applyMatrix4(pose.matrix);
      // head leans with lateral load in the cockpit
      _q.copy(pose.quat).multiply(FLIP);
      const lookYaw = this.yaw + (id === 'cockpit' ? clamp(-veh.latAcc * 0.004, -0.12, 0.12) : 0);
      const pitch = (id === 'tcam' ? -0.07 : id === 'nose' ? -0.03 : -0.06) + this.pitch * 0.5;
      const lq = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, lookYaw, id === 'cockpit' ? clamp(veh.latAcc * 0.0012, -0.05, 0.05) : 0, 'YXZ'));
      _q.multiply(lq);
      cam.quaternion.copy(_q);
      cam.position.add(shake.applyQuaternion(_q));
      fov = id === 'cockpit' ? 76 : id === 'nose' ? 82 : 70;
      fov += Math.min(8, speed * 0.06);
      fov /= Math.sqrt(this.zoom);
    } else if (id === 'tv') {
      const idx = this._pickTv(veh);
      const c = this.tvCams[idx];
      if (idx !== this.tvIndex) { this.tvIndex = idx; this.smoothLook.copy(pose.pos); }
      cam.position.copy(c.pos);
      this.smoothLook.lerp(pose.pos, 1 - Math.exp(-dt * 7));
      cam.up.set(0, 1, 0);
      cam.lookAt(this.smoothLook.x, this.smoothLook.y + 0.6, this.smoothLook.z);
      const dist = cam.position.distanceTo(pose.pos);
      fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan((pose.model.userData.length * 2.3) / dist)), 3.5, 48) / this.zoom;
    } else if (id === 'heli') {
      this.heliAngle += dt * 0.07;
      const a = this.heliAngle + this.yaw;
      const r = 95 * this.zoom;
      const desired = pose.pos.clone().add(new THREE.Vector3(Math.cos(a) * r, 55 * this.zoom + 30 * this.pitch, Math.sin(a) * r));
      this._clampAboveGround(desired, 25);
      if (this.first) { this.smoothPos.copy(desired); this.smoothLook.copy(pose.pos); this.first = false; }
      this.smoothPos.lerp(desired, 1 - Math.exp(-dt * 1.6));
      cam.position.copy(this.smoothPos);
      cam.up.set(0, 1, 0);
      this.smoothLook.lerp(pose.pos, 1 - Math.exp(-dt * 5));
      cam.lookAt(this.smoothLook);
      fov = 30;
    }
    // tall screens: widen the vertical field so the sides of the view are not cropped away
    if (cam.aspect < 1) fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) / Math.pow(cam.aspect, 0.65)));
    fov = Math.min(fov, 100);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * (id === 'tv' ? 4 : 6));
      cam.updateProjectionMatrix();
    }
    this.activeId = id;
  }

  // Attract mode: cut between TV, helicopter and onboard shots
  _cinematicId(veh) {
    const t = performance.now() / 1000;
    const slot = Math.floor(t / 9) % 6;
    const id = ['tv', 'heli', 'tv', 'tcam', 'tv', 'chase'][slot];
    if (id !== this._lastCine) { this._lastCine = id; this.first = true; this.tvIndex = -1; }
    return id;
  }
}
