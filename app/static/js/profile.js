// Pilot profile page (profile.html?id=<id> or ?name=<name>; without either, your own): name, avatar and
// statistics, open to everyone. The owner changes the avatar and the pilot name here. Server side:
// app/profile.py and /auth/name in app/auth.py.
import { t, setText, setLang, getLang } from './i18n.js';
import { music, musicButton } from './music.js';
import { linksBar } from './links.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const AVATAR_SIZE = 256; // px, as app/profile.py expects
const AVATAR_MAX_BYTES = 256 * 1024;
const status = $('#status');
const msg = $('#msg');
let profile = null;

function show(key, kind = 'error', args) {
  if (key) setText(msg, key, args);
  else msg.textContent = '';
  msg.className = `msg ${kind}`;
}

const ERRORS = ['name', 'name_taken', 'too_big', 'not_image', 'signed_out', 'unavailable'];
const errorText = (code) => (ERRORS.includes(code) ? (code.startsWith('name') ? `auth.err.${code}` : `profile.err.${code}`) : 'auth.err.unknown');

async function api(path, options = {}) {
  const r = await fetch(path, options);
  let data = {};
  try {
    data = await r.json();
  } catch { /* empty answer */ }
  if (!r.ok) throw Object.assign(new Error(data.detail), { code: data.detail, status: r.status });
  return data;
}

// --- Rendering -----------------------------------------------------------------------------------
const number = (n) => new Intl.NumberFormat(getLang()).format(n);

function renderAvatar() {
  const box = $('#avatar');
  if (profile.avatar) {
    const img = document.createElement('img');
    img.src = profile.avatar;
    img.alt = profile.name;
    box.replaceChildren(img);
    box.style.background = '';
  } else {
    // No picture: the first letter on a colour of the pilot's own
    box.textContent = [...profile.name][0]?.toUpperCase() || '?';
    box.style.background = `hsl(${(parseInt(profile.id.slice(0, 8), 16) * 137) % 360} 55% 32%)`;
  }
  $('#avatar-remove').disabled = !profile.avatar;
}

function render() {
  const s = profile.stats;
  $('#name').textContent = profile.name;
  setText($('#since'), 'profile.since', {
    date: new Intl.DateTimeFormat(getLang(), { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(profile.since)),
  });
  renderAvatar();
  $('#s-xp').textContent = number(s.xp);
  const hours = s.flightSeconds / 3600;
  $('#s-hours').textContent = hours < 10 ? hours.toFixed(1) : number(Math.floor(hours));
  $('#s-hours').title = t('profile.hm', { h: Math.floor(hours), m: Math.floor((s.flightSeconds % 3600) / 60) });
  $('#s-wins').textContent = number(s.wins);
  $('#s-losses').textContent = number(s.losses);
  $('#s-asteroids').textContent = number(s.asteroidKills);
  $('#s-ratio').textContent = s.losses ? (s.wins / s.losses).toFixed(2) : s.wins ? '∞' : '—';
  for (const el of document.querySelectorAll('.owner')) el.classList.toggle('hidden', !profile.me);
  if (profile.me) $('#name-input').value = profile.name;
  document.title = `${profile.name} — ${t('profile.title')}`;
}

async function load() {
  const query = params.has('id') ? `?id=${encodeURIComponent(params.get('id'))}`
    : params.has('name') ? `?name=${encodeURIComponent(params.get('name'))}` : '';
  const me = await api('/auth/me').catch(() => null);
  $('#signin').classList.toggle('hidden', !!me);
  try {
    profile = await api(`/api/profile${query}`);
  } catch (e) {
    setText(status, e.status === 401 ? 'profile.signInToSee' : e.status === 404 ? 'profile.notFound' : 'profile.err.unavailable');
    status.className = 'msg error';
    return;
  }
  // A stable address to share: names can change, ids (public, random: app/profile.py) do not
  if (!params.has('id')) history.replaceState(null, '', `?id=${profile.id}`);
  $('#myprofile').classList.toggle('hidden', !me || profile.me);
  status.classList.add('hidden');
  $('#card').classList.remove('hidden');
  render();
}

// --- Owner's tools -------------------------------------------------------------------------------

// The middle square of the picture, scaled to AVATAR_SIZE and re-encoded (which also drops its metadata)
async function cropAvatar(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE;
  const g = canvas.getContext('2d');
  g.fillStyle = '#07303d'; // under transparent pixels, JPEG has no alpha
  g.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close?.();
  for (const quality of [0.9, 0.75, 0.6]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= AVATAR_MAX_BYTES) return blob;
  }
  throw Object.assign(new Error(), { code: 'too_big' });
}

$('#avatar-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  show(null);
  try {
    let blob;
    try {
      blob = await cropAvatar(file);
    } catch (err) {
      throw err.code ? err : Object.assign(new Error(), { code: 'not_image' });
    }
    const r = await api('/api/avatar', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    profile.avatar = r.avatar;
    renderAvatar();
    show('profile.avatarSaved', 'ok');
  } catch (err) {
    show(errorText(err.code));
  }
});

$('#avatar-remove').addEventListener('click', async () => {
  try {
    await api('/api/avatar', { method: 'DELETE' });
    profile.avatar = null;
    renderAvatar();
    show(null);
  } catch (err) {
    show(errorText(err.code));
  }
});

$('#name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    const r = await api('/auth/name', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#name-input').value }),
    });
    profile.name = r.name;
    render();
    show('auth.renamed', 'ok');
  } catch (err) {
    show(errorText(err.code));
  } finally {
    button.disabled = false;
  }
});

for (const b of document.querySelectorAll('[data-lang]')) {
  b.addEventListener('click', () => {
    setLang(b.dataset.lang);
    if (profile) render();
  });
}

load();
music.play('profile');
musicButton();
linksBar();
