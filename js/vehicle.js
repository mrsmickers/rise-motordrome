import { RHO, G } from './cars.js';
import { clamp, smoothstep } from './noise.js';

const ETA = 0.92; // drivetrain efficiency

// Total wheel power for a car at engine rpm and road speed (m/s)
export function powerAt(car, rpm, v, boost = false) {
  const e = car.engine;
  const x = rpm / e.redline;
  const curve = clamp(1 - 2.4 * (x - 0.93) * (x - 0.93), 0.25, 1);
  let p = car.powerIce * curve;
  if (car.powerElectric > 0) {
    const [a, b] = boost ? car.boostFade : car.electricFade;
    const kmh = v * 3.6;
    p += car.powerElectric * (1 - smoothstep(a, b, kmh));
  } else if (boost) {
    p *= 1.06;
  }
  return p * ETA;
}

function aero(car, straight) {
  const cda = straight && car.CdAStraight ? car.CdAStraight : car.CdA;
  const cla = straight && car.ClAStraight ? car.ClAStraight : car.ClA;
  return { cda, cla };
}

// Lap speed profile along the racing line (m/s per 5 m sample) and the lap time it gives
export function speedProfile(track, car, grip = 0.96) {
  const n = track.lineN, step = track.lineStep;
  const vmax = new Float32Array(n);
  const m = car.mass;
  for (let i = 0; i < n; i++) {
    const s = i * step;
    const f = track.frame(s);
    const k = Math.abs(track.lineK[i]);
    const straight = k < 1 / 900;
    const { cla } = aero(car, straight);
    const cD = 0.5 * RHO * cla / m;
    // banking tilts the road into the corner when its sign opposes the turn direction
    const bankHelp = -f.bank * Math.sign(track.lineK[i]) * G;
    const vc = Math.max(-0.002, f.vcurv);
    const mu = car.mu * grip;
    const den = k - mu * (cD + vc);
    const num = mu * G + bankHelp;
    vmax[i] = den > 1e-6 ? Math.sqrt(Math.max(num, 1) / den) : 140;
    vmax[i] = Math.min(vmax[i], 140);
  }
  const v = Float32Array.from(vmax);
  const forward = () => {
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < n; j++) {
        const i = j, b = (j + 1) % n;
        const f = track.frame(i * step);
        const straight = Math.abs(track.lineK[i]) < 1 / 900;
        const { cda, cla } = aero(car, straight);
        const vi = Math.max(v[i], 3);
        const rpm = engineRpm(car, vi, bestGear(car, vi));
        const drive = powerAt(car, rpm, vi) / vi;
        const q = 0.5 * RHO * vi * vi;
        const N = m * G + q * cla;
        const lat = vi * vi * Math.abs(track.lineK[i]) * m;
        const tractionCap = Math.sqrt(Math.max(0, (car.mu * grip * N) ** 2 - lat * lat));
        const a = (Math.min(drive, tractionCap) - q * cda - car.crr * N - m * G * f.grade) / m;
        const vn = Math.sqrt(Math.max(1, vi * vi + 2 * a * track.lineSeg[i]));
        if (vn < v[b]) v[b] = vn;
      }
    }
  };
  const backward = () => {
    for (let pass = 0; pass < 2; pass++) {
      for (let j = n - 1; j >= 0; j--) {
        const i = j, a0 = (j - 1 + n) % n;
        const f = track.frame(a0 * step);
        const { cda, cla } = aero(car, false);
        const vi = v[i];
        const q = 0.5 * RHO * vi * vi;
        const N = m * G + q * cla;
        const lat = vi * vi * Math.abs(track.lineK[a0]) * m;
        const brakeCap = Math.min(car.brakeMax + q * cda, Math.sqrt(Math.max(0, (car.muBrake * grip * N) ** 2 - lat * lat)) + q * cda);
        const dec = (brakeCap + m * G * f.grade) / m;
        const vp = Math.sqrt(vi * vi + 2 * Math.max(dec, 2) * track.lineSeg[a0]);
        if (vp < v[a0]) v[a0] = vp;
      }
    }
  };
  forward(); backward(); forward(); backward();
  let time = 0;
  for (let i = 0; i < n; i++) time += track.lineSeg[i] / Math.max(1, 0.5 * (v[i] + v[(i + 1) % n]));
  return { v, time, vmax };
}

