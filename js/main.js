import * as THREE from 'three/webgpu';
import { pass, uniform, Fn, vec3, vec4, float, dot, mix, max, pow, smoothstep, step, length, screenUV, screenSize, vec2, mrt, output, normalView } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { Track, BASE_ALT, reversedData } from './track.js';
import { Terrain } from './terrain.js';
import { buildTrackMeshes } from './trackmesh.js';
import { Atmosphere, PRESETS, PRESET_ORDER } from './sky.js';
import { buildLake } from './water.js';
import { buildScenery } from './scenery.js';
import { buildVegetation } from './trees.js';
import { buildCar, loadCarModel } from './car-model.js';
import { CARS } from './cars.js';
import { Vehicle } from './vehicle.js';
import { CameraRig, CAMERAS, placeTvCameras } from './cameras.js';
import { Input } from './input.js';
import { Sound } from './audio.js';
import { Hud } from './hud.js';
import { Assists, LEVELS, LEVEL_ORDER } from './assists.js';
import { buildChevrons } from './chevrons.js';

const $ = (id) => document.getElementById(id);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const bootTimes = [];
let bootLast = performance.now();
const status = async (text, p) => {
  const now = performance.now();
  bootTimes.push(`${Math.round(now - bootLast)}ms`);
  bootLast = now;
  if (p === 1) console.info('[boot] stage times', bootTimes.join(' '));
  $('intro-status-text').textContent = text;
  $('intro-progress').style.width = `${Math.round(p * 100)}%`;
  await nextFrame();
};

const app = {
  mode: 'intro', autopilot: true, simTime: 0, carIndex: 0, startPhase: null, quality: 1,
  pose: {
    pos: new THREE.Vector3(), quat: new THREE.Quaternion(), matrix: new THREE.Matrix4(), forwardFlat: new THREE.Vector3(), velocity: new THREE.Vector3(), model: null
  }
};

function drawIntroMap(track) {
  const svg = $('intro-map');
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let i = 0; i < track.M; i += 10) { minX = Math.min(minX, track.px[i]); maxX = Math.max(maxX, track.px[i]); minZ = Math.min(minZ, track.pz[i]); maxZ = Math.max(maxZ, track.pz[i]); }
  const sc = 92 / Math.max(maxX - minX, maxZ - minZ);
  let d = '';
  for (let i = 0; i <= track.M; i += 12) {
    const k = (Math.round(track.startLine) + i) % track.M;
    const x = 50 + (track.px[k] - (minX + maxX) / 2) * sc, y = 50 + (track.pz[k] - (minZ + maxZ) / 2) * sc;
    d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
  }
  svg.innerHTML = `<path class="base" d="${d}"/><path class="draw" d="${d}"/>`;
  const p = svg.querySelector('.draw');
  const len = p.getTotalLength();
  p.style.strokeDasharray = len;
  p.style.strokeDashoffset = len;
  p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 3800, easing: 'cubic-bezier(.6,.05,.3,1)', fill: 'forwards' });
}

