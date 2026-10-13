// Procedural cockpit: faceted canopy with upper and lower windows, holographic screens and scanner.
// Ship-local axes: -Z forward, +Y up, +X right. The pilot's eyes are at EYE.
import * as THREE from 'three';
import { panelTexture, labelTexture } from './textures.js';

export const EYE = new THREE.Vector3(0, 1.2, 0);
export const GUNS = [new THREE.Vector3(-0.9, 0.52, -3.5), new THREE.Vector3(0.9, 0.52, -3.5)];
export const SCANNER_RX = 0.2;
export const SCANNER_RZ = 0.12;
export const SCANNER_MAX_CONTACTS = 64;
export const SCANNER_MAX_LABELS = 12; // player names floating next to their blips
export const SCANNER_ZONE_SEGMENTS = 512; // line segments shared by all pirate-zone rings

const v = (x, y, z) => new THREE.Vector3(x, y, z);
const Z_AXIS = v(0, 0, 1);

// Triangle fan around the centroid of an (approximately planar) convex polygon.
function polyGeometry(points) {
  const c = new THREE.Vector3();
  points.forEach((p) => c.add(p));
  c.divideScalar(points.length);
  const pos = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    pos.push(c.x, c.y, c.z, a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// Framed window in a hull panel (convex polygon, roughly planar): the glass is the panel inset by `inset`
// with its corners chamfered by `chamfer`; the ring between panel edge and glass becomes a solid frame.
// The outline is built in the panel's best-fit plane and projected back onto the panel's triangle fan,
// so it follows panels that fold (the front one bends around the nose).
// Returns the frame geometry and the window outline (3D points).
function framedWindow(points, { inset, chamfer }) {
  const c3 = points.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(points.length);
  const n = new THREE.Vector3(); // Newell normal
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length];
    n.x += (p.y - q.y) * (p.z + q.z);
    n.y += (p.z - q.z) * (p.x + q.x);
    n.z += (p.x - q.x) * (p.y + q.y);
  });
  n.normalize();
  const u = new THREE.Vector3(0, 1, 0).cross(n);
  if (u.lengthSq() < 0.1) u.set(1, 0, 0).addScaledVector(n, -n.x);
  u.normalize();
  const w = n.clone().cross(u);
  const to2 = (p) => new THREE.Vector2(p.clone().sub(c3).dot(u), p.clone().sub(c3).dot(w));
  const poly = points.map(to2);
  const ccw = !THREE.ShapeUtils.isClockWise(poly);
  if (!ccw) poly.reverse();

  const fan = points.map((p, i) => [c3, p, points[(i + 1) % points.length]]);
  const ray = new THREE.Ray(), hit = new THREE.Vector3();
  const to3 = (q) => {
    const orig = points.find((p) => to2(p).distanceTo(q) < 1e-5);
    if (orig) return orig.clone();
    const onPlane = c3.clone().addScaledVector(u, q.x).addScaledVector(w, q.y);
    ray.set(onPlane.clone().addScaledVector(n, -5), n);
    for (const [a, b, d] of fan) if (ray.intersectTriangle(a, b, d, false, hit)) return hit.clone();
    return onPlane;
  };

  // Inset: shift every edge inwards and intersect neighbouring edges
  const m = poly.length;
  const dirs = poly.map((a, i) => poly[(i + 1) % m].clone().sub(a).normalize());
  const inner = poly.map((p, i) => {
    const d0 = dirs[(i + m - 1) % m], d1 = dirs[i];
    const p0 = poly[(i + m - 1) % m].clone().add(new THREE.Vector2(-d0.y, d0.x).multiplyScalar(inset));
    const p1 = p.clone().add(new THREE.Vector2(-d1.y, d1.x).multiplyScalar(inset));
    const den = d0.x * d1.y - d0.y * d1.x;
    if (Math.abs(den) < 1e-4) return p1;
    const t = ((p1.x - p0.x) * d1.y - (p1.y - p0.y) * d1.x) / den;
    return p0.addScaledVector(d0, t);
  });

  // Chamfer the sharper corners: replace each by two points along its edges
  const glass = [];
  inner.forEach((p, i) => {
    const prev = inner[(i + m - 1) % m], next = inner[(i + 1) % m];
    const a = prev.clone().sub(p), b = next.clone().sub(p);
    if (a.clone().normalize().dot(b.clone().normalize()) < -0.85) return glass.push(p); // nearly straight
    const k = Math.min(chamfer, a.length() * 0.35, b.length() * 0.35);
    glass.push(p.clone().addScaledVector(a.normalize(), k), p.clone().addScaledVector(b.normalize(), k));
  });

  const shape = new THREE.Shape(poly);
  shape.holes = [new THREE.Path([...glass].reverse())];
  const frame = new THREE.ShapeGeometry(shape);
  const pos = frame.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const p = to3(new THREE.Vector2(pos.getX(i), pos.getY(i)));
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  frame.deleteAttribute('uv');
  frame.computeVertexNormals();
  return { frame, glass: glass.map(to3) };
}

