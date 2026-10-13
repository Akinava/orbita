// Shared bits for server-driven ships (pirates and other players): the hull model and snapshot
// interpolation. Ships are drawn slightly in the past, between the two snapshots around that moment.
import * as THREE from 'three';

export const INTERP_DELAY = 0.12; // seconds behind the newest snapshot
const BUFFER_SIZE = 12;

export function shipGeometry() {
  const nose = [0, 0, -24], lw = [-20, -1, 10], rw = [20, -1, 10], top = [0, 6, 6], bot = [0, -5, 8];
  const fin = [0, 11, 12], finBase = [0, 5, 10];
  const tris = [
    [nose, top, lw], [nose, rw, top], [nose, lw, bot], [nose, bot, rw],
    [lw, top, bot], [top, rw, bot], [top, fin, finBase],
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(2), 3));
  g.computeVertexNormals();
  return g;
}

// Snapshot sample {t, p, q} for buffer `buf` from server arrays p (xyz) and q (xyzw).
export function pushSample(buf, t, p, q, extra = {}) {
  buf.push({ t, p: new THREE.Vector3().fromArray(p), q: new THREE.Quaternion().fromArray(q), ...extra });
  if (buf.length > BUFFER_SIZE) buf.shift();
}

// Pose `obj` at render time rt from the buffer; returns the newest sample.
export function applySample(buf, rt, obj) {
  let i = buf.length - 1;
  while (i > 0 && buf[i - 1].t > rt) i--;
  const s1 = buf[i], s0 = buf[Math.max(0, i - 1)];
  const k = s1.t > s0.t ? THREE.MathUtils.clamp((rt - s0.t) / (s1.t - s0.t), 0, 1) : 1;
  obj.position.lerpVectors(s0.p, s1.p, k);
  obj.quaternion.slerpQuaternions(s0.q, s1.q, k);
  return buf[buf.length - 1];
}
