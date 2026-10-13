// Sign-in page (login.html): e-mail sign-in and sign-up with Cloudflare Turnstile, provider buttons,
// the forgotten password forms and the signed-in view. The server side is app/auth.py.
import { t, setText, setLang, getLang } from './i18n.js';
import { music, musicButton } from './music.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const next = params.get('next') || '/';
// The password reset link: keep its token, then drop it from the address bar and history
const resetToken = params.get('reset');
if (resetToken) history.replaceState(null, '', location.pathname);
const msg = $('#msg');
const resendBtn = $('#resend');
let config = { enabled: false, providers: [], captchaSiteKey: null };
let lastEmail = '';

function show(key, kind = 'error', args) {
  if (key) setText(msg, key, args);
  else msg.textContent = '';
  msg.className = `msg ${kind}`;
}

async function api(path, body) {
  const r = await fetch(`/auth/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await r.json();
  } catch { /* empty answer */ }
  if (!r.ok) {
    const code = typeof data.detail === 'string' ? data.detail : 'unknown';
    throw Object.assign(new Error(code), { code });
  }
  return data;
}

const ERRORS = ['captcha', 'credentials', 'unverified', 'email', 'password', 'mail', 'unavailable', 'token', 'oauth', 'provider', 'name', 'name_taken'];
const errorText = (code) => `auth.err.${ERRORS.includes(code) ? code : 'unknown'}`;

// --- Captcha -------------------------------------------------------------------------------------
const widgets = {};
let turnstileReady = null;

function loadTurnstile() {
  turnstileReady ??= new Promise((resolve, reject) => {
    window.onTurnstileLoad = resolve;
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
    s.async = true;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return turnstileReady;
}

async function renderCaptcha(form) {
  if (!config.captchaSiteKey || widgets[form] !== undefined) return;
  try {
    await loadTurnstile();
  } catch {
    show('auth.err.captchaLoad');
    return;
  }
  widgets[form] = window.turnstile.render(`#captcha-${form}`, {
    sitekey: config.captchaSiteKey, language: getLang(), theme: 'dark',
  });
}

function captchaToken(form) {
  return widgets[form] !== undefined ? window.turnstile.getResponse(widgets[form]) || '' : '';
}

function resetCaptcha(form) {
  if (widgets[form] !== undefined) window.turnstile.reset(widgets[form]);
}

// --- Views ---------------------------------------------------------------------------------------
const VIEWS = ['login', 'register', 'forgot', 'reset'];

// One form at a time; the tabs and provider buttons belong to sign-in and sign-up only
function showView(view) {
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === view);
  for (const v of VIEWS) $(`#${v}-form`).classList.toggle('hidden', v !== view);
  const reset = view === 'reset';
  for (const id of ['#tabs', '#providers', '#or']) $(id).classList.toggle('hidden', reset);
  resendBtn.classList.add('hidden');
  show(null);
  if (view === 'forgot' && !$('#forgot-form').email.value) $('#forgot-form').email.value = $('#login-form').email.value;
  if (!reset) renderCaptcha(view); // no third-party script on the page that holds the reset token
}

function showSignedIn(me) {
  $('#forms').classList.add('hidden');
  $('#signed').classList.remove('hidden');
  $('#me-name').textContent = me.name;
  $('#me-email').textContent = me.email || '';
  $('#me-email').classList.toggle('hidden', !me.email);
}

async function init() {
  try {
    config = await api('config');
  } catch { /* server without accounts */ }
  if (!config.enabled) {
    $('#unavailable').classList.remove('hidden');
    return;
  }
  try {
    if (resetToken) throw new Error('reset'); // a reset link works for whoever is signed in here
    const me = await api('me');
    showSignedIn(me);
    if (params.has('verified')) show('auth.verified', 'ok');
    return;
  } catch { /* signed out */ }
  $('#forms').classList.remove('hidden');
  for (const b of document.querySelectorAll('[data-provider]')) {
    const on = config.providers.includes(b.dataset.provider);
    b.disabled = !on;
    if (!on) b.title = t('auth.providerOff');
  }
  if (resetToken) {
    showView('reset');
    return;
  }
  showView(params.get('tab') === 'register' ? 'register' : 'login');
  if (params.has('error')) show(errorText(params.get('error')));
}

// --- Actions -------------------------------------------------------------------------------------
for (const b of document.querySelectorAll('[data-tab], [data-view]')) {
  b.addEventListener('click', () => showView(b.dataset.tab || b.dataset.view));
}

for (const b of document.querySelectorAll('[data-provider]')) {
  b.addEventListener('click', () => {
    location.href = `/auth/${b.dataset.provider}/start?next=${encodeURIComponent(next)}`;
  });
}

async function submit(form, action) {
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  resendBtn.classList.add('hidden');
  try {
    await action();
  } catch (e) {
    show(errorText(e.code));
    if (e.code === 'unverified') resendBtn.classList.remove('hidden');
  } finally {
    button.disabled = false;
    resetCaptcha(form.id.replace('-form', ''));
  }
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  lastEmail = f.email.value.trim();
  submit(f, async () => {
    if (!lastEmail || !f.password.value) throw Object.assign(new Error(), { code: 'credentials' });
    await api('login', { email: lastEmail, password: f.password.value, captcha: captchaToken('login') });
    location.href = next;
  });
});

$('#register-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  submit(f, async () => {
    if (f.password.value.length < 8) throw Object.assign(new Error(), { code: 'password' });
    if (f.password.value !== f.password2.value) {
      show('auth.err.mismatch');
      return;
    }
    lastEmail = f.email.value.trim();
    await api('register', {
      email: lastEmail, password: f.password.value, name: f.name.value, captcha: captchaToken('register'), lang: getLang(),
    });
    f.reset();
    show('auth.sent', 'ok', { email: lastEmail });
  });
});

$('#forgot-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  submit(f, async () => {
    const email = f.email.value.trim();
    await api('forgot', { email, captcha: captchaToken('forgot'), lang: getLang() });
    show('auth.resetSent', 'ok', { email });
  });
});

$('#reset-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  submit(f, async () => {
    if (f.password.value.length < 8) throw Object.assign(new Error(), { code: 'password' });
    if (f.password.value !== f.password2.value) {
      show('auth.err.mismatch');
      return;
    }
    const me = await api('reset', { token: resetToken, password: f.password.value });
    f.reset();
    showSignedIn({ name: me.name });
    show('auth.resetDone', 'ok');
  });
});

resendBtn.addEventListener('click', async () => {
  resendBtn.disabled = true;
  try {
    await api('resend', { email: lastEmail, captcha: captchaToken('login'), lang: getLang() });
    show('auth.sent', 'ok', { email: lastEmail });
    resendBtn.classList.add('hidden');
  } catch (e) {
    show(errorText(e.code));
  } finally {
    resendBtn.disabled = false;
    resetCaptcha('login');
  }
});

$('#logout').addEventListener('click', async () => {
  await api('logout', {}).catch(() => {});
  location.href = '/login.html';
});

for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => setLang(b.dataset.lang));

init();
music.play('login');
musicButton();