function strut(a, b, size, mat) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, len + size), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(Z_AXIS, b.clone().sub(a).normalize());
  return m;
}

function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

// Shared clock for all hologram shaders; advanced by cockpit.update().
const holoTime = { value: 0 };
const ADD = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide };

// Additive projection of a texture: scanlines, a slow bright sweep, flicker and soft edges.
// Dark texels add nothing, so a canvas with a near-black background floats in the air.
function holoMaterial(map, tint = new THREE.Color(1, 1, 1), opacity = 1) {
  return new THREE.ShaderMaterial({
    ...ADD,
    toneMapped: false,
    uniforms: { map: { value: map }, time: holoTime, tint: { value: tint }, opacity: { value: opacity } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D map;
      uniform float time, opacity;
      uniform vec3 tint;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(map, vUv).rgb * tint;
        float scan = 0.82 + 0.18 * sin(vUv.y * 420.0 - time * 8.0);
        float sweep = 1.0 + 0.35 * exp(-pow((fract(vUv.y - time * 0.18) - 0.5) * 18.0, 2.0));
        float flicker = 0.94 + 0.06 * sin(time * 41.0) * sin(time * 17.0);
        vec2 e = smoothstep(0.0, 0.025, vUv) * smoothstep(0.0, 0.025, 1.0 - vUv);
        gl_FragColor = vec4(c * scan * sweep * flicker + vec3(0.0, 0.025, 0.035), opacity * e.x * e.y);
        #include <colorspace_fragment>
      }`,
  });
}

// Light cone from an emitter (uv.y = 0) fading out along uv.y; flat beams also fade towards the sides.
function beamMaterial(color, strength = 0.35, radial = false) {
  return new THREE.ShaderMaterial({
    ...ADD,
    defines: radial ? { RADIAL: '' } : {},
    uniforms: { color: { value: new THREE.Color(color) }, time: holoTime, strength: { value: strength } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 color;
      uniform float time, strength;
      varying vec2 vUv;
      void main() {
        #ifdef RADIAL
        float side = 1.0;
        #else
        float side = sin(vUv.x * 3.14159);
        #endif
        float a = (1.0 - vUv.y) * side * strength * (0.85 + 0.15 * sin(time * 23.0 + vUv.y * 30.0));
        gl_FragColor = vec4(color, a);
        #include <colorspace_fragment>
      }`,
  });
}

// Trapezoid from a narrow emitter edge a0-a1 (uv.y = 0) out to a wide hologram edge b0-b1 (uv.y = 1).
function beamQuad(a0, a1, b0, b1, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a0.toArray(), ...a1.toArray(), ...b0.toArray(), ...b1.toArray()], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  g.setIndex([0, 2, 1, 1, 2, 3]);
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 20;
  return m;
}

export class CanvasScreen {
  constructor(pxW, pxH, w, h) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      holoMaterial(this.texture, new THREE.Color(1.0, 1.08, 1.12)),
    );
    this.mesh.renderOrder = 21;
  }

  commit() {
    this.texture.needsUpdate = true;
  }
}

