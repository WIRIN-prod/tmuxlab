// Shared state, API access (per machine), and small UI helpers.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('tl.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tl.' + k, JSON.stringify(v)); } catch {} },
};
export const isApp = !!window.Capacitor?.isNativePlatform?.();
export const touch = matchMedia('(pointer: coarse)').matches;

export const S = {
  machines: store.get('machines', null), cur: store.get('cur', 0),
  sessions: [], presets: [], stacks: [], projects: [], stats: null, info: null, filter: 'all', previews: {},
};
// tmuxlab 1.0/1.1 kept a single {base, token}
if (!S.machines) { const old = store.get('cfg', null); S.machines = old ? [{ name: '', ...old }] : []; }
if (S.cur >= S.machines.length) S.cur = 0;
export const cfg = () => S.machines[S.cur];
export const saveMachines = () => { store.set('machines', S.machines); store.set('cur', S.cur); };

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

export function toast(msg, bad, { action, run } = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn sm'; b.textContent = action;
    b.onclick = () => { t.remove(); run(); };
    t.append(b);
  }
  $('#toasts').append(t);
  setTimeout(() => t.remove(), action ? 8000 : bad ? 5000 : 2500);
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
export const vibrate = () => { if (touch) navigator.vibrate?.(6); };

// popup menu anchored to an element; items: {label, icon, run, checked, danger, sub}
let closeFn = null;
export function menu(anchor, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>
    <span class="mi">${esc(it.checked ? '✓' : it.icon || '')}</span><span>${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></button>`).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.max(8, r.bottom + m.offsetHeight + 8 > innerHeight ? r.top - m.offsetHeight - 4 : r.bottom + 4) + 'px';
  m.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) { closeMenu(); items[b.dataset.i].run?.(); } });
  m.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
  const outside = (e) => { if (!m.contains(e.target)) closeMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
  closeFn = () => { m.remove(); document.removeEventListener('pointerdown', outside); };
  return m;
}
export function closeMenu() { closeFn?.(); closeFn = null; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

export const presetItems = (pick) => S.presets.map((p) => ({ label: p.label, icon: p.icon || '❯', sub: p.cmd || 'shell', run: () => pick(p) }));

// close buttons in every dialog
document.addEventListener('click', (e) => { const b = e.target.closest('[data-close]'); if (b) b.closest('dialog').close(); });
