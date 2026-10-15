import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { buildCockpit, EYE, GUNS } from './cockpit.js';
import { World, SUN_DIR, STATION_SIZE, STATION_FACES, SLOT_HALF_W, SLOT_HALF_H } from './world.js';
import { InfoPanel } from './info.js';
import { VrMenu } from './vrmenu.js';
import { Combat, ZONE_LEASH } from './combat.js';
import { Input } from './input.js';
import { Sfx } from './audio.js';
import { Hud, CONTACT } from './hud.js';
import { t, setText, setLang } from './i18n.js';
import { Net } from './net.js';
import { RemotePlayers } from './remote.js';
import { Voice } from './voice.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { music, musicButton } from './music.js';
import { linksBar } from './links.js';
import { onVolume, volumeSliders } from './volume.js';

const MAX_SPEED = 320;
const BOOST_MULT = 3;
const RATES = new THREE.Vector3(1.0, 0.55, 1.7); // pitch, yaw, roll (rad/s)
const DOCK_MAX_SPEED = 160;
const REPAIR_PAUSE = 5; // seconds docked, the screen dark and the repair clip playing (static/music/base)
const PVP_KILL_SCORE = 250; // as app/modes.py and app/stats.py count them; the server keeps the score
const PIRATE_KILL_SCORE = 100;
const KILL_CREDIT_TIME = 10; // a death within this many seconds of a player's hit counts as their kill
const FORWARD = new THREE.Vector3(0, 0, -1);

const overlay = document.getElementById('overlay');
const loading = document.getElementById('loading');
const touchMode = isTouchDevice(); // phone or tablet: on-screen controls, lighter rendering
document.body.classList.toggle('touch', touchMode);

// Let the loading screen paint before the heavy texture generation.
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

// --- Renderer / scene ------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, touchMode ? 1.5 : 2)); // phone GPUs vs 3x screens
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local'); // seated experience
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 100000);

// A wide phone screen gets a narrower vertical view so the cockpit screens stay large enough to read;
// a portrait screen gets a wider one so there is still something to see left and right.
function fitCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  let fov = touchMode && aspect > 1.6 ? 65 : 75;
  if (aspect < 1) fov = Math.min(100, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(35)) / aspect)));
  camera.fov = fov;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
fitCamera();

// ship -> rig -> camera/controllers. The world moves past a stable cockpit.
const ship = new THREE.Group();
const rig = new THREE.Group();
scene.add(ship);
ship.add(rig);
rig.add(camera);
camera.position.copy(EYE);

const cockpit = buildCockpit({ screenX: touchMode ? 0.4 : 0.6 });
ship.add(cockpit.group);

scene.add(new THREE.AmbientLight(0x6f7f99, 0.6));
const sun = new THREE.DirectionalLight(0xfff4e0, 3);
sun.position.copy(SUN_DIR).multiplyScalar(1000);
scene.add(sun);

// Fade sphere around the head for docking / death transitions
const fade = new THREE.Mesh(
  new THREE.SphereGeometry(0.2, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
);
fade.renderOrder = 10000;
fade.visible = false;
camera.add(fade);
const fader = { value: 0, target: 0 };

const controllerFactory = new XRControllerModelFactory();
for (let i = 0; i < 2; i++) {
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerFactory.createControllerModel(grip));
  rig.add(grip);
}

const world = new World(scene);
const sfx = new Sfx();
const touch = touchMode ? new TouchControls(document.body) : null;
if (touch) touch.visible = false;
const input = new Input(renderer, renderer.domElement, touch);
const hud = new Hud(cockpit, MAX_SPEED);
const info = new InfoPanel(cockpit.screens.info, document.getElementById('info'), touchMode);
// The VR menu (pressing the right stick): the flat panel's settings and the way out to the main menu
const vrMenu = new VrMenu(cockpit.screens.menu, {
  voice: () => voiceToggle.checked,
  async setVoice(on) {
    voiceToggle.checked = playVoice.checked = on;
    await setupVoice();
    if (vrMenu.open) vrMenu.draw(); // the microphone may have been refused
  },
  invert: () => input.invertPitch,
  setInvert,
  exit: () => renderer.xr.getSession()?.end(), // the session end shows the menu
});

// --- Game state ------------------------------------------------------------
const state = {
  mode: 'menu', alive: true, docking: false,
  shields: 100, hull: 100, energy: 100,
  throttle: 0, speed: 0, boosting: false,
  // score and kills: the server's (js/info.js says which)
  score: 0, kills: 0, online: 0, mic: null, lastAttacker: null, lastAttackerTime: -99, time: 0, lastHit: -99, hitFlash: 0,
};
const velocity = new THREE.Vector3();
const angVel = new THREE.Vector3();
let fireCooldown = 0, gunIndex = 0, recenterFrames = 0;
const timers = [];

const after = (delay, fn) => timers.push({ at: state.time + delay, fn });
const say = (text, color) => hud.message(text, color, state.time);

function pulse(intensity, ms, hand) {
  const session = renderer.xr.getSession();
  if (!session) {
    // Phones only buzz for the big events: being hit, kills, death (not every laser shot)
    if (touchMode && intensity >= 0.5) navigator.vibrate?.(ms);
    return;
  }
  for (const src of session.inputSources) {
    if (hand && src.handedness !== hand) continue;
    try {
      src.gamepad?.hapticActuators?.[0]?.pulse(intensity, ms);
    } catch { /* haptics unsupported */ }
  }
}