export function engineRpm(car, v, gear) {
  const wheelRpm = (Math.abs(v) / (2 * Math.PI * car.wheelRadius)) * 60;
  return wheelRpm * car.gears[gear] * car.final;
}

export function bestGear(car, v) {
  for (let g = 0; g < car.gears.length; g++) {
    if (engineRpm(car, v, g) < car.engine.shift) return g;
  }
  return car.gears.length - 1;
}

// Vehicle state in track coordinates: s along the centreline, d to the left, psi heading off the tangent (+ left)
export class Vehicle {
  constructor(track, car) {
    this.track = track;
    this.f = {};
    this.setCar(car);
    this.reset(track.wrap(track.startLine - 9), 2.6);
  }

  setCar(car) {
    this.car = car;
    this.profile = speedProfile(this.track, car);
  }

  reset(s, d = 0) {
    this.s = this.track.wrap(s);
    this.d = d;
    this.psi = 0;
    this.v = 0;
    this.r = 0;
    this.gear = 0;
    this.rpm = this.car.engine.idle;
    this.throttle = 0; this.brake = 0; this.steer = 0;
    this.latAcc = 0; this.lonAcc = 0; this.vertAcc = 0;
    this.slip = 0;
    this.shiftCut = 0;
    this.shiftEvent = 0;
    this.surface = 'road';
    this.kerb = 0;
    this.wallHit = 0;
    this.lapDist = 0;
    this.straightMode = false;
    this.boost = false;
    this.limiter = 0;
    this.airborne = 0;
  }

  // inputs: throttle 0..1, brake 0..1, steer -1..1 (+ left), boost bool
  step(dt, input) {
    const sub = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / sub;
    for (let k = 0; k < sub; k++) this._step(h, input);
  }

