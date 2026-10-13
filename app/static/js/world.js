// The game world: skybox (nebula, stars, sun, planet, moon), Coriolis stations, asteroid belt, space dust.
// The stations and whether there is a belt depend on the map (setStations, setAsteroids; the server
// sends them, see app/modes.py).
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { fbm3, mulberry32 } from './noise.js';
import * as TX from './textures.js';

export const SUN_DIR = new THREE.Vector3(-0.85, 0.35, 0.25).normalize();
export const STATION_SIZE = 500;
const BELT_MAX = 90; // asteroids built; a map shows as many as the server places (app/modes.py)
export const SLOT_HALF_W = 70;
export const SLOT_HALF_H = 25;
const SLOT_DEPTH = 400; // the docking tunnel; a ship docking at full speed coasts ~100 m into it
export const TEAM_COLORS = [0x3c8cff, 0xff4a3c]; // blue, red

// Cuboctahedron faces as planes n·p = d (station local space).
export const STATION_FACES = (() => {
  const s = STATION_SIZE, faces = [];
  for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    for (const sg of [-1, 1]) faces.push({ n: new THREE.Vector3(...ax).multiplyScalar(sg), d: s });
  }
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    faces.push({ n: new THREE.Vector3(x, y, z).normalize(), d: (2 * s) / Math.sqrt(3) });
  }
  return faces;
})();

const SKY_ORDER = { nebula: -100, stars: -99, sun: -98, atmo: -97, planet: -96, moon: -95 };

