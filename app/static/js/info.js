// Info panel at the top centre of the view while playing: the pilot's score and victories (all-time on
// farming maps, on this map on PvP ones, in the round on team maps), and on team maps the round: its
// clock or the countdown, the teams' points, who is ready between rounds and, on "station" maps, the
// bases. One drawing, two places: a canvas over the page on a flat screen, a hologram high on the
// canopy in VR (screens.info in cockpit.js). On a phone the flat panel is compact: a line or two with
// only the numbers that matter in flight (the "Ready" button below it replaces the hints).
import { t } from './i18n.js';
import { TEAM_COLORS } from './world.js';

const W = 640;
const LINE = 40;
const PAD = 14;
const COMPACT = { w: 420, line: 32, pad: 6 }; // the phone panel: narrower, so its text shows larger
const REDRAW = 0.2; // seconds
const TEXT = '#cdf6ff', ACCENT = '#7fe9ff', WARN = '#ffd24a', DIM = '#8fd8ea';
export const TEAM_CSS = TEAM_COLORS.map((c) => `#${c.toString(16).padStart(6, '0')}`);

const number = (n) => new Intl.NumberFormat().format(n);
const clock = (s) => {
  const m = Math.floor(Math.max(0, s) / 60), sec = Math.floor(Math.max(0, s) % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};
const teamName = (team) => [t(`info.team${team}`), TEAM_CSS[team]];

export class InfoPanel {
  // screen: the VR hologram (CanvasScreen); root: the page element that holds the flat canvas;
  // compact: the flat panel of a phone
  constructor(screen, root, compact = false) {
    this.screen = screen;
    this.compact = compact;
    this.canvas = document.createElement('canvas');
    this.canvas.width = compact ? COMPACT.w : W;
    root.prepend(this.canvas);
    this.timer = 0;
  }

  // d: { mode, score, wins, team, ready, readyCount, total, match, bases, readyKey }
  update(dt, d, vr) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = REDRAW;
    if (vr) {
      const c = this.screen.canvas;
      this.draw(this.screen.ctx, W, c.height, LINE, this.lines(d));
      this.screen.commit();
    } else {
      const compact = this.compact;
      const lines = compact ? this.compactLines(d) : this.lines(d);
      const line = compact ? COMPACT.line : LINE;
      const h = lines.length * line + (compact ? COMPACT.pad : PAD) * 2;
      if (this.canvas.height !== h) this.canvas.height = h;
      this.draw(this.canvas.getContext('2d'), this.canvas.width, h, line, lines);
    }
  }

  // Each line: a list of [text, colour] pieces, centred; the first line is the title
  lines(d) {
    if (d.mode === 'farm') {
      return [
        [[t('info.mode.farm'), ACCENT]],
        [[`${t('info.scoreAll')} `, DIM], [number(d.score), TEXT], ['   ', TEXT], [`${t('info.winsAll')} `, DIM], [number(d.wins), TEXT]],
      ];
    }
    if (d.mode === 'pvp') {
      return [
        [[t('info.mode.pvp'), ACCENT]],
        [[`${t('info.scoreMap')} `, DIM], [number(d.score), TEXT], ['   ', TEXT], [`${t('info.winsMap')} `, DIM], [number(d.wins), TEXT]],
      ];
    }
    const m = d.match || { phase: 'lobby', left: 0, score: [0, 0], lost: [0, 0], result: null };
    const out = [];
    if (m.phase === 'round') out.push([[t('info.round', { time: clock(m.left) }), ACCENT]]);
    else if (m.phase === 'countdown') out.push([[t('info.countdown', { n: Math.ceil(m.left) }), WARN]]);
    else if (m.result) {
      const w = m.result.winner;
      out.push(w === null ? [[t('info.draw'), WARN]] : [[t('info.won', { team: t(`info.team${w}`) }), TEAM_CSS[w]]]);
    } else out.push([[t(`info.mode.${d.mode}`), ACCENT]]);

    const [a, b] = m.phase === 'lobby' && m.result ? m.result.score : m.score;
    out.push([teamName(0), [`  ${number(a)} : ${number(b)}  `, TEXT], teamName(1)]);
    if (d.mode === 'station') {
      const lost = m.phase === 'lobby' && m.result ? m.result.lost : m.lost;
      const base = (team) => {
        const st = d.bases.find((s) => s.team === team);
        return st && !st.alive ? t('info.baseDown') : `${Math.round((st?.hp ?? 1) * 100)}%`;
      };
      out.push([
        [`${t('info.bases')} `, DIM], [`${base(0)} · ${lost[0]}/3`, TEAM_CSS[0]], ['   ', TEXT], [`${base(1)} · ${lost[1]}/3`, TEAM_CSS[1]],
      ]);
    }
    const you = d.team === null ? [] : [[`${t('info.you')} `, DIM], teamName(d.team), ['   ', TEXT]];
    if (m.phase === 'round') {
      out.push([...you, [`${t('info.scoreRound')} `, DIM], [number(d.score), TEXT], ['   ', TEXT], [`${t('info.winsRound')} `, DIM], [number(d.wins), TEXT]]);
    } else {
      out.push([...you, [t('info.readyCount', { n: d.readyCount, total: d.total }), TEXT]]);
      out.push(d.ready ? [[t('info.waiting'), DIM]] : [[t('info.pressReady', { key: d.readyKey }), WARN]]);
    }
    return out;
  }

  // The phone's version of lines(): no titles or hints, the score and victories (or, on team maps, the
  // round's clock and the teams' points, the bases, how many are ready) in one or two lines
  compactLines(d) {
    if (d.mode === 'farm' || d.mode === 'pvp') {
      return [[[`★ ${number(d.score)}`, TEXT], ['   ', TEXT], [`⚔ ${number(d.wins)}`, TEXT]]];
    }
    const m = d.match || { phase: 'lobby', left: 0, score: [0, 0], lost: [0, 0], result: null };
    const lobby = m.phase === 'lobby';
    let status;
    if (m.phase === 'round') status = [clock(m.left), ACCENT];
    else if (m.phase === 'countdown') status = [t('info.countdown', { n: Math.ceil(m.left) }), WARN];
    else if (m.result) {
      const w = m.result.winner;
      status = w === null ? [t('info.draw'), WARN] : [t('info.won', { team: t(`info.team${w}`) }), TEAM_CSS[w]];
    }
    // The pilot's own team is marked with an arrow
    const team = (i) => { const [name, color] = teamName(i); return [d.team === i ? `▸${name}` : name, color]; };
    const [a, b] = lobby && m.result ? m.result.score : m.score;
    const out = [[...(status ? [status, ['   ', TEXT]] : []), team(0), [` ${number(a)} : ${number(b)} `, TEXT], team(1)]];
    if (d.mode === 'station') {
      const lost = lobby && m.result ? m.result.lost : m.lost;
      const base = (i) => {
        const st = d.bases.find((s) => s.team === i);
        return [`${st && !st.alive ? '✕' : `${Math.round((st?.hp ?? 1) * 100)}%`} ${lost[i]}/3`, TEAM_CSS[i]];
      };
      out.push([base(0), ['   ', TEXT], base(1)]);
    }
    if (m.phase !== 'round') out.push([[t('info.readyCount', { n: d.readyCount, total: d.total }), d.ready ? DIM : WARN]]);
    return out;
  }

  // w, h: the canvas; line: a line's height
  draw(g, w, h, line, lines) {
    g.fillStyle = '#000000'; // transparent on the additive hologram, a dark panel on the page
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#1fb6d6';
    g.lineWidth = 3;
    g.strokeRect(2, 2, w - 4, h - 4);
    g.textBaseline = 'middle';
    const top = (h - lines.length * line) / 2;
    lines.forEach((pieces, i) => {
      // A line too long for the panel (a long translation) gets a smaller font
      let size = i === 0 ? 28 : 24, width;
      do {
        g.font = `${i === 0 ? 'bold ' : ''}${size}px monospace`;
        width = pieces.reduce((sum, [text]) => sum + g.measureText(text).width, 0);
      } while (width > w - 24 && --size > 12);
      let x = (w - width) / 2;
      for (const [text, color] of pieces) {
        g.fillStyle = color;
        g.fillText(text, x, top + line * (i + 0.5));
        x += g.measureText(text).width;
      }
    });
  }
}