  _step(dt, inp) {
    const car = this.car, tr = this.track, f = tr.frame(this.s, this.f);
    const m = car.mass;
    this.throttle += (inp.throttle - this.throttle) * Math.min(1, dt * 14);
    this.brake += (inp.brake - this.brake) * Math.min(1, dt * 18);
    // keyboard steering eases in; analogue input passes through faster
    const steerRate = inp.analog ? 16 : 5.5;
    this.steer += (inp.steer - this.steer) * Math.min(1, dt * steerRate);
    this.boost = !!inp.boost;

    // Surface
    const ad = Math.abs(this.d), e = f.half;
    const side = this.d >= 0;
    const kerbW = (side ? tr.kerbL : tr.kerbR)[f.i] || 0;
    const runW = (side ? tr.runL : tr.runR)[f.i] || 0;
    let muS = 1, crr = car.crr;
    if (ad <= e) this.surface = 'road';
    else if (ad <= e + kerbW) this.surface = 'kerb';
    else if (ad <= e + kerbW + runW) this.surface = 'runoff';
    else { this.surface = 'grass'; muS = 0.55; crr = 0.09; }
    this.kerb = this.surface === 'kerb' ? 1 : 0;

    const v = this.v;
    const av = Math.abs(v);
    const kAbs = Math.abs(f.kL);
    this.straightMode = car.CdAStraight && kAbs < 1 / 1100 && this.throttle > 0.9 && this.brake < 0.05 && av > 50;
    const cda = this.straightMode ? car.CdAStraight : car.CdA;
    const cla = this.straightMode ? car.ClAStraight : car.ClA;
    const q = 0.5 * RHO * v * v;
    const gradeAlong = f.grade * Math.cos(this.psi);
    const vc = f.vcurv * Math.cos(this.psi) ** 2;
    let N = m * G + q * cla + m * v * v * vc;
    this.vertAcc = v * v * vc;
    this.airborne = N <= 0 ? 1 : 0;
    N = Math.max(N, 0);
    const mu = car.mu * muS;
    const gripAcc = (mu * N) / m;

    // Lateral: steering asks for a yaw rate; grip limits it
    const L = car.wheelbase;
    const maxLock = car.era === 'classic' ? 0.42 : 0.36;
    const delta = this.steer * maxLock * (1 / (1 + av * av * 0.00011));
    const rGeom = (v * Math.tan(delta)) / L;
    const turnSign = Math.sign(rGeom) || 0;
    const bankHelp = -f.bank * turnSign * G;
    const latCap = Math.max(0.5, gripAcc + bankHelp);
    const rCap = latCap / Math.max(av, 1);
    let rTarget = rGeom;
    // straight-line assist: with no steering input on gentle bends the car holds the road's direction
    const free = 1 - Math.min(1, Math.abs(this.steer) * 4);
    if (free > 0 && av > 3) {
      const assist = free * (1 - smoothstep(1 / 600, 1 / 160, kAbs));
      rTarget += assist * (f.kL * v - this.psi * 1.6);
    }
    this.slip = 0;
    if (Math.abs(rGeom) > rCap) {
      this.slip = clamp((Math.abs(rGeom) - rCap) / (rCap + 0.05), 0, 1);
      rTarget = turnSign * rCap * (1 - 0.08 * this.slip);
    }
    this.r += (rTarget - this.r) * Math.min(1, dt * (car.era === 'classic' ? 7 : 10));
    const latAcc = v * this.r;
    this.latAcc = latAcc;

    // Longitudinal
    const wheelRpm = (av / (2 * Math.PI * car.wheelRadius)) * 60;
    const eng = car.engine;
    let rpmTarget = wheelRpm * car.gears[this.gear] * car.final;
    // launch: clutch slips until the wheels catch up
    const launch = eng.idle + this.throttle * (eng.shift * 0.62 - eng.idle);
    if (this.gear === 0 && rpmTarget < launch) rpmTarget = Math.max(rpmTarget, eng.idle + (launch - eng.idle) * Math.min(1, this.throttle * 1.4));
    rpmTarget = Math.max(rpmTarget, eng.idle);
    this.shiftCut = Math.max(0, this.shiftCut - dt);
    this.shiftEvent = Math.max(0, this.shiftEvent - dt);
    this.rpm += (rpmTarget - this.rpm) * Math.min(1, dt * (this.shiftCut > 0 ? 40 : 18));
    this.limiter = 0;
    if (this.rpm > eng.redline) { this.rpm = eng.redline; this.limiter = 1; }

    // gear changes
    if (v > 0.5) {
      if (this.rpm > eng.shift && this.gear < car.gears.length - 1 && this.throttle > 0.2) {
        this.gear++; this.shiftCut = 0.045; this.shiftEvent = 0.12; this.shiftDir = 1;
      } else if (this.gear > 0) {
        const lower = engineRpm(car, av, this.gear - 1);
        const downAt = this.brake > 0.2 ? eng.shift * 0.86 : eng.shift * 0.6;
        if (lower < downAt && this.rpm < eng.shift * 0.7) { this.gear--; this.shiftCut = 0.03; this.shiftEvent = 0.12; this.shiftDir = -1; }
      }
    } else if (v <= 0.5) {
      this.gear = 0;
    }

    let drive = 0;
    if (this.throttle > 0.01 && this.shiftCut <= 0) {
      const p = powerAt(car, Math.max(this.rpm, eng.idle * 1.5), Math.max(av, 1), this.boost);
      drive = this.throttle * Math.min(p / Math.max(av, 4), car.era === 'classic' ? 9000 : 16000);
      if (this.limiter) drive *= 0.2;
    }
    const latForce = m * Math.abs(latAcc);
    const cap = Math.sqrt(Math.max(0, (mu * N) ** 2 - latForce * latForce)) + 0.15 * mu * N;
    drive = Math.min(drive, cap * 0.62);
    const brakeCap = Math.min(car.brakeMax * this.brake, Math.sqrt(Math.max(0, (car.muBrake * muS * N) ** 2 - latForce * latForce)) + 0.1 * N);
    const drag = q * cda;
    const roll = crr * N;
    const gravity = m * G * gradeAlong;
    let reverse = 0;
    if (inp.brake > 0.5 && av < 0.6 && inp.throttle < 0.1) reverse = -4500;
    let F = drive - Math.sign(v) * (drag + roll + (av > 0.05 ? brakeCap : 0)) - gravity + reverse;
    let a = F / m;
    let vn = v + a * dt;
    // stopping must not reverse direction under braking alone
    if (v > 0 && vn < 0 && reverse === 0) vn = 0;
    if (v < 0 && inp.throttle > 0.1) vn = Math.min(0, v + 12 * dt);
    // the driver holds the car on the brakes when stopped, even on a 15% slope
    if (reverse === 0 && inp.throttle < 0.05 && Math.abs(vn) < 0.8 && Math.abs(v) < 0.8 && inp.brake < 0.5) vn = 0;
    vn = Math.max(vn, -6);
    this.lonAcc = (vn - v) / dt;
    this.v = vn;

    // Kinematics on the curvilinear frame
    const denom = Math.max(0.2, 1 - f.kL * this.d);
    const sdot = (this.v * Math.cos(this.psi)) / denom;
    this.d += this.v * Math.sin(this.psi) * dt;
    this.psi += (this.r - f.kL * sdot) * dt;
    this.psi = Math.atan2(Math.sin(this.psi), Math.cos(this.psi));
    const sPrev = this.s;
    this.s = tr.wrap(this.s + sdot * dt);
    this.lapDist += sdot * dt;

    // Walls
    this.wallHit = Math.max(0, this.wallHit - dt);
    const wl = tr.wallL[f.i] - 1.1, wr = -(tr.wallR[f.i] - 1.1);
    if (this.d > wl || this.d < wr) {
      const into = this.d > wl ? Math.sin(this.psi) : -Math.sin(this.psi);
      this.d = clamp(this.d, wr, wl);
      if (into > 0) {
        const impact = Math.abs(this.v) * into;
        this.psi *= -0.25;
        this.r *= 0.2;
        this.v *= 1 - clamp(impact / 60, 0.02, 0.5);
        this.wallHit = Math.min(1, impact / 25 + 0.2);
      }
    }
    this.crossedLine = this.crossedLine || this._crossed(sPrev, this.s, tr.startLine);
  }

