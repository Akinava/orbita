// Pirates (drawn from server snapshots; the server runs their AI, see app/game.py), pirate laser bolts,
// player beam lasers and explosions.
import * as THREE from 'three';
import { glowTexture } from './textures.js';
import { STATION_SIZE } from './world.js';
import { shipGeometry, pushSample, applySample, INTERP_DELAY } from './ships.js';

export const BOLT_SPEED = 1100;
export const ZONE_LEASH = 2.2; // pirates chase a player until this many zone radii from its centre
const ENEMY_RADIUS = 20;
const PLAYER_RADIUS = 9;
const MODES = ['patrol', 'attack', 'evade'];
const FORWARD = new THREE.Vector3(0, 0, -1);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

function raySphere(origin, dir, center, radius) {
  _v.subVectors(origin, center);
  const b = _v.dot(dir);
  const c = _v.lengthSq() - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  let t = -b - s;
  if (t < 0) t = -b + s;
  return t > 0 ? t : -1;
}

function segmentPointDistance(a, b, p) {
  _v.subVectors(b, a);
  const len2 = _v.lengthSq();
  const t = len2 > 0 ? THREE.MathUtils.clamp(_v2.subVectors(p, a).dot(_v) / len2, 0, 1) : 0;
  return _v2.copy(a).addScaledVector(_v, t).distanceTo(p);
}

const randomUnit = (out) => {
  const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
  return out.set(r * Math.cos(th), u, r * Math.sin(th));
};

class Explosions {
  constructor(scene, poolSize = 16, particles = 90) {
    const tex = glowTexture('rgba(255,255,255,1)', 'rgba(255,190,90,0.6)', 64);
    this.pool = [];
    for (let i = 0; i < poolSize; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particles * 3), 3));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({
        map: tex, size: 8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffaa55,
      }));
      pts.frustumCulled = false;
      pts.visible = false;
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: 0xffe0b0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      flash.visible = false;
      scene.add(pts, flash);
      this.pool.push({ pts, flash, vel: new Float32Array(particles * 3), t: 0, life: 1, scale: 1, active: false });
    }
  }

  spawn(pos, scale = 1) {
    const e = this.pool.find((p) => !p.active) || this.pool.reduce((a, b) => (a.t / a.life > b.t / b.life ? a : b));
    const arr = e.pts.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = pos.x; arr[i + 1] = pos.y; arr[i + 2] = pos.z;
      randomUnit(_v).multiplyScalar((15 + Math.random() * 110) * scale);
      e.vel[i] = _v.x; e.vel[i + 1] = _v.y; e.vel[i + 2] = _v.z;
    }
    e.pts.geometry.attributes.position.needsUpdate = true;
    e.pts.material.size = 9 * scale;
    e.flash.position.copy(pos);
    e.t = 0;
    e.life = 1.2 + 0.4 * Math.min(scale, 2);
    e.scale = scale;
    e.active = e.pts.visible = e.flash.visible = true;
  }

  update(dt) {
    for (const e of this.pool) {
      if (!e.active) continue;
      e.t += dt;
      const k = e.t / e.life;
      if (k >= 1) {
        e.active = e.pts.visible = e.flash.visible = false;
        continue;
      }
      const arr = e.pts.geometry.attributes.position.array;
      const drag = Math.max(0, 1 - dt * 0.9);
      for (let i = 0; i < arr.length; i++) {
        arr[i] += e.vel[i] * dt;
        e.vel[i] *= drag;
      }
      e.pts.geometry.attributes.position.needsUpdate = true;
      e.pts.material.opacity = 1 - k;
      e.pts.material.color.setHSL(0.11 * (1 - k), 1, 0.6);
      e.flash.material.opacity = Math.max(0, 1 - k * 3);
      e.flash.scale.setScalar(e.scale * (40 + 120 * k));
    }
  }
}

