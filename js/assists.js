import { clamp, smoothstep } from './noise.js';

// Driving help, from most to least. The hot lap autopilot ignores all of this.
export const LEVELS = {
  beginner: {
    label: 'Beginner', line: 'full', steer: 1, brake: true, tc: true, edge: 1, recover: true,
    summary: 'Racing line, steering and braking help, traction control, auto recovery'
  },
  intermediate: {
    label: 'Intermediate', line: 'braking', steer: 0, brake: false, tc: true, edge: 0.6, recover: true,
    summary: 'Braking zones marked, traction control, help at the track edge, auto recovery'
  },
  advanced: {
    label: 'Advanced', line: 'off', steer: 0, brake: false, tc: false, edge: 0, recover: false,
    summary: 'No help'
  }
};
export const LEVEL_ORDER = ['beginner', 'intermediate', 'advanced'];

export class Assists {
  constructor() {
    this.level = 'beginner';
    this.stuckFor = 0;
    this.offFor = 0;
    this.shift = 0;
    this.recovered = 0;
    this.out = { throttle: 0, brake: 0, steer: 0, boost: false, analog: false, active: false };
  }

  get cfg() { return LEVELS[this.level]; }

  // Target speed on the racing line here, cut back when the car is off the line
  targetSpeed(v, margin) {
    const tr = v.track, prof = v.profile.v, n = prof.length, step = tr.lineStep;
    const at = (s) => {
      const u = tr.wrap(s) / step, i = Math.floor(u) % n, j = (i + 1) % n, t = u - Math.floor(u);
      return prof[i] + (prof[j] - prof[i]) * t;
    };
    const offLine = Math.abs(v.d - tr.lineOffset(v.s));
    const cut = 1 - Math.min(0.25, offLine * 0.03);
    return Math.min(at(v.s), at(v.s + 5)) * margin * cut;
  }

  // Steering that follows the racing line: aim at a point on the line ahead (pure pursuit).
  // shift moves the aim left (+) or right of the line, kept inside the white lines.
  lineSteer(v, shift = 0) {
    const tr = v.track, car = v.car;
    const av = Math.max(Math.abs(v.v), 1);
    const La = clamp(av * 0.42, 9, 42);
    const lim = tr.frame(v.s + La).half - 1.3;
    const dAhead = clamp(tr.lineOffset(v.s + La) + shift, -lim, lim);
    const alpha = Math.atan2(dAhead - v.d, La) - v.psi;
    const iK = Math.floor(tr.wrap(v.s + La * 0.4) / tr.lineStep) % tr.lineN;
    const kappa = tr.lineK[iK] + (2 * Math.sin(alpha)) / La;
    const maxLock = (car.era === 'classic' ? 0.42 : 0.36) / (1 + av * av * 0.00011);
    return clamp(Math.atan(kappa * car.wheelbase) / maxLock, -1, 1);
  }

  // Returns the input the car should get, given what the driver pressed
  apply(v, inp, dt) {
    const c = this.cfg, o = this.out;
    o.throttle = inp.throttle; o.brake = inp.brake; o.steer = inp.steer; o.boost = inp.boost; o.analog = inp.analog; o.active = inp.active;
    const tr = v.track, f = tr.frame(v.s);
    const av = Math.abs(v.v);
    if (c.steer > 0 && v.v > 2) {
      // steering moves the car up to 3 m either side of the racing line, never off the track
      this.shift += (inp.steer * 3 - this.shift) * Math.min(1, dt * 2.5);
      o.steer = this.lineSteer(v, this.shift);
      o.analog = true;
    }
    if (c.edge > 0 && v.v > 5) {
      // nudge back when running wide towards the edge, harder once over it
      const half = f.half, d = v.d, out = Math.sign(d);
      const near = smoothstep(half - 2.2, half + 1.5, Math.abs(d));
      const heading = Math.sin(v.psi) * out; // > 0 = heading off the track
      if (near > 0 && heading > -0.05) {
        o.steer = clamp(o.steer - out * near * c.edge * (0.4 + Math.max(0, heading) * 5), -1, 1);
        o.analog = true;
      }
    }
    if (c.brake && v.v > 3) {
      const vT = this.targetSpeed(v, 0.93);
      if (v.v > vT + 0.4) {
        o.throttle = 0;
        o.brake = Math.max(inp.brake, clamp((v.v - vT) / 5, 0.2, 1));
      } else if (v.v > vT - 1.5) {
        o.throttle = Math.min(o.throttle, 0.35);
      }
    }
    if (c.tc) {
      // ease off the power when the tyres are sliding or the car is on the grass
      const slide = Math.max(v.slip * 2.2, v.surface === 'grass' ? 0.35 : 0);
      if (slide > 0) o.throttle *= clamp(1 - slide, 0.3, 1);
    }
    // stuck off the track, against a wall or facing the wrong way: put the car back on the line
    this.recovered = Math.max(0, this.recovered - dt);
    if (c.recover) {
      const offTrack = Math.abs(v.d) > f.half + 1.5 && !tr.inPitArea(v.s, v.d);
      const backwards = Math.cos(v.psi) < -0.2;
      const stuck = (av < 2.5 && (offTrack || v.wallHit > 0)) || backwards;
      this.stuckFor = stuck ? this.stuckFor + dt : 0;
      this.offFor = offTrack ? this.offFor + dt : 0;
      if (this.stuckFor > 2.2 || this.offFor > 3) {
        // back on the line facing the right way, keeping some speed if the car was still moving
        const keep = this.stuckFor > 2.2 ? 0 : Math.min(av, this.targetSpeed(v, 0.6));
        this.stuckFor = this.offFor = 0;
        const s = tr.wrap(v.s), dist = v.lapDist;
        v.reset(s, tr.lineOffset(s));
        v.v = keep;
        v.lapDist = dist;
        this.recovered = 2.5;
      }
    }
    return o;
  }
}