async function boot() {
  if (!navigator.gpu) console.info('WebGPU not available: three.js falls back to WebGL 2');
  const renderer = new THREE.WebGPURenderer({ antialias: false, reversedDepthBuffer: true, powerPreference: 'high-performance' });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  $('viewport').appendChild(renderer.domElement);
  app.renderer = renderer;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.12, 60000);
  app.scene = scene; app.camera = camera;

  await status('Tracing the circuit', 0.08);
  const track = new Track();
  app.track = track;
  app.trackFwd = track;
  app.reverse = false;
  drawIntroMap(track);
  const vehicle = new Vehicle(track, CARS[0]);
  track.computeLayout(vehicle.profile.v);
  app.vehicle = vehicle;

  await status('Lighting the sky over Bugesera', 0.16);
  const atmo = new Atmosphere(scene, renderer, camera);
  app.atmo = atmo;

  await status('Shaping the hills', 0.24);
  const terrain = new Terrain(track);
  app.terrain = terrain;
  await status('Laying the terrain', 0.42);
  scene.add(terrain.buildMeshes(atmo.U));
  await status('Paving 6 km of asphalt', 0.5);
  scene.add(buildTrackMeshes(track, atmo.U));
  await status('Filling the lake', 0.56);
  scene.add(buildLake(atmo.U));
  await status('Building the stands and paddock', 0.62);
  const tvSpots = placeTvCameras(track, terrain);
  const scenery = buildScenery(track, terrain, atmo.U, tvSpots);
  scene.add(scenery.group);
  app.startLights = scenery.startLights;
  await status('Planting acacias and papyrus', 0.7);
  const veg = buildVegetation(track, terrain, atmo.U, tvSpots);
  scene.add(veg);
  app.assists = new Assists();
  try { const saved = localStorage.getItem('agp-assists'); if (LEVELS[saved]) app.assists.level = saved; } catch { /* storage may be blocked */ }
  rebuildChevrons();
  await status('Rolling out the car', 0.8);
  await loadCarModel();
  setCar(0, true);

  // camera, input, sound, HUD
  app.rig = new CameraRig(camera, renderer.domElement, track, terrain);
  app.rig.cinematic = true;
  app.input = new Input();
  app.input.bindTouch($('touch'));
  app.input.onKey = onKey;
  app.sound = new Sound();
  app.hud = new Hud(track);
  app.hud.setCar(CARS[app.carIndex]);
  buildCarPicker();
  wireUi();

  // post-processing: bloom and a gentle grade
  await status('Preparing the graphics: up to 20 s on a first visit', 0.86);
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: 4 });
  const color = scenePass.getTextureNode('output');
  // ambient occlusion from a cheap half-size depth and normal pass without foliage, fences, water or sky
  const prePass = pass(scene, camera, { samples: 0 });
  prePass.setResolutionScale(0.5);
  prePass.setMRT(mrt({ output: normalView }));
  prePass.overrideMaterial = new THREE.MeshBasicNodeMaterial();
  const skip = [];
  scene.traverse((o) => { if (o.isMesh && (/^trees-|track-fence|^lake$/.test(o.name) || o.isSkyMesh || o === atmo.sky)) skip.push(o); });
  skip.push(atmo.sky);
  const preUpdate = prePass.updateBefore.bind(prePass);
  prePass.updateBefore = (frame) => {
    for (const o of skip) o.visible = false;
    const chev = app.chev && app.chev.mesh, chevShown = chev && chev.visible;
    if (chev) chev.visible = false;
    const r = preUpdate(frame);
    for (const o of skip) o.visible = true;
    if (chev) chev.visible = chevShown;
    return r;
  };
  const aoPass = ao(prePass.getTextureNode('depth'), prePass.getTextureNode(), camera);
  aoPass.resolutionScale = 1;
  aoPass.radius.value = 1.1;
  aoPass.samples.value = 10;
  aoPass.distanceExponent.value = 1.4;
  const aoTex = denoise(aoPass.getTextureNode(), prePass.getTextureNode('depth'), prePass.getTextureNode(), camera);
  const bloomPass = bloom(color, 0.16, 0.45, 0.95);
  app.bloom = bloomPass;
  const vignette = uniform(0.22);
  app.aoStrength = uniform(0.75);
  const preDepth = prePass.getTextureNode('depth');
  const grade = (withAO) => Fn(() => {
    // the sky and other skipped surfaces leave the cleared depth behind: no occlusion there
    const dz = preDepth.r;
    const drawn = renderer.reversedDepthBuffer ? step(0.0000001, dz) : step(dz, 0.9999999);
    const occl = withAO ? mix(float(1), aoTex.r, app.aoStrength.mul(drawn)) : float(1);
    const c = color.rgb.mul(occl).add(bloomPass.rgb).toVar();
    const luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c.assign(mix(vec3(luma), c, 1.08));
    const aspect = screenSize.x.div(screenSize.y);
    const r = length(screenUV.sub(0.5).mul(vec2(aspect, 1))).div(length(vec2(aspect, 1).mul(0.5)));
    return vec4(c.mul(float(1).sub(smoothstep(0.45, 1.05, r).mul(vignette))), 1);
  })();
  app.outputs = { withAO: grade(true), plain: grade(false) };
  pipeline.outputNode = app.outputs.withAO;
  app.aoOn = true;
  app.pipeline = pipeline;

  // first pose and camera so compilation sees the real scene
  vehicle.reset(track.wrap(track.startLine - 600), 0);
  vehicle.v = vehicle.profile.v[Math.floor(vehicle.s / track.lineStep)];
  updatePose(0);
  app.rig.update(0.016, app.pose, vehicle);
  atmo.update(0.016, app.pose.pos);
  try { await renderer.compileAsync(scene, camera); } catch (err) { console.warn('compileAsync', err); }

  // Start rendering behind the loader. The first frames build the post-processing, shadow and reflection
  // passes, so Ready only shows once frames run smoothly from every camera.
  window.addEventListener('resize', onResize);
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    app.frameMs = now - last;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frame(dt);
  });
  await status('Warming up the cameras and engine', 0.93);
  // the engine sound graph is built now (silent until a button press) so starting does not stall
  try { await app.sound.init(); app.sound.setMuted(true); } catch (err) { console.warn('Audio unavailable', err); }
  await warmUp();
  perf.ema = 1 / 60; perf.slowFor = perf.fastFor = 0; perf.grace = 4;
  await status('Ready', 1);
  $('intro-status').hidden = true;
  $('intro-actions').hidden = false;
  $('btn-drive').focus({ preventScroll: true });
}