// Pirates and asteroids are shared: the server owns them, settles damage and credits each kill to
// the player who fired the last shot.
const combat = new Combat(scene, ship, sfx, {
  onPlayerHit() {
    damagePlayer(9);
  },
  onPirateHit(enemy) {
    net.hitPirate(enemy.id);
  },
  onAsteroidHit(asteroid) {
    net.hitAsteroid(asteroid.index, asteroid.maxHp);
  },
  onRam(enemy) {
    combat.explosions.spawn(enemy.obj.position, 1.6);
    sfx.explosion(1);
    net.ram(enemy.id);
    damagePlayer(35);
  },
  onRemoteHit(remote) {
    net.hit(remote.id);
    pulse(0.4, 40, 'right');
  },
  onBaseHit(base) {
    net.hitBase(base.id);
    pulse(0.3, 30, 'right');
  },
});

// Zone alerts when a zone we are in reach of turns hostile (possibly because of another player)
function onZonesChanged(zones) {
  for (const z of zones) {
    const near = state.alive && ship.position.distanceTo(z.center) < z.radius * ZONE_LEASH;
    if (!near) continue;
    if (z.hostile) {
      const count = combat.enemies.count(z);
      if (!count) continue;
      say(t('msg.zoneAlert', { count }), '#ff6655');
      sfx.beep(880, 0.15, 0.15);
      after(0.25, () => sfx.beep(880, 0.15, 0.15));
    } else {
      say(t('msg.zoneEscape'), '#9ff3ff');
    }
  }
}

// --- The map: its type and, on team maps, our team and the round (app/modes.py) -------
// mapInfo: { id, type, name, private, ... } from the server; match: { phase, left, score, lost, result }
let mapInfo = null;
let match = null;
let myTeam = null, myReady = false;
let spawnedOn = null; // the map we were last placed on: a new one starts us at its spawn point
const mode = () => mapInfo?.type ?? null;
const teamMap = () => mode() === 'team' || mode() === 'station';
// Weapons are live except between rounds on team maps; pilots can be shot on PvP maps, and on team maps
// those of the other team
const canFire = () => !teamMap() || match?.phase === 'round';
const teamVoice = () => teamMap() && match?.phase === 'round';
// Music in flight (js/music.js): its own on "Farming space", the battle tracks during a round on team
// maps and the sign-in page's calm ones before and after it, the battle ones on PvP; null until the
// map is known (the menu's track plays on)
const flightMood = () => {
  if (!mapInfo) return null;
  if (mode() === 'farm') return 'farming';
  if (teamMap()) return match?.phase === 'round' ? 'battle' : 'login';
  return 'battle';
}; // voice chat with one's team only (app/room.py)
const canHitPilot = (r) => (mode() === 'pvp' || (teamMap() && r.team !== myTeam)) && canFire();
// Stations we may dock at: everyone's on free-for-all maps, our own team's base on team maps
const ownStation = (st) => st.alive && (st.team === null || st.team === myTeam);

function markBases() {
  for (const st of world.stations) st.hittable = mode() === 'station' && st.team !== myTeam && st.alive;
}

