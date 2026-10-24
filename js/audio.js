// All sound is synthesised: no audio files.

const WORKLET = `
class F1Engine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 4000, minValue: 0, maxValue: 26000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }
  constructor() {
    super();
    this.rpm = 4000; this.load = 0; this.phase = 0; this.next = 0; this.cycle = 0;
    this.carry = 0; this.nEnv = 0; this.pop = 0; this.lpBody = 0; this.dcx = 0; this.dcy = 0; this.pulse = 0;
    this.z = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    this.coef = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
    this.seed = 12345;
    this.configure({ cylinders: 6, redline: 12000, formants: [[420, 3, 1], [1150, 4, 0.6], [2600, 5, 0.25]], body: 0.8, noise: 0.25, drive: 1.6, pops: 0.04, gain: 0.5, jitter: 0.002, alt: 0.05, pulse: 0.0004 });
    this.port.onmessage = (e) => this.configure(e.data);
  }
  rand() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
  configure(c) {
    this.cfg = Object.assign({}, this.cfg || {}, c);
    const n = this.cfg.cylinders;
    this.offsets = []; this.amps = [];
    for (let k = 0; k < n; k++) {
      this.offsets.push(k / n + (this.rand() - 0.5) * this.cfg.jitter);
      this.amps.push((1 - this.cfg.alt * (k % 2)) * (0.94 + this.rand() * 0.12));
    }
    this.next = 0; this.cycle = Math.floor(this.phase);
  }
  bandpass(i, f, q) {
    const w = 2 * Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate;
    const al = Math.sin(w) / (2 * q), cs = Math.cos(w), a0 = 1 + al;
    const c = this.coef[i];
    c[0] = al / a0; c[1] = 0; c[2] = -al / a0; c[3] = -2 * cs / a0; c[4] = (1 - al) / a0;
  }
  process(_, outputs, params) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const cfg = this.cfg;
    const rpmT = params.rpm[0], loadT = params.load[0], pitch = params.pitch[0], cut = params.cut[0];
    const bright = 1 + 0.18 * this.load + 0.12 * (this.rpm / cfg.redline);
    for (let i = 0; i < 3; i++) this.bandpass(i, cfg.formants[i][0] * bright * pitch, cfg.formants[i][1]);
    const n = cfg.cylinders;
    const nDecay = Math.exp(-1 / (sampleRate * 0.0009));
    // each firing is an exhaust pressure pulse that dies away over a fraction of a millisecond
    const pulseDecay = Math.exp(-1 / (sampleRate * cfg.pulse));
    const pDecay = Math.exp(-1 / (sampleRate * 0.012));
    for (let s = 0; s < L.length; s++) {
      this.rpm += (rpmT - this.rpm) * 0.004;
      this.load += (loadT - this.load) * 0.003;
      const dphi = (this.rpm / 60) * pitch / 2 / sampleRate;
      this.phase += dphi;
      let x = this.carry; this.carry = 0;
      // fire every cylinder whose slot we just passed
      for (let guard = 0; guard < 4; guard++) {
        const pos = this.cycle + this.offsets[this.next];
        if (this.phase < pos) break;
        const frac = Math.min(1, (this.phase - pos) / Math.max(dphi, 1e-9));
        let a = this.amps[this.next] * (0.32 + 0.68 * this.load) * (1 - 0.85 * cut);
        if (cut > 0.5 && this.rand() < 0.5) a *= 0.1;
        x += a * (1 - frac); this.carry += a * frac;
        this.nEnv = Math.max(this.nEnv, a);
        if (this.load < 0.08 && this.rpm > cfg.redline * 0.45 && this.rand() < cfg.pops) this.pop = 0.6 + this.rand() * 0.8;
        this.next++;
        if (this.next >= n) { this.next = 0; this.cycle++; }
      }
      if (this.phase > 1e6) { this.phase -= this.cycle; this.cycle = 0; }
      this.pulse = this.pulse * pulseDecay + x;
      const noise = this.rand() * 2 - 1;
      const e = this.pulse + noise * (this.nEnv * cfg.noise + this.pop * 0.9);
      this.nEnv *= nDecay; this.pop *= pDecay;
      let y = 0;
      for (let k = 0; k < 3; k++) {
        const c = this.coef[k], z = this.z[k];
        const o = c[0] * e + c[1] * z[0] + c[2] * z[1] - c[3] * z[2] - c[4] * z[3];
        z[1] = z[0]; z[0] = e; z[3] = z[2]; z[2] = o;
        y += o * cfg.formants[k][2];
      }
      this.lpBody += (this.pulse - this.lpBody) * 0.12;
      y += this.lpBody * cfg.body;
      y = Math.tanh(y * cfg.drive) * cfg.gain;
      // DC blocker
      const dc = y - this.dcx + 0.995 * this.dcy; this.dcx = y; this.dcy = dc;
      L[s] = dc; R[s] = dc;
    }
    return true;
  }
}
registerProcessor('f1-engine', F1Engine);
`;

