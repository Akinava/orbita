// Multiplayer connection: reports our ship to the server and dispatches what it relays.
// Messages are JSON; see app/main.py for the server side. Reconnects on its own.

const STATE_INTERVAL = 1 / 15; // seconds between state reports
const RECONNECT_DELAY = 2000;
const KICK_CODE = 4001; // the same account joined the game elsewhere (app/main.py): do not reconnect
const SIGN_IN_CODE = 4401; // no account (or the session expired): only signed-in pilots play
const NO_MAP_CODE = 4404; // the map was closed (nobody on it for a while) or never was
const FULL_CODE = 4409;

export class Net {
  // hooks: onWelcome(msg), onYou(msg), onSnapshot(msg), onRoster(msg), onJoin(msg), onLeave(msg), onShot(msg), onHit(msg), onKill(msg),
  //        onBolt(msg), onPirateKill(msg), onAsteroid(msg), onRtc(msg), onStatus(connected), onKicked(),
  //        onSignInRequired(), onMapClosed(full), onScore(msg), onMatch(msg), onRound(msg), onRoundEnd(msg),
  //        onBase(msg)
  constructor(hooks) {
    this.hooks = hooks;
    this.id = null;
    this.name = '';
    this.map = null;
    this.ws = null;
    this.started = false;
    this.stateTimer = 0;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // Connects to the map with the id `map` (created by POST /api/maps), or switches to it if we are on
  // another one.
  start(name, map) {
    this.name = name;
    if (this.started && map === this.map) return;
    this.started = true;
    this.map = map;
    const old = this.ws;
    this.ws = null; // so its close handler does not reconnect
    old?.close();
    this.id = null;
    this.connect();
  }

  connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?map=${encodeURIComponent(this.map)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ type: 'hello', name: this.name });
      this.hooks.onStatus?.(true);
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'welcome': this.id = msg.id; this.hooks.onWelcome?.(msg); break;
        case 'you': this.name = msg.name; this.hooks.onYou?.(msg); break; // the name the server gave us
        case 'snap': this.hooks.onSnapshot?.(msg); break;
        case 'roster': this.hooks.onRoster?.(msg); break;
        case 'bolt': this.hooks.onBolt?.(msg); break;
        case 'pkill': this.hooks.onPirateKill?.(msg); break;
        case 'arespawn': this.hooks.onAsteroid?.(msg); break;
        case 'join': this.hooks.onJoin?.(msg); break;
        case 'leave': this.hooks.onLeave?.(msg); break;
        case 'shot': this.hooks.onShot?.(msg); break;
        case 'hit': this.hooks.onHit?.(msg); break;
        case 'kill': this.hooks.onKill?.(msg); break;
        case 'rtc': this.hooks.onRtc?.(msg); break;
        case 'score': this.hooks.onScore?.(msg); break;
        case 'match': this.hooks.onMatch?.(msg); break;
        case 'round': this.hooks.onRound?.(msg); break;
        case 'roundEnd': this.hooks.onRoundEnd?.(msg); break;
        case 'base': this.hooks.onBase?.(msg); break;
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.id = null;
      if ([KICK_CODE, SIGN_IN_CODE, NO_MAP_CODE, FULL_CODE].includes(e.code)) {
        this.ws = null;
        this.started = false; // the next start() connects again
        if (e.code === KICK_CODE) this.hooks.onKicked?.();
        else if (e.code === SIGN_IN_CODE) this.hooks.onSignInRequired?.();
        else this.hooks.onMapClosed?.(e.code === FULL_CODE);
        return;
      }
      this.hooks.onStatus?.(false);
      setTimeout(() => this.connect(), RECONNECT_DELAY);
    };
  }

  send(msg) {
    if (this.connected) this.ws.send(JSON.stringify(msg));
  }

  // Called every frame; reports position, orientation, whether we can be seen and hit, and our voice
  // chat state (voice: in the chat, talking: microphone open).
  update(dt, ship, active, voice = false, talking = false) {
    this.stateTimer -= dt;
    if (this.stateTimer > 0) return;
    this.stateTimer = STATE_INTERVAL;
    const r = (x) => Math.round(x * 100) / 100;
    const q = ship.quaternion;
    this.send({
      type: 'state',
      p: ship.position.toArray().map(r),
      q: [q.x, q.y, q.z, q.w].map((x) => Math.round(x * 1e4) / 1e4),
      a: active,
      v: voice,
      t: talking,
    });
  }

  shot(from, to) {
    this.send({ type: 'shot', from: from.toArray(), to: to.toArray() });
  }

  hit(targetId) {
    this.send({ type: 'hit', target: targetId });
  }

  hitPirate(id) {
    this.send({ type: 'phit', id });
  }

  ram(id) {
    this.send({ type: 'ram', id });
  }

  hitAsteroid(index, maxHp) {
    this.send({ type: 'ahit', i: index, hp: maxHp });
  }

  died(byId) {
    this.send({ type: 'died', by: byId });
  }

  hitBase(id) {
    this.send({ type: 'bhit', id });
  }

  // Team maps, between rounds
  ready(on) {
    this.send({ type: 'ready', on });
  }

  switchTeam() {
    this.send({ type: 'team' });
  }
}
