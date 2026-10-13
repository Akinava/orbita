// A strip pinned to the bottom of a page with links to the donation platforms. The page's scrolling
// element and the corner music button keep clear of it, also when it wraps onto two lines on a phone.
import { t } from './i18n.js';

const LINKS = [
  ['Boosty', 'https://boosty.to/akinava'],
  ['Patreon', 'https://www.patreon.com/c/Akinava'],
];

const CSS = `
  .donate-clear { padding-bottom: calc(var(--donate-h, 64px) + 16px) !important; }
  #music-btn { bottom: calc(var(--donate-h, 64px) + 10px) !important; }
  #donate {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 15; display: flex; align-items: center;
    justify-content: center; flex-wrap: wrap; gap: 8px 12px; box-sizing: border-box;
    background: rgba(2, 10, 18, 0.95); border-top: 1px solid #1d5a6c; box-shadow: 0 -4px 24px rgba(40, 215, 255, 0.12);
    padding: 10px max(16px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    font-family: system-ui, sans-serif;
  }
  #donate span { font-weight: 700; color: #fff; text-align: center; }
  #donate div { display: flex; gap: 8px; }
  #donate a {
    font-weight: 700; font-size: 14px; padding: 8px 14px; border-radius: 8px; border: 1px solid #28d7ff;
    background: #07303d; color: #e8fbff; text-decoration: none;
  }
  #donate a:hover { background: #0b4a5e; }
`;

// `scroller` is the element whose content scrolls under the strip (the page body by default).
export function donateBar(scroller = document.body) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const bar = document.createElement('aside');
  bar.id = 'donate';
  const label = document.createElement('span');
  label.dataset.i18n = 'donate.text'; // follows a language switch (applyDom)
  label.textContent = t('donate.text');
  const links = document.createElement('div');
  for (const [name, href] of LINKS) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = name;
    links.append(a);
  }
  bar.append(label, links);
  document.body.append(bar);

  scroller.classList.add('donate-clear');
  new ResizeObserver(() => document.documentElement.style.setProperty('--donate-h', `${bar.offsetHeight}px`)).observe(bar);
}
