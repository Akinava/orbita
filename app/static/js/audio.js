// Synthesized sound effects via WebAudio, plus recorded clips from a folder of static/music played at the
// same sound level (track(): the repair at a station, static/music/base).
const MASTER = 0.5; // master gain at the sound level 1 (js/volume.js)
const TRACK_FADE = 0.6; // seconds of fade-out at the end of a clip

export class Sfx {
  constructor() {
    this.ctx = null;
    this.level = 1;
    this.buffers = new Map(); // url -> Promise of the decoded AudioBuffer
    this.folders = null; // Promise of /api/music
  }

  // The game's sound level, 0..1, from the menu
  setVolume(level) {
    this.level = level;
    if (this.master) this.master.gain.setTargetAtTime(MASTER * level, this.ctx.currentTime, 0.05);
  }

  // Must be called from a user gesture.
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = MASTER * this.level;
    this.master.connect(ctx.destination);
    this.preload('base');

    const len = ctx.sampleRate * 2;
    this.white = ctx.createBuffer(1, len, ctx.sampleRate);
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.white.getChannelData(0), b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last * 3.5;
    }

    // Engine: filtered brown noise plus a low sawtooth hum
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 200;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    src.connect(this.engFilter).connect(this.engGain).connect(this.master);
    src.start();
    this.engOsc = ctx.createOscillator();
    this.engOsc.type = 'sawtooth';
    this.engOsc.frequency.value = 45;
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 140;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.12;
    this.engOsc.connect(humFilter).connect(humGain).connect(this.engGain);
    this.engOsc.start();
  }

  engine(speedNorm, boost) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engFilter.frequency.setTargetAtTime(150 + 900 * speedNorm + (boost ? 700 : 0), t, 0.2);
    this.engGain.gain.setTargetAtTime(0.2 + 0.45 * Math.min(1, speedNorm), t, 0.2);
    this.engOsc.frequency.setTargetAtTime(40 + 45 * speedNorm, t, 0.3);
  }

  tone(type, f0, f1, dur, vol) {
    if (!this.ctx || vol <= 0) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  noise(dur, vol, f0, f1, buffer = this.white) {
    if (!this.ctx || vol <= 0) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.3);
    src.stop(t + dur + 0.02);
  }

  laser() {
    this.tone('square', 1400, 180, 0.14, 0.08);
    this.tone('sine', 900, 300, 0.1, 0.1);
  }

  enemyLaser(vol) {
    this.tone('sawtooth', 700, 150, 0.2, 0.06 * Math.max(0, vol));
  }

  explosion(vol = 1) {
    vol = Math.max(0, Math.min(1, vol));
    this.noise(1.6, 0.9 * vol, 1200, 60);
    this.tone('sine', 90, 30, 0.8, 0.5 * vol);
  }

  hit() {
    this.noise(0.35, 0.6, 2500, 200);
    this.tone('triangle', 120, 50, 0.3, 0.4);
  }

  // Decodes the clips of a music folder ahead of time, so track() starts without a delay
  async preload(folder) {
    this.folders ??= fetch('/api/music').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    for (const url of (await this.folders)[folder] || []) this.buffer(url);
  }

  buffer(url) {
    if (!this.buffers.has(url)) {
      this.buffers.set(url, fetch(url).then((r) => r.arrayBuffer()).then((b) => this.ctx.decodeAudioData(b)).catch(() => null));
    }
    return this.buffers.get(url);
  }

  // A random clip of a music folder for `duration` seconds: a shorter one repeats, and the last moment
  // fades out
  async track(folder, duration) {
    if (!this.ctx) return;
    await this.preload(folder);
    const urls = (await this.folders)[folder] || [];
    if (!urls.length) return;
    const buf = await this.buffer(urls[Math.floor(Math.random() * urls.length)]);
    if (!buf) return;
    const t = this.ctx.currentTime, end = t + duration;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = buf.duration < duration;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(1, t);
    g.gain.setValueAtTime(1, end - TRACK_FADE);
    g.gain.linearRampToValueAtTime(0, end);
    src.connect(g).connect(this.master);
    src.start(t);
    src.stop(end);
  }

  beep(freq = 880, dur = 0.12, vol = 0.12) {
    this.tone('sine', freq, freq * 0.999, dur, vol);
  }
}
