// Cockpit instruments: status/nav screens, 3D scanner, canopy target marker.
import * as THREE from 'three';
import { t } from './i18n.js';
import { EYE, SCANNER_RX, SCANNER_RZ, SCANNER_MAX_CONTACTS, SCANNER_MAX_LABELS, SCANNER_ZONE_SEGMENTS } from './cockpit.js';
import { labelTexture } from './textures.js';

const SCANNER_RANGE = 5000;
const SCANNER_HEIGHT = 0.12;
const MARKER_DIST = 40;
const MESSAGE_LIFE = 9;
const ZONE_RING_STEPS = 48;
const ZONE_COLOR = [0.55, 0.12, 0.12], ZONE_HOSTILE_COLOR = [1, 0.2, 0.2];
const CONTACT_COLORS = [[1, 0.25, 0.25], [0.6, 0.55, 0.45], [0.3, 1, 0.55], [1, 0.95, 0.3], [0.35, 0.85, 1]];

const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _eye = new THREE.Vector3();

export const CONTACT = { ENEMY: 0, ASTEROID: 1, STATION: 2, BOLT: 3, PLAYER: 4 };

// Scanner's sqrt distance scale, signed so it can be applied across the centre.
const scanScale = (d) => Math.sign(d) * Math.sqrt(Math.min(Math.abs(d), SCANNER_RANGE) / SCANNER_RANGE);

function formatDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} ${t('unit.km')}` : `${Math.round(m)} ${t('unit.m')}`;
}

export class Hud {
  constructor(cockpit, maxSpeed) {
    this.cockpit = cockpit;
    this.maxSpeed = maxSpeed;
    this.messages = [];
    this.timer = 0;
    this.labelTextures = new Map(); // name -> texture, for scanner labels
  }

  labelTexture(text) {
    let tex = this.labelTextures.get(text);
    if (!tex) {
      tex = labelTexture(text);
      this.labelTextures.set(text, tex);
    }
    return tex;
  }

  message(text, color = '#9ff3ff', time = 0) {
    this.messages.unshift({ text, color, time });
    this.messages.length = Math.min(this.messages.length, 4);
  }

  update(dt, state, ship, contacts, target, stationPos, zones = []) {
    _q.copy(ship.quaternion).invert();
    this.updateScanner(contacts, ship);
    this.updateZones(zones, ship, state.time);
    this.updateMarker(target, ship);
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.12;
      this.drawStatus(state);
      this.drawNav(state, ship, target, stationPos, zones);
    }
  }

  updateScanner(contacts, ship) {
    const { blips, blipMats, stalks, labels } = this.cockpit.scanner;
    const pos = stalks.geometry.attributes.position.array;
    const col = stalks.geometry.attributes.color.array;
    let n = 0, nl = 0;
    for (const c of contacts) {
      if (n >= SCANNER_MAX_CONTACTS) break;
      _v.subVectors(c.pos, ship.position).applyQuaternion(_q);
      const d = _v.length();
      if (d > SCANNER_RANGE || d < 1) continue;
      const k = Math.sqrt(d / SCANNER_RANGE) / d; // sqrt scale: near objects get more room
      const x = _v.x * k * SCANNER_RX, z = _v.z * k * SCANNER_RZ, y = _v.y * k * SCANNER_HEIGHT;
      const b = blips[n];
      b.visible = true;
      b.material = blipMats[c.type];
      b.position.set(x, y, z);
      pos.set([x, 0, z, x, y, z], n * 6);
      const cc = CONTACT_COLORS[c.type];
      col.set([cc[0] * 0.5, cc[1] * 0.5, cc[2] * 0.5, cc[0], cc[1], cc[2]], n * 6);
      n++;
      if (c.label && nl < SCANNER_MAX_LABELS) {
        const l = labels[nl++];
        l.material.map = this.labelTexture(c.label);
        l.position.set(x, y + 0.02, z);
        l.visible = true;
      }
    }
    for (let i = n; i < SCANNER_MAX_CONTACTS; i++) blips[i].visible = false;
    for (let i = nl; i < SCANNER_MAX_LABELS; i++) labels[i].visible = false;
    stalks.geometry.setDrawRange(0, n * 2);
    stalks.geometry.attributes.position.needsUpdate = true;
    stalks.geometry.attributes.color.needsUpdate = true;
  }

  // Zone rings in normalised scanner coords (rim = unit circle), mapped with the same sqrt
  // scale as the blips along the zone's bearing. Zones past the rim get an arrow on it.
  updateZones(zones, ship, time) {
    const geo = this.cockpit.scanner.zones.geometry;
    const pos = geo.attributes.position.array, col = geo.attributes.color.array;
    let n = 0;
    const seg = (ax, az, bx, bz, c) => {
      if (n >= SCANNER_ZONE_SEGMENTS) return;
      pos.set([ax * SCANNER_RX, 0, az * SCANNER_RZ, bx * SCANNER_RX, 0, bz * SCANNER_RZ], n * 6);
      col.set([...c, ...c], n * 6);
      n++;
    };
    const blink = Math.floor(time * 3) % 2 === 0;
    for (const z of zones) {
      _v.subVectors(z.center, ship.position).applyQuaternion(_q);
      const dh = Math.hypot(_v.x, _v.z) || 1;
      const ux = _v.x / dh, uz = _v.z / dh;
      const c = z.hostile && blink ? ZONE_HOSTILE_COLOR : ZONE_COLOR;
      if (dh - z.radius > SCANNER_RANGE) {
        // Arrow on the rim pointing at the zone
        const px = -uz, pz = ux;
        seg(ux * 0.9 + px * 0.06, uz * 0.9 + pz * 0.06, ux, uz, c);
        seg(ux * 0.9 - px * 0.06, uz * 0.9 - pz * 0.06, ux, uz, c);
        continue;
      }
      const far = scanScale(dh + z.radius), near = scanScale(dh - z.radius);
      const mid = (far + near) / 2, r = (far - near) / 2;
      const cx = ux * mid, cz = uz * mid;
      let px = cx + r, pz = cz;
      for (let i = 1; i <= ZONE_RING_STEPS; i++) {
        const a = (i / ZONE_RING_STEPS) * Math.PI * 2;
        const qx = cx + Math.cos(a) * r, qz = cz + Math.sin(a) * r;
        if (px * px + pz * pz <= 1 && qx * qx + qz * qz <= 1) seg(px, pz, qx, qz, c);
        px = qx;
        pz = qz;
      }
    }
    geo.setDrawRange(0, n * 2);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  // Bracket on the canopy over the nearest pirate.
  updateMarker(target, ship) {
    const marker = this.cockpit.marker;
    if (!target) {
      marker.visible = false;
      return;
    }
    _eye.copy(EYE).applyQuaternion(ship.quaternion).add(ship.position);
    _v.subVectors(target.obj.position, _eye).applyQuaternion(_q);
    const d = _v.length();
    if (_v.z > -1) {
      marker.visible = false;
      return;
    }
    marker.visible = true;
    _v.multiplyScalar(MARKER_DIST / d);
    marker.position.copy(EYE).add(_v);
    marker.lookAt(_eye.copy(EYE).applyQuaternion(ship.quaternion).add(ship.position));
    marker.scale.setScalar(THREE.MathUtils.clamp((40 / d) * MARKER_DIST, 0.8, 4));
  }

  drawBar(g, y, label, frac, text, color) {
    g.fillStyle = '#8fd8ea';
    g.font = '22px monospace';
    g.fillText(label, 20, y + 21);
    g.fillStyle = '#0b2a33';
    g.fillRect(180, y, 310, 28);
    g.fillStyle = color;
    g.fillRect(180, y, 310 * Math.max(0, Math.min(1, frac)), 28);
    g.fillStyle = '#ffffff';
    g.font = 'bold 20px monospace';
    g.textAlign = 'right';
    g.fillText(text, 484, y + 21);
    g.textAlign = 'left';
  }

  frame(g, title) {
    const W = 512, H = 384;
    g.fillStyle = '#000000'; // black is transparent on the additive hologram
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#1fb6d6';
    g.lineWidth = 4;
    g.strokeRect(4, 4, W - 8, H - 8);
    g.fillStyle = '#7fe9ff';
    g.font = 'bold 28px monospace';
    g.fillText(title, 20, 44);
    g.fillStyle = '#1fb6d6';
    g.fillRect(20, 56, W - 40, 2);
  }

  drawStatus(state) {
    const scr = this.cockpit.screens.left, g = scr.ctx;
    this.frame(g, t('hud.systems'));
    this.drawBar(g, 76, t('hud.speed'), state.speed / (this.maxSpeed * 3), `${Math.round(state.speed)} ${t('unit.mps')}`, '#3cc8ff');
    this.drawBar(g, 132, t('hud.throttle'), state.throttle, `${Math.round(state.throttle * 100)}%`, '#ffd24a');
    this.drawBar(g, 188, t('hud.shields'), state.shields / 100, `${Math.round(state.shields)}`, state.shields < 25 ? '#ff4455' : '#4aa8ff');
    this.drawBar(g, 244, t('hud.hull'), state.hull / 100, `${Math.round(state.hull)}`, state.hull < 30 ? '#ff4444' : '#4cff8a');
    this.drawBar(g, 300, t('hud.energy'), state.energy / 100, `${Math.round(state.energy)}`, '#ffaa44');
    if (state.boosting && Math.floor(state.time * 4) % 2 === 0) {
      g.fillStyle = '#ffdd55';
      g.font = 'bold 26px monospace';
      g.fillText(t('hud.boost'), 20, 362);
    }
    if (state.shields <= 0 && Math.floor(state.time * 3) % 2 === 0) {
      g.fillStyle = '#ff4444';
      g.font = 'bold 26px monospace';
      g.fillText(t('hud.shieldsDown'), 220, 362);
    }
    scr.commit();
  }

  drawNav(state, ship, target, stationPos, zones) {
    const zoneDist = zones.reduce((m, z) => Math.min(m, z.center.distanceTo(ship.position) - z.radius), Infinity);
    const scr = this.cockpit.screens.right, g = scr.ctx;
    this.frame(g, t('hud.nav'));
    g.font = '22px monospace';
    g.fillStyle = '#cdf6ff';
    const lines = [
      [t('hud.score'), state.score],
      [t('hud.kills'), state.kills],
      [t('hud.zone'), zoneDist === Infinity ? '—' : zoneDist <= 0 ? t('hud.inside') : formatDist(zoneDist)],
      [t('hud.target'), target ? formatDist(target.obj.position.distanceTo(ship.position)) : '—'],
      [t('hud.station'), stationPos ? formatDist(Math.max(0, stationPos.distanceTo(ship.position) - 500)) : '—'],
      [t('hud.online'), state.online || '—'],
      [t('hud.mic'), state.mic === null ? '—' : t(state.mic ? 'hud.micOn' : 'hud.micOff')],
    ];
    lines.forEach(([label, value], i) => g.fillText(`${label.padEnd(9)}${value}`, 20, 90 + i * 29));

    // Compass to the nearest station we may dock at: dot position = direction, filled = ahead, hollow = behind
    const cx = 420, cy = 140, r = 56;
    g.strokeStyle = '#1fb6d6';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    if (stationPos) {
      _v.subVectors(stationPos, ship.position).applyQuaternion(_q).normalize();
      g.beginPath();
      g.arc(cx + _v.x * (r - 8), cy - _v.y * (r - 8), 8, 0, Math.PI * 2);
      g.fillStyle = g.strokeStyle = '#44ff88';
      if (_v.z < 0) g.fill(); else g.stroke();
    }
    g.font = '16px monospace';
    g.fillStyle = '#8fd8ea';
    g.textAlign = 'center';
    g.fillText(t('hud.station'), cx, cy + r + 22);
    g.textAlign = 'left';

    // Message log
    let y = 282;
    g.font = 'bold 20px monospace';
    for (const m of this.messages) {
      const age = state.time - m.time;
      if (age > MESSAGE_LIFE) continue;
      g.globalAlpha = Math.min(1, (MESSAGE_LIFE - age) / 2);
      g.fillStyle = m.color;
      g.fillText(m.text, 20, y);
      y += 28;
      if (y > 372) break;
    }
    g.globalAlpha = 1;
    scr.commit();
  }
}
