// Leaderboards (leaders.html; ?by=flight, ?by=wins): the top pilots by experience, flight hours or
// victories (pilots and pirates shot down), open to everyone; the signed-in pilot's row is highlighted, or added at the bottom with their
// place when they are not in the top. Server side: /api/leaders in app/profile.py.
import { t, setText, setLang, getLang } from './i18n.js';
import { music, musicButton } from './music.js';
import { linksBar } from './links.js';

const $ = (sel) => document.querySelector(sel);
const status = $('#status');
const BOARDS = { xp: 'leaders.heading', flight: 'leaders.headingFlight', wins: 'leaders.headingWins' };
let board = new URLSearchParams(location.search).get('by');
if (!(board in BOARDS)) board = 'xp';
let data = null;

const number = (n) => new Intl.NumberFormat(getLang()).format(n);

function avatar(p) {
  const box = document.createElement('span');
  box.className = 'ava';
  if (p.avatar) {
    const img = document.createElement('img');
    img.src = p.avatar;
    img.alt = '';
    img.loading = 'lazy';
    box.append(img);
  } else {
    // Same look as on the profile page: the first letter on the pilot's own colour
    box.textContent = [...p.name][0]?.toUpperCase() || '?';
    box.style.background = `hsl(${(parseInt(p.id.slice(0, 8), 16) * 137) % 360} 55% 32%)`;
  }
  return box;
}

function row(p, mine) {
  const tr = document.createElement('tr');
  if (p.rank <= 3) tr.className = `top${p.rank}`;
  if (mine) tr.classList.add('mine');
  const cell = (text, cls) => {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = text;
    return td;
  };
  const stat = (col, text) => cell(text, col === board ? 'stat active' : 'stat');
  const pilot = document.createElement('td');
  pilot.className = 'pilot';
  const link = document.createElement('a');
  link.href = `/profile.html?id=${p.id}`;
  const name = document.createElement('span');
  name.textContent = p.name;
  link.append(avatar(p), name);
  pilot.append(link);
  // Hours and minutes: whole hours alone would show equal numbers for different places
  const flight = t('profile.hm', { h: number(Math.floor(p.flightSeconds / 3600)), m: Math.floor((p.flightSeconds % 3600) / 60) });
  tr.append(
    cell(p.rank, 'rank'),
    pilot,
    stat('xp', number(p.xp)),
    stat('flight', flight),
    stat('wins', number(p.wins)),
    stat('losses', number(p.losses)),
  );
  return tr;
}

function render() {
  setText($('#heading'), BOARDS[board]);
  for (const b of document.querySelectorAll('[data-board]')) b.classList.toggle('active', b.dataset.board === board);
  for (const th of document.querySelectorAll('th.stat')) th.classList.toggle('active', th.dataset.col === board);
  const myId = data.me?.id;
  const rows = data.leaders.map((p) => row(p, p.id === myId));
  if (data.me && !data.leaders.some((p) => p.id === myId)) {
    const gap = document.createElement('tr');
    gap.className = 'gap';
    gap.innerHTML = '<td colspan="6">⋯</td>';
    rows.push(gap, row(data.me, true));
  }
  $('#rows').replaceChildren(...rows);
  $('#table').classList.toggle('hidden', !rows.length);
  if (rows.length) status.classList.add('hidden');
  else {
    setText(status, 'leaders.empty');
    status.className = 'msg';
  }
}

async function load() {
  try {
    const r = await fetch(`/api/leaders?by=${board}`);
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch {
    setText(status, 'profile.err.unavailable');
    status.className = 'msg error';
    return;
  }
  $('#myprofile').classList.toggle('hidden', !data.signedIn);
  $('#signin').classList.toggle('hidden', data.signedIn);
  render();
}

// Switching boards keeps the address in step, so a link opens the same board
for (const b of document.querySelectorAll('[data-board]')) {
  b.addEventListener('click', () => {
    if (b.dataset.board === board) return;
    board = b.dataset.board;
    history.replaceState(null, '', board === 'xp' ? location.pathname : `?by=${board}`);
    load();
  });
}

for (const b of document.querySelectorAll('[data-lang]')) {
  b.addEventListener('click', () => {
    setLang(b.dataset.lang);
    if (data) render(); // numbers follow the language
  });
}

load();
music.play('profile');
musicButton();
linksBar();