// --- Multiplayer ------------------------------------------------------------------
const remotes = new RemotePlayers(scene);
const nameOf = (id) => remotes.get(id)?.name ?? '?';
// Everyone else on the map ({ id, name, v }), sent by the server when it changes. Snapshots carry only
// the ships near us, so voice chat and the online count go by this list.
let roster = [];
const net = new Net({
  onStatus(connected) {
    if (connected) say(t('msg.online'), '#9ff3ff');
    else {
      clearMultiplayer();
      say(t('msg.offline'), '#ffb36b');
    }
  },
  onKicked() {
    // Our account joined the game from another tab or device: that one plays, this one goes to the menu
    leaveGame('menu.kicked');
  },
  onSignInRequired() {
    // Signed out or the session expired (the server plays with signed-in pilots only)
    leaveGame('menu.signInNeeded');
    accountReady = showAccount();
  },
  onWelcome(msg) {
    mapInfo = msg.map;
    match = msg.match;
    myTeam = msg.team;
    myReady = false;
    say(t('msg.map', { type: t(`info.mode.${mapInfo.type}`), name: mapInfo.name || '—' }), '#9ff3ff');
    voice.closeAll(); // new map or new connection: player ids changed
    roster = [];
    combat.enemies.clear();
    combat.enemies.setZones(msg.zones);
    world.setAsteroids(msg.asteroids);
    world.setStations(msg.stations);
    markBases();
    if (spawnedOn !== mapInfo.id) {
      spawnedOn = mapInfo.id;
      respawn(false);
      // Free-for-all maps start in front of a station; team pilots start at their base
      if (!teamMap()) say(t('msg.stationAhead'), '#44ff88');
    }
    showMapLink();
    selectCurrentMap();
  },
  onYou(msg) {
    // A guest asked for a name that belongs to a registered pilot
    if (msg.taken) say(t('msg.nameTaken', { name: msg.name }), '#ffb36b');
  },
  onSnapshot(msg) {
    const now = performance.now() / 1000;
    msg.bases?.forEach(([hp], i) => world.stations[i] && (world.stations[i].hp = hp));
    const others = msg.players.filter((p) => p.id !== net.id);
    remotes.onSnapshot(others, now);
    // Voice chat with everyone on the map, during a round on team maps with one's own team only (the
    // server relays nothing else): the other team's connections close here when a round starts and
    // open again after it
    voice.sync(roster.filter((p) => p.v && (!teamVoice() || p.tm === myTeam)).map((p) => p.id));
    onZonesChanged(combat.enemies.onSnapshot(msg.pirates, msg.zones, now));
  },
  onRoster(msg) {
    roster = msg.players.filter((p) => p.id !== net.id);
    const me = msg.players.find((p) => p.id === net.id);
    if (!me) return;
    myReady = me.r;
    if (me.tm !== myTeam) {
      // Changed teams between rounds: off to the new team's base
      myTeam = me.tm;
      markBases();
      if (myTeam !== null) {
        say(t('msg.teamNow', { team: t(`info.team${myTeam}`) }), '#9ff3ff');
        respawn(false);
      }
    }
  },
  onScore(msg) {
    state.score = msg.score;
    state.kills = msg.wins;
  },
  onMatch(msg) {
    const was = match?.phase;
    match = msg;
    markBases();
    if (msg.phase === 'countdown' && was !== 'countdown') {
      say(t('msg.countdown'), '#ffd24a');
      sfx.beep(660, 0.15, 0.15);
    }
  },
  onRound() {
    // Everyone starts the round at their base, repaired
    match = { ...(match || {}), phase: 'round' };
    markBases();
    respawn(false);
    say(t('msg.roundStart'), '#ffd24a');
    sfx.beep(990, 0.3, 0.2);
    pulse(0.6, 150);
  },
  onRoundEnd(msg) {
    const team = msg.winner === null ? null : t(`info.team${msg.winner}`);
    say(team === null ? t('msg.roundDraw') : t(msg.reason === 'bases' ? 'msg.roundWonBases' : 'msg.roundWon', { team }),
      msg.winner === myTeam ? '#7dff9a' : '#ffb36b');
    say(t('msg.pressReady'), '#9ff3ff');
  },
  onBase(msg) {
    const st = world.stations[msg.id];
    if (!st) return;
    st.alive = msg.alive;
    st.obj.visible = msg.alive;
    markBases();
    const team = t(`info.team${st.team}`);
    if (!msg.alive) {
      st.hp = 0;
      for (let i = 0; i < 6; i++) {
        const p = st.position.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(Math.random() * STATION_SIZE));
        combat.explosions.spawn(p, 6 + Math.random() * 6);
      }
      sfx.explosion(1 - st.position.distanceTo(ship.position) / 15000);
      say(t(st.team === myTeam ? 'msg.ourBaseDown' : 'msg.baseDown', { team, name: msg.byName }), st.team === myTeam ? '#ff4444' : '#7dff9a');
    } else {
      st.hp = 1;
      say(t('msg.baseBack', { team }), '#9ff3ff');
    }
  },
  onMapClosed(full) {
    forgetMap();
    leaveGame(full ? 'menu.mapFull' : 'menu.mapGone');
  },
  onBolt(msg) {
    const from = new THREE.Vector3().fromArray(msg.from);
    combat.bolts.fire(from, new THREE.Vector3().fromArray(msg.dir));
    sfx.enemyLaser(1 - from.distanceTo(ship.position) / 2500);
  },
  onPirateKill(msg) {
    const e = combat.enemies.get(msg.id);
    const pos = e ? e.obj.position : new THREE.Vector3().fromArray(msg.p);
    if (!e?.rammed) {
      combat.explosions.spawn(pos, 1.6);
      sfx.explosion(1 - pos.distanceTo(ship.position) / 5000);
    }
    combat.enemies.remove(msg.id);
    if (msg.killer === net.id) {
      say(t('msg.kill', { score: PIRATE_KILL_SCORE }), '#7dff9a');
      pulse(0.6, 80);
    } else if (msg.killerName) {
      say(t('msg.pirateKilledBy', { name: msg.killerName }), '#8fd8ea');
    }
  },
  onAsteroid(msg) {
    const a = world.asteroids[msg.i];
    if (!a) return;
    combat.explosions.spawn(a.mesh.position, a.radius / 40);
    sfx.explosion(0.7 * (1 - a.mesh.position.distanceTo(ship.position) / 5000));
    a.mesh.position.fromArray(msg.p);
  },
  onJoin(msg) {
    say(t('msg.joined', { name: msg.name }), '#9ff3ff');
  },
  onLeave(msg) {
    remotes.remove(msg.id);
    say(t('msg.left', { name: msg.name }), '#8fd8ea');
  },
  onRtc(msg) {
    voice.onSignal(msg.from, msg.data);
  },
  onShot(msg) {
    remotes.showShot(msg.from, msg.to);
    sfx.enemyLaser(1 - ship.position.distanceTo(new THREE.Vector3().fromArray(msg.from)) / 3000);
  },
  onHit(msg) {
    if (state.mode === 'play') damagePlayer(msg.dmg, msg.by);
  },
  onKill(msg) {
    if (msg.killer === net.id) {
      say(t('msg.youKilled', { name: msg.victimName, score: PVP_KILL_SCORE }), '#7dff9a');
      pulse(0.8, 120);
    } else if (msg.victim === net.id) {
      if (msg.killerName) say(t('msg.killedBy', { name: msg.killerName }), '#ff6655');
    } else if (msg.killerName) {
      say(t('msg.playerKilled', { killer: msg.killerName, victim: msg.victimName }), '#ffb36b');
    } else {
      say(t('msg.playerDied', { name: msg.victimName }), '#8fd8ea');
    }
    const victim = remotes.get(msg.victim);
    if (victim?.active) {
      combat.explosions.spawn(victim.obj.position, 1.6);
      sfx.explosion(1 - victim.obj.position.distanceTo(ship.position) / 5000);
    }
  },
});

function leaveGame(noteKey) {
  clearMultiplayer();
  setText(menuNote, noteKey);
  if (renderer.xr.isPresenting) renderer.xr.getSession().end(); // the session end shows the menu
  else showMenu();
}

// No longer on a map (it closed, or we were turned away): the next game starts from the map list
function forgetMap() {
  mapInfo = match = null;
  myTeam = null;
  spawnedOn = null;
  if (params.has('map')) {
    params.delete('map');
    history.replaceState(null, '', location.pathname);
  }
  showMapLink();
}

function clearMultiplayer() {
  voice.closeAll();
  remotes.clear();
  roster = [];
  combat.enemies.clear();
  combat.bolts.clear();
}

const menuNote = document.getElementById('menu-note');
const voice = new Voice(net);
// Music (js/music.js): the menu's tracks while choosing a map, the battle ones while flying. The corner
// button shows in the menu only (index.html hides it while playing).
music.play('profile');
musicButton();
// Donation and contact links under the menu (index.html hides them while playing)
linksBar(document.getElementById('overlay'));

