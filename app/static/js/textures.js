// Procedurally generated canvas textures: planets, nebula, glows, cockpit panels.
import * as THREE from 'three';
import { fbm3, mulberry32 } from './noise.js';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

// Iterates an equirectangular image, passing the unit-sphere direction of each pixel.
function paintSphere(w, h, fn) {
  const canvas = makeCanvas(w, h);
  const g = canvas.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  const out = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) {
    const lat = (0.5 - (y + 0.5) / h) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let x = 0; x < w; x++) {
      const lon = ((x + 0.5) / w) * Math.PI * 2;
      fn(cl * Math.cos(lon), sl, cl * Math.sin(lon), out);
      const i = (y * w + x) * 4;
      d[i] = out[0];
      d[i + 1] = out[1];
      d[i + 2] = out[2];
      d[i + 3] = out[3];
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

export function glowTexture(inner = 'rgba(255,255,255,1)', mid = 'rgba(255,255,255,0.35)', size = 128) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.25, mid);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return toTexture(c);
}

// Halo for a planet. `ratio` = planet radius / sprite half-size.
export function atmosphereTexture(ratio) {
  const size = 512;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(90,160,255,0.6)');
  grd.addColorStop(ratio * 0.96, 'rgba(110,180,255,0.7)');
  grd.addColorStop(ratio, 'rgba(140,200,255,0.75)');
  grd.addColorStop(ratio + (1 - ratio) * 0.3, 'rgba(60,120,255,0.22)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return toTexture(c);
}

export function planetTexture(w = 1024, h = 512) {
  const canvas = paintSphere(w, h, (x, y, z, out) => {
    const n = fbm3(x * 1.8 + 10, y * 1.8, z * 1.8, 6, 1);
    const clouds = fbm3(x * 3 + 5, y * 7, z * 3, 5, 7);
    let r, g, b;
    if (n < 0.5) {
      const t = clamp01((n - 0.3) / 0.2);
      r = mix(8, 30, t); g = mix(25, 95, t); b = mix(70, 170, t);
    } else {
      const t = clamp01((n - 0.5) / 0.17);
      if (t < 0.15) { r = 190; g = 175; b = 120; } // coast
      else if (t < 0.6) { r = mix(50, 110, t); g = mix(105, 95, t); b = mix(45, 60, t); }
      else { const k = clamp01((t - 0.6) / 0.4); r = mix(110, 220, k); g = mix(95, 220, k); b = mix(60, 225, k); }
    }
    if (Math.abs(y) + (n - 0.5) * 0.7 > 0.86) { r = 235; g = 240; b = 245; }
    const ca = clamp01((clouds - 0.54) * 4.5) * 0.9;
    out[0] = mix(r, 250, ca);
    out[1] = mix(g, 250, ca);
    out[2] = mix(b, 255, ca);
    out[3] = 255;
  });
  const t = toTexture(canvas);
  t.anisotropy = 4;
  return t;
}

export function moonTexture(w = 512, h = 256) {
  const canvas = paintSphere(w, h, (x, y, z, out) => {
    const n = fbm3(x * 3 + 3, y * 3, z * 3, 6, 21);
    const m = fbm3(x * 1.2, y * 1.2, z * 1.2, 3, 33); // dark "maria"
    const v = 70 + n * 120 - (m > 0.55 ? 45 : 0);
    out[0] = v; out[1] = v * 0.97; out[2] = v * 0.93; out[3] = 255;
  });
  // Craters
  const g = canvas.getContext('2d');
  const rnd = mulberry32(5);
  for (let i = 0; i < 140; i++) {
    const cx = rnd() * w, cy = h * 0.1 + rnd() * h * 0.8, r = 2 + Math.pow(rnd(), 3) * 18;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = 'rgba(30,30,30,0.35)';
    g.fill();
    g.beginPath();
    g.arc(cx - r * 0.15, cy - r * 0.15, r * 0.8, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(220,220,210,0.25)';
    g.lineWidth = 1;
    g.stroke();
  }
  return toTexture(canvas);
}

// Signed offset of a sky direction (unit vector) from the Milky Way's centre line.
// Shared by the nebula glow and the star field so both follow the same band.
export const galacticOffset = (x, y) => y - 0.15 * x;

export function nebulaTexture(w = 1024, h = 512) {
  const canvas = paintSphere(w, h, (x, y, z, out) => {
    const n = fbm3(x * 2 + 7, y * 2, z * 2, 5, 11);
    const hue = fbm3(x * 1.3, y * 1.3 + 4, z * 1.3, 3, 13);
    const band = Math.exp(-Math.pow(galacticOffset(x, y) * 2.2, 2)); // galactic band
    const k = clamp01((n - 0.47) * 3.2) * (0.25 + band * 0.75);
    out[0] = k * mix(120, 30, hue) + band * 6;
    out[1] = k * mix(40, 70, hue) + band * 6;
    out[2] = k * mix(150, 140, hue) + band * 10;
    out[3] = 255;
  });
  return toTexture(canvas);
}

// A short text label (player name) with a dark outline, centred on a 256x64 canvas.
export function labelTexture(text, color = '#7fe9ff') {
  const c = makeCanvas(256, 64);
  const g = c.getContext('2d');
  g.font = 'bold 34px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0, 20, 30, 0.9)';
  g.strokeText(text, 128, 32);
  g.fillStyle = color;
  g.fillText(text, 128, 32);
  return toTexture(c);
}

// Cockpit side console: grid of glowing buttons.
export function panelTexture(seed = 1) {
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  const rnd = mulberry32(seed);
  g.fillStyle = '#15191f';
  g.fillRect(0, 0, 256, 256);
  const colors = ['#ff5533', '#33ddff', '#ffcc33', '#55ff88', '#2a3340', '#2a3340'];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 6; col++) {
      if (rnd() < 0.2) continue;
      const x = 14 + col * 40, y = 14 + row * 34;
      g.fillStyle = '#0b0d11';
      g.fillRect(x - 3, y - 3, 30, 22);
      g.fillStyle = colors[Math.floor(rnd() * colors.length)];
      g.fillRect(x, y, 24, 16);
    }
  }
  g.strokeStyle = '#28d7ff';
  g.lineWidth = 2;
  g.strokeRect(4, 4, 248, 248);
  return toTexture(c);
}
