// On-screen controls for phones and tablets: a floating stick under the left thumb (pitch and roll,
// like the right VR stick), a throttle slider, fire / boost / stop buttons and a top bar.
// Input reads the same fields it builds from a keyboard or gamepad.
import { t } from './i18n.js';

// Phones and tablets get touch mode; ?touch=1 / ?touch=0 forces it on or off.
export function isTouchDevice() {
  const forced = new URLSearchParams(location.search).get('touch');
  if (forced !== null) return forced !== '0';
  return matchMedia('(hover: none) and (pointer: coarse)').matches;
}

const STICK_RADIUS = 56; // px of thumb travel for full deflection
const STICK_DEAD = 0.08;

export class TouchControls {
  constructor(root) {
    this.pitch = this.roll = 0;
    this.fire = this.boost = false;
    this.lever = null; // 0..1 when the slider moved since the last read
    this.pending = new Set(); // one-shot buttons: allStop, recenter, talk, menu

    this.el = document.createElement('div');
    this.el.id = 'touch';
    this.el.innerHTML = `
      <div class="t-stick-zone"><div class="t-stick-base"><div class="t-stick-knob"></div></div>
        <div class="t-stick-hint"></div></div>
      <div class="t-top">
        <button class="t-btn t-small" data-tap="menu">☰</button>
        <button class="t-btn t-small" data-tap="recenter">◎</button>
        <button class="t-btn t-small t-mic" data-tap="talk"></button>
      </div>
      <div class="t-right">
        <div class="t-col">
          <button class="t-btn t-small t-stop" data-tap="allStop"></button>
          <button class="t-btn t-boost" data-hold="boost"></button>
          <button class="t-btn t-fire" data-hold="fire"></button>
        </div>
        <div class="t-throttle"><div class="t-throttle-fill"></div><div class="t-throttle-label"></div></div>
      </div>`;
    root.appendChild(this.el);

    this.zone = this.el.querySelector('.t-stick-zone');
    this.base = this.el.querySelector('.t-stick-base');
    this.knob = this.el.querySelector('.t-stick-knob');
    this.mic = this.el.querySelector('.t-mic');
    this.track = this.el.querySelector('.t-throttle');
    this.fill = this.el.querySelector('.t-throttle-fill');
    this.throttleLabel = this.el.querySelector('.t-throttle-label');
    this.setupStick();
    this.setupThrottle();
    this.setupButtons();
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.applyLang();
  }

  applyLang() {
    this.el.querySelector('.t-stop').textContent = t('touch.stop');
    this.el.querySelector('.t-boost').textContent = t('touch.boost');
    this.el.querySelector('.t-fire').textContent = t('touch.fire');
    this.el.querySelector('.t-stick-hint').textContent = t('touch.stickHint');
  }

  set visible(v) {
    this.el.classList.toggle('hidden', !v);
    if (!v) this.release();
  }

  release() {
    this.pitch = this.roll = 0;
    this.fire = this.boost = false;
    this.base.classList.remove('active');
    for (const b of this.el.querySelectorAll('.pressed')) b.classList.remove('pressed');
  }

  // Edge-triggered buttons are reported once.
  take(name) {
    return this.pending.delete(name);
  }

  takeLever() {
    const l = this.lever;
    this.lever = null;
    return l;
  }

  // Floating stick: appears where the thumb lands. Pull back (down) = nose up, as on a flight stick.
  setupStick() {
    let id = null, ox = 0, oy = 0;
    const move = (e) => {
      let dx = (e.clientX - ox) / STICK_RADIUS, dy = (e.clientY - oy) / STICK_RADIUS;
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      this.knob.style.transform = `translate(${dx * STICK_RADIUS}px, ${dy * STICK_RADIUS}px)`;
      const curve = (v) => (Math.abs(v) < STICK_DEAD ? 0 : Math.sign(v) * ((Math.abs(v) - STICK_DEAD) / (1 - STICK_DEAD)) ** 1.5);
      this.roll = -curve(dx);
      this.pitch = curve(dy);
    };
    this.zone.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId;
      this.zone.setPointerCapture(id);
      const r = this.zone.getBoundingClientRect();
      ox = e.clientX;
      oy = e.clientY;
      this.base.style.left = `${ox - r.left}px`;
      this.base.style.top = `${oy - r.top}px`;
      this.base.classList.add('active');
      this.zone.classList.add('used');
      move(e);
    });
    this.zone.addEventListener('pointermove', (e) => e.pointerId === id && move(e));
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      this.pitch = this.roll = 0;
      this.knob.style.transform = '';
      this.base.classList.remove('active');
    };
    this.zone.addEventListener('pointerup', end);
    this.zone.addEventListener('pointercancel', end);
  }

  // Throttle slider: an absolute position that stays where the thumb leaves it.
  setupThrottle() {
    let id = null;
    const set = (e) => {
      const r = this.track.getBoundingClientRect();
      const v = Math.max(0, Math.min(1, (r.bottom - e.clientY) / r.height));
      this.lever = v < 0.04 ? 0 : v > 0.96 ? 1 : v;
      this.show(this.lever);
    };
    this.track.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      this.track.setPointerCapture(id);
      set(e);
    });
    this.track.addEventListener('pointermove', (e) => e.pointerId === id && set(e));
    const end = (e) => e.pointerId === id && (id = null);
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
  }

  setupButtons() {
    for (const b of this.el.querySelectorAll('[data-hold]')) {
      const key = b.dataset.hold;
      const set = (on) => {
        this[key] = on;
        b.classList.toggle('pressed', on);
      };
      b.addEventListener('pointerdown', (e) => {
        b.setPointerCapture(e.pointerId);
        set(true);
      });
      b.addEventListener('pointerup', () => set(false));
      b.addEventListener('pointercancel', () => set(false));
    }
    for (const b of this.el.querySelectorAll('[data-tap]')) {
      b.addEventListener('pointerdown', () => {
        this.pending.add(b.dataset.tap);
        b.classList.add('pressed');
      });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => b.classList.remove('pressed'));
    }
  }

  show(throttle) {
    const pct = Math.round(throttle * 100);
    this.fill.style.height = `${pct}%`;
    this.throttleLabel.textContent = `${pct}%`;
  }

  // Per frame: follow the ship's throttle (dock / stop / respawn change it) and the mic state.
  render(state) {
    this.show(state.throttle);
    this.mic.classList.toggle('hidden', state.mic === null);
    this.mic.classList.toggle('on', state.mic === true);
    this.mic.textContent = state.mic ? '🎙' : '🔇';
  }
}