// Volume: the game's sounds, music and other pilots' voices (js/volume.js). Sliders in the menu, and the
// same in the settings panel over the game that the ⚙ button or M opens without stopping the flight
// (with the voice chat and inversion switches, see below).
const playSettings = document.getElementById('play-settings');
volumeSliders(document.getElementById('menu-volumes'));
volumeSliders(playSettings);
function toggleSettings(open = playSettings.classList.contains('hidden')) {
  if (open) {
    input.release();
    playVoice.checked = voiceToggle.checked;
    playInvert.checked = invertToggle.checked;
  }
  playSettings.classList.toggle('hidden', !open);
}
document.getElementById('settings-btn').addEventListener('click', (e) => {
  toggleSettings();
  e.currentTarget.blur(); // Space must fire the lasers, not press the button again
});
onVolume((v) => {
  sfx.setVolume(v.sfx);
  voice.setVolume(v.voice);
});

// Pitch inversion, chosen in the menu and remembered by the browser
const invertToggle = document.getElementById('invert-pitch');
try {
  invertToggle.checked = localStorage.getItem('orbita.invertPitch') === 'on';
} catch { /* storage blocked */ }
input.invertPitch = invertToggle.checked;
function setInvert(on) {
  invertToggle.checked = on;
  input.invertPitch = on;
  try {
    localStorage.setItem('orbita.invertPitch', on ? 'on' : 'off');
  } catch { /* storage blocked */ }
}
invertToggle.addEventListener('change', () => setInvert(invertToggle.checked));

const voiceToggle = document.getElementById('voice-toggle');
try {
  voiceToggle.checked = localStorage.getItem('orbita.voice') !== 'off';
} catch { /* storage blocked */ }

async function setupVoice() {
  try {
    localStorage.setItem('orbita.voice', voiceToggle.checked ? 'on' : 'off');
  } catch { /* storage blocked */ }
  if (!voiceToggle.checked) {
    voice.disable();
    return;
  }
  if (voice.enabled) return;
  if (await voice.enable()) say(t(touchMode ? 'msg.voiceReadyTouch' : 'msg.voiceReady'), '#9ff3ff');
  else {
    voiceToggle.checked = playVoice.checked = false;
    say(t('msg.voiceDenied'), '#ffb36b');
  }
}

// The same two switches in the in-flight settings panel: they act at once, the menu's follow them
const playVoice = document.getElementById('play-voice');
const playInvert = document.getElementById('play-invert');
playVoice.addEventListener('change', () => {
  voiceToggle.checked = playVoice.checked;
  setupVoice();
  playVoice.blur(); // Space must fire the lasers, not flip the switch again
});
playInvert.addEventListener('change', () => {
  setInvert(playInvert.checked);
  playInvert.blur();
});

// Players spawn spread out so they don't appear inside each other: around the start point, or on team
// maps in front of their base's docking slot, facing away from it.
function placeAtSpawn() {
  const base = myTeam !== null && world.stations.find((st) => st.team === myTeam);
  if (!base) {
    ship.position.set((Math.random() - 0.5) * 800, (Math.random() - 0.5) * 300, (Math.random() - 0.5) * 400);
    ship.quaternion.identity();
    return;
  }
  const st = base.obj;
  st.updateMatrixWorld();
  ship.position.copy(st.localToWorld(new THREE.Vector3((Math.random() - 0.5) * 600, (Math.random() - 0.5) * 300, STATION_SIZE + 700)));
  ship.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), st.rotation.y + Math.PI);
}
placeAtSpawn();

// Map choice (app/main.py, /api/maps): maps are made by the players. The pilot picks a type, then one
// of the busiest public maps of that type or a new one (private ones are left out of the list and
// joined by their link, ?map=<id>, which the menu shows for the current map).
const NEW_MAP = 'new';
const LINK_MAP = 'link';
const MAP_REFRESH = 5; // seconds between list refreshes while the menu is open
const params = new URLSearchParams(location.search);
const modeSelect = document.getElementById('mode-select');
const mapSelect = document.getElementById('map-select');
const privateRow = document.getElementById('map-private-row');
const privateBox = document.getElementById('map-private');
const mapLinkRow = document.getElementById('map-link-row');
const readyBtn = document.getElementById('match-ready');
let maps = [];
let linked = null; // the map of the link the page was opened with: { id, type, name, ... }
try {
  modeSelect.value = localStorage.getItem('orbita.mode') || 'farm';
} catch { /* storage blocked */ }
if (!modeSelect.value) modeSelect.value = 'farm';

function renderMaps() {
  const current = mapSelect.value;
  const option = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };
  const named = (m) => ({ type: t(`info.mode.${m.type}`), name: m.name || '—' });
  const options = [];
  if (mapInfo) options.push(option(mapInfo.id, t('menu.currentMap', named(mapInfo)))); // back to it from the menu
  if (linked && linked.id !== mapInfo?.id) options.push(option(LINK_MAP, t('menu.linkedMap', named(linked))));
  options.push(option(NEW_MAP, t('menu.newMap')));
  for (const m of maps) {
    if (m.id === mapInfo?.id) continue;
    const phase = m.phase === 'round' ? ` · ${t('menu.inRound')}` : '';
    options.push(option(m.id, t('menu.mapOption', { name: m.name || '—', n: m.players, max: m.max }) + phase));
  }
  mapSelect.replaceChildren(...options);
  mapSelect.value = [...mapSelect.options].some((o) => o.value === current) ? current : options[0].value;
  privateRow.classList.toggle('hidden', mapSelect.value !== NEW_MAP);
}

