// Keyboard, gamepad and touch merged into one control state
const BIND = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown', 'Space'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  boost: ['ShiftLeft', 'ShiftRight']
};

const isTyping = (e) => {
  const t = e.target;
  return t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
};

export class Input {
  constructor() {
    this.down = new Set();
    this.touch = { steer: 0, throttle: 0, brake: 0 };
    this.state = { throttle: 0, brake: 0, steer: 0, boost: false, analog: false, active: false };
    this.onKey = null;
    const codes = new Set(Object.values(BIND).flat());
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (codes.has(e.code)) { e.preventDefault(); this.down.add(e.code); }
      if (!e.repeat && this.onKey) this.onKey(e);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.down.clear(); });
  }

  bindTouch(root) {
    const steer = root.querySelector('#touch-steer'), knob = root.querySelector('#touch-knob');
    const thr = root.querySelector('#touch-thr'), brk = root.querySelector('#touch-brake');
    let sid = null;
    const setSteer = (e) => {
      const r = steer.getBoundingClientRect();
      const t = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      this.touch.steer = -t;
      knob.style.transform = `translateX(${t * (r.width / 2 - 30)}px)`;
    };
    steer.addEventListener('pointerdown', (e) => { sid = e.pointerId; steer.setPointerCapture(sid); setSteer(e); });
    steer.addEventListener('pointermove', (e) => { if (e.pointerId === sid) setSteer(e); });
    const endSteer = () => { sid = null; this.touch.steer = 0; knob.style.transform = ''; };
    steer.addEventListener('pointerup', endSteer);
    steer.addEventListener('pointercancel', endSteer);
    const pedal = (el, key) => {
      el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); this.touch[key] = 1; el.classList.add('down'); });
      const off = () => { this.touch[key] = 0; el.classList.remove('down'); };
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
    };
    pedal(thr, 'throttle');
    pedal(brk, 'brake');
  }

  poll() {
    const k = (a) => BIND[a].some((c) => this.down.has(c));
    let throttle = k('throttle') ? 1 : 0;
    let brake = k('brake') ? 1 : 0;
    let steer = (k('left') ? 1 : 0) - (k('right') ? 1 : 0);
    let boost = k('boost');
    let analog = false;
    throttle = Math.max(throttle, this.touch.throttle);
    brake = Math.max(brake, this.touch.brake);
    if (this.touch.steer) { steer = this.touch.steer; analog = true; }
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = p.axes[0] || 0;
      if (Math.abs(ax) > 0.08) { steer = -Math.sign(ax) * Math.pow((Math.abs(ax) - 0.08) / 0.92, 1.4); analog = true; }
      const rt = p.buttons[7]?.value || 0, lt = p.buttons[6]?.value || 0;
      if (rt > 0.02) throttle = Math.max(throttle, rt);
      if (lt > 0.02) brake = Math.max(brake, lt);
      if (p.buttons[0]?.pressed) throttle = Math.max(throttle, 1);
      if (p.buttons[1]?.pressed) brake = Math.max(brake, 1);
      if (p.buttons[5]?.pressed || p.buttons[4]?.pressed) boost = true;
      this._padButtons(p);
    }
    const s = this.state;
    s.throttle = throttle; s.brake = brake; s.steer = steer; s.boost = boost; s.analog = analog;
    s.active = throttle > 0 || brake > 0 || Math.abs(steer) > 0.05;
    return s;
  }

  // Gamepad: Y camera, X hot lap, Back reset
  _padButtons(p) {
    this._prev = this._prev || {};
    const map = { 3: 'KeyV', 2: 'KeyP', 8: 'KeyR', 9: 'KeyT' };
    for (const [b, code] of Object.entries(map)) {
      const on = !!p.buttons[b]?.pressed;
      if (on && !this._prev[b] && this.onKey) this.onKey({ code, repeat: false, preventDefault() {} });
      this._prev[b] = on;
    }
  }
}
