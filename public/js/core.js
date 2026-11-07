// Shared state, API access (per machine), and small UI helpers.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('tl.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tl.' + k, JSON.stringify(v)); } catch {} },
};
export const isApp = !!window.Capacitor?.isNativePlatform?.();
export const VERSION = '2.9.1'; // this build; kept equal to package.json by a test
export const touch = matchMedia('(pointer: coarse)').matches;

export const S = {
  machines: store.get('machines', null), cur: store.get('cur', 0),
  sessions: [], presets: [], stacks: [], snippets: [], projects: [], stats: null, info: null, filter: store.get('filter', 'all'), previews: {},
};
// tmuxlab 1.0/1.1 kept a single {base, token}
if (!S.machines) { const old = store.get('cfg', null); S.machines = old ? [{ name: '', ...old }] : []; }
if (S.cur >= S.machines.length) S.cur = 0;
export const cfg = () => S.machines[S.cur];
export const saveMachines = () => { if (S.watch) return; store.set('machines', S.machines); store.set('cur', S.cur); }; // a watch link is never remembered

export class Unauthorized extends Error {}
export async function api(path, { method = 'GET', body, raw, m = cfg(), timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(m.base + path, {
      method, signal: ctl.signal,
      headers: { authorization: 'Bearer ' + m.token, ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Unauthorized('The token was rejected. Paste a fresh link from the server.');
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  } finally { clearTimeout(t); }
}
// for user actions: show the error, then rethrow so callers stop
export const act = (p, body, method = 'POST') => api(p, { method, body }).catch((e) => { toast(e.message, true); throw e; });
export const W = (s, i) => `/api/windows/${encodeURIComponent(s)}/${i}`;

export const icon = (n, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

// toasts are polite (never take focus), dismissable, and stay longer when they carry an action
export function toast(msg, bad, { action, run } = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  if (bad) t.setAttribute('role', 'alert'); // the container is already a polite live region
  const span = document.createElement('span'); span.textContent = msg; t.append(span);
  const gone = () => { t.classList.add('out'); setTimeout(() => t.remove(), 140); };
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn sm'; b.textContent = action;
    b.onclick = () => { gone(); run(); };
    t.append(b);
  }
  const x = document.createElement('button');
  x.className = 'btn sm ghost icon'; x.setAttribute('aria-label', 'Dismiss'); x.innerHTML = icon('x'); x.onclick = gone;
  t.append(x);
  $('#toasts').append(t);
  setTimeout(gone, action ? 8000 : bad ? 6000 : 3000);
}

export function show(id) { for (const v of $$('.view')) v.hidden = v.id !== id; }

export const ago = (t) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? 'just now' : s < 3600 ? `${s / 60 | 0}m ago` : s < 86400 ? `${s / 3600 | 0}h ago` : `${s / 86400 | 0}d ago`;
};
export const bytes = (n) => n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`;
export const home = (p) => String(p || '').replace(/^\/home\/[^/]+|^\/Users\/[^/]+|^\/root(?=\/|$)/, '~');
export const winState = (w) => (w.dead ? 'dead' : w.running ? 'run' : 'idle');
export const activeWin = (s) => s.windows.find((w) => w.active) || s.windows[0];
export const findSess = (n) => S.sessions.find((s) => s.name === n);
export const activePane = (w) => w.panes?.find((p) => p.active) || w.panes?.[0] || w;
// what a window is doing and where: the agent (or the running program), the repo, the worktree and the folder.
// Read from the pane that runs something, since that's the one you care about.
export const placeOf = (w) => { const p = w.panes?.find((x) => x.running) || activePane(w); return { cmd: p.running ? p.cmd : '', repo: p.repo, branch: p.branch, wt: p.wt, cwd: home(p.cwd) }; };
export function whereHtml(w, { branch = true } = {}) {
  const x = placeOf(w);
  return `${x.cmd ? `<b class="agent">${esc(x.cmd)}</b>` : '<span>shell</span>'}`
    + (x.repo ? `<span class="repo" title="git repository">${esc(x.repo)}</span>` : '')
    + (branch && x.branch ? `<span class="br" title="git branch">${icon('branch')}${esc(x.branch)}</span>` : '')
    + (x.wt ? `<span class="wt" title="git worktree ${esc(x.wt)}">${x.wt === x.branch ? 'worktree' : `worktree ${esc(x.wt)}`}</span>` : '')
    + `<span class="cwd" title="${esc(x.cwd)}"><bdi>${esc(x.cwd)}</bdi></span>`;
}
export const whereText = (w) => { const x = placeOf(w); return [x.cmd, x.repo, x.wt && `worktree ${x.wt}`, x.cwd].filter(Boolean).join(' · '); };
// launcher icons follow what the launcher runs, so they stay consistent whatever glyph the config holds
export const presetIcon = (p) => { const c = p.cmd || ''; return p.windows ? 'layers' : !c ? 'terminal' : /--continue|--resume/.test(c) ? 'refresh'
  : /^claude/.test(c) ? 'spark' : /^codex/.test(c) ? 'target' : /test/.test(c) ? 'check' : /dev|serve|start/.test(c) ? 'play' : 'terminal'; };
export const vibrate = () => { if (touch) navigator.vibrate?.(6); };

// Android Back / browser back closes the top overlay first. Each open overlay owns one history entry.
const stack = []; let ownBacks = 0, backTimer; const waiters = [];
const flush = () => { ownBacks = 0; clearTimeout(backTimer); waiters.splice(0).forEach((f) => f()); };
export function onBack(close) {
  const e = { close }; stack.push(e);
  // a menu that opens a dialog closes first: wait for that history.back() before pushing
  afterNav(() => { if (stack.includes(e)) { history.pushState({ ...history.state, ov: stack.indexOf(e) + 1 }, ''); e.pushed = true; } });
  return () => {
    const i = stack.indexOf(e); if (i < 0) return;
    stack.splice(i, 1);
    if (!e.pushed) return;
    ownBacks++; history.back();
    clearTimeout(backTimer); backTimer = setTimeout(flush, 500); // never wait forever on a traversal the browser dropped
  };
}
// run fn once our own history.back() calls have landed, so a new pushState isn't popped by them
export const afterNav = (fn) => ownBacks ? waiters.push(fn) : fn();
addEventListener('popstate', (e) => {
  if (ownBacks) { if (!--ownBacks) flush(); e.stopImmediatePropagation(); return; }
  const depth = history.state?.ov || 0;
  const had = stack.length;
  while (stack.length > depth) stack.pop().close();
  if (had > depth || stack.length < depth) e.stopImmediatePropagation(); // Back only closed an overlay
});
const showModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function () {
  showModal.call(this);
  const release = onBack(() => this.close());
  this.addEventListener('close', release, { once: true });
};
// tap outside a dialog closes it (only when the press also started outside, so text selection is safe)
let downOn = null;
document.addEventListener('pointerdown', (e) => { downOn = e.target; });
document.addEventListener('click', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDialogElement) || downOn !== d || d.id === 'dlg-ask') return;
  const r = d.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
});

// popup menu anchored to an element; items: {label, icon, run, checked, danger, sub}
// keyboard: arrows/Home/End move, Esc/Tab close, focus returns to the anchor
let closeFn = null;
export function menu(anchor, items) {
  closeMenu(false);
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button role="${it.checked !== undefined ? 'menuitemradio' : 'menuitem'}" data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''} ${it.checked !== undefined ? `aria-checked="${!!it.checked}"` : ''}>
    <span class="mi" aria-hidden="true">${it.checked ? icon('check') : it.icon ? icon(it.icon) : ''}</span><span>${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></button>`).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.max(8, r.bottom + m.offsetHeight + 8 > innerHeight ? r.top - m.offsetHeight - 4 : r.bottom + 4) + 'px';
  const btns = () => $$('button:not([disabled])', m);
  m.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) { closeMenu(false); items[b.dataset.i].run?.(); } });
  m.addEventListener('keydown', (e) => {
    const l = btns(), i = l.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: l.length - 1 }[e.key];
    if (to !== undefined) { e.preventDefault(); l[(to + l.length) % l.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'Tab') closeMenu();
  });
  btns()[0]?.focus({ preventScroll: true });
  anchor.setAttribute('aria-expanded', 'true');
  const outside = (e) => { if (!m.contains(e.target)) closeMenu(false); };
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
  const finish = (refocus) => {
    m.remove(); document.removeEventListener('pointerdown', outside); anchor.setAttribute('aria-expanded', 'false'); closeFn = null;
    if (refocus && anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  const release = onBack(() => finish(false));
  closeFn = (refocus = true) => { finish(refocus); release(); };
  return m;
}
export function closeMenu(refocus) { closeFn?.(refocus); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// In-app replacement for prompt()/confirm(): labelled, validated inline, and closable with Back.
// With `label` it asks for text and resolves the string (or null); without, it resolves true/false.
export function ask({ title, message = '', label, value = '', placeholder = '', help = '', ok = 'OK', danger = false, validate }) {
  const d = $('#dlg-ask'), inp = $('#ask-i'), err = $('#ask-e'), okb = $('#ask-ok');
  const text = label !== undefined;
  $('#ask-t').textContent = title;
  $('#ask-m').textContent = message; $('#ask-m').hidden = !message;
  $('#ask-field').hidden = !text;
  $('#ask-l').textContent = label || '';
  $('#ask-h').textContent = help; $('#ask-h').hidden = !help;
  inp.value = value; inp.placeholder = placeholder; inp.removeAttribute('aria-invalid');
  err.textContent = '';
  okb.textContent = ok; okb.className = danger ? 'btn danger solid' : 'btn primary';
  return new Promise((res) => {
    const onSubmit = (e) => {
      if (e.submitter?.value !== 'ok' || !text) return;
      const msg = validate?.(inp.value.trim());
      if (msg) { e.preventDefault(); err.textContent = msg; inp.setAttribute('aria-invalid', 'true'); inp.focus(); }
    };
    d.addEventListener('submit', onSubmit);
    d.addEventListener('close', () => {
      d.removeEventListener('submit', onSubmit);
      const yes = d.returnValue === 'ok';
      res(text ? (yes ? inp.value.trim() : null) : yes);
    }, { once: true });
    d.returnValue = '';
    d.showModal();
    if (text) { inp.focus(); inp.select(); } else (danger ? $('#ask-cancel') : okb).focus();
  });
}
export const NAME_RULE = (v) => !v ? 'Enter a name.' : /^[\w.-]{1,64}$/.test(v) ? '' : 'Use letters, digits, - _ or . (up to 64 characters).';

// show a button as busy while its action runs, so it can't be pressed twice
export async function busy(btn, fn) {
  if (btn?.getAttribute('aria-busy') === 'true') return;
  btn?.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { btn?.removeAttribute('aria-busy'); }
}

export const presetItems = (pick) => S.presets.map((p) => ({ label: p.label, icon: presetIcon(p), sub: p.cmd || 'shell', run: () => pick(p) }));

// close buttons in every dialog
document.addEventListener('click', (e) => { const b = e.target.closest('[data-close]'); if (b) b.closest('dialog').close(); });

// a dev server inside a session, opened through tmuxlab's forwarder (its link carries a key for that port only)
export async function openPort(port) {
  const native = !!window.Capacitor?.isNativePlatform?.();
  const tab = native ? null : window.open('', '_blank'); // open now, while the tap still counts, or the popup is blocked
  try {
    const f = await api(`/api/ports/${port}/open`, { method: 'POST' });
    const u = new URL(cfg().base), url = `${u.protocol}//${u.hostname}:${f.port}/?tl=${encodeURIComponent(f.key)}`;
    if (tab) tab.location = url; else window.open(url, '_blank');
  } catch (e) { tab?.close(); toast(e.message, true); }
}