function buildScanner() {
  const group = new THREE.Group();
  const lineMat = new THREE.LineBasicMaterial({ color: 0x33ffaa, opacity: 0.8, ...ADD });
  for (const k of [1, 0.66, 0.33]) {
    const pts = new THREE.EllipseCurve(0, 0, SCANNER_RX * k, SCANNER_RZ * k)
      .getPoints(64)
      .map((p) => v(p.x, 0, p.y));
    group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
  }
  const cross = [
    v(-SCANNER_RX, 0, 0), v(SCANNER_RX, 0, 0),
    v(0, 0, -SCANNER_RZ), v(0, 0, SCANNER_RZ),
    v(0, 0, 0), v(-SCANNER_RX * 0.7, 0, -SCANNER_RZ * 0.7),
    v(0, 0, 0), v(SCANNER_RX * 0.7, 0, -SCANNER_RZ * 0.7),
  ];
  group.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(cross),
    new THREE.LineBasicMaterial({ color: 0x1d8a66, opacity: 0.8, ...ADD }),
  ));
  const discGeo = new THREE.CircleGeometry(1, 48);
  discGeo.rotateX(-Math.PI / 2);
  discGeo.scale(SCANNER_RX, 1, SCANNER_RZ);
  const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: 0x0a4a33, opacity: 0.35, ...ADD }));
  group.add(disc);

  // Rotating radar sweep
  const sweepGeo = new THREE.CircleGeometry(1, 24, 0, 0.6);
  sweepGeo.rotateX(-Math.PI / 2);
  const sweep = new THREE.Mesh(sweepGeo, new THREE.MeshBasicMaterial({ color: 0x1f9a70, opacity: 0.35, ...ADD }));
  const sweepFrame = new THREE.Group(); // squashes the spinning wedge onto the ellipse
  sweepFrame.scale.set(SCANNER_RX, 1, SCANNER_RZ);
  sweepFrame.position.y = 0.0005;
  sweepFrame.add(sweep);
  group.add(sweepFrame);

  // Contact pool: blips plus vertical stalks (Elite-style 3D scanner).
  const blipGeo = new THREE.OctahedronGeometry(0.007);
  const blipMats = [0xff3b3b, 0xb0a490, 0x44ff88, 0xffee55, 0x55ddff].map((c) => new THREE.MeshBasicMaterial({ color: c, ...ADD }));
  const blips = [];
  for (let i = 0; i < SCANNER_MAX_CONTACTS; i++) {
    const m = new THREE.Mesh(blipGeo, blipMats[0]);
    m.visible = false;
    group.add(m);
    blips.push(m);
  }
  const stalkGeo = new THREE.BufferGeometry();
  stalkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SCANNER_MAX_CONTACTS * 6), 3));
  stalkGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SCANNER_MAX_CONTACTS * 6), 3));
  const stalks = new THREE.LineSegments(stalkGeo, new THREE.LineBasicMaterial({ vertexColors: true, ...ADD }));
  stalks.frustumCulled = false;
  group.add(stalks);

  // Pirate zones: rings on the scanner plane, rebuilt every frame and clipped to its rim.
  const zoneGeo = new THREE.BufferGeometry();
  zoneGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SCANNER_ZONE_SEGMENTS * 6), 3));
  zoneGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SCANNER_ZONE_SEGMENTS * 6), 3));
  zoneGeo.setDrawRange(0, 0);
  const zones = new THREE.LineSegments(zoneGeo, new THREE.LineBasicMaterial({ vertexColors: true, ...ADD }));
  zones.frustumCulled = false;
  zones.position.y = 0.001; // just above the disc
  group.add(zones);

  group.traverse((o) => (o.renderOrder = 22));
  const blank = labelTexture(''); // labels always have a map, so swapping names needs no recompile
  const labels = Array.from({ length: SCANNER_MAX_LABELS }, () => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: blank, transparent: true, depthWrite: false, toneMapped: false }));
    s.scale.set(0.11, 0.0275, 1);
    s.renderOrder = 23;
    s.visible = false;
    group.add(s);
    return s;
  });

  return { group, blips, blipMats, stalks, zones, sweep, labels };
}

