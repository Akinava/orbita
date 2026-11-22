// How fast the ship turns for a given movement of the mouse (PC) or of the right finger (touch screens).
// One multiplier, remembered in localStorage; set with the slider in the game menu and the in-flight panel.
import { t } from './i18n.js';

const STORAGE_KEY = 'orbita.sensitivity';
const MIN = 0.25, MAX = 3;
const clamp = (v) => Math.max(MIN, Math.min(MAX, v));
const listeners = new Set();

function load() {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (saved) return clamp(saved);
  } catch { /* storage blocked: the default */ }
  return 1;
}

export const aim = { speed: load() };

function setSpeed(value) {
  aim.speed = clamp(value);
  try {
    localStorage.setItem(STORAGE_KEY, String(aim.speed));
  } catch { /* storage blocked */ }
  for (const fn of listeners) fn();
}

// The slider added to `container`; every copy of it follows the others
export function sensitivitySlider(container, touch) {
  const key = touch ? 'menu.aimSpeed' : 'menu.mouseSpeed';
  const label = document.createElement('label');
  label.className = 'speed';
  const name = document.createElement('span');
  name.dataset.i18n = key;
  name.textContent = t(key);
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: MIN * 100, max: MAX * 100, step: 5 });
  const out = document.createElement('output');
  const show = () => {
    input.value = Math.round(aim.speed * 100);
    out.textContent = `${input.value}%`;
  };
  input.addEventListener('input', () => setSpeed(input.value / 100));
  input.addEventListener('pointerup', () => input.blur()); // the arrows must fly the ship, not move the slider
  listeners.add(show);
  show();
  label.append(name, input, out);
  container.append(label);
}
