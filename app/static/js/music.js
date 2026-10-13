// Background music: random tracks from a folder of static/music, one after another (the list comes from
// /api/music in app/main.py). Pages pick the folder: login (sign-in page; also between rounds on team
// maps), profile (menu, profile, leaderboards), farming (flying on "Farming space"), battle (flying on
// the other maps). Switching folders fades the current track out. How loud it plays is
// the music level of js/volume.js; at 0 the music is off.
//
// Browsers do not play sound before the first click or key press on the page, so until then the track
// waits and starts on that first gesture; meanwhile the page's music button says so (`blocked`).
import { t } from './i18n.js';
import { volume, setVolume, onVolume } from './volume.js';

const MAX_VOLUME = 0.35; // at the music level 1, so that it stays under the game's sounds
const FADE = 0.8; // seconds
const FADE_STEP = 30; // ms; a timer, not requestAnimationFrame, which the page does not get in VR
const GESTURES = ['pointerdown', 'mousedown', 'click', 'keydown', 'touchend'];

let lists = null;
function trackLists() {
  lists ??= fetch('/api/music').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return lists;
}

class Music {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.volume = 0;
    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('error', () => this.onError());
    this.mood = null;
    this.last = null; // the track just played, not to be picked twice in a row
    this.failures = 0;
    this.switching = 0; // bumped on every switch, so an older fade gives up
    this.fading = false;
    this.restore = 1; // the level to come back to when the button turns the music on again
    this.waitForGesture = this.waitForGesture.bind(this);
    this.enabled = false;
    this.blocked = false; // waiting for the first gesture to be allowed to play
    this.blockedListeners = new Set();
    onVolume((v) => this.onLevel(v.music));
  }

  get target() {
    return MAX_VOLUME * volume.music;
  }

  // Play random tracks from the folder `mood`; nothing changes if it is already playing.
  play(mood) {
    if (mood === this.mood) return;
    this.mood = mood;
    if (this.enabled) this.switchTo(mood);
  }

  onLevel(level) {
    const was = this.enabled;
    this.enabled = level > 0;
    if (this.enabled && !was) {
      if (this.mood) this.switchTo(this.mood);
    } else if (!this.enabled && was) {
      this.switching++;
      this.fadeTo(0).then((done) => done && this.audio.pause());
    } else if (this.enabled && !this.fading && !this.audio.paused) {
      this.audio.volume = this.target; // the slider moved while playing
    }
  }

  // On/off for the button on the pages: off remembers the level, on brings it back
  setEnabled(on) {
    if (on) setVolume('music', this.restore || 1);
    else {
      this.restore = volume.music;
      setVolume('music', 0);
    }
  }

  async switchTo(mood) {
    const id = ++this.switching;
    if (!this.audio.paused && !(await this.fadeTo(0))) return;
    const tracks = (await trackLists())[mood] || [];
    if (id !== this.switching || !this.enabled) return;
    this.audio.pause();
    if (!tracks.length) return;
    const choices = tracks.length > 1 ? tracks.filter((u) => u !== this.last) : tracks;
    this.last = choices[Math.floor(Math.random() * choices.length)];
    this.audio.src = this.last;
    this.start(id);
  }

  async start(id) {
    try {
      this.audio.volume = 0;
      await this.audio.play();
      this.failures = 0;
      this.setBlocked(false);
      if (id === this.switching) this.fadeTo(this.target);
    } catch (e) {
      if (e.name === 'NotAllowedError') {
        this.setBlocked(true);
        this.waitForGesture(true);
      }
    }
  }

  setBlocked(blocked) {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    for (const fn of this.blockedListeners) fn(blocked);
  }

  // fn(blocked) now and whenever the browser starts or stops holding the music back
  onBlocked(fn) {
    this.blockedListeners.add(fn);
    fn(this.blocked);
  }

  // Autoplay blocked: start on the first gesture anywhere on the page
  waitForGesture(arm) {
    for (const type of GESTURES) document.removeEventListener(type, this.waitForGesture, true);
    if (arm === true) {
      for (const type of GESTURES) document.addEventListener(type, this.waitForGesture, true);
    } else if (this.enabled && this.audio.src) {
      this.start(this.switching);
    }
  }

  next() {
    if (this.enabled && this.mood) this.switchTo(this.mood);
  }

  onError() {
    // A track that would not load: try another, but do not spin if none of them work
    if (++this.failures < 3) setTimeout(() => this.next(), 1000);
  }

  // Resolves true when the fade finished, false when another switch took over
  fadeTo(target) {
    const id = this.switching;
    const from = this.audio.volume;
    const started = performance.now();
    this.fading = true;
    return new Promise((resolve) => {
      const step = () => {
        if (id !== this.switching) {
          this.fading = false;
          return resolve(false);
        }
        const k = Math.min(1, (performance.now() - started) / (FADE * 1000));
        this.audio.volume = from + (target - from) * k;
        if (k < 1) setTimeout(step, FADE_STEP);
        else {
          this.fading = false;
          resolve(true);
        }
      };
      step();
    });
  }
}

export const music = new Music();

// A round on/off button in the corner of a page (#music-btn). While the browser holds the music back
// until the first click, a hint next to it asks for one; the click that starts the music is not taken as
// "turn it off".
export function musicButton() {
  const box = document.createElement('div');
  box.id = 'music-btn';
  box.style.cssText = 'position:fixed;right:max(14px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));'
    + 'z-index:20;display:flex;align-items:center;gap:8px';
  const hint = document.createElement('span');
  hint.dataset.i18n = 'music.tapToStart';
  hint.textContent = t('music.tapToStart');
  hint.style.cssText = 'font-size:13px;padding:6px 10px;border-radius:8px;background:rgba(2,10,18,0.88);'
    + 'border:1px solid #1d5a6c;color:#bfefff;cursor:pointer';
  const b = document.createElement('button');
  b.type = 'button';
  b.style.cssText = 'width:44px;height:44px;padding:0;border-radius:50%;font-size:20px;line-height:1;'
    + 'display:flex;align-items:center;justify-content:center;background:rgba(7,48,61,0.85)';
  let wasBlocked = false;
  b.addEventListener('pointerdown', () => (wasBlocked = music.blocked && music.enabled), true);
  b.addEventListener('click', () => {
    if (!wasBlocked) music.setEnabled(!music.enabled);
  });
  music.onBlocked((blocked) => (hint.hidden = !blocked));
  onVolume((v) => {
    const on = v.music > 0;
    b.textContent = on ? '♪' : '✕';
    b.dataset.i18nTitle = on ? 'music.turnOff' : 'music.turnOn';
    b.title = t(b.dataset.i18nTitle);
    b.setAttribute('aria-label', b.title);
    b.style.opacity = on ? '1' : '0.6';
    hint.hidden = !on || !music.blocked;
  });
  box.append(hint, b);
  document.body.append(box);
  return box;
}
