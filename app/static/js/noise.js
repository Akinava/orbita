// Deterministic RNG and 3D value noise used for procedural textures and asteroids.

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x, y, z, seed) {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

export function noise3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
  const h000 = hash3(xi, yi, zi, seed), h100 = hash3(xi + 1, yi, zi, seed);
  const h010 = hash3(xi, yi + 1, zi, seed), h110 = hash3(xi + 1, yi + 1, zi, seed);
  const h001 = hash3(xi, yi, zi + 1, seed), h101 = hash3(xi + 1, yi, zi + 1, seed);
  const h011 = hash3(xi, yi + 1, zi + 1, seed), h111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  return lerp(
    lerp(lerp(h000, h100, xf), lerp(h010, h110, xf), yf),
    lerp(lerp(h001, h101, xf), lerp(h011, h111, xf), yf),
    zf,
  );
}

export function fbm3(x, y, z, octaves = 5, seed = 0) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq, seed + i * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