const VOICES = {
  v6: { cylinders: 6, formants: [[380, 1.8, 1.0], [1050, 2.4, 0.7], [2500, 3.2, 0.32]], body: 0.55, noise: 0.22, drive: 1.3, pops: 0.03, gain: 0.32, jitter: 0.002, alt: 0.04, pulse: 0.00045 },
  v10: { cylinders: 10, formants: [[760, 1.6, 0.85], [2100, 2.0, 0.85], [4600, 2.6, 0.55]], body: 0.35, noise: 0.14, drive: 1.6, pops: 0.015, gain: 0.3, jitter: 0.003, alt: 0.03, pulse: 0.00022 },
  v8: { cylinders: 8, formants: [[300, 1.6, 1.0], [900, 2.2, 0.75], [2300, 2.8, 0.45]], body: 0.7, noise: 0.36, drive: 2.0, pops: 0.07, gain: 0.32, jitter: 0.004, alt: 0.12, pulse: 0.00035 }
};

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.ready = false;
    this.onboard = false;
    this.lastShift = 0;
    this.prevLoad = 0;
    this.night = 0;
    this.muted = false;
  }

  async init() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled && !this.muted ? 0.9 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);
    this.comp = comp;
    // noise source shared by everything
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // engine chain
    this.engine = new AudioWorkletNode(ctx, 'f1-engine', { numberOfInputs: 0, outputChannelCount: [2] });
    this.voiceLP = ctx.createBiquadFilter(); this.voiceLP.type = 'lowpass'; this.voiceLP.frequency.value = 9000; this.voiceLP.Q.value = 0.5;
    this.voiceShelf = ctx.createBiquadFilter(); this.voiceShelf.type = 'lowshelf'; this.voiceShelf.frequency.value = 220; this.voiceShelf.gain.value = 0;
    this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.engine.connect(this.voiceShelf).connect(this.voiceLP).connect(this.engineGain).connect(this.pan).connect(this.master);

    // turbo whistle and hybrid / gear whine
    this.turbo = this._osc('sine', 3000, 0);
    this.mgu = this._osc('sine', 1500, 0);
    this.gearWhine = this._osc('triangle', 3000, 0);
    this.hiss = this._noise('bandpass', 5200, 1.2, 0);
    // tyres, wind, kerbs, grass, squeal
    this.road = this._noise('bandpass', 520, 0.6, 0);
    this.wind = this._noise('lowpass', 600, 0.4, 0);
    this.squeal = this._noise('bandpass', 1150, 7, 0);
    this.grass = this._noise('bandpass', 2300, 0.9, 0);
    this.kerb = this._noise('lowpass', 170, 0.8, 0);
    this.kerbLfo = ctx.createOscillator(); this.kerbLfo.type = 'square'; this.kerbLfo.frequency.value = 30;
    this.kerbDepth = ctx.createGain(); this.kerbDepth.gain.value = 0;
    this.kerbLfo.connect(this.kerbDepth).connect(this.kerb.gain.gain);
    this.kerbLfo.start();
    // ambience
    this.amb = ctx.createGain(); this.amb.gain.value = 0.9; this.amb.connect(this.master);
    this.crowd = this._noise('bandpass', 750, 0.6, 0, this.amb);
    this.crickets = this._osc('sine', 4400, 0, this.amb);
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 22;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth).connect(this.crickets.gain.gain); lfo.start();
    this.cricketDepth = lfoDepth;
    this.setCar({ engine: { type: 'v6', redline: 12400 } });
    this.ready = true;
    this._scheduleBirds();
  }

  _osc(type, f, g, dest = this.master) {
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = f;
    const gain = this.ctx.createGain(); gain.gain.value = g;
    o.connect(gain).connect(dest); o.start();
    return { osc: o, gain };
  }

  _noise(type, f, q, g, dest = this.master) {
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const flt = this.ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = q;
    const gain = this.ctx.createGain(); gain.gain.value = g;
    src.connect(flt).connect(gain).connect(dest); src.start();
    return { src, flt, gain };
  }

  setCar(car) {
    this.car = car;
    if (!this.engine) return;
    const v = VOICES[car.engine.type] || VOICES.v6;
    this.engine.port.postMessage({ ...v, redline: car.engine.redline });
    this.voice = car.engine;
  }

  setEnabled(on) {
    this.enabled = on;
    this._applyGain();
  }

  // the menu is silent; the on/off choice is kept for when driving resumes
  setMuted(m) {
    this.muted = m;
    this._applyGain();
  }

  _applyGain() {
    if (this.master) this.master.gain.setTargetAtTime(this.enabled && !this.muted ? 0.9 : 0, this.ctx.currentTime, 0.12);
  }

  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); }

  // listener: { onboard, dist, doppler, pan, crowd, lake }
  update(veh, listener, env) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const set = (param, v, tau = 0.04) => param.setTargetAtTime(v, t, tau);
    const eng = this.voice;
    const speed = Math.abs(veh.v);
    const onboard = listener.onboard;
    const P = this.engine.parameters;
    const load = veh.limiter ? 0.3 : veh.shiftCut > 0 ? 0 : veh.throttle;
    set(P.get('rpm'), veh.rpm, 0.012);
    set(P.get('load'), load, 0.02);
    set(P.get('pitch'), listener.doppler, 0.05);
    set(P.get('cut'), veh.shiftCut > 0 || veh.limiter ? 1 : 0, 0.005);
    // voicing: onboard is darker with more intake; outside depends on distance
    const dist = listener.dist;
    // trackside mix in the style of TV sound: distance softens the engine but never loses it
    const att = onboard ? 1 : Math.min(1.3, Math.max(0.12, Math.pow(25 / Math.max(8, dist), 0.75)));
    set(this.engineGain.gain, (onboard ? 0.85 : 1.0) * att * (0.55 + 0.45 * Math.min(1, veh.throttle + 0.3)), 0.03);
    set(this.voiceLP.frequency, onboard ? 5200 + veh.throttle * 1800 : Math.max(900, 15000 / (1 + dist / 140)), 0.05);
    set(this.voiceShelf.gain, onboard ? 5 : 0, 0.1);
    set(this.pan.pan, onboard ? 0 : listener.pan, 0.05);
    const rpmF = veh.rpm / eng.redline;
    const near = onboard ? 1 : att;
    // turbo and hybrid
    const boost = this.car.engine.turbo ? Math.max(0, rpmF - 0.35) * (0.25 + veh.throttle * 0.75) : 0;
    set(this.turbo.osc.frequency, (2400 + boost * 5200) * listener.doppler, 0.08);
    set(this.turbo.gain.gain, boost * 0.035 * near, 0.08);
    set(this.hiss.gain.gain, boost * 0.05 * near, 0.08);
    if (this.car.engine.turbo && this.prevLoad > 0.7 && veh.throttle < 0.2 && rpmF > 0.6) this._burst(4200, 0.5, 0.12 * near, 0.18);
    this.prevLoad = veh.throttle;
    const hybrid = this.car.engine.hybrid ? 1 : 0;
    set(this.mgu.osc.frequency, (900 + speed * 38) * listener.doppler, 0.05);
    set(this.mgu.gain.gain, hybrid * (0.004 + veh.brake * 0.02 + veh.throttle * 0.006) * (onboard ? 1 : near * 0.5), 0.05);
    set(this.gearWhine.osc.frequency, (veh.rpm / 60) * 21 * listener.doppler, 0.02);
    set(this.gearWhine.gain.gain, onboard ? 0.006 + veh.throttle * 0.004 : 0, 0.05);
    // tyres and air
    const roll = Math.min(1, speed / 80);
    set(this.road.gain.gain, roll * (onboard ? 0.09 : 0.08 * near), 0.06);
    set(this.road.flt.frequency, 380 + speed * 7, 0.1);
    set(this.wind.gain.gain, Math.pow(roll, 2) * (onboard ? 0.12 : 0.04 * near), 0.06);
    set(this.wind.flt.frequency, 300 + speed * 26, 0.1);
    set(this.squeal.gain.gain, Math.min(1, veh.slip * 2) * Math.min(1, speed / 15) * 0.12 * near, 0.04);
    set(this.grass.gain.gain, veh.surface === 'grass' ? Math.min(1, speed / 20) * 0.28 * near : 0, 0.04);
    const onKerb = veh.kerb && speed > 3;
    set(this.kerbLfo.frequency, Math.max(5, speed / 1.0), 0.02);
    set(this.kerb.gain.gain, onKerb ? 0.35 * near : 0, 0.02);
    set(this.kerbDepth.gain, onKerb ? 0.35 * near : 0, 0.02);
    if (veh.shiftEvent > 0.1 && t - this.lastShift > 0.08) {
      this.lastShift = t;
      if (onboard) this._burst(2600, 3, 0.18, 0.025);
    }
    if (veh.wallHit > 0.6 && t - (this.lastHit || 0) > 0.4) { this.lastHit = t; this._thud(veh.wallHit); }
    // ambience
    this.night = env.night;
    set(this.crowd.gain.gain, env.crowd * (0.06 + 0.04 * Math.sin(t * 0.3)), 0.4);
    set(this.crickets.gain.gain, env.night * 0.004, 0.5);
    set(this.cricketDepth.gain, env.night * 0.004, 0.5);
    set(this.amb.gain, 1 - Math.min(0.7, speed / 90) * (onboard ? 1 : 0.4), 0.3);
    this.lakeNear = env.lake;
  }

  _burst(freq, q, gain, len) {
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random()); src.stop(t + len + 0.05);
  }

  _thud(k) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.25);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.5 * k, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.4);
    this._burst(900, 0.7, 0.35 * k, 0.25);
  }

  // Birds by day, frogs by the lake at night
  _scheduleBirds() {
    const tick = () => {
      if (!this.ctx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      if (this.enabled && this.night < 0.5) {
        const notes = 2 + Math.floor(Math.random() * 4);
        const base = 2400 + Math.random() * 2600;
        const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 2 - 1;
        pan.connect(this.amb);
        for (let i = 0; i < notes; i++) {
          const o = ctx.createOscillator(); o.type = 'sine';
          const g = ctx.createGain();
          const st = t + i * (0.09 + Math.random() * 0.06);
          o.frequency.setValueAtTime(base * (1 + Math.random() * 0.2), st);
          o.frequency.exponentialRampToValueAtTime(base * (0.7 + Math.random() * 0.6), st + 0.07);
          g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(0.012, st + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, st + 0.08);
          o.connect(g).connect(pan); o.start(st); o.stop(st + 0.1);
        }
      } else if (this.enabled && this.lakeNear > 0.2) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 170 + Math.random() * 90;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.02 * this.lakeNear, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        o.connect(f).connect(g).connect(this.amb); o.start(t); o.stop(t + 0.3);
      }
      setTimeout(tick, 600 + Math.random() * 2600);
    };
    tick();
  }
}
