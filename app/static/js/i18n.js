// UI language: string lookup and the static DOM texts of the start screen.
// Strings live in i18n/<lang>.js; the choice is remembered in localStorage (English by default).
import en from './i18n/en.js';
import ru from './i18n/ru.js';

export const LANGS = { en, ru };
const STORAGE_KEY = 'orbita.lang';

function storedLang() {
  try {
    const l = localStorage.getItem(STORAGE_KEY);
    return l in LANGS ? l : 'en';
  } catch {
    return 'en';
  }
}

let lang = storedLang();

export const getLang = () => lang;

export function t(key, params) {
  let s = LANGS[lang][key] ?? LANGS.en[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
  return s;
}

// Elements with data-i18n get their text from that key; data-i18n-args holds JSON params;
// data-i18n-placeholder and data-i18n-title set an element's placeholder and tooltip; <body data-title>
// names the key of the page title.
export function applyDom(root = document) {
  document.documentElement.lang = lang;
  document.title = t(document.body?.dataset.title || 'page.title');
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n, el.dataset.i18nArgs ? JSON.parse(el.dataset.i18nArgs) : undefined);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-lang]')) el.classList.toggle('active', el.dataset.lang === lang);
}

// Point an element at a key (so it survives a language switch) and render it now.
export function setText(el, key, params) {
  el.dataset.i18n = key;
  if (params) el.dataset.i18nArgs = JSON.stringify(params);
  else delete el.dataset.i18nArgs;
  el.textContent = t(key, params);
}

export function setLang(l) {
  if (!(l in LANGS)) return;
  lang = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch { /* storage blocked */ }
  applyDom();
}

applyDom();