// screenX: how far the side screens sit from the centre line (closer on phones, clear of the touch buttons)
export function buildCockpit({ screenX = 0.6 } = {}) {
  const group = new THREE.Group();

  const hullMat = new THREE.MeshStandardMaterial({ color: 0x3a4250, metalness: 0.5, roughness: 0.6, side: THREE.DoubleSide });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1f26, metalness: 0.4, roughness: 0.7, side: THREE.DoubleSide });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x23272e, metalness: 0.3, roughness: 0.9, side: THREE.DoubleSide });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, metalness: 0.8, roughness: 0.35 });
  const accentMat = new THREE.MeshBasicMaterial({ color: 0x28d7ff });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x5a2a2a, roughness: 0.85 });
  const exteriorMat = new THREE.MeshStandardMaterial({
    color: 0x8d96a3, metalness: 0.6, roughness: 0.4, flatShading: true, side: THREE.DoubleSide,
  });
  const glassBase = new THREE.Color(0x9fc6ff);
  const glassMat = new THREE.MeshStandardMaterial({
    color: glassBase.clone(), transparent: true, opacity: 0.07, metalness: 0.9, roughness: 0.05,
    side: THREE.DoubleSide, depthWrite: false,
  });

  // Canopy key points
  const B = 0.95; // window sill height
  const BACK = 1.6;
  const FC = v(0, B, -1.75), FL = v(-1.25, B, -1.15), FR = v(1.25, B, -1.15);
  const SL = v(-1.45, B, 0.5), SR = v(1.45, B, 0.5);
  const TC = v(0, 2.05, -0.95), TL = v(-0.85, 2.1, -0.55), TR = v(0.85, 2.1, -0.55);
  const BTL = v(-0.95, 2.15, 0.5), BTR = v(0.95, 2.15, 0.5);
  const SLb = v(-1.45, B, BACK), SRb = v(1.45, B, BACK);
  const BTLb = v(-0.95, 2.15, BACK), BTRb = v(0.95, 2.15, BACK);
  const fl = (p) => v(p.x, 0, p.z);

  const add = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    group.add(m);
    return m;
  };

  // Floor window in front of the seat: the floor edge crosses the side walls at z = FLOOR_Z.
  const FLOOR_Z = -0.55;
  const edgeX = (a, b) => a.x + (b.x - a.x) * ((FLOOR_Z - a.z) / (b.z - a.z));
  const FWL = v(edgeX(FL, SL), 0, FLOOR_Z), FWR = v(edgeX(FR, SR), 0, FLOOR_Z);

  // Windows: canopy, the lower walls below the sill, and the front of the floor. Each panel holds one
  // large window with chamfered corners in a solid frame, with a metal trim along the glass edge.
  for (const [pts, opts] of [
    [[FL, FC, FR, TR, TC, TL], { inset: 0.09, chamfer: 0.22 }],
    [[FL, TL, BTL, SL], { inset: 0.1, chamfer: 0.18 }], [[FR, SR, BTR, TR], { inset: 0.1, chamfer: 0.18 }],
    [[TL, TC, TR], { inset: 0.08, chamfer: 0.1 }], [[TL, TR, BTR, BTL], { inset: 0.12, chamfer: 0.2 }],
    [[fl(FL), fl(FC), FC, FL], { inset: 0.08, chamfer: 0.12 }], [[fl(FC), fl(FR), FR, FC], { inset: 0.08, chamfer: 0.12 }],
    [[fl(SL), fl(FL), FL, SL], { inset: 0.08, chamfer: 0.12 }], [[fl(FR), fl(SR), SR, FR], { inset: 0.08, chamfer: 0.12 }],
    [[fl(FL), FWL, FWR, fl(FR), fl(FC)], { inset: 0.1, chamfer: 0.15 }],
  ]) {
    const { frame, glass } = framedWindow(pts, opts);
    add(frame, hullMat);
    add(polyGeometry(glass), glassMat).renderOrder = 10;
    glass.forEach((a, i) => group.add(strut(a, glass[(i + 1) % glass.length], 0.035, frameMat)));
  }

  // Solid hull: back section, rear floor (the roof is glass)
  for (const pts of [
    [fl(SL), fl(SLb), SLb, SL], [SL, SLb, BTLb, BTL],
    [fl(SR), fl(SRb), SRb, SR], [SR, SRb, BTRb, BTR],
    [BTL, BTR, BTRb, BTLb],
    [fl(SLb), fl(SRb), SRb, SLb], [SLb, SRb, BTRb, BTLb],
  ]) add(polyGeometry(pts), hullMat);
  add(polyGeometry([FWL, fl(SL), fl(SLb), fl(SRb), fl(SR), FWR]), floorMat);

  // Canopy frame
  for (const [a, b] of [
    [FC, FL], [FC, FR], [FL, TL], [FR, TR], [TL, TR],
    [TL, BTL], [TR, BTR], [SL, BTL], [SR, BTR], [FL, SL], [FR, SR], [BTL, BTR],
    // lower window frames
    [fl(FL), FL], [fl(FC), FC], [fl(FR), FR], [fl(SL), SL], [fl(SR), SR],
    [fl(SL), fl(FL)], [fl(FL), fl(FC)], [fl(FC), fl(FR)], [fl(FR), fl(SR)], [FWL, FWR],
  ]) group.add(strut(a, b, 0.07, frameMat));

  // Glowing accent strip under the sill
  const inward = (p) => p.clone().add(v(0, B, -0.3).sub(p).setY(0).normalize().multiplyScalar(0.06)).setY(B - 0.05);
  for (const [a, b] of [[SL, FL], [FL, FC], [FC, FR], [FR, SR]]) group.add(strut(inward(a), inward(b), 0.015, accentMat));

  // Dashboard: a slim rail on two legs, so the lower windows stay clear
  group.add(box(2.0, 0.04, 0.24, darkMat, 0, 0.86, -0.72));
  group.add(box(2.0, 0.012, 0.012, accentMat, 0, 0.845, -0.835));
  for (const x of [-0.95, 0.95]) group.add(box(0.06, 0.84, 0.06, frameMat, x, 0.42, -0.72));

  // Holographic multi-function screens, projected up from emitters on the rail
  const emitterMat = new THREE.MeshBasicMaterial({ color: 0x7ff6ff });
  const left = new CanvasScreen(512, 384, 0.44, 0.33);
  const right = new CanvasScreen(512, 384, 0.44, 0.33);
  for (const [scr, x] of [[left, -screenX], [right, screenX]]) {
    scr.mesh.position.set(x, 1.1, -0.74);
    scr.mesh.lookAt(EYE);
    group.add(scr.mesh);
    const emitter = box(0.16, 0.015, 0.03, emitterMat, x, 0.887, -0.72);
    group.add(emitter);
    // Beam from the emitter to the bottom edge of the screen, in the screen's local space
    scr.mesh.updateMatrix();
    const toLocal = (p) => p.applyMatrix4(scr.mesh.matrix.clone().invert());
    scr.mesh.add(beamQuad(
      toLocal(v(x - 0.08, 0.895, -0.72)), toLocal(v(x + 0.08, 0.895, -0.72)),
      v(-0.22, -0.165, 0), v(0.22, -0.165, 0), beamMaterial(0x39dcff, 0.22),
    ));
  }

  // Info panel (js/info.js) high in the middle of the canopy; shown in VR only, a flat screen has it
  // over the page instead
  const info = new CanvasScreen(640, 200, 0.56, 0.175);
  info.mesh.position.set(0, 1.8, -0.97);
  info.mesh.lookAt(EYE);
  info.mesh.visible = false;
  group.add(info.mesh);

  // The VR menu (js/vrmenu.js) right in front of the pilot, over everything else while it is open
  const menu = new CanvasScreen(640, 540, 0.5, 0.42);
  menu.mesh.position.set(0, 1.2, -0.72);
  menu.mesh.lookAt(EYE);
  menu.mesh.renderOrder = 30;
  menu.mesh.visible = false;
  group.add(menu.mesh);

  // Holographic 3D scanner above an emitter dish on the rail
  const scanner = buildScanner();
  scanner.group.position.set(0, 0.99, -0.66);
  group.add(scanner.group);
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.15, 0.025, 48), frameMat);
  pedestal.scale.set(SCANNER_RX * 0.45, 1, SCANNER_RZ * 0.45);
  pedestal.position.set(0, 0.892, -0.66);
  group.add(pedestal);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(1, 32), emitterMat);
  lens.rotation.x = -Math.PI / 2;
  lens.scale.set(SCANNER_RX * 0.35, SCANNER_RZ * 0.35, 1);
  lens.position.set(0, 0.906, -0.66);
  group.add(lens);
  const coneGeo = new THREE.CylinderGeometry(1, 0.35, 1, 48, 1, true);
  coneGeo.translate(0, 0.5, 0);
  const cone = new THREE.Mesh(coneGeo, beamMaterial(0x2bffb0, 0.16, true)); // cylinder uv.y = 0 at the lens
  cone.scale.set(SCANNER_RX, 0.99 - 0.906, SCANNER_RZ);
  cone.position.set(0, 0.906, -0.66);
  cone.renderOrder = 20;
  group.add(cone);

  // Side consoles
  for (const [x, seed, tilt] of [[-1.1, 3, 0.4], [1.1, 4, -0.4]]) {
    group.add(box(0.36, 0.05, 1.1, darkMat, x, 0.88, -0.2));
    for (const dx of [-0.14, 0.14]) group.add(box(0.012, 0.01, 0.96, emitterMat, x + dx, 0.909, -0.2));
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 1.0), holoMaterial(panelTexture(seed), new THREE.Color(0.8, 1.1, 1.25), 0.9));
    panel.rotation.set(-Math.PI / 2, 0, 0);
    panel.rotateY(tilt);
    panel.position.set(x, 0.99, -0.2);
    panel.renderOrder = 21;
    group.add(panel);
  }

  // Seat
  group.add(box(0.62, 0.12, 0.55, seatMat, 0, 0.5, 0.0));
  const back = box(0.62, 0.95, 0.12, seatMat, 0, 0.98, 0.3);
  back.rotation.x = 0.12;
  group.add(back);
  group.add(box(0.32, 0.22, 0.1, seatMat, 0, 1.55, 0.33));
  group.add(box(0.1, 0.06, 0.45, frameMat, -0.38, 0.72, -0.05));
  group.add(box(0.1, 0.06, 0.45, frameMat, 0.38, 0.72, -0.05));

  // Exterior visible through the windows: nose, wings, guns (the belly is open so the lower windows see space)
  const NOSE = v(0, 0.55, -5.2);
  add(polyGeometry([FL, FC, NOSE]), exteriorMat);
  add(polyGeometry([FC, FR, NOSE]), exteriorMat);
  for (const s of [-1, 1]) {
    add(polyGeometry([v(1.45 * s, 0.55, -0.6), v(5.2 * s, 0.6, 0.9), v(5.5 * s, 0.6, 2.2), v(1.45 * s, 0.55, 2.0)]), exteriorMat);
    group.add(box(0.26, 0.22, 1.7, exteriorMat, 0.9 * s, 0.42, -2.3));
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 1.4, 10), frameMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0.9 * s, 0.52, -2.8);
    group.add(barrel);
    const navLight = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: s < 0 ? 0xff2222 : 0x22ff44 }));
    navLight.position.set(5.5 * s, 0.62, 2.0);
    group.add(navLight);
  }

  // HUD projected onto the canopy (rendered on top, far away for comfortable focus)
  const hudMat = new THREE.MeshBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false });
  const crosshair = new THREE.Group();
  crosshair.add(new THREE.Mesh(new THREE.RingGeometry(0.5, 0.58, 40), hudMat));
  for (let i = 0; i < 4; i++) {
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.35), hudMat);
    const a = (i * Math.PI) / 2;
    tick.position.set(Math.cos(a) * 0.85, Math.sin(a) * 0.85, 0);
    tick.rotation.z = a + Math.PI / 2;
    crosshair.add(tick);
  }
  crosshair.position.set(EYE.x, EYE.y, -40);
  crosshair.traverse((o) => (o.renderOrder = 1000));
  group.add(crosshair);

  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1.0, 4, 1, Math.PI / 4),
    new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
  );
  marker.renderOrder = 1001;
  marker.visible = false;
  group.add(marker);

  // Interior light so the cockpit is readable on the night side
  const lamp = new THREE.PointLight(0x88aaff, 3, 6, 2);
  lamp.position.set(0, 1.95, -0.2);
  group.add(lamp);

  // Animate hologram shaders and the radar sweep
  const update = (time) => {
    holoTime.value = time;
    scanner.sweep.rotation.y = -time * 1.6;
  };

  return { group, glassMat, glassBase, screens: { left, right, info, menu }, scanner, crosshair, marker, update };
}