// Show every camera for a few frames, then wait for a run of smooth frames
async function warmUp() {
  const rig = app.rig, frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  rig.cinematic = false;
  app.warming = true; // chevrons too, so the first Drive press does not build their shader
  for (const i of [2, 0, 4, 5, 1, 3]) { rig.set(i); await frames(4); }
  app.warming = false;
  rig.cinematic = true; rig.first = true;
  const t0 = performance.now();
  let good = 0;
  while (good < 12 && performance.now() - t0 < 30000) {
    await frames(1);
    good = app.frameMs < 34 ? good + 1 : 0;
  }
}

function setCar(i, first = false) {
  app.carIndex = i;
  const car = CARS[i];
  if (app.carModel) {
    app.scene.remove(app.carModel);
    app.carModel.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); } });
  }
  app.carModel = buildCar(car);
  app.scene.add(app.carModel);
  app.pose.model = app.carModel;
  if (!first) {
    const keep = { s: app.vehicle.s, d: app.vehicle.d, v: app.vehicle.v };
    app.vehicle.setCar(car);
    Object.assign(app.vehicle, keep);
    app.vehicle.gear = 0;
    app.sound.setCar(car);
    app.hud.setCar(car);
    rebuildChevrons();
    document.querySelectorAll('.car-card').forEach((c, k) => c.classList.toggle('active', k === i));
  } else {
    app.vehicle.setCar(car);
  }
}

// Chevrons follow the racing line and target speeds of this car on this direction of the lap
function rebuildChevrons() {
  if (app.chev) {
    app.scene.remove(app.chev.mesh);
    app.chev.mesh.geometry.dispose();
    app.chev.mesh.material.dispose();
  }
  app.chev = buildChevrons(app.track, app.vehicle.profile, app.atmo.U);
  app.chev.mesh.visible = false;
  app.scene.add(app.chev.mesh);
}

