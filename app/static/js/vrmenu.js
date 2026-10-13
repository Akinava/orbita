// The in-flight menu in VR: a hologram in front of the pilot with the settings of the flat screen's
// panel (voice chat, inversion, volumes) and the way out to the main menu. Opened and closed by
// pressing the right stick (input.menu); while it is open the sticks move through it and the trigger
// or A changes the chosen line (input.nav), and the ship flies on without the pilot's hands.
import { t } from './i18n.js';
import { volume, setVolume } from './volume.js';

const LINE = 56;
const TOP = 78;
const VOLUME_STEP = 0.1;
const TEXT = '#cdf6ff', ACCENT = '#7fe9ff', DIM = '#8fd8ea', WARN = '#ffd24a';

export class VrMenu {
  // screen: the cockpit's CanvasScreen; actions: { voice() -> bool, setVoice(on), invert() -> bool,
  // setInvert(on), exit() }
  constructor(screen, actions) {
    this.screen = screen;
    this.actions = actions;
    this.open = false;
    this.selected = 0;
    const onOff = (on) => t(on ? 'vrmenu.on' : 'vrmenu.off');
    const toggle = (get, set) => ({ value: () => onOff(get()), change: () => set(!get()), press: () => set(!get()) });
    const level = (kind) => ({
      value: () => `${Math.round(volume[kind] * 100)}%`,
      change: (dir) => setVolume(kind, Math.round((volume[kind] + dir * VOLUME_STEP) * 10) / 10),
    });
    this.items = [
      { key: 'menu.voice', ...toggle(actions.voice, actions.setVoice) },
      { key: 'menu.invert', ...toggle(actions.invert, actions.setInvert) },
      { key: 'menu.volumeSfx', ...level('sfx') },
      { key: 'menu.volumeMusic', ...level('music') },
      { key: 'menu.volumeVoice', ...level('voice') },
      { key: 'vrmenu.resume', press: () => this.toggle(false) },
      { key: 'vrmenu.exit', press: () => { this.toggle(false); actions.exit(); } },
    ];
    screen.mesh.visible = false;
  }

  toggle(open = !this.open) {
    this.open = open;
    this.screen.mesh.visible = open;
    if (open) this.draw();
  }

  // nav: { up, down, left, right, press } this frame, from input.nav
  update(nav) {
    if (!this.open) return;
    const n = this.items.length;
    let changed = false;
    if (nav.up || nav.down) {
      this.selected = (this.selected + (nav.down ? 1 : -1) + n) % n;
      changed = true;
    }
    const item = this.items[this.selected];
    if ((nav.left || nav.right) && item.change) {
      item.change(nav.right ? 1 : -1);
      changed = true;
    } else if (nav.press && item.press) {
      item.press();
      changed = true;
    }
    if (changed && this.open) this.draw();
  }

  draw() {
    const g = this.screen.ctx, { width: w, height: h } = this.screen.canvas;
    g.fillStyle = '#000000'; // transparent on the additive hologram
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#1fb6d6';
    g.lineWidth = 3;
    g.strokeRect(2, 2, w - 4, h - 4);
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillStyle = ACCENT;
    g.font = 'bold 34px monospace';
    g.fillText(t('menu.settings'), w / 2, 40);
    this.items.forEach((item, i) => {
      const y = TOP + LINE * (i + 0.5);
      const on = i === this.selected;
      if (on) {
        g.fillStyle = '#0b4a5e';
        g.fillRect(16, y - LINE / 2 + 4, w - 32, LINE - 8);
      }
      g.font = `${on ? 'bold ' : ''}28px monospace`;
      if (item.value) {
        g.textAlign = 'left';
        g.fillStyle = on ? '#ffffff' : TEXT;
        g.fillText(t(item.key), 36, y);
        g.textAlign = 'right';
        g.fillStyle = on ? WARN : DIM;
        g.fillText(on ? `◀ ${item.value()} ▶` : item.value(), w - 36, y);
      } else {
        g.textAlign = 'center';
        g.fillStyle = on ? '#ffffff' : ACCENT;
        g.fillText(t(item.key), w / 2, y);
      }
    });
    g.textAlign = 'center';
    g.fillStyle = DIM;
    g.font = '20px monospace';
    g.fillText(t('vrmenu.hint'), w / 2, h - 26);
    this.screen.commit();
  }
}
