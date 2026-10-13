// Unified input: WebXR controllers, keyboard/mouse, standard gamepads, flight joysticks and touch controls.
// Outputs: pitch (+ = nose up), yaw (+ = left), roll (+ = left), throttle rate, throttle lever position,
// fire, boost, edge-triggered buttons (ready and team: the "ready" switch and changing teams between
// rounds on team maps; menu: the VR menu, js/vrmenu.js). While the VR menu is open (panel) the
// controllers move through it instead (nav) and fly nothing.

const DEAD = 0.12;
const deadzone = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));
const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const LEVER_STEP = 0.02; // the throttle lever takes over only when it actually moves

// Flight joysticks (e.g. Thrustmaster T.Flight HOTAS X) have no standard mapping; browsers list their
// axes in device order: 0 stick X, 1 stick Y, 2 throttle lever, 3 stick twist, 4 rudder rocker.
const JOY = { roll: 0, pitch: 1, lever: 2, twist: 3, rocker: 4 };
const JOY_BUTTONS = { fire: 0, boost: 1, allStop: 2, recenter: 3, talk: 4 };

export class Input {
  constructor(renderer, canvas, touch = null) {
    this.renderer = renderer;
    this.touch = touch; // TouchControls on phones and tablets
    this.keys = new Set();
    this.prev = new Map();
    this.pitch = this.yaw = this.roll = this.throttle = 0;
    this.fire = this.boost = this.recenter = this.allStop = this.talk = this.ready = this.team = this.menu = false;
    this.panel = false; // set by the game while the VR menu is open
    this.nav = { up: false, down: false, left: false, right: false, press: false };
    this.lookYaw = this.lookPitch = 0;
    this.invertPitch = false; // menu setting: swaps nose up / nose down for every control
    this.throttleLever = null; // 0..1 when a joystick lever moved this frame, otherwise null
    this.levers = new Map(); // gamepad index -> last lever position

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return; // typing the pilot name
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // Dragging the view (mouse, or a finger on the open part of a touch screen)
    let dragging = null, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', (e) => {
      if (dragging !== null) return;
      dragging = e.pointerId;
      lx = e.clientX;
      ly = e.clientY;
    });
    const end = (e) => e.pointerId === dragging && (dragging = null);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('pointermove', (e) => {
      if (e.pointerId !== dragging) return;
      this.lookYaw = Math.max(-2.2, Math.min(2.2, this.lookYaw - (e.clientX - lx) * 0.004));
      this.lookPitch = Math.max(-1.2, Math.min(1.2, this.lookPitch - (e.clientY - ly) * 0.004));
      lx = e.clientX;
      ly = e.clientY;
    });
  }

  edge(id, pressed) {
    const was = this.prev.get(id) || false;
    this.prev.set(id, pressed);
    return pressed && !was;
  }

  update(enabled) {
    const k = (c) => (this.keys.has(c) ? 1 : 0);
    let pitch = k('ArrowUp') - k('ArrowDown');
    let yaw = k('KeyA') - k('KeyD');
    let roll = k('KeyQ') + k('ArrowLeft') - k('KeyE') - k('ArrowRight');
    let throttle = k('KeyW') - k('KeyS');
    let fire = k('Space') === 1;
    let boost = k('ShiftLeft') + k('ShiftRight') > 0;
    let recenter = this.edge('kR', k('KeyR') === 1);
    let allStop = this.edge('kX', k('KeyX') === 1);
    let talk = this.edge('kV', k('KeyV') === 1); // toggles the voice chat microphone
    let ready = this.edge('kG', k('KeyG') === 1);
    let team = this.edge('kT', k('KeyT') === 1);
    let menu = false;
    let lever = null;
    let navX = 0, navY = 0, navPress = false; // the VR menu: either stick, the right trigger or A

    const tc = this.touch;
    if (tc) {
      pitch += tc.pitch;
      roll += tc.roll;
      fire ||= tc.fire;
      boost ||= tc.boost;
      allStop ||= tc.take('allStop');
      recenter ||= tc.take('recenter');
      talk ||= tc.take('talk');
      const l = tc.takeLever();
      if (l !== null) lever = l;
    }

    const session = this.renderer.xr.getSession();
    if (session) {
      for (const src of session.inputSources) {
        const gp = src.gamepad;
        if (!gp) continue;
        const ax = gp.axes;
        const sx = deadzone(ax.length >= 4 ? ax[2] : ax[0] || 0);
        const sy = deadzone(ax.length >= 4 ? ax[3] : ax[1] || 0);
        const btn = (i) => !!gp.buttons[i]?.pressed;
        const h = src.handedness;
        if (h === 'right') {
          roll -= sx;
          pitch += sy; // pull back (+y) = nose up
          fire ||= btn(0);
          recenter ||= this.edge('rA', btn(4));
          talk ||= this.edge('rB', btn(5));
          menu ||= this.edge('rS', btn(3)); // pressing the right stick
          const trigger = this.edge('nT', btn(0)), a = this.edge('nA', btn(4)); // both edges kept up to date
          navPress ||= trigger || a;
        } else if (h === 'left') {
          yaw -= sx;
          throttle -= sy; // push forward (-y) = more thrust
          boost ||= btn(0);
          allStop ||= this.edge('lX', btn(4));
          ready ||= this.edge('lY', btn(5)); // recentring stays on A
          team ||= this.edge('lS', btn(3)); // pressing the left stick
        }
        if (Math.abs(sx) > Math.abs(navX)) navX = sx;
        if (Math.abs(sy) > Math.abs(navY)) navY = sy;
      }
    } else {
      for (const gp of navigator.getGamepads?.() || []) {
        if (!gp) continue;
        if (gp.mapping !== 'standard') {
          const j = this.joystick(gp);
          pitch += j.pitch;
          yaw += j.yaw;
          roll += j.roll;
          fire ||= j.fire;
          boost ||= j.boost;
          allStop ||= j.allStop;
          recenter ||= j.recenter;
          talk ||= j.talk;
          if (j.lever !== null) lever = j.lever;
          continue;
        }
        yaw -= deadzone(gp.axes[0]);
        throttle -= deadzone(gp.axes[1]);
        roll -= deadzone(gp.axes[2]);
        pitch += deadzone(gp.axes[3]);
        fire ||= !!gp.buttons[7]?.pressed;
        boost ||= !!gp.buttons[6]?.pressed;
        allStop ||= this.edge('gX', !!gp.buttons[2]?.pressed);
        recenter ||= this.edge('gY', !!gp.buttons[3]?.pressed);
        talk ||= this.edge('gB', !!gp.buttons[1]?.pressed);
        ready ||= this.edge('gA', !!gp.buttons[0]?.pressed);
        team ||= this.edge('gS', !!gp.buttons[8]?.pressed); // Back / Select
      }
    }

    const nav = this.nav;
    nav.up = this.edge('nU', navY < -0.6);
    nav.down = this.edge('nD', navY > 0.6);
    nav.left = this.edge('nL', navX < -0.6);
    nav.right = this.edge('nR', navX > 0.6);
    nav.press = navPress;
    if (this.panel) {
      // The hands are on the menu: the flight controls and the other buttons rest
      pitch = yaw = roll = throttle = 0;
      fire = boost = allStop = recenter = talk = ready = team = false;
      lever = null;
    }
    this.menu = menu;

    if (!enabled) {
      pitch = yaw = roll = throttle = 0;
      fire = boost = allStop = false;
      lever = null;
    }
    this.pitch = clamp1(this.invertPitch ? -pitch : pitch);
    this.yaw = clamp1(yaw);
    this.roll = clamp1(roll);
    this.throttle = clamp1(throttle);
    this.fire = fire;
    this.boost = boost;
    this.recenter = recenter;
    this.allStop = allStop;
    this.talk = talk;
    this.ready = ready;
    this.team = team;
    this.throttleLever = lever;
  }

  joystick(gp) {
    const axis = (i) => deadzone(gp.axes[i] || 0);
    const btn = (name) => !!gp.buttons[JOY_BUTTONS[name]]?.pressed;
    const id = `j${gp.index}`;
    const out = {
      pitch: axis(JOY.pitch), // pull back (+y) = nose up
      roll: -axis(JOY.roll),
      yaw: -axis(JOY.twist) - axis(JOY.rocker),
      fire: btn('fire'),
      boost: btn('boost'),
      allStop: this.edge(`${id}s`, btn('allStop')),
      recenter: this.edge(`${id}r`, btn('recenter')),
      talk: this.edge(`${id}t`, btn('talk')),
      lever: null,
    };
    if (gp.axes.length > JOY.lever) {
      const pos = (1 - gp.axes[JOY.lever]) / 2; // lever forward = -1 = full thrust
      const last = this.levers.get(gp.index);
      if (last === undefined || Math.abs(pos - last) > LEVER_STEP) {
        if (last !== undefined) out.lever = pos < LEVER_STEP ? 0 : pos > 1 - LEVER_STEP ? 1 : pos;
        this.levers.set(gp.index, pos);
      }
    }
    return out;
  }
}