async function refreshMaps() {
  try {
    const r = await fetch(`/api/maps?type=${encodeURIComponent(modeSelect.value)}`);
    if (!r.ok) throw new Error(r.status);
    maps = await r.json();
  } catch {
    return; // keep the last list; the server may be restarting
  }
  renderMaps();
}

// Opened with a map's link: offer that map first
async function loadLinkedMap() {
  const id = params.get('map');
  if (!id) return;
  try {
    const r = await fetch(`/api/maps/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(r.status);
    linked = await r.json();
    modeSelect.value = linked.type;
    renderMaps();
    mapSelect.value = LINK_MAP;
    privateRow.classList.add('hidden');
  } catch {
    setText(menuNote, 'menu.mapGone');
    forgetMap();
  }
}

modeSelect.addEventListener('change', () => {
  try {
    localStorage.setItem('orbita.mode', modeSelect.value);
  } catch { /* storage blocked */ }
  maps = [];
  renderMaps();
  mapSelect.value = NEW_MAP;
  refreshMaps();
});
mapSelect.addEventListener('change', () => privateRow.classList.toggle('hidden', mapSelect.value !== NEW_MAP));
setInterval(() => state.mode === 'menu' && !document.hidden && refreshMaps(), MAP_REFRESH * 1000);
renderMaps();
refreshMaps();
loadLinkedMap();

// The map to fly: the one picked, or a new one made now. Null if it could not be made.
async function chosenMap() {
  const choice = mapSelect.value;
  if (choice === LINK_MAP) return linked.id;
  if (choice !== NEW_MAP) return choice;
  try {
    const r = await fetch('/api/maps', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: modeSelect.value, private: privateBox.checked, name: pilotName() }),
    });
    if (!r.ok) throw new Error(r.status);
    return (await r.json()).id;
  } catch {
    return null;
  }
}

// The menu's map choice back on the map we are on (so "Play" returns to it)
function selectCurrentMap() {
  if (!mapInfo) return;
  mapSelect.value = mapInfo.id;
  privateRow.classList.add('hidden');
}

// The current map's link, to invite others (the only way into a private map)
function mapLink() {
  return `${location.origin}${location.pathname}?map=${encodeURIComponent(mapInfo.id)}`;
}

function showMapLink() {
  renderMaps();
  mapLinkRow.classList.toggle('hidden', !mapInfo);
  if (!mapInfo) return;
  setText(document.getElementById('map-link-text'), mapInfo.private ? 'menu.linkPrivate' : 'menu.linkPublic', {
    type: t(`info.mode.${mapInfo.type}`), name: mapInfo.name || '—',
  });
  document.getElementById('map-link').href = mapLink();
  if (params.get('map') !== mapInfo.id) {
    params.set('map', mapInfo.id);
    history.replaceState(null, '', `?${params}`);
  }
}

// Team maps between rounds: the same as G and T
readyBtn.addEventListener('click', (e) => {
  net.ready(!myReady);
  e.currentTarget.blur(); // Space must fire the lasers, not press the button again
});
document.getElementById('match-team').addEventListener('click', (e) => {
  net.switchTeam();
  e.currentTarget.blur();
});

document.getElementById('map-link-copy').addEventListener('click', async () => {
  if (!mapInfo) return;
  try {
    await navigator.clipboard.writeText(mapLink());
    setText(menuNote, 'menu.linkCopied');
  } catch {
    setText(menuNote, 'menu.linkCopyFailed');
  }
});

const nameInput = document.getElementById('pilot-name');
const nameBadge = document.getElementById('pilot-badge'); // signed in: the name, shown instead of nameInput
try {
  nameInput.value = localStorage.getItem('orbita.name') || '';
} catch { /* storage blocked */ }
let accountName = null; // signed in: the server flies us under this name whatever we send
function pilotName() {
  if (accountName) return accountName;
  const name = nameInput.value.trim().slice(0, 16);
  try {
    localStorage.setItem('orbita.name', name);
  } catch { /* storage blocked */ }
  return name;
}

// Account (login.html): the menu shows who is signed in; their account name is their pilot name and is
// changed on the account page. Only signed-in pilots play (unless the server allows guests): signed out,
// the play buttons lead to the sign-in page. Hidden when the server has no accounts.
let signInRequired = false;
const SIGN_IN_URL = '/login.html?next=/';
const playButtons = ['desk-btn', 'touch-btn'].map((id) => document.getElementById(id));
const logoutItem = document.getElementById('logout-item');

async function showAccount() {
  const row = document.getElementById('account');
  const nameEl = document.getElementById('account-name');
  const link = document.getElementById('account-link');
  let config;
  try {
    config = await (await fetch('/auth/config')).json();
  } catch {
    return;
  }
  if (!config.enabled) return;
  const r = await fetch('/auth/me').catch(() => null);
  const me = r?.ok ? await r.json() : null;
  signInRequired = !me && !config.guests;
  nameInput.hidden = signInRequired;
  for (const b of playButtons) setText(b, signInRequired ? 'menu.signInToPlay' : b.id === 'desk-btn' ? 'menu.play' : 'menu.playTouch');
  if (me) {
    setText(nameEl, 'menu.signedAs', { name: me.name });
    setText(link, 'menu.account');
    link.href = '/profile.html';
    accountName = me.name;
    nameInput.value = me.name;
    nameInput.hidden = true;
    document.getElementById('pilot-badge-name').textContent = me.name;
    nameBadge.classList.remove('hidden');
    logoutItem.classList.remove('hidden');
  } else {
    logoutItem.classList.add('hidden');
    accountName = null;
    nameBadge.classList.add('hidden');
    nameEl.textContent = '';
    delete nameEl.dataset.i18n;
    setText(link, 'menu.signIn');
    link.href = '/login.html';
  }
  row.classList.remove('hidden');
}
let accountReady = showAccount();

// Sign out: end the session on the server, then reload into the sign-in page (drops the game connection too)
document.getElementById('logout-link').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = SIGN_IN_URL;
});

// Play buttons: straight into the game, or to the sign-in page first
async function play(enter) {
  await accountReady;
  if (signInRequired) location.href = SIGN_IN_URL;
  else enter();
}

// --- Player ship -------------------------------------------------------------
function damagePlayer(amount, attacker = null) {
  if (!state.alive || state.docking) return;
  state.lastHit = state.time;
  if (attacker !== null) {
    state.lastAttacker = attacker;
    state.lastAttackerTime = state.time;
  }
  state.hitFlash = 1;
  const absorbed = Math.min(state.shields, amount);
  const hadShields = state.shields > 0;
  state.shields -= absorbed;
  state.hull -= amount - absorbed;
  sfx.hit();
  pulse(0.9, 120);
  if (hadShields && state.shields <= 0) {
    say(t('msg.shieldsDown'), '#ff5555');
    sfx.beep(440, 0.3, 0.2);
  }
  if (state.hull <= 0) die();
}

function die() {
  state.alive = false;
  state.hull = 0;
  net.died(state.time - state.lastAttackerTime < KILL_CREDIT_TIME ? state.lastAttacker : null);
  state.lastAttacker = null;
  ship.updateMatrixWorld();
  for (let i = 0; i < 4; i++) {
    const p = ship.localToWorld(new THREE.Vector3((Math.random() - 0.5) * 12, 1 + (Math.random() - 0.5) * 6, -6 - Math.random() * 10));
    combat.explosions.spawn(p, 1 + Math.random());
  }
  sfx.explosion(1);
  pulse(1, 600);
  say(t('msg.destroyed'), '#ff4444');
  after(1.6, () => (fader.target = 1));
  after(3.6, () => {
    respawn();
    fader.target = 0;
  });
}

function respawn(announce = true) {
  placeAtSpawn();
  velocity.set(0, 0, 0);
  angVel.set(0, 0, 0);
  Object.assign(state, { alive: true, shields: 100, hull: 100, energy: 100, throttle: 0 });
  combat.bolts.clear();
  if (announce) say(t('msg.respawn'), '#9ff3ff');
}

function dock(station) {
  state.docking = true;
  say(t('msg.dockGranted'), '#44ff88');
  sfx.beep(660, 0.2);
  fader.target = 1;
  // Inside: the ship stops in the tunnel for the repair, out of the fight (damagePlayer skips docking)
  after(1.0, () => {
    velocity.set(0, 0, 0);
    angVel.set(0, 0, 0);
    sfx.track('base', REPAIR_PAUSE);
  });
  after(1.0 + REPAIR_PAUSE, () => {
    const st = station.obj;
    Object.assign(state, { shields: 100, hull: 100, energy: 100, throttle: 0.3 });
    st.updateMatrixWorld();
    ship.position.copy(st.localToWorld(new THREE.Vector3(0, 0, STATION_SIZE + 300)));
    ship.quaternion.copy(st.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    velocity.copy(FORWARD).applyQuaternion(ship.quaternion).multiplyScalar(100);
    angVel.set(0, 0, 0);
    combat.bolts.clear();
    say(t('msg.repaired'), '#44ff88');
  });
  after(1.5 + REPAIR_PAUSE, () => {
    fader.target = 0;
    state.docking = false;
  });
}

function updateShip(dt, controllable) {
  const k = Math.min(1, dt * 4);
  angVel.x += (input.pitch * RATES.x - angVel.x) * k;
  angVel.y += (input.yaw * RATES.y - angVel.y) * k;
  angVel.z += (input.roll * RATES.z - angVel.z) * k;
  ship.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(angVel.x * dt, angVel.y * dt, angVel.z * dt))).normalize();

  if (controllable) {
    state.throttle = THREE.MathUtils.clamp(state.throttle + input.throttle * dt * 0.6, 0, 1);
    if (input.throttleLever !== null) state.throttle = input.throttleLever;
    if (input.allStop) {
      state.throttle = 0;
      say(t('msg.allStop'), '#ffd24a');
    }
  }
  state.boosting = controllable && input.boost && state.energy > 5 && state.throttle > 0;
  if (state.boosting) state.energy -= 20 * dt;

  const targetSpeed = state.throttle * MAX_SPEED * (state.boosting ? BOOST_MULT : 1);
  const desired = FORWARD.clone().applyQuaternion(ship.quaternion).multiplyScalar(targetSpeed);
  if (state.docking) desired.set(0, 0, 0);
  velocity.lerp(desired, Math.min(1, dt * (state.boosting ? 1.5 : 0.9)));
  ship.position.addScaledVector(velocity, dt);
  state.speed = velocity.length();
}

let holdFireSaid = false;
function fireLasers(dt) {
  fireCooldown -= dt;
  if (input.fire && !canFire()) {
    // Between rounds on team maps
    if (!holdFireSaid) say(t('msg.holdFire'), '#ffb36b');
    holdFireSaid = true;
    return;
  }
  if (!input.fire) holdFireSaid = false;
  if (!input.fire || fireCooldown > 0 || state.energy < 2) return;
  fireCooldown = 0.14;
  state.energy -= 2;
  ship.updateMatrixWorld();
  const origin = ship.localToWorld(EYE.clone());
  const dir = FORWARD.clone().applyQuaternion(ship.quaternion);
  const dist = combat.playerShot(origin, dir, gunIndex, GUNS[gunIndex], EYE, world, remotes.list.filter(canHitPilot));
  net.shot(ship.localToWorld(GUNS[gunIndex].clone()), origin.addScaledVector(dir, dist));
  gunIndex = 1 - gunIndex;
  sfx.laser();
  pulse(0.25, 25, 'right');
}

// --- Collisions -------------------------------------------------------------
const _local = new THREE.Vector3(), _n = new THREE.Vector3();

function bounce(normal, depth) {
  ship.position.addScaledVector(normal, depth);
  const vn = velocity.dot(normal);
  if (vn < 0) {
    velocity.addScaledVector(normal, -1.6 * vn);
    damagePlayer(Math.min(60, -vn * 0.12 + 3));
  }
}

function collide() {
  for (const a of world.asteroids) {
    const minD = a.radius * 0.9 + 8;
    const d = ship.position.distanceTo(a.mesh.position);
    if (d < minD) bounce(_n.subVectors(ship.position, a.mesh.position).normalize(), minD - d);
  }

  for (const station of world.stations) {
    if (station.alive && station.position.distanceTo(ship.position) < STATION_SIZE * 2) collideStation(station);
  }
}

// A station's hull, and its docking slot if we may dock there (an enemy base's slot is just wall)
function collideStation(station) {
  const st = station.obj;
  st.updateMatrixWorld();
  st.worldToLocal(_local.copy(ship.position));
  const s = STATION_SIZE;
  if (ownStation(station) && Math.abs(_local.x) < SLOT_HALF_W && Math.abs(_local.y) < SLOT_HALF_H && _local.z > s - 70 && _local.z < s + 40) {
    if (_local.z < s - 20) {
      if (state.speed < DOCK_MAX_SPEED) dock(station);
      else {
        damagePlayer(45);
        say(t('msg.dockTooFast'), '#ff5555');
        velocity.set(0, 0, 1).applyQuaternion(st.quaternion).multiplyScalar(80);
        ship.position.copy(st.localToWorld(new THREE.Vector3(0, 0, s + 40)));
      }
    }
    return;
  }
  let best = -Infinity, bestFace = null;
  for (const f of STATION_FACES) {
    const sd = f.n.dot(_local) - f.d;
    if (sd > best) { best = sd; bestFace = f; }
  }
  const margin = 12;
  if (best < margin) bounce(_n.copy(bestFace.n).applyQuaternion(st.quaternion), margin - best);
}

// --- View / XR -------------------------------------------------------------------
function recenter() {
  if (!renderer.xr.isPresenting) {
    input.lookYaw = input.lookPitch = 0;
    return;
  }
  const yaw = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').y;
  rig.rotation.set(0, -yaw, 0);
  rig.updateMatrix();
  rig.position.copy(EYE).sub(camera.position.clone().applyQuaternion(rig.quaternion));
}

let starting = false;
async function startGame() {
  if (starting) return;
  starting = true;
  sfx.init();
  menuNote.textContent = '';
  delete menuNote.dataset.i18n;
  const map = await chosenMap();
  starting = false;
  if (!map) {
    leaveGame('menu.createFailed');
    return;
  }
  if (net.started && net.map !== map) {
    // Leaving for another map: nothing from the old one carries over
    remotes.clear();
    combat.enemies.clear();
    combat.bolts.clear();
    velocity.set(0, 0, 0);
    state.throttle = 0;
    state.score = state.kills = 0;
    mapInfo = match = null;
  }
  net.start(pilotName(), map);
  setupVoice();
  enterPlay();
}

// Hides the menu and flies on: after startGame(), or straight back with Esc while still on the map
function enterPlay() {
  overlay.classList.add('hidden');
  state.mode = 'play';
  document.body.classList.add('playing'); // the music follows in tick() (flightMood)
  if (touch && !renderer.xr.isPresenting) {
    touch.visible = true;
    goFullscreen();
  }
}

function showMenu() {
  state.mode = 'menu';
  input.release();
  toggleSettings(false);
  vrMenu.toggle(false);
  music.play('profile');
  document.body.classList.remove('playing');
  if (touch) touch.visible = false;
  overlay.classList.remove('hidden');
  selectCurrentMap();
  refreshMaps();
}

// On phones: hide the browser bars and hold landscape where the browser allows it (Android; iPhone
// Safari has neither, there the rotate hint asks the pilot to turn the phone).
async function goFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    await screen.orientation?.lock?.('landscape');
  } catch { /* not supported or refused */ }
}

renderer.xr.addEventListener('sessionstart', () => {
  startGame();
  recenterFrames = 30;
});
renderer.xr.addEventListener('sessionend', () => {
  rig.position.set(0, 0, 0);
  rig.rotation.set(0, 0, 0);
  camera.position.copy(EYE);
  camera.quaternion.identity();
  showMenu();
});

async function setupVrButton() {
  const btn = document.getElementById('vr-btn');
  const note = document.getElementById('vr-note');
  if (!('xr' in navigator)) {
    setText(btn, 'menu.vrUnavailable');
    setText(note, window.isSecureContext ? 'menu.noXr' : 'menu.insecure');
    if (touchMode) btn.hidden = note.hidden = true;
    return;
  }
  const supported = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (!supported) {
    setText(btn, 'menu.vrUnavailable');
    setText(note, 'menu.noHeadset');
    if (touchMode) btn.hidden = note.hidden = true; // an ordinary phone: no point advertising VR
    return;
  }
  btn.disabled = false;
  setText(btn, 'menu.vrEnter');
  btn.addEventListener('click', () => play(async () => {
    sfx.init();
    try {
      const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
      await renderer.xr.setSession(session);
    } catch (e) {
      setText(note, 'menu.vrFailed', { error: e.message });
    }
  }));
}

for (const b of playButtons) b.addEventListener('click', () => play(startGame));
for (const b of document.querySelectorAll('[data-lang]')) {
  b.addEventListener('click', () => {
    setLang(b.dataset.lang);
    showMapLink();
    touch?.applyLang();
  });
}
window.addEventListener('keydown', (e) => {
  // Esc opens the menu; pressed again while still on a map, it goes back to the game
  if (e.code === 'Escape' && !renderer.xr.isPresenting) {
    if (state.mode === 'play') showMenu();
    else if (net.started && mapInfo && !e.repeat) enterPlay();
  }
  if (e.code === 'KeyM' && state.mode === 'play' && !e.repeat && !(e.target instanceof HTMLInputElement && e.target.type === 'text')) {
    toggleSettings();
  }
});
window.addEventListener('resize', fitCamera);

// --- Main loop -------------------------------------------------------------------
const clock = new THREE.Clock();
const contacts = [];

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  state.time += dt;
  for (let i = timers.length - 1; i >= 0; i--) {
    if (timers[i].at <= state.time) timers.splice(i, 1)[0].fn();
  }

  const playing = state.mode === 'play';
  const controllable = playing && state.alive && !state.docking;
  if (playing) {
    const mood = flightMood();
    if (mood) music.play(mood); // nothing happens while it stays the same
  }
  input.panel = vrMenu.open;
  input.update(controllable);
  if (touch?.take('menu')) showMenu();
  if (input.menu && playing && renderer.xr.isPresenting) vrMenu.toggle();
  vrMenu.update(input.nav);
  if (input.recenter) recenter();
  if (playing && teamMap() && match?.phase !== 'round') {
    if (input.ready) net.ready(!myReady);
    if (input.team) net.switchTeam();
  }
  if (recenterFrames > 0 && renderer.xr.isPresenting && --recenterFrames === 0) recenter();

  updateShip(dt, controllable);
  world.update(dt, ship, velocity);
  if (controllable) fireLasers(dt);
  combat.update(dt, performance.now() / 1000, ship.position, controllable);
  if (input.talk && voice.enabled) {
    voice.talk(!voice.talking);
    sfx.beep(voice.talking ? 990 : 660, 0.08, 0.1);
  }
  state.mic = voice.enabled ? voice.talking : null;
  net.update(dt, ship, playing && state.alive && !state.docking, voice.enabled, voice.talking);
  remotes.update(dt, performance.now() / 1000);
  state.online = net.connected ? roster.length + 1 : 0;
  if (controllable) collide();

  // Regeneration
  if (state.alive) {
    state.energy = Math.min(100, state.energy + 12 * dt);
    if (state.time - state.lastHit > 3) state.shields = Math.min(100, state.shields + 6 * dt);
  }

  // Instruments
  contacts.length = 0;
  let target = null, targetDist = Infinity;
  for (const e of combat.enemies.list) {
    contacts.push({ pos: e.obj.position, type: CONTACT.ENEMY });
    const d = e.obj.position.distanceTo(ship.position);
    if (e.mode !== 'patrol' && d < targetDist) { targetDist = d; target = e; }
  }
  for (const r of remotes.list) {
    // [name]: talking; during a round on team maps only teammates, whom one hears
    const heard = r.talking && (!teamVoice() || r.team === myTeam);
    contacts.push({ pos: r.obj.position, type: CONTACT.PLAYER, label: heard ? `[${r.name}]` : r.name });
    const d = r.obj.position.distanceTo(ship.position);
    if (d < targetDist) { targetDist = d; target = r; }
  }
  let home = null, homeDist = Infinity; // the nearest station we may dock at, for the nav screen
  for (const st of world.stations) {
    if (!st.alive) continue;
    contacts.push({ pos: st.position, type: CONTACT.STATION });
    const d = st.position.distanceTo(ship.position);
    if (ownStation(st) && d < homeDist) { homeDist = d; home = st; }
  }
  for (const p of combat.bolts.activePositions()) contacts.push({ pos: p, type: CONTACT.BOLT });
  for (const a of world.asteroids) {
    if (a.mesh.position.distanceTo(ship.position) < 2500) contacts.push({ pos: a.mesh.position, type: CONTACT.ASTEROID });
  }
  hud.update(dt, state, ship, contacts, target, home?.position ?? null, combat.enemies.zones);
  if (playing && mapInfo) {
    if (match?.phase === 'round' || match?.phase === 'countdown') match.left = Math.max(0, match.left - dt);
    info.update(dt, {
      mode: mapInfo.type, score: state.score, wins: state.kills, team: myTeam, ready: myReady,
      readyCount: roster.filter((p) => p.r).length + (myReady ? 1 : 0), total: roster.length + 1,
      match, bases: world.stations, readyKey: renderer.xr.isPresenting ? 'Y' : touchMode ? t('match.ready') : 'G',
    }, renderer.xr.isPresenting);
  }
  cockpit.screens.info.mesh.visible = playing && !!mapInfo && renderer.xr.isPresenting;
  document.body.classList.toggle('on-map', !!mapInfo);
  document.body.classList.toggle('team-lobby', playing && teamMap() && match?.phase !== 'round');
  readyBtn.classList.toggle('on', myReady);
  touch?.render(state);

  cockpit.update(state.time);
  state.hitFlash = Math.max(0, state.hitFlash - dt * 2.5);
  cockpit.glassMat.color.copy(cockpit.glassBase).lerp(new THREE.Color(0xff2020), state.hitFlash);
  cockpit.glassMat.opacity = 0.07 + 0.3 * state.hitFlash;

  fader.value += Math.sign(fader.target - fader.value) * Math.min(Math.abs(fader.target - fader.value), dt * 1.5);
  fade.material.opacity = fader.value;
  fade.visible = fader.value > 0.001;

  sfx.engine(state.speed / (MAX_SPEED * BOOST_MULT), state.boosting);

  if (!renderer.xr.isPresenting) camera.rotation.set(input.lookPitch, input.lookYaw, 0, 'YXZ');
  renderer.render(scene, camera);
}

setupVrButton();
loading.classList.add('hidden');
say(t('msg.welcome'), '#9ff3ff');
renderer.setAnimationLoop(tick);

// Handy for debugging from the browser console.
window.orbita = { state, ship, combat, world, net, remotes, voice, input };
