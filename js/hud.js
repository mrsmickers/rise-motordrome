import { BASE_ALT } from './track.js';

const $ = (id) => document.getElementById(id);
const fmt = (t) => {
  if (!isFinite(t) || t <= 0) return '--:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};
const nf = new Intl.NumberFormat('en-GB');

export class Hud {
  constructor(track) {
    this.track = track;
    this.el = {
      root: $('hud'), lap: $('hud-lap'), last: $('hud-last'), best: $('hud-best'), s: [$('hud-s1'), $('hud-s2'), $('hud-s3')],
      speed: $('hud-speed'), gear: $('hud-gear'), rpm: $('hud-rpm'), thr: $('hud-thr'), brk: $('hud-brk'),
      alt: $('hud-alt'), grad: $('hud-grad'), bank: $('hud-bank'), corner: $('hud-corner'), mode: $('hud-mode'),
      cam: $('hud-cam'), car: $('hud-car-name'), hint: $('hud-hint'), lights: $('shift-lights')
    };
    for (let i = 0; i < 15; i++) this.el.lights.appendChild(document.createElement('i'));
    this.lightEls = [...this.el.lights.children];
    this.map = $('map-canvas'); this.mapCtx = this.map.getContext('2d');
    this.prof = $('profile-canvas'); this.profCtx = this.prof.getContext('2d');
    this.g = $('g-canvas'); this.gCtx = this.g.getContext('2d');
    this._prepareMap();
    this._prepareProfile();
    this.lapStart = null;
    this.sectorStart = null;
    this.sector = 0;
    this.sectorTimes = [null, null, null];
    this.bestSectors = [Infinity, Infinity, Infinity];
    this.best = Infinity;
    this.cornerShown = null;
    this.frame = 0;
  }

  setCar(car) {
    this.carId = car.id;
    this.el.car.textContent = `${car.eraLabel} · ${car.name}`;
    try { this.best = Number(localStorage.getItem('rise-best-' + car.id)) || Infinity; } catch { this.best = Infinity; }
    this.el.best.textContent = fmt(this.best);
    this.resetLap();
  }

  resetLap() {
    this.lapStart = null; this.sectorStart = null; this.sector = 0;
    this.sectorTimes = [null, null, null];
    this.el.s.forEach((e, i) => { e.className = 'sec'; e.textContent = `S${i + 1}`; });
    this.el.lap.textContent = fmt(0);
  }

  _prepareMap() {
    const tr = this.track, c = this.map, g = this.mapCtx;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let i = 0; i < tr.M; i += 10) { minX = Math.min(minX, tr.px[i]); maxX = Math.max(maxX, tr.px[i]); minZ = Math.min(minZ, tr.pz[i]); maxZ = Math.max(maxZ, tr.pz[i]); }
    const pad = 24, sc = Math.min((c.width - pad * 2) / (maxX - minX), (c.height - pad * 2) / (maxZ - minZ));
    this.mapT = { sc, ox: c.width / 2 - ((minX + maxX) / 2) * sc, oz: c.height / 2 - ((minZ + maxZ) / 2) * sc };
    const P = (i) => [tr.px[i] * sc + this.mapT.ox, tr.pz[i] * sc + this.mapT.oz];
    const base = document.createElement('canvas'); base.width = c.width; base.height = c.height;
    const b = base.getContext('2d');
    b.lineCap = b.lineJoin = 'round';
    b.strokeStyle = 'rgba(0,0,0,0.45)'; b.lineWidth = 11;
    b.beginPath(); for (let i = 0; i < tr.M; i += 6) { const [x, z] = P(i); i ? b.lineTo(x, z) : b.moveTo(x, z); } b.closePath(); b.stroke();
    // colour by altitude: low = lake blue, high = sun yellow
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < tr.M; i++) { lo = Math.min(lo, tr.py[i]); hi = Math.max(hi, tr.py[i]); }
    this.altRange = [lo, hi];
    b.lineWidth = 6;
    for (let i = 0; i < tr.M; i += 6) {
      const t = (tr.py[i] - lo) / (hi - lo);
      b.strokeStyle = `hsl(${200 - t * 150}, ${70 + t * 20}%, ${48 + t * 8}%)`;
      const [x0, z0] = P(i), [x1, z1] = P((i + 7) % tr.M);
      b.beginPath(); b.moveTo(x0, z0); b.lineTo(x1, z1); b.stroke();
    }
    // start line and corner numbers
    const sl = Math.round(tr.startLine) % tr.M;
    const [sx, sz] = P(sl);
    b.fillStyle = '#fff'; b.beginPath(); b.arc(sx, sz, 5, 0, Math.PI * 2); b.fill();
    b.font = '600 15px "Barlow Condensed", sans-serif'; b.textAlign = 'center'; b.textBaseline = 'middle';
    for (const cn of tr.corners) {
      const i = Math.round(cn.s) % tr.M;
      const out = cn.dir === 'L' ? -1 : 1;
      const x = tr.px[i] + tr.lx[i] * out * 55, z = tr.pz[i] + tr.lz[i] * out * 55;
      b.fillStyle = 'rgba(242,245,248,0.75)';
      b.fillText(String(cn.n), x * sc + this.mapT.ox, z * sc + this.mapT.oz);
    }
    this.mapBase = base;
  }

  _prepareProfile() {
    const tr = this.track, c = this.prof;
    const base = document.createElement('canvas'); base.width = c.width; base.height = c.height;
    const b = base.getContext('2d');
    const [lo, hi] = this.altRange;
    const W = c.width, H = c.height, top = 14, bot = H - 8;
    const X = (s) => (tr.wrap(s - tr.startLine) / tr.length) * W;
    const Y = (y) => bot - ((y - lo) / (hi - lo)) * (bot - top);
    const grad = b.createLinearGradient(0, top, 0, bot);
    grad.addColorStop(0, 'rgba(250,210,1,0.55)'); grad.addColorStop(1, 'rgba(0,161,222,0.12)');
    b.beginPath(); b.moveTo(0, bot);
    for (let k = 0; k <= 400; k++) { const s = tr.startLine + (k / 400) * tr.length; b.lineTo(X(s) || (k ? W : 0), Y(tr.get(tr.py, s))); }
    b.lineTo(W, bot); b.closePath(); b.fillStyle = grad; b.fill();
    b.beginPath();
    for (let k = 0; k <= 400; k++) { const s = tr.startLine + (k / 400) * tr.length; const x = k === 400 ? W : X(s); k ? b.lineTo(x, Y(tr.get(tr.py, s))) : b.moveTo(x, Y(tr.get(tr.py, s))); }
    b.strokeStyle = 'rgba(255,255,255,0.85)'; b.lineWidth = 2; b.stroke();
    b.fillStyle = 'rgba(242,245,248,0.7)'; b.font = '600 18px "Barlow Condensed", sans-serif';
    b.textAlign = 'left'; b.fillText(`${nf.format(Math.round(hi + BASE_ALT))} m`, 6, 18);
    b.fillText(`${nf.format(Math.round(lo + BASE_ALT))} m`, 6, H - 12);
    this.profBase = base;
    this.profX = X; this.profY = Y;
  }

  // Lap and sector timing; returns true when a lap completes
  timing(now, veh, crossed) {
    const tr = this.track;
    if (crossed) {
      if (this.lapStart !== null && this.sector === 2) {
        const lap = now - this.lapStart;
        this._closeSector(2, now);
        this.el.last.textContent = fmt(lap);
        if (lap < this.best) {
          this.best = lap;
          this.el.best.textContent = fmt(lap);
          try { localStorage.setItem('rise-best-' + this.carId, String(lap)); } catch { /* storage may be blocked */ }
        }
      }
      this.lapStart = now; this.sectorStart = now; this.sector = 0;
      this.el.s.forEach((e, i) => { e.className = i === 0 ? 'sec live' : 'sec'; e.textContent = `S${i + 1}`; });
    }
    if (this.lapStart !== null) {
      const sec = tr.sectorAt(veh.s);
      if (sec === this.sector + 1) { this._closeSector(this.sector, now); this.sector = sec; this.el.s[sec].className = 'sec live'; }
      this.el.lap.textContent = fmt(now - this.lapStart);
    }
  }

  _closeSector(i, now) {
    const t = now - this.sectorStart;
    this.sectorStart = now;
    const el = this.el.s[i];
    const cls = t < this.bestSectors[i] ? 'purple' : 'yellow';
    if (t < this.bestSectors[i]) this.bestSectors[i] = t;
    el.className = 'sec ' + cls;
    el.textContent = t.toFixed(1);
  }

  update(veh, car, camLabel, modeText) {
    this.frame++;
    const e = this.el;
    const kmh = Math.round(Math.abs(veh.v) * 3.6);
    e.speed.textContent = kmh;
    e.gear.textContent = veh.v < -0.3 ? 'R' : kmh < 1 && veh.throttle < 0.05 ? 'N' : String(veh.gear + 1);
    e.rpm.textContent = nf.format(Math.round(veh.rpm / 10) * 10);
    e.thr.style.width = `${Math.round(veh.throttle * 100)}%`;
    e.brk.style.width = `${Math.round(veh.brake * 100)}%`;
    const f = this.track.frame(veh.s);
    const h = this.track.heightAt(veh.s, veh.d, f);
    e.alt.textContent = `${nf.format(Math.round(h + BASE_ALT))} m`;
    e.grad.textContent = `${(f.grade * 100).toFixed(1)}%`;
    e.bank.textContent = `${(Math.abs(f.bank) * 100).toFixed(1)}%`;
    if (camLabel !== this._cam) { e.cam.textContent = camLabel; this._cam = camLabel; }
    if (modeText !== this._mode) { e.mode.textContent = modeText; this._mode = modeText; }
    // shift lights fill from 60% of the shift point
    const eng = car.engine;
    const frac = Math.max(0, Math.min(1, (veh.rpm - eng.shift * 0.62) / (eng.shift - eng.shift * 0.62)));
    const lit = Math.round(frac * 15);
    const flash = veh.rpm > eng.shift * 0.99 && Math.floor(performance.now() / 70) % 2;
    this.lightEls.forEach((l, i) => { l.className = flash ? 'b' : i < lit ? (i < 5 ? 'g' : i < 10 ? 'r' : 'b') : ''; });
    // next corner
    const nc = this.track.nextCorner(veh.s, 420);
    const key = nc ? nc.corner.n : null;
    if (nc) {
      const dist = Math.max(0, Math.round(nc.distance / 10) * 10);
      const label = nc.corner.name.replace(/^Turn \d+ ?·? ?/, '');
      const html = `<b>T${nc.corner.n}</b>${label || nc.corner.dir === 'L' ? (label || 'Left') : 'Right'}${nc.distance > 15 ? `<span class="dist">${dist} m</span>` : ''}`;
      if (html !== this._cornerHtml) { e.corner.innerHTML = html; this._cornerHtml = html; }
    }
    e.corner.classList.toggle('show', !!key);
    if (this.frame % 2 === 0) { this._drawMap(veh); this._drawProfile(veh); this._drawG(veh); }
  }

  _drawMap(veh) {
    const g = this.mapCtx, c = this.map, tr = this.track;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(this.mapBase, 0, 0);
    const f = tr.frame(veh.s);
    const x = (f.x + f.lx * veh.d) * this.mapT.sc + this.mapT.ox, z = (f.z + f.lz * veh.d) * this.mapT.sc + this.mapT.oz;
    g.fillStyle = 'rgba(250,210,1,0.25)'; g.beginPath(); g.arc(x, z, 15, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fad201'; g.strokeStyle = '#0b1016'; g.lineWidth = 3;
    g.beginPath(); g.arc(x, z, 7, 0, Math.PI * 2); g.fill(); g.stroke();
  }

  _drawProfile(veh) {
    const g = this.profCtx, c = this.prof, tr = this.track;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(this.profBase, 0, 0);
    const x = this.profX(veh.s), y = this.profY(tr.get(tr.py, veh.s));
    g.strokeStyle = 'rgba(250,210,1,0.8)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, 8); g.lineTo(x, c.height - 6); g.stroke();
    g.fillStyle = '#fad201'; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
  }

  _drawG(veh) {
    const g = this.gCtx, W = this.g.width, r = W / 2 - 8;
    g.clearRect(0, 0, W, W);
    g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 2;
    for (const k of [1, 0.5]) { g.beginPath(); g.arc(W / 2, W / 2, r * k, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(W / 2 - r, W / 2); g.lineTo(W / 2 + r, W / 2); g.moveTo(W / 2, W / 2 - r); g.lineTo(W / 2, W / 2 + r); g.stroke();
    const gx = Math.max(-1, Math.min(1, -veh.latAcc / 9.81 / 5)), gy = Math.max(-1, Math.min(1, -veh.lonAcc / 9.81 / 5));
    g.fillStyle = '#fad201';
    g.beginPath(); g.arc(W / 2 + gx * r, W / 2 + gy * r, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(242,245,248,0.8)'; g.font = '600 20px "Barlow Condensed", sans-serif'; g.textAlign = 'center';
    const tot = Math.hypot(veh.latAcc, veh.lonAcc) / 9.81;
    g.fillText(`${tot.toFixed(1)}g`, W / 2, W - 2);
  }

  hint(html) { this.el.hint.innerHTML = html; }
}