  _crossed(a, b, line) {
    const L = this.track.length;
    const da = this.track.wrap(a - line), db = this.track.wrap(b - line);
    return da > L * 0.9 && db < L * 0.1;
  }

  // Autopilot: ride the racing line at the profile speed. Fills the same telemetry as driving.
  autopilot(dt) {
    const tr = this.track, car = this.car;
    const prof = this.profile.v;
    const n = tr.lineN, step = tr.lineStep;
    const sub = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / sub;
    for (let k = 0; k < sub; k++) {
      const u = this.s / step;
      const i = Math.floor(u) % n, j = (i + 1) % n, t = u - Math.floor(u);
      const vT = prof[i] + (prof[j] - prof[i]) * t;
      // ease onto the line and up to speed from wherever we are
      const dv = vT - this.v;
      // pulling away is limited by rear-tyre traction and power, as from a real standing start
      const vv = Math.max(this.v, 1);
      const qd = 0.5 * RHO * vv * vv;
      const launch = Math.min(car.mu * (G + (qd * car.ClA) / car.mass) * 0.72, powerAt(car, Math.max(this.rpm, car.engine.shift * 0.7), vv) / vv / car.mass, car.era === 'classic' ? 11 : 20);
      const acc = clamp(dv * 3, -48, Math.min(22, launch));
      const v0 = this.v;
      this.v = Math.max(0, this.v + acc * h);
      this.lonAcc = (this.v - v0) / h;
      const f = tr.frame(this.s, this.f);
      const dLine = tr.lineOffset(this.s);
      const dAhead = tr.lineOffset(this.s + Math.max(8, this.v * 0.35));
      const dTarget = dLine + (dAhead - dLine) * 0.15;
      // steer onto the line: aim the car's heading at it, and move sideways only by driving along that heading
      const lineSlope = (tr.lineOffset(this.s + 2) - tr.lineOffset(this.s - 2)) / 4;
      const denom = Math.max(0.2, 1 - f.kL * this.d);
      const look = Math.max(22, this.v * 0.7);
      const psiT = Math.atan(lineSlope / denom) + Math.atan2(dTarget - this.d, look);
      const psi0 = this.psi;
      // a car can only turn as it rolls: no faster than a tight hairpin's curvature allows at this speed
      const turn = (psiT - this.psi) * Math.min(1, h * 12), maxTurn = (this.v * h) / 7 + 1e-6;
      this.psi += clamp(turn, -maxTurn, maxTurn);
      this.d += this.v * Math.sin(this.psi) * h;
      const sdot = (this.v * Math.cos(this.psi)) / denom;
      const sPrev = this.s;
      this.s = tr.wrap(this.s + sdot * h);
      this.lapDist += sdot * h;
      const kLine = tr.lineK[i];
      this.r = (this.psi - psi0) / h + f.kL * sdot;
      this.latAcc = this.v * this.v * kLine;
      this.vertAcc = this.v * this.v * f.vcurv;
      // wheel angle from the path the car is actually taking, so it turns while it moves across
      const steerT = clamp(((this.r / Math.max(this.v, 3)) * car.wheelbase) / 0.36 * 2.2, -1, 1);
      this.steer += (steerT - this.steer) * Math.min(1, h * 10);
      // pedals and gears as a driver would use them
      this.throttle = acc > 0.5 ? clamp(0.55 + acc / 20, 0, 1) : acc > -2 ? 0.25 : 0;
      this.brake = acc < -6 ? clamp(-acc / 45, 0, 1) : 0;
      this.straightMode = car.CdAStraight && Math.abs(f.kL) < 1 / 1100 && this.throttle > 0.9 && this.v > 50;
      const eng = car.engine;
      this.shiftCut = Math.max(0, this.shiftCut - h);
      this.shiftEvent = Math.max(0, this.shiftEvent - h);
      let rpmT = engineRpm(car, this.v, this.gear);
      if (rpmT > eng.shift && this.gear < car.gears.length - 1) { this.gear++; this.shiftCut = 0.045; this.shiftEvent = 0.12; this.shiftDir = 1; }
      else if (this.gear > 0 && engineRpm(car, this.v, this.gear - 1) < (this.brake > 0 ? eng.shift * 0.88 : eng.shift * 0.62)) { this.gear--; this.shiftCut = 0.03; this.shiftEvent = 0.12; this.shiftDir = -1; }
      rpmT = Math.max(eng.idle, engineRpm(car, this.v, this.gear));
      if (this.gear === 0 && this.v < 30) rpmT = Math.max(rpmT, eng.idle + (eng.shift * 0.6 - eng.idle) * this.throttle);
      this.rpm += (rpmT - this.rpm) * Math.min(1, h * 25);
      this.surface = 'road'; this.kerb = Math.abs(this.d) > f.half - 0.2 ? 1 : 0;
      this.slip = 0; this.limiter = 0; this.wallHit = 0;
      this.crossedLine = this.crossedLine || this._crossed(sPrev, this.s, tr.startLine);
    }
  }
}
