import * as THREE from 'three/webgpu';
import {
  Fn, uniform, vec3, vec4, float, mix, normalize, positionWorld, cameraPosition, max, min, pow, exp, dot, smoothstep,
  fog, floor, fract, mx_cell_noise_float, time, sin, length, clamp, abs, step
} from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { LAKE_LEVEL } from './track.js';

const dirFrom = (azDeg, elDeg) => {
  const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
};

// Bugesera sits 2° south of the equator: the sun rises in the east and sets over the lake to the west.
export const PRESETS = {
  dawn: {
    label: 'Dawn · 06:30', sun: dirFrom(103, 6.5), sunColor: 0xffb46e, sunIntensity: 2.6,
    hemiSky: 0x9fb8d8, hemiGround: 0x5a4a32, hemi: 0.6, env: 0.5,
    fogColor: 0xd9c3ae, fog: 0.000075, haze: 0.0028, hazeFalloff: 9,
    turbidity: 6.5, rayleigh: 2.6, mie: 0.006, mieG: 0.86, clouds: 0.38, cloudDensity: 0.32, skyExposure: 0.3,
    night: 0, flood: 0, exposure: 1.0, bloom: 0.22, stars: 0
  },
  day: {
    label: 'Day · 10:30', sun: dirFrom(118, 52), sunColor: 0xfff1dc, sunIntensity: 5.4,
    hemiSky: 0xa9cdf2, hemiGround: 0x5d5232, hemi: 0.62, env: 0.5,
    fogColor: 0xbcd0e2, fog: 0.00006, haze: 0.00025, hazeFalloff: 14,
    turbidity: 4.2, rayleigh: 1.6, mie: 0.004, mieG: 0.82, clouds: 0.42, cloudDensity: 0.42, skyExposure: 0.13,
    night: 0, flood: 0, exposure: 1.0, bloom: 0.14, stars: 0
  },
  sunset: {
    label: 'Sunset · 17:45', sun: dirFrom(256, 6.0), sunColor: 0xff9a58, sunIntensity: 3.6,
    hemiSky: 0x93a3cc, hemiGround: 0x5e3f2a, hemi: 0.8, env: 0.62,
    fogColor: 0xd9a07c, fog: 0.00007, haze: 0.0006, hazeFalloff: 10,
    turbidity: 8.5, rayleigh: 3.0, mie: 0.009, mieG: 0.9, clouds: 0.4, cloudDensity: 0.38, skyExposure: 0.55,
    night: 0, flood: 0, exposure: 1.05, bloom: 0.26, stars: 0
  },
  night: {
    label: 'Night race · 21:00', sun: new THREE.Vector3(0.25, 0.92, 0.3).normalize(), sunColor: 0xe6eeff, sunIntensity: 2.3,
    hemiSky: 0x223352, hemiGround: 0x15140f, hemi: 0.28, env: 0.45,
    fogColor: 0x0b1220, fog: 0.00011, haze: 0.0008, hazeFalloff: 10,
    turbidity: 2, rayleigh: 0.6, mie: 0.003, mieG: 0.8, clouds: 0.18, cloudDensity: 0.25, skyExposure: 0.0,
    night: 1, flood: 0.34, exposure: 1.0, bloom: 0.34, stars: 1
  }
};
export const PRESET_ORDER = ['dawn', 'day', 'sunset', 'night'];

