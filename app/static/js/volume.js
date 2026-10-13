// Volume levels, 0..1 each: sfx (the game's sounds, js/audio.js), music (js/music.js) and voice (other
// pilots in the voice chat, js/voice.js). Set with sliders (volumeSliders: in the game menu and the
// in-flight sound panel), remembered in localStorage and shared by all pages; whoever plays sound
// subscribes with onVolume().
import { t } from './i18n.js';

const STORAGE_KEY = 'orbita.volume';
const DEFAULTS = { sfx: 1, music: 1, voice: 1 };
const listeners = new Set();

function load() {
  const v = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    for (const k of Object.keys(DEFAULTS)) {
      if (Number.isFinite(saved[k])) v[k] = Math.max(0, Math.min(1, saved[k]));
    }
    if (!(STORAGE_KEY in localStorage) && localStorage.getItem('orbita.music') === 'off') v.music = 0; // older on/off switch
  } catch { /* storage blocked: defaults */ }
  return v;
}

export const volume = load();

export function setVolume(kind, value) {
  volume[kind] = Math.max(0, Math.min(1, value));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(volume));
  } catch { /* storage blocked */ }
  for (const fn of listeners) fn(volume);
}

// fn(volume) now and on every change
export function onVolume(fn) {
  listeners.add(fn);
  fn(volume);
}

const LABELS = { sfx: 'menu.volumeSfx', music: 'menu.volumeMusic', voice: 'menu.volumeVoice' };

// Three sliders (sounds, music, voices) added to `container`; every set of sliders follows the others
export function volumeSliders(container) {
  for (const [kind, key] of Object.entries(LABELS)) {
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.dataset.i18n = key;
    name.textContent = t(key);
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: 0, max: 100, step: 5 });
    const out = document.createElement('output');
    input.addEventListener('input', () => setVolume(kind, input.value / 100));
    // Let go of it: give the keyboard back, or the arrows would move the slider, not the ship (a slider
    // reached with Tab keeps the focus, so it still works from the keyboard)
    input.addEventListener('pointerup', () => input.blur());
    onVolume((v) => {
      input.value = Math.round(v[kind] * 100);
      out.textContent = `${input.value}%`;
    });
    label.append(name, input, out);
    container.append(label);
  }
}