class Bolts {
  constructor(scene, poolSize = 60) {
    const core = new THREE.BoxGeometry(0.5, 0.5, 16);
    const glow = new THREE.BoxGeometry(1.6, 1.6, 18);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffd0d8 });
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff2244, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.pool = [];
    for (let i = 0; i < poolSize; i++) {
      const mesh = new THREE.Mesh(core, coreMat);
      mesh.add(new THREE.Mesh(glow, glowMat));
      mesh.visible = false;
      scene.add(mesh);
      this.pool.push({ mesh, vel: new THREE.Vector3(), prev: new THREE.Vector3(), life: 0, active: false });
    }
  }

  fire(pos, dir) {
    const b = this.pool.find((p) => !p.active);
    if (!b) return;
    b.mesh.position.copy(pos);
    b.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    b.vel.copy(dir).multiplyScalar(BOLT_SPEED);
    b.life = 2.5;
    b.active = b.mesh.visible = true;
  }

  update(dt, playerPos, onHit) {
    for (const b of this.pool) {
      if (!b.active) continue;
      b.prev.copy(b.mesh.position);
      b.mesh.position.addScaledVector(b.vel, dt);
      b.life -= dt;
      if (playerPos && segmentPointDistance(b.prev, b.mesh.position, playerPos) < PLAYER_RADIUS) {
        onHit(b);
        b.life = 0;
      }
      if (b.life <= 0) b.active = b.mesh.visible = false;
    }
  }

  clear() {
    for (const b of this.pool) b.active = b.mesh.visible = false;
  }

  activePositions() {
    return this.pool.filter((b) => b.active).map((b) => b.mesh.position);
  }
}

// Pirates as the server reports them. `zones` mirror the server's pirate zones (centre, radius, hostile).
class Pirates {
  constructor(scene) {
    this.scene = scene;
    this.byId = new Map();
    this.list = []; // pirates currently shown, refreshed in update()
    this.zones = [];
    this.geo = shipGeometry();
    this.edges = new THREE.EdgesGeometry(this.geo);
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x7d6a60, metalness: 0.55, roughness: 0.45, flatShading: true, side: THREE.DoubleSide,
    });
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0xff7755 });
    this.engineMat = new THREE.SpriteMaterial({
      map: glowTexture('rgba(255,240,220,1)', 'rgba(255,120,40,0.6)', 64),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
  }

  setZones(zones) {
    this.zones = zones.map((z) => ({ id: z.id, center: new THREE.Vector3().fromArray(z.c), radius: z.r, hostile: false }));
  }

  get(id) {
    return this.byId.get(id);
  }

  count(zone) {
    let n = 0;
    for (const e of this.byId.values()) n += e.zone === zone.id;
    return n;
  }

  add(id, zone) {
    const obj = new THREE.Group();
    obj.add(new THREE.Mesh(this.geo, this.mat));
    obj.add(new THREE.LineSegments(this.edges, this.edgeMat));
    for (const x of [-6, 6]) {
      const s = new THREE.Sprite(this.engineMat);
      s.position.set(x, 0, 10);
      s.scale.setScalar(9);
      obj.add(s);
    }
    obj.visible = false;
    this.scene.add(obj);
    const e = { id, zone, obj, buf: [], mode: 'patrol', rammed: false };
    this.byId.set(id, e);
    return e;
  }

  remove(id) {
    const e = this.byId.get(id);
    if (!e) return;
    this.scene.remove(e.obj);
    this.byId.delete(id);
  }

  clear() {
    for (const id of [...this.byId.keys()]) this.remove(id);
  }

  // Returns the zones whose hostile flag changed.
  onSnapshot(pirates, hostile, now) {
    const seen = new Set();
    for (const p of pirates) {
      seen.add(p.id);
      const e = this.byId.get(p.id) ?? this.add(p.id, p.z);
      pushSample(e.buf, now, p.p, p.q);
      e.mode = MODES[p.m] ?? 'patrol';
    }
    for (const id of [...this.byId.keys()]) if (!seen.has(id)) this.remove(id);
    const changed = [];
    this.zones.forEach((z, i) => {
      if (hostile[i] !== undefined && hostile[i] !== z.hostile) {
        z.hostile = hostile[i];
        changed.push(z);
      }
    });
    return changed;
  }

  update(now) {
    const rt = now - INTERP_DELAY;
    this.list.length = 0;
    for (const e of this.byId.values()) {
      if (!e.buf.length) continue;
      e.obj.visible = !e.rammed;
      if (e.rammed) continue;
      applySample(e.buf, rt, e.obj);
      this.list.push(e);
    }
  }
}