export class Atmosphere {
  constructor(scene, renderer, camera) {
    this.scene = scene; this.renderer = renderer; this.camera = camera;
    this.U = {
      night: uniform(0), flood: uniform(0), stars: uniform(0),
      sunDir: uniform(new THREE.Vector3(0, 1, 0)), sunColor: uniform(new THREE.Color(1, 1, 1)),
      fogColor: uniform(new THREE.Color(0.8, 0.85, 0.9)), fogDensity: uniform(0.0001),
      hazeDensity: uniform(0.0005), hazeFalloff: uniform(30), skyExposure: uniform(0.13),
      wind: uniform(1)
    };
    this.current = { ...PRESETS.day };
    this.target = PRESETS.day;
    this.blend = 1;
    this.id = 'day';

    // Sky dome
    this.sky = this._makeSky();
    scene.add(this.sky);

    // Sun / moon / floodlight key
    this.sun = new THREE.DirectionalLight(0xffffff, 4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 4000;
    scene.add(this.sun, this.sun.target);
    try {
      const csm = new CSMShadowNode(this.sun, { cascades: 3, maxFar: 1400, mode: 'practical', lightMargin: 400 });
      csm.fade = true;
      this.sun.shadow.shadowNode = csm;
      this.csm = csm;
    } catch (err) {
      console.warn('CSM unavailable, using a single shadow map', err);
      const c = this.sun.shadow.camera;
      c.left = -160; c.right = 160; c.top = 160; c.bottom = -160;
    }

    this.hemi = new THREE.HemisphereLight(0xa9cdf2, 0x6b5a3a, 1);
    scene.add(this.hemi);

    // Fog: distance haze plus a mist layer that hugs the lake and valleys
    const U = this.U;
    scene.fogNode = Fn(() => {
      const toFrag = positionWorld.sub(cameraPosition);
      const dist = length(toFrag);
      const base = float(1).sub(exp(dist.mul(U.fogDensity).negate()));
      const hh = max(positionWorld.y.sub(LAKE_LEVEL), 0.0);
      const mist = float(1).sub(exp(dist.mul(U.hazeDensity).mul(exp(hh.div(U.hazeFalloff).negate())).negate()));
      const f = float(1).sub(float(1).sub(base).mul(float(1).sub(mist)));
      const view = normalize(toFrag);
      const glow = pow(max(dot(view, U.sunDir), 0.0), 8.0).mul(float(1).sub(U.night)).mul(0.35);
      const col = mix(vec3(U.fogColor), vec3(U.sunColor), glow);
      return fog(col, clamp(f, 0.0, 0.985));
    })();

    // Environment map scene
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = this._makeSky(true);
    this.envScene.add(this.envSky);
    const ground = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide }));
    this.envGroundMat = ground.material;
    this.envGroundMat.colorNode = vec3(0.09, 0.1, 0.05).mul(mix(float(1), float(0.05), U.night));
    this.envScene.add(ground);
    // floodlight panels that show up in reflections at night
    this.envLights = new THREE.Group();
    const panelMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    panelMat.colorNode = vec3(9, 9.5, 10);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(4, 1.2), panelMat);
      m.position.set(Math.cos(a) * 30, 9 + (i % 3) * 3, Math.sin(a) * 30);
      m.lookAt(0, 0, 0);
      this.envLights.add(m);
    }
    this.envScene.add(this.envLights);
    this.envTarget = null;
    this._apply(PRESETS.day);
    this.updateEnvironment();
  }

  _makeSky(forEnv = false) {
    const sky = new SkyMesh();
    sky.scale.setScalar(forEnv ? 100 : 80000);
    sky.cloudScale.value = 0.00022;
    sky.cloudSpeed.value = 0.00002;
    sky.cloudElevation.value = 0.55;
    const U = this.U;
    const raw = sky.material.colorNode;
    sky.material.colorNode = Fn(() => {
      const dir = normalize(positionWorld.sub(cameraPosition));
      const day = raw.rgb.mul(U.skyExposure);
      // night sky: deep blue gradient, stars, a soft band of glow
      const up = max(dir.y, 0.0);
      const nightBase = mix(vec3(0.012, 0.02, 0.04), vec3(0.002, 0.004, 0.012), pow(up, 0.5));
      const grid = dir.mul(420.0);
      const cell = floor(grid);
      const h = mx_cell_noise_float(cell);
      const offs = vec3(mx_cell_noise_float(cell.add(17.0)), mx_cell_noise_float(cell.add(29.0)), mx_cell_noise_float(cell.add(41.0))).mul(0.6).add(0.2);
      const point = smoothstep(0.16, 0.0, length(fract(grid).sub(offs)));
      const star = step(0.9975, h).mul(point).mul(h.sub(0.9975).mul(400.0).add(0.4)).mul(smoothstep(0.0, 0.08, dir.y));
      const tw = sin(time.mul(3.0).add(h.mul(800.0))).mul(0.35).add(0.65);
      const band = exp(abs(dot(dir, normalize(vec3(0.3, 0.2, 0.93)))).mul(-9.0)).mul(0.012).mul(up);
      const nightCol = nightBase.add(vec3(star.mul(tw).mul(1.6))).add(vec3(0.6, 0.62, 0.8).mul(band)).mul(U.stars);
      const horizonGlow = vec3(0.05, 0.06, 0.07).mul(exp(up.mul(-14.0))).mul(U.night);
      return vec4(mix(day, nightCol.add(horizonGlow), U.night), 1.0);
    })();
    if (!forEnv && this.renderer.reversedDepthBuffer) {
      const v = sky.material.vertexNode;
      sky.material.vertexNode = Fn(() => {
        const p = v.toVar();
        p.z.assign(0.0);
        return p;
      })();
    }
    sky.frustumCulled = false;
    return sky;
  }

  set(id, instant = false) {
    if (!PRESETS[id]) return;
    this.id = id;
    this.from = { ...this.current, sun: this.current.sun.clone() };
    this.target = PRESETS[id];
    this.blend = instant ? 1 : 0;
    if (instant) { this._apply(this.target); this.updateEnvironment(); }
    this._envSteps = new Set([0.5, 1]);
  }

  _lerpPreset(a, b, t) {
    const out = {};
    for (const k of Object.keys(b)) {
      const va = a[k], vb = b[k];
      if (typeof vb === 'number' && k.toLowerCase().includes('color') || k === 'hemiSky' || k === 'hemiGround' || k === 'fogColor') {
        out[k] = new THREE.Color(va).lerp(new THREE.Color(vb), t).getHex();
      } else if (typeof vb === 'number') out[k] = va + (vb - va) * t;
      else if (vb && vb.isVector3) out[k] = va.clone().lerp(vb, t).normalize();
      else out[k] = t < 0.5 ? va : vb;
    }
    // the sun swings over the top rather than through the ground
    if (a.sun && b.sun) {
      const mid = a.sun.clone().add(b.sun).multiplyScalar(0.5);
      if (mid.y < 0.15) mid.y = 0.6;
      out.sun = (t < 0.5 ? a.sun.clone().lerp(mid, t * 2) : mid.clone().lerp(b.sun, (t - 0.5) * 2)).normalize();
    }
    return out;
  }

  _apply(p) {
    this.current = { ...p, sun: p.sun.clone() };
    const U = this.U;
    const sunDir = p.sun;
    U.sunDir.value.copy(sunDir);
    U.sunColor.value.set(p.sunColor);
    U.fogColor.value.set(p.fogColor);
    U.fogDensity.value = p.fog;
    U.hazeDensity.value = p.haze;
    U.hazeFalloff.value = p.hazeFalloff;
    U.skyExposure.value = p.skyExposure;
    U.night.value = p.night;
    U.flood.value = p.flood;
    U.stars.value = p.stars;
    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemi;
    this.scene.environmentIntensity = p.env;
    for (const sky of [this.sky, this.envSky]) {
      if (!sky) continue;
      // at night the Preetham sun sits under the horizon so the dome goes dark
      const skySun = p.night > 0.5 ? new THREE.Vector3(0, -0.3, -1).normalize() : sunDir;
      sky.sunPosition.value.copy(skySun).multiplyScalar(450000);
      sky.turbidity.value = p.turbidity;
      sky.rayleigh.value = p.rayleigh;
      sky.mieCoefficient.value = p.mie;
      sky.mieDirectionalG.value = p.mieG;
      sky.cloudCoverage.value = p.clouds;
      sky.cloudDensity.value = p.cloudDensity;
      sky.showSunDisc.value = p.night > 0.5 || sky === this.envSky ? 0 : 1;
    }
    if (this.envLights) this.envLights.visible = p.night > 0.5;
  }

  updateEnvironment() {
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 200);
    this.scene.environment = this.envTarget.texture;
  }

  // Move the shadow-casting light with the camera focus
  update(dt, focus) {
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 2.2);
      const t = this.blend * this.blend * (3 - 2 * this.blend);
      this._apply(this._lerpPreset(this.from, this.target, t));
      for (const step of [...this._envSteps]) {
        if (this.blend >= step) { this._envSteps.delete(step); this.updateEnvironment(); }
      }
    }
    const d = this.U.sunDir.value;
    this.sun.position.copy(focus).addScaledVector(d, 1500);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
  }
}