class SpaceDust {
  constructor(scene, count = 500, range = 250) {
    this.count = count;
    this.range = range;
    this.p = new Float32Array(count * 3);
    for (let i = 0; i < this.p.length; i++) this.p[i] = (Math.random() * 2 - 1) * range;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    this.lines = new THREE.LineSegments(this.geo, new THREE.LineBasicMaterial({
      color: 0xa8b8cc, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    scene.add(this.lines);
  }

  update(shipPos, vel) {
    const R = this.range, p = this.p, out = this.geo.attributes.position.array;
    const speed = vel.length();
    const k = 0.05;
    const mx = speed > 1 ? vel.x / speed : 0, my = speed > 1 ? vel.y / speed : 1, mz = speed > 1 ? vel.z / speed : 0;
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      let dx = p[j] - shipPos.x, dy = p[j + 1] - shipPos.y, dz = p[j + 2] - shipPos.z;
      if (dx > R) p[j] -= 2 * R; else if (dx < -R) p[j] += 2 * R;
      if (dy > R) p[j + 1] -= 2 * R; else if (dy < -R) p[j + 1] += 2 * R;
      if (dz > R) p[j + 2] -= 2 * R; else if (dz < -R) p[j + 2] += 2 * R;
      dx = p[j] - shipPos.x; dy = p[j + 1] - shipPos.y; dz = p[j + 2] - shipPos.z;
      const o = i * 6;
      out[o] = p[j]; out[o + 1] = p[j + 1]; out[o + 2] = p[j + 2];
      if (dx * dx + dy * dy + dz * dz < 100) {
        // Keep dust out of the cockpit
        out[o + 3] = p[j]; out[o + 4] = p[j + 1]; out[o + 5] = p[j + 2];
      } else {
        out[o + 3] = p[j] - vel.x * k - mx * 0.4;
        out[o + 4] = p[j + 1] - vel.y * k - my * 0.4;
        out[o + 5] = p[j + 2] - vel.z * k - mz * 0.4;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
  }
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.rng = mulberry32(1337);
    this.sky = new THREE.Group();
    scene.add(this.sky);
    this.buildSky();
    this.buildStation();
    this.buildAsteroids();
    this.dust = new SpaceDust(scene);
    this.time = 0;
  }

  // Everything in `sky` follows the ship, so it appears infinitely far away.
  // Glows and stars don't write depth (drawn in renderOrder); planet and moon do, to occlude them.
  buildSky() {
    const sky = this.sky, rnd = this.rng;
    const noDepth = { depthWrite: false };

    const nebula = new THREE.Mesh(
      new THREE.SphereGeometry(60000, 48, 32),
      new THREE.MeshBasicMaterial({ map: TX.nebulaTexture(), side: THREE.BackSide, ...noDepth }),
    );
    nebula.renderOrder = SKY_ORDER.nebula;
    sky.add(nebula);

    // Star field: dense and clumpy along the Milky Way, thinning out away from it.
    // Each layer: count, point size, band half-width, density far from the band, brightness range.
    const palette = [0xffffff, 0xcfe0ff, 0xa8c4ff, 0xfff1c8, 0xffd2a0];
    const dir = new THREE.Vector3();
    for (const layer of [
      { count: 26000, size: 1, width: 0.16, floor: 0.0, bright: [0.25, 0.5], clumps: true },
      { count: 5000, size: 2, width: 0.35, floor: 0.06, bright: [0.35, 0.65], clumps: true },
      { count: 300, size: 3.5, width: 0.5, floor: 0.25, bright: [0.6, 1], clumps: false },
    ]) {
      const pos = new Float32Array(layer.count * 3), col = new Float32Array(layer.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < layer.count;) {
        const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
        dir.set(r * Math.cos(th), u, r * Math.sin(th));
        const band = Math.exp(-Math.pow(TX.galacticOffset(dir.x, dir.y) / layer.width, 2));
        // Star clouds and dark lanes inside the band
        const clump = layer.clumps ? Math.pow(fbm3(dir.x * 4 + 3, dir.y * 4, dir.z * 4, 4, 21), 3.5) * 6 : 1;
        if (rnd() > layer.floor + (1 - layer.floor) * band * Math.min(1, clump)) continue;
        pos.set([dir.x * 55000, dir.y * 55000, dir.z * 55000], i * 3);
        const [lo, hi] = layer.bright;
        c.setHex(palette[Math.floor(rnd() * palette.length)]).multiplyScalar(lo + Math.pow(rnd(), 2) * (hi - lo));
        col.set([c.r, c.g, c.b], i * 3);
        i++;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const stars = new THREE.Points(geo, new THREE.PointsMaterial({
        size: layer.size, sizeAttenuation: false, vertexColors: true, transparent: true, ...noDepth,
      }));
      stars.renderOrder = SKY_ORDER.stars;
      sky.add(stars);
    }

    const sunTex = TX.glowTexture('rgba(255,255,245,1)', 'rgba(255,225,160,0.55)');
    for (const [scale, opacity] of [[7000, 1], [32000, 0.35]]) {
      const sun = new THREE.Sprite(new THREE.SpriteMaterial({
        map: sunTex, blending: THREE.AdditiveBlending, transparent: true, opacity, ...noDepth,
      }));
      sun.position.copy(SUN_DIR).multiplyScalar(50000);
      sun.scale.setScalar(scale);
      sun.renderOrder = SKY_ORDER.sun;
      sky.add(sun);
    }

    const R = 13000;
    const planetPos = new THREE.Vector3(0.45, -0.3, -1).normalize().multiplyScalar(42000);
    const atmoScale = 1.14;
    const atmo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TX.atmosphereTexture(1 / atmoScale), blending: THREE.AdditiveBlending, transparent: true, ...noDepth,
    }));
    atmo.position.copy(planetPos);
    atmo.scale.setScalar(R * 2 * atmoScale);
    atmo.renderOrder = SKY_ORDER.atmo;
    sky.add(atmo);

    this.planet = new THREE.Mesh(
      new THREE.SphereGeometry(R, 96, 64),
      // Drawn with the transparent objects, right after the glow, so it simply paints over it: tested
      // against each other the flat glow and the far limb are too close for the depth buffer (striped edge)
      new THREE.MeshStandardMaterial({ map: TX.planetTexture(), roughness: 1, metalness: 0, transparent: true }),
    );
    this.planet.position.copy(planetPos);
    this.planet.rotation.z = 0.4;
    this.planet.renderOrder = SKY_ORDER.planet;
    sky.add(this.planet);

    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(2200, 48, 32),
      new THREE.MeshStandardMaterial({ map: TX.moonTexture(), roughness: 1, metalness: 0 }),
    );
    this.moon.position.set(-0.7, 0.25, -1).normalize().multiplyScalar(30000);
    this.moon.renderOrder = SKY_ORDER.moon;
    sky.add(this.moon);
  }

