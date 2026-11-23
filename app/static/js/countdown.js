// The countdown next to the game's title (index.html, login.html): to the weekly event, every Saturday at
// 14:00 UTC. The moment is the same for everyone, so the time left does not depend on the time zone.
import { t } from './i18n.js';

const SATURDAY = 6;
const EVENT_HOUR = 14; // UTC
const WEEK = 7 * 24 * 3600 * 1000;
const EVENT_LENGTH = 2 * 3600 * 1000; // the event lasts two hours
const BUSIEST_REFRESH = 15000; // ms between looks at the busiest map while the event is on
const pad = (n) => String(n).padStart(2, '0');

// The next event after `now` (ms since the epoch), in the same units
export function nextEvent(now) {
  const d = new Date(now);
  const days = (SATURDAY - d.getUTCDay() + 7) % 7;
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, EVENT_HOUR);
  return at > now ? at : at + WEEK;
}

// Whether the event is on at `now`: it began at the last Saturday 14:00 UTC and lasts two hours
export function eventOnline(now) {
  return nextEvent(now) - WEEK + EVENT_LENGTH > now;
}

export function eventCountdown(root = document.getElementById('event-countdown')) {
  const time = root.querySelector('.event-time');
  const label = root.querySelector('.event-label');
  const link = document.createElement('a');
  link.className = 'event-link';
  link.href = '/';
  link.textContent = t('event.online');
  link.hidden = true;
  label.after(link);
  let online = false;
  let checked = 0;
  // While the event is on, the link leads to the map with the most pilots
  const aim = async () => {
    try {
      const r = await fetch('/api/maps/busiest');
      link.href = r.ok ? `/?map=${encodeURIComponent((await r.json()).id)}` : '/';
    } catch { /* keep the previous link */ }
  };
  const tick = () => {
    // Hidden while flying: nothing to redraw
    if (root.offsetParent !== null) {
      const now = Date.now();
      if (eventOnline(now) !== online) {
        online = !online;
        label.hidden = time.hidden = online;
        link.hidden = !online;
        link.textContent = t('event.online');
        checked = 0;
      }
      if (online) {
        link.textContent = t('event.online'); // follows the language
        if (now - checked >= BUSIEST_REFRESH) {
          checked = now;
          aim();
        }
        setTimeout(tick, 1000 - (Date.now() % 1000));
        return;
      }
      const at = nextEvent(now);
      const left = Math.ceil((at - now) / 1000);
      const days = Math.floor(left / 86400);
      const clock = `${pad(Math.floor(left / 3600) % 24)}:${pad(Math.floor(left / 60) % 60)}:${pad(left % 60)}`;
      time.textContent = days ? `${days} ${t('event.days')} ${clock}` : clock;
    }
    setTimeout(tick, 1000 - (Date.now() % 1000)); // on the turn of each second
  };
  tick();
}