function setAssist(level) {
  if (!LEVELS[level]) return;
  app.assists.level = level;
  try { localStorage.setItem('agp-assists', level); } catch { /* storage may be blocked */ }
  const cfg = LEVELS[level];
  document.querySelectorAll('.assist-btn').forEach((b) => { const on = b.dataset.assist === level; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  $('assist-summary').textContent = cfg.summary;
  $('btn-assist-label').textContent = cfg.label;
  $('btn-assist').title = `Assists: ${cfg.label} [L]`;
  app.hud.setAssist(cfg.label);
}

function buildCarPicker() {
  const list = $('car-list');
  list.innerHTML = '';
  CARS.forEach((car, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'car-card' + (i === app.carIndex ? ' active' : '');
    const L = car.livery;
    b.innerHTML = `<span class="swatch" style="background:linear-gradient(115deg, ${L.base} 0 52%, ${L.accent} 52% 70%, ${L.third} 70%)"></span>
      <span class="era">${car.eraLabel}</span><strong>${car.name}</strong><span class="spec">${car.specLine}<br>${car.blurb}</span>`;
    b.addEventListener('click', () => { setCar(i); $('car-picker').hidePopover?.(); });
    list.appendChild(b);
  });
}

function setTime(id) {
  app.atmo.set(id);
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.time === id));
  const p = PRESETS[id];
  app.bloom.strength.value = p.bloom;
}

function setAutopilot(on) {
  app.autopilot = on;
  $('btn-auto').setAttribute('aria-pressed', String(on));
}

function wireUi() {
  $('btn-drive').addEventListener('click', () => start(false));
  $('btn-hotlap').addEventListener('click', () => start(true));
  document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => setTime(b.dataset.time)));
  $('btn-auto').addEventListener('click', () => setAutopilot(!app.autopilot));
  $('btn-reverse').addEventListener('click', () => setDirection(!app.reverse, true));
  document.querySelectorAll('.dir-btn').forEach((b) => b.addEventListener('click', () => setDirection(b.dataset.dir === '1', false)));
  $('btn-show').addEventListener('click', () => toggleHud(false));
  $('btn-menu').addEventListener('click', returnToMenu);
  document.querySelectorAll('.assist-btn').forEach((b) => b.addEventListener('click', () => setAssist(b.dataset.assist)));
  $('btn-assist').addEventListener('click', () => setAssist(LEVEL_ORDER[(LEVEL_ORDER.indexOf(app.assists.level) + 1) % LEVEL_ORDER.length]));
  setAssist(app.assists.level);
  $('btn-sound').addEventListener('click', toggleSound);
  $('btn-hide').addEventListener('click', () => toggleHud(true));
  $('btn-full').addEventListener('click', toggleFull);
  $('cam-prev').addEventListener('click', () => app.rig.next(-1));
  $('cam-next').addEventListener('click', () => app.rig.next(1));
  $('cam-name').addEventListener('click', () => app.rig.next(1));
  // buttons must not keep focus, or Space presses them again
  document.addEventListener('pointerup', (e) => { const b = e.target.closest('button'); if (b) b.blur(); });
  if (matchMedia('(pointer: coarse)').matches) { $('touch').hidden = false; document.body.classList.add('touch-ui'); }
}

// Back to the title screen; the car keeps lapping behind it for the broadcast views
function returnToMenu() {
  if (app.mode !== 'drive') return;
  app.mode = 'intro';
  app.startPhase = null;
  clearTimeout(app.lightsTimer);
  $('title-card').hidden = true;
  app.startLights.forEach((u) => (u.value = 0));
  app.startLights.green.value = 0;
  for (const p of document.querySelectorAll(':popover-open')) p.hidePopover();
  $('hud').classList.remove('clean');
  $('hud').hidden = true;
  $('intro').classList.remove('gone');
  setAutopilot(true);
  const tr = app.track, v = app.vehicle, s = tr.wrap(v.s);
  v.reset(s, tr.lineOffset(s));
  v.v = v.profile.v[Math.floor(s / tr.lineStep) % v.profile.v.length];
  app.rig.cinematic = true;
  app.rig.first = true;
  app.sound.setMuted(true);
  $('btn-drive').focus({ preventScroll: true });
}