  buildStation() {
    const s = STATION_SIZE;
    const pts = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      pts.push(new THREE.Vector3(a * s, b * s, 0), new THREE.Vector3(a * s, 0, b * s), new THREE.Vector3(0, a * s, b * s));
    }
    const station = new THREE.Group();
    station.add(new THREE.Mesh(
      new ConvexGeometry(pts),
      new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.45, flatShading: true }),
    ));

    // Docking slot on the +Z face (the face the rotation axis passes through): a black tunnel deep into
    // the hull, black from both sides, so a ship still coasting in while the screen fades out on docking
    // sees its walls, not the hull from inside. The tunnel has no depth offset, so the hull hides it from
    // every other side; only the flat mouth and its lights, seen from the front alone, are pulled
    // towards the camera to stay over the hull face far away (an offset is counted in depth-buffer
    // steps, tens of metres at a few km, and pulled a double-sided tunnel through the hull).
    const black = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
    const open = new THREE.MeshBasicMaterial({ visible: false });
    const slot = new THREE.Mesh(
      new THREE.BoxGeometry(SLOT_HALF_W * 2, SLOT_HALF_H * 2, SLOT_DEPTH),
      [black, black, black, black, open, black], // faces +x, -x, +y, -y, +z (the mouth), -z
    );
    slot.position.z = s + 2 - SLOT_DEPTH / 2;
    station.add(slot);
    const offset = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 };
    const mouth = new THREE.Mesh(
      new THREE.PlaneGeometry(SLOT_HALF_W * 2, SLOT_HALF_H * 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, ...offset }),
    );
    mouth.position.z = s + 2;
    station.add(mouth);
    const slotLightMat = new THREE.MeshBasicMaterial({ color: 0x44ff88, ...offset });
    for (const [w, h, x, y] of [
      [SLOT_HALF_W * 2 + 10, 4, 0, SLOT_HALF_H + 3], [SLOT_HALF_W * 2 + 10, 4, 0, -SLOT_HALF_H - 3],
      [4, SLOT_HALF_H * 2 + 10, SLOT_HALF_W + 3, 0], [4, SLOT_HALF_H * 2 + 10, -SLOT_HALF_W - 3, 0],
    ]) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(w, h), slotLightMat);
      bar.position.set(x, y, s + 4.5);
      station.add(bar);
    }

    // Blinking beacons at the vertices
    this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3030 });
    const beaconGeo = new THREE.SphereGeometry(7, 8, 6);
    for (const p of pts) {
      const b = new THREE.Mesh(beaconGeo, this.beaconMat);
      b.position.copy(p).multiplyScalar(1.02);
      station.add(b);
    }

    this.stationModel = station; // copied for each station of the map (setStations)
    this.stations = [];
  }

  // The map's stations, from the server: { id, p, team (null: everyone's), yaw (turns the slot, local
  // +Z, towards the middle of the map) }. Team bases wear a ring of their team's colour.
  setStations(list) {
    for (const st of this.stations) this.scene.remove(st.obj);
    this.stations = list.map((s) => {
      const obj = this.stationModel.clone();
      obj.position.fromArray(s.p);
      obj.rotation.set(0, s.yaw, 0);
      if (s.team !== null) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(STATION_SIZE * 1.15, 14, 8, 64),
          new THREE.MeshBasicMaterial({ color: TEAM_COLORS[s.team] }),
        );
        obj.add(ring);
      }
      this.scene.add(obj);
      return { id: s.id, obj, position: obj.position, team: s.team, alive: true, hp: 1 };
    });
  }

  // The map's asteroids, placed by the server (its welcome: a position per asteroid, app/game.py); the
  // ones beyond its count are hidden and left out of collisions, shots and the scanner.
  setAsteroids(positions) {
    this.belt.forEach((a, i) => {
      a.mesh.visible = i < positions.length;
      if (a.mesh.visible) a.mesh.position.fromArray(positions[i]);
    });
    this.asteroids = this.belt.slice(0, positions.length);
  }

  buildAsteroids() {
    const rnd = this.rng;
    const geos = [];
    const tmp = new THREE.Vector3();
    for (let k = 0; k < 6; k++) {
      const g = new THREE.IcosahedronGeometry(1, 2);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        tmp.fromBufferAttribute(p, i);
        const n = fbm3(tmp.x * 1.4 + k * 10, tmp.y * 1.4, tmp.z * 1.4, 4, 99 + k);
        tmp.multiplyScalar(0.55 + n * 0.9);
        tmp.x *= 1 + (k % 3) * 0.25;
        p.setXYZ(i, tmp.x, tmp.y, tmp.z);
      }
      g.computeVertexNormals();
      g.computeBoundingSphere();
      geos.push(g);
    }

    this.belt = [];
    for (let i = 0; i < BELT_MAX; i++) {
      const radius = 12 + Math.pow(rnd(), 2.2) * 150;
      const mesh = new THREE.Mesh(geos[i % 6], new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(0.07 + rnd() * 0.05, 0.12 + rnd() * 0.15, 0.22 + rnd() * 0.15),
        roughness: 1, metalness: 0.05, flatShading: true,
      }));
      mesh.scale.setScalar(radius);
      mesh.rotation.set(rnd() * 6, rnd() * 6, rnd() * 6);
      const a = {
        index: i, mesh, radius, hp: Math.ceil(radius / 12), maxHp: Math.ceil(radius / 12),
        spin: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.6 * (30 / (radius + 20))),
      };
      mesh.visible = false; // until the map's welcome places it (setAsteroids)
      this.scene.add(mesh);
      this.belt.push(a);
    }
    this.asteroids = [];
  }

  update(dt, ship, velocity) {
    this.time += dt;
    this.sky.position.copy(ship.position);
    this.planet.rotation.y += dt * 0.004;
    for (const st of this.stations) st.obj.rotation.z += dt * 0.12;
    this.beaconMat.color.setHex(Math.sin(this.time * 4) > 0.6 ? 0xff4040 : 0x400808);
    for (const a of this.asteroids) {
      a.mesh.rotation.x += a.spin.x * dt;
      a.mesh.rotation.y += a.spin.y * dt;
      a.mesh.rotation.z += a.spin.z * dt;
    }
    this.dust.update(ship.position, velocity);
  }
}
