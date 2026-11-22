// Other players nearby (snapshots carry only ships within the server's area of interest): ships rebuilt
// from server snapshots, drawn slightly in the past and interpolated between snapshots for smooth
// motion, and their laser shots. Names are shown on the scanner (hud.js). On team maps a ship's edges
// glow in its team's colour; on PvP maps pilots fly in the colours of their profiles (the roster has them).
import * as THREE from 'three';
import { glowTexture } from './textures.js';
import { TEAM_COLORS } from './world.js';
import { shipGeometry, pushSample, applySample, INTERP_DELAY } from './ships.js';

const BEAM_LIFE = 0.12;
const FORWARD = new THREE.Vector3(0, 0, -1);

export class RemotePlayers {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map();
    this.list = []; // visible remotes, refreshed in update()
    this.geo = shipGeometry();
    this.edges = new THREE.EdgesGeometry(this.geo);
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x5f7f9c, metalness: 0.6, roughness: 0.4, flatShading: true, side: THREE.DoubleSide,
    });
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0x55ddff });
    this.colors = new Map(); // pilot id -> { ship, fire, radar } (PvP maps; each may be missing)
    this.looks = new Map(); // colour -> materials made for it
    this.teamEdgeMats = TEAM_COLORS.map((color) => new THREE.LineBasicMaterial({ color }));
    this.engineMat = new THREE.SpriteMaterial({
      map: glowTexture('rgba(230,250,255,1)', 'rgba(60,200,255,0.6)', 64),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });

    const beamGeo = new THREE.CylinderGeometry(0.8, 0.8, 1, 6, 1, true);
    beamGeo.rotateX(-Math.PI / 2);
    beamGeo.translate(0, 0, -0.5);
    this.beams = Array.from({ length: 12 }, () => {
      const mesh = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
        color: 0xff5544, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, t: 0 };
    });
  }

  get(id) {
    return this.players.get(id);
  }

  add(id, name, team = null) {
    const obj = new THREE.Group();
    const hull = new THREE.Mesh(this.geo, this.mat);
    const edges = new THREE.LineSegments(this.edges, team === null ? this.edgeMat : this.teamEdgeMats[team]);
    obj.add(hull, edges);
    const flames = [-6, 6].map((x) => {
      const s = new THREE.Sprite(this.engineMat);
      s.position.set(x, 0, 10);
      s.scale.setScalar(9);
      obj.add(s);
      return s;
    });
    obj.visible = false;
    this.scene.add(obj);
    const r = { id, name, team, obj, hull, edges, flames, buf: [], active: false };
    this.players.set(id, r);
    this.paint(r);
    return r;
  }

  // Materials for a colour, shared by every ship wearing it
  look(color) {
    let l = this.looks.get(color);
    if (!l) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)); // '#rrggbb'
      l = {
        hull: new THREE.MeshStandardMaterial({
          color, emissive: color, emissiveIntensity: 0.3, metalness: 0.6, roughness: 0.4, flatShading: true, side: THREE.DoubleSide,
        }),
        edge: new THREE.LineBasicMaterial({ color }),
        flame: new THREE.SpriteMaterial({
          map: glowTexture('rgba(255,255,255,1)', `rgba(${r},${g},${b},0.75)`, 64),
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }),
      };
      this.looks.set(color, l);
    }
    return l;
  }

  paint(r) {
    const c = this.colors.get(r.id);
    r.hull.material = c?.ship ? this.look(c.ship).hull : this.mat;
    r.edges.material = c?.ship ? this.look(c.ship).edge : r.team === null ? this.edgeMat : this.teamEdgeMats[r.team];
    for (const s of r.flames) s.material = c?.fire ? this.look(c.fire).flame : this.engineMat;
  }

  // From the roster: [{ id, c: { ship, fire, radar } or null }, ...]
  setColors(pilots) {
    this.colors = new Map(pilots.filter((p) => p.c).map((p) => [p.id, p.c]));
    for (const r of this.players.values()) this.paint(r);
  }

  remove(id) {
    const r = this.players.get(id);
    if (!r) return;
    this.scene.remove(r.obj);
    this.players.delete(id);
  }

  clear() {
    for (const id of [...this.players.keys()]) this.remove(id);
    this.colors = new Map();
  }

  onSnapshot(list, now) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      let r = this.players.get(p.id);
      const team = p.tm ?? null;
      if (r && (r.name !== p.name || r.team !== team)) {
        this.remove(p.id);
        r = null;
      }
      if (!r) r = this.add(p.id, p.name, team);
      pushSample(r.buf, now, p.p, p.q, { a: p.a });
      r.voice = !!p.v;
      r.talking = !!p.t;
    }
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.remove(id);
  }

  // Remote laser: a short-lived beam from the shooter's guns to where the shot ended.
  showShot(from, to, id) {
    const b = this.beams.find((x) => x.t <= 0) ?? this.beams[0];
    const a = new THREE.Vector3().fromArray(from), e = new THREE.Vector3().fromArray(to);
    const dir = e.clone().sub(a);
    b.mesh.material.color.set(this.colors.get(id)?.fire ?? 0xff5544);
    b.mesh.position.copy(a);
    b.mesh.quaternion.setFromUnitVectors(FORWARD, dir.clone().normalize());
    b.mesh.scale.set(1, 1, dir.length());
    b.mesh.visible = true;
    b.t = BEAM_LIFE;
  }

  update(dt, now) {
    const rt = now - INTERP_DELAY;
    this.list.length = 0;
    for (const r of this.players.values()) {
      if (!r.buf.length) continue;
      r.active = applySample(r.buf, rt, r.obj).a;
      r.obj.visible = r.active;
      if (r.active) this.list.push(r);
    }
    for (const b of this.beams) {
      if (b.t <= 0) continue;
      b.t -= dt;
      b.mesh.material.opacity = 0.9 * Math.max(0, b.t / BEAM_LIFE);
      if (b.t <= 0) b.mesh.visible = false;
    }
  }
}