class Lasers {
  constructor(ship) {
    const make = (rFar, rNear, color, opacity) => {
      const geo = new THREE.CylinderGeometry(rFar, rNear, 1, 8, 1, true);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, 0, -0.5);
      return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
    };
    this.beams = [0, 1].map(() => {
      const core = make(0.5, 0.06, 0xeaffea, 0.9);
      core.add(make(1.6, 0.18, 0x33ff66, 0.4));
      core.visible = false;
      ship.add(core);
      return { mesh: core, t: 0 };
    });
  }

  fire(index, from, to) {
    const b = this.beams[index];
    const dir = _v.subVectors(to, from);
    const len = dir.length();
    b.mesh.position.copy(from);
    b.mesh.quaternion.setFromUnitVectors(FORWARD, dir.normalize());
    b.mesh.scale.set(1, 1, len);
    b.t = 0.09;
    b.mesh.visible = true;
  }

  update(dt) {
    for (const b of this.beams) {
      if (!b.mesh.visible) continue;
      b.t -= dt;
      if (b.t <= 0) b.mesh.visible = false;
    }
  }
}

export class Combat {
  constructor(scene, ship, sfx, hooks) {
    this.ship = ship;
    this.sfx = sfx;
    this.hooks = hooks;
    this.explosions = new Explosions(scene);
    this.bolts = new Bolts(scene);
    this.enemies = new Pirates(scene);
    this.lasers = new Lasers(ship);
  }

  // Instant-hit beam along the ship's nose. `remotes` are the other players' ships it may hit (see
  // remote.js); stations stop it, and one marked `hittable` (an enemy base) takes the hit. Returns the
  // hit distance.
  playerShot(origin, dir, gunIndex, gunLocal, aimLocal, world, remotes = [], range = 4000) {
    let best = range, enemy = null, asteroid = null, remote = null;
    for (const e of this.enemies.list) {
      const t = raySphere(origin, dir, e.obj.position, ENEMY_RADIUS);
      if (t > 0 && t < best) { best = t; enemy = e; asteroid = remote = null; }
    }
    for (const r of remotes) {
      const t = raySphere(origin, dir, r.obj.position, ENEMY_RADIUS);
      if (t > 0 && t < best) { best = t; remote = r; enemy = asteroid = null; }
    }
    for (const a of world.asteroids) {
      const t = raySphere(origin, dir, a.mesh.position, a.radius * 0.85);
      if (t > 0 && t < best) { best = t; asteroid = a; enemy = remote = null; }
    }
    let base = null;
    for (const st of world.stations) {
      if (!st.alive) continue;
      const ts = raySphere(origin, dir, st.position, STATION_SIZE);
      if (ts > 0 && ts < best) { best = ts; enemy = asteroid = remote = null; base = st.hittable ? st : null; }
    }

    const hitPoint = origin.clone().addScaledVector(dir, best);
    const end = aimLocal.clone().setZ(aimLocal.z - best); // converge on the crosshair line
    this.lasers.fire(gunIndex, gunLocal, end);

    // Damage is settled by the server, which announces kills and destroyed asteroids to everyone.
    if (enemy) {
      this.explosions.spawn(hitPoint, 0.25);
      this.hooks.onPirateHit?.(enemy);
    } else if (remote) {
      this.explosions.spawn(hitPoint, 0.3);
      this.hooks.onRemoteHit?.(remote);
    } else if (asteroid) {
      this.explosions.spawn(hitPoint, 0.2);
      this.hooks.onAsteroidHit?.(asteroid);
    } else if (base) {
      this.explosions.spawn(hitPoint, 0.4);
      this.hooks.onBaseHit?.(base);
    } else if (best < range) {
      this.explosions.spawn(hitPoint, 0.15);
    }
    return best;
  }

  // `now` is the snapshot clock (performance.now() in seconds). Rams are detected here and reported.
  update(dt, now, playerPos, alive) {
    this.enemies.update(now);
    if (alive) {
      for (const e of this.enemies.list) {
        if (e.obj.position.distanceTo(playerPos) < ENEMY_RADIUS + PLAYER_RADIUS) {
          e.rammed = true; // hidden until the server confirms the kill
          this.hooks.onRam(e);
        }
      }
    }
    this.bolts.update(dt, alive ? playerPos : null, (b) => this.hooks.onPlayerHit(b));
    this.lasers.update(dt);
    this.explosions.update(dt);
  }
}
