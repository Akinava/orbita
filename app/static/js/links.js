// A strip pinned to the bottom of a page with links to the donation platforms and to the Telegram group. The
// page's scrolling element and the corner music button keep clear of it, also when it wraps onto two lines on a phone.
import { t } from './i18n.js';

const DONATE_LINKS = [
  ['Boosty', 'https://boosty.to/akinava'],
  ['Patreon', 'https://www.patreon.com/c/Akinava'],
];
const TELEGRAM = 'https://orbita.p2me.in/';

const CSS = `
  .links-clear { padding-bottom: calc(var(--links-h, 64px) + 16px) !important; }
  #music-btn { bottom: calc(var(--links-h, 64px) + 10px) !important; }
  #links-bar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 15; display: flex; align-items: center;
    justify-content: center; flex-wrap: wrap; gap: 8px 12px; box-sizing: border-box;
    background: rgba(2, 10, 18, 0.95); border-top: 1px solid #1d5a6c; box-shadow: 0 -4px 24px rgba(40, 215, 255, 0.12);
    padding: 10px max(16px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    font-family: system-ui, sans-serif;
  }
  #links-bar section { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px 12px; }
  #links-bar section.contact { padding-left: 16px; margin-left: 4px; border-left: 1px solid #1d5a6c; }
  @media (max-width: 640px) {
    #links-bar section.contact { padding: 8px 0 0; margin: 0; border-left: 0; border-top: 1px solid #1d5a6c; width: 100%; }
  }
  #links-bar span { font-weight: 700; color: #fff; text-align: center; }
  #links-bar div { display: flex; gap: 8px; }
  #links-bar a {
    font-weight: 700; font-size: 14px; padding: 8px 14px; border-radius: 8px; border: 1px solid #28d7ff;
    background: #07303d; color: #e8fbff; text-decoration: none;
  }
  #links-bar a:hover { background: #0b4a5e; }
  #links-bar a.tg { border-color: #2aabee; background: #0b2a3d; }
  #links-bar a.tg:hover { background: #12415e; }
`;

// `scroller` is the element whose content scrolls under the strip (the page body by default).
export function linksBar(scroller = document.body) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const bar = document.createElement('aside');
  bar.id = 'links-bar';
  const link = (name, href) => {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = name;
    return a;
  };
  // A labelled group of links; the label follows a language switch (applyDom).
  const group = (key, anchors) => {
    const section = document.createElement('section');
    const label = document.createElement('span');
    label.dataset.i18n = key;
    label.textContent = t(key);
    const links = document.createElement('div');
    links.append(...anchors);
    section.append(label, links);
    return section;
  };
  const tg = link('Telegram', TELEGRAM);
  tg.className = 'tg';
  const contact = group('links.contact', [tg]);
  contact.className = 'contact';
  bar.append(group('links.donate', DONATE_LINKS.map(([name, href]) => link(name, href))), contact);
  document.body.append(bar);

  scroller.classList.add('links-clear');
  new ResizeObserver(() => document.documentElement.style.setProperty('--links-h', `${bar.offsetHeight}px`)).observe(bar);
}