function toggleHud(hide) {
  $('hud').classList.toggle('clean', hide);
  if (!hide) $('btn-hide').focus({ preventScroll: true });
}

// Anticlockwise is the official direction; reverse runs the same road clockwise
function setDirection(rev, restart) {
  if (rev && !app.trackRev) {
    app.trackRev = new Track(reversedData());
    app.trackRev.copyLayoutFrom(app.trackFwd);
  }
  if (app.reverse !== rev) {
    const v = app.vehicle;
    const sF = app.track.forwardS(v.s), d = v.d;
    app.reverse = rev;
    app.track = rev ? app.trackRev : app.trackFwd;
    v.track = app.track;
    v.setCar(CARS[app.carIndex]);
    rebuildChevrons();
    // same spot on the road, now facing the other way
    v.reset(rev ? app.track.wrap(app.track.length - sF) : sF, -d);
    app.hud.setTrack(app.track);
  }
  document.querySelectorAll('.dir-btn').forEach((b) => { const on = (b.dataset.dir === '1') === rev; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  $('btn-reverse').setAttribute('aria-pressed', String(rev));
  if (restart && app.mode === 'drive') restartRun(app.autopilot);
}

// Back to the grid for the current direction. The hot lap shows the title card, then red lights that turn green.
function restartRun(hotlap) {
  const tr = app.track, v = app.vehicle;
  app.hud.resetLap();
  // pole sits 13 m short of the gantry in either direction (the gantry is 4 m past the anticlockwise line)
  v.reset(tr.wrap(tr.startLine - (tr.reversed ? 17 : 9)), 2.6);
  beginStartLights(hotlap ? { title: 3.2, green: true } : {});
}

function toggleSound() {
  const on = !app.sound.enabled;
  app.sound.setEnabled(on);
  $('btn-sound').setAttribute('aria-pressed', String(on));
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

async function start(hotlap) {
  try {
    await app.sound.init();
    app.sound.setCar(CARS[app.carIndex]);
    app.sound.resume();
    app.sound.setMuted(false);
  } catch (err) { console.warn('Audio unavailable', err); }
  $('intro').classList.add('gone');
  $('hud').hidden = false;
  app.rig.cinematic = false;
  app.mode = 'drive';
  app.hud.resetLap();
  app.rig.set(2); // cockpit
  setAutopilot(hotlap);
  restartRun(hotlap);
  app.hud.hint(app.assists.level === 'beginner'
    ? '<kbd>W</kbd> throttle · <kbd>A</kbd><kbd>D</kbd> move across the line · steering and braking are helped · <kbd>L</kbd> assists · <kbd>V</kbd> camera'
    : '<kbd>W</kbd> throttle · <kbd>S</kbd> brake · <kbd>A</kbd><kbd>D</kbd> steer · <kbd>L</kbd> assists · <kbd>V</kbd> camera · <kbd>P</kbd> hot lap');
  setTimeout(() => app.hud.hint(''), 9000);
}

// opts.title: seconds of title card first; opts.green: lights turn green rather than go out.
// The lights are the ones on the start gantry over the track; the cockpit camera looks up at them.
function beginStartLights(opts = {}) {
  const title = opts.title || 0;
  app.startPhase = { t: -title, title, out: 3.2 + 0.6 + Math.random() * 1.6, green: !!opts.green };
  clearTimeout(app.lightsTimer);
  app.startLights.forEach((u) => (u.value = 0));
  app.startLights.green.value = 0;
  app.rig.lookUp = 1;
  const card = $('title-card');
  card.hidden = !(title > 0);
  card.classList.remove('show');
  if (title > 0) requestAnimationFrame(() => card.classList.add('show'));
}

function updateStartLights(dt) {
  const sp = app.startPhase;
  if (!sp) return;
  sp.t += dt;
  const card = $('title-card');
  if (sp.t < 0) {
    if (sp.t > -0.55) card.classList.remove('show');
    return;
  }
  card.hidden = true;
  const lit = Math.min(5, Math.floor(sp.t / 0.8) + 1);
  const out = sp.t >= sp.out;
  for (let i = 0; i < 5; i++) app.startLights[i].value = !out && i < lit ? 1 : 0;
  app.startLights.green.value = out && sp.green ? 1 : 0;
  if (out) {
    app.startPhase = null;
    app.lightsTimer = setTimeout(() => { app.startLights.green.value = 0; }, 2500);
    setTimeout(() => { app.rig.lookUp = 0; }, 400);
  }
}

function onKey(e) {
  if (app.mode !== 'drive') return;
  switch (e.code) {
    case 'KeyV': app.rig.next(1); break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6':
      app.rig.set(Number(e.code.slice(5)) - 1); break;
    case 'KeyP': setAutopilot(!app.autopilot); break;
    case 'KeyR': {
      const v = app.vehicle;
      v.reset(v.s, 0);
      break;
    }
    case 'KeyT': {
      const i = PRESET_ORDER.indexOf(app.atmo.id);
      setTime(PRESET_ORDER[(i + 1) % PRESET_ORDER.length]);
      break;
    }
    case 'KeyN': toggleSound(); break;
    case 'KeyH': toggleHud(!$('hud').classList.contains('clean')); break;
    case 'KeyC': setDirection(!app.reverse, true); break;
    case 'KeyL': setAssist(LEVEL_ORDER[(LEVEL_ORDER.indexOf(app.assists.level) + 1) % LEVEL_ORDER.length]); break;
    case 'Escape': if (!document.querySelector(':popover-open')) returnToMenu(); break;
    case 'KeyF': toggleFull(); break;
    default: break;
  }
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  app.camera.aspect = w / h;
  app.camera.updateProjectionMatrix();
  app.renderer.setSize(w, h);
}

const _f = {}, _T = new THREE.Vector3(), _L = new THREE.Vector3(), _N = new THREE.Vector3(), _F = new THREE.Vector3(), _X = new THREE.Vector3(), _basis = new THREE.Matrix4();
const _rollQ = new THREE.Quaternion(), _e = new THREE.Euler();

function updatePose(dt) {
  const v = app.vehicle, tr = app.track, pose = app.pose;
  const f = tr.frame(v.s, _f);
  const thetaC = f.theta - v.psi;
  const fx = Math.cos(thetaC), fz = Math.sin(thetaC);
  const prev = pose.pos.clone();
  const kerbLift = v.kerb ? 0.035 + Math.abs(Math.sin(v.s * Math.PI)) * 0.012 : 0;
  const y = tr.heightAt(v.s, v.d, f) + kerbLift + (v.surface === 'grass' ? Math.sin(v.s * 1.7) * 0.02 : 0);
  pose.pos.set(f.x + f.lx * v.d, y, f.z + f.lz * v.d);
  if (dt > 0) pose.velocity.copy(pose.pos).sub(prev).divideScalar(dt);
  // road plane from grade and banking
  const bank = Math.abs(v.d) <= f.half ? f.bank : -0.02 * Math.sign(v.d);
  _T.set(f.tx, f.grade, f.tz).normalize();
  _L.set(f.lx, bank, f.lz).normalize();
  _N.crossVectors(_T, _L).normalize();
  _F.set(fx, -(_N.x * fx + _N.z * fz) / _N.y, fz).normalize();
  _X.crossVectors(_N, _F).normalize();
  _basis.makeBasis(_X, _N, _F);
  pose.quat.setFromRotationMatrix(_basis);
  // body roll and pitch from the loads
  const roll = THREE.MathUtils.clamp(v.latAcc * 0.0016, -0.06, 0.06);
  const pitch = THREE.MathUtils.clamp(-v.lonAcc * 0.0009, -0.05, 0.05);
  _rollQ.setFromEuler(_e.set(pitch, 0, roll));
  pose.quat.multiply(_rollQ);
  pose.forwardFlat.set(fx, 0, fz);
  pose.matrix.compose(pose.pos, pose.quat, new THREE.Vector3(1, 1, 1));
  const m = app.carModel;
  m.position.copy(pose.pos);
  m.quaternion.copy(pose.quat);
  // wheels, steering, active aero, rain light
  const ud = m.userData;
  const car = CARS[app.carIndex];
  const spin = (v.v / car.wheelRadius) * dt;
  for (const w of ud.wheels) {
    w.spin.rotation.x += spin;
    if (w.front) w.steer.rotation.y = v.steer * 0.3;
  }
  if (ud.flap) ud.flap.rotation.x += ((v.straightMode ? -0.42 : 0) - ud.flap.rotation.x) * Math.min(1, dt * 10);
  const blink = Math.floor(performance.now() / 120) % 2;
  ud.rainOn.value = (car.engine.hybrid && v.brake > 0.1 && blink) || app.atmo.U.night.value > 0.5 ? 1 : 0.0;
  // seen from the driver's seat (looking along +z) a left turn is anticlockwise: a negative rotation about z
  ud.steeringWheel.group.rotation.z = -v.steer * 1.15;
  ud.updateHands();
  const rimMat = ud.wheels[0].spin.children[1].material;
  if (rimMat.userData.speed) rimMat.userData.speed.value = Math.abs(v.v);
}

function listenerFor() {
  const cam = app.camera, pose = app.pose;
  const id = app.rig.activeId;
  const onboard = id === 'tcam' || id === 'cockpit' || id === 'nose';
  const toCar = pose.pos.clone().sub(cam.position);
  const dist = toCar.length();
  // Doppler: source speed along the line to the listener
  const dir = toCar.clone().normalize();
  const vr = -pose.velocity.dot(dir);
  const doppler = onboard ? 1 : THREE.MathUtils.clamp(343 / (343 - vr), 0.55, 1.8);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const pan = onboard ? 0 : THREE.MathUtils.clamp(dir.dot(right) * 0.8, -0.8, 0.8);
  return { onboard, dist: onboard ? 0 : dist, doppler, pan };
}

function frame(dt) {
  const v = app.vehicle;
  app.simTime += dt;
  const inp = app.input.poll();
  if (app.mode === 'drive') {
    if (app.autopilot && inp.active && !app.startPhase) setAutopilot(false);
    updateStartLights(dt);
    const sp = app.startPhase;
    if (sp) {
      // held on the grid: the driver revs once the lights come on (the autopilot does it for you)
      const eng = v.car.engine;
      let thr = inp.throttle;
      if (app.autopilot) thr = sp.t < 0 ? 0 : 0.55 + 0.12 * Math.sin(app.simTime * 9);
      v.step(dt, { ...inp, throttle: thr, brake: 1, steer: 0 });
      v.v = 0; v.gear = 0;
      v.rpm = Math.max(eng.idle, eng.idle + thr * (eng.shift * 0.75 - eng.idle));
      v.throttle = thr;
    } else if (app.autopilot) v.autopilot(dt);
    else v.step(dt, app.assists.apply(v, inp, dt));
  } else {
    v.autopilot(dt);
  }
  const crossed = v.crossedLine;
  v.crossedLine = false;
  if (app.chev) {
    const line = app.assists.cfg.line;
    app.chev.mesh.visible = app.warming || (app.mode === 'drive' && !app.autopilot && line !== 'off');
    app.chev.u.mode.value = line === 'braking' ? 2 : 1;
    // a braking rate a driver can hold without locking up: about 2.8 g in a modern car, 0.9 g in 1967
    app.chev.update(v.s, Math.max(0, v.v), v.car.era === 'classic' ? 9 : 27);
  }
  updatePose(dt);
  if (app.freeCam) {
    app.camera.position.copy(app.freeCam.pos);
    app.camera.lookAt(app.freeCam.target);
    if (app.freeCam.fov && app.camera.fov !== app.freeCam.fov) { app.camera.fov = app.freeCam.fov; app.camera.updateProjectionMatrix(); }
    app.rig.activeId = 'free';
  } else app.rig.update(dt, app.pose, v);
  app.atmo.update(dt, app.pose.pos);
  if (app.mode === 'drive') {
    app.hud.timing(app.simTime, v, crossed);
    let mode = app.autopilot ? 'Hot lap' : app.assists.recovered > 0 ? 'Back on track' : '';
    if (v.straightMode && !mode) mode = 'Straight-line mode';
    if (v.boost && !mode) mode = 'Boost';
    app.hud.update(v, CARS[app.carIndex], app.rig.label, mode);
    const cockpit = app.rig.activeId === 'cockpit';
    if (cockpit !== app.hudCockpit) { app.hudCockpit = cockpit; $('hud').classList.toggle('cam-cockpit', cockpit); }
    const ud = app.carModel.userData;
    if (app.rig.activeId === 'cockpit' && (app.hud.frame % 3 === 0)) {
      const car = CARS[app.carIndex];
      ud.steeringWheel.draw(String(v.gear + 1), Math.round(Math.abs(v.v) * 3.6), Math.max(0, Math.min(1, (v.rpm - car.engine.shift * 0.62) / (car.engine.shift * 0.38))));
    }
  }
  // the car mesh hides when the camera sits inside it
  app.carModel.visible = true;
  if (app.sound.ready) {
    const L = listenerFor();
    const tr = app.track;
    const fromLine = tr.wrap(v.s - tr.startLine + 300);
    const crowd = fromLine < 700 ? 1 : 0.15;
    const lake = Math.max(0, 1 - Math.max(0, app.terrain.infoAt(app.camera.position.x, app.camera.position.z).lake) / 300);
    app.sound.update(v, L, { night: app.atmo.U.night.value, crowd, lake });
  }
  adaptQuality(dt);
  app.pipeline.render();
}

// Step quality down when frames stay slow: first ambient occlusion, then resolution. Up again when there is headroom.
const perf = { ema: 1 / 60, slowFor: 0, fastFor: 0, grace: 30 };
function adaptQuality(dt) {
  perf.grace -= dt;
  perf.ema += (dt - perf.ema) * Math.min(1, dt * 1.5);
  if (perf.grace > 0) return;
  perf.slowFor = perf.ema > 1 / 38 ? perf.slowFor + dt : 0;
  perf.fastFor = perf.ema < 1 / 75 ? perf.fastFor + dt : 0;
  const r = app.renderer, maxPR = Math.min(window.devicePixelRatio, 1.5);
  if (perf.slowFor > 4) {
    perf.slowFor = 0; perf.grace = 3;
    if (app.aoOn) { app.aoOn = false; app.pipeline.outputNode = app.outputs.plain; app.pipeline.needsUpdate = true; }
    else if (r.getPixelRatio() > 0.6) r.setPixelRatio(Math.max(0.6, r.getPixelRatio() * 0.8));
  } else if (perf.fastFor > 8) {
    perf.fastFor = 0; perf.grace = 3;
    if (r.getPixelRatio() < maxPR) r.setPixelRatio(Math.min(maxPR, r.getPixelRatio() * 1.15));
    else if (!app.aoOn) { app.aoOn = true; app.pipeline.outputNode = app.outputs.withAO; app.pipeline.needsUpdate = true; }
  }
}

boot().catch((err) => {
  console.error(err);
  $('intro-status-text').textContent = 'This browser could not start the 3D view: ' + (err && err.message ? err.message : err);
});

// debugging handle
window.__rise = app;
