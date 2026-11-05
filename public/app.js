'use strict';
// tmuxlab client. Runs as a page served by server.js and, unchanged, inside the Capacitor Android app.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('tl.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tl.' + k, JSON.stringify(v)); } catch {} },
};
const isApp = !!window.Capacitor?.isNativePlatform?.();

const S = { cfg: store.get('cfg', null), sessions: [], presets: [], cur: null, filter: 'all', previews: {} };

// ---------- connection config ----------
(function bootCfg() {
  const m = location.hash.match(/token=([\w-]+)/);
  if (m && !isApp) {
    S.cfg = { base: location.origin, token: m[1] };
    store.set('cfg', S.cfg);
    history.replaceState(null, '', location.pathname);
  }
})();

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(S.cfg.base + path, {
    method, headers: { authorization: 'Bearer ' + S.cfg.token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { showLogin('The token was rejected. Paste a fresh link from the server.'); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const act = (p, body, method = 'POST') => api(p, { method, body }).catch((e) => { toast(e.message, true); throw e; });
const W = (s, i) => `/api/windows/${encodeURIComponent(s)}/${i}`;

function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2500);
}

function show(id) { for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id; }

// ---------- login ----------
function showLogin(err) {
  show('login');
  $('#login-err').textContent = err || '';
  if (!isApp && !$('#login-url').value) $('#login-url').value = location.origin;
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let raw = $('#login-url').value.trim(), token = $('#login-token').value.trim();
  const m = raw.match(/#token=([\w-]+)/);
  if (m) { token = m[1]; raw = raw.slice(0, raw.indexOf('#')); }
  if (!/^https?:\/\//.test(raw)) raw = 'http://' + raw;
  let base;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' && !u.port) u.port = '7681'; // plain http without a port means the tmuxlab default
    base = u.origin;
  } catch { $('#login-err').textContent = 'That address is not a valid URL.'; return; }
  if (!token) { $('#login-err').textContent = 'Enter the token, or paste the full link that includes it.'; return; }
  S.cfg = { base, token };
  try {
    await api('/api/info');
    store.set('cfg', S.cfg);
    start();
  } catch (err) {
    if (err.message !== 'unauthorized') $('#login-err').textContent = `Could not reach ${base}. Check the server is running and the phone can reach it.`;
  }
});

// ---------- data ----------
const ago = (t) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? 'just now' : s < 3600 ? `${s / 60 | 0}m ago` : s < 86400 ? `${s / 3600 | 0}h ago` : `${s / 86400 | 0}d ago`;
};
const winState = (w) => (w.dead ? 'dead' : w.running ? 'run' : 'idle');
const activeWin = (s) => s.windows.find((w) => w.active) || s.windows[0];
const findSess = (n) => S.sessions.find((s) => s.name === n);

async function refresh() {
  try { S.sessions = await api('/api/sessions'); } catch { return; }
  if (!$('#wall').hidden) renderWall();
  if (!$('#term').hidden) renderTermBar();
}

async function refreshPreviews() {
  if ($('#wall').hidden || document.hidden) return;
  const list = visibleSessions().slice(0, 24);
  await Promise.all(list.map(async (s) => {
    const w = activeWin(s);
    try { S.previews[s.name] = (await api(`${W(s.name, w.index)}/capture?lines=14`)).text.replace(/\s+$/, ''); } catch {}
  }));
  for (const s of list) {
    const pre = document.querySelector(`.card[data-s="${CSS.escape(s.name)}"] pre`);
    if (pre && pre.textContent !== S.previews[s.name]) pre.textContent = S.previews[s.name] ?? '';
  }
}

// ---------- wall ----------
function visibleSessions() {
  return S.sessions.filter((s) => S.filter === 'all' ||
    (S.filter === 'running' ? s.windows.some((w) => w.running) : !s.windows.some((w) => w.running)));
}

function renderWall() {
  const all = S.sessions;
  const runs = all.flatMap((s) => s.windows).filter((w) => w.running).length;
  $('#stats').innerHTML = `<span><b>${all.length}</b> sessions</span><span class="r"><b>${runs}</b> running</span>`;
  $('#empty').hidden = all.length > 0;
  const grid = $('#grid');
  const list = visibleSessions();
  const keep = new Set(list.map((s) => s.name));
  for (const c of [...grid.children]) if (!keep.has(c.dataset.s)) c.remove();
  list.forEach((s, i) => {
    let card = grid.querySelector(`.card[data-s="${CSS.escape(s.name)}"]`);
    if (!card) {
      card = document.createElement('article');
      card.className = 'card';
      card.dataset.s = s.name;
      card.innerHTML = `<div class="card-h"></div><div class="wins"></div>
        <div class="screen" role="button" tabindex="0" aria-label="Open ${esc(s.name)}"><span class="path"></span><pre></pre></div>
        <div class="card-f"></div>`;
      $('pre', card).textContent = S.previews[s.name] ?? '';
    }
    if (grid.children[i] !== card) grid.insertBefore(card, grid.children[i] || null);
    const aw = activeWin(s);
    const hasRun = s.windows.some((w) => w.running);
    card.classList.toggle('has-run', hasRun);
    const sig = JSON.stringify([s.windows, s.attached, ago(s.activity)]);
    if (card.dataset.sig === sig) return;
    card.dataset.sig = sig;
    $('.card-h', card).innerHTML = `<span class="dot ${hasRun ? 'run' : ''}"></span><h3>${esc(s.name)}</h3>
      ${s.attached ? `<span class="att" title="Clients attached">${s.attached} attached</span>` : ''}<span class="when">${ago(s.activity)}</span>`;
    $('.wins', card).innerHTML = s.windows.map((w) => `<button class="win ${w.active ? 'active' : ''}" data-w="${w.index}" title="${esc(w.cmd)}">
      <span class="dot ${winState(w)}"></span>${esc(w.name)}<span class="c">${w.running ? esc(w.cmd) : ''}</span></button>`).join('');
    $('.path', card).textContent = aw.cwd.replace(/^\/home\/[^/]+/, '~');
    $('.card-f', card).innerHTML = `<button class="btn sm primary" data-a="open">Open</button>
      ${aw.running ? `<button class="btn sm ghost danger" data-a="stop">Stop ${esc(aw.cmd)}</button>`
        : aw.preset ? `<button class="btn sm run" data-a="start" title="${esc(aw.preset)}">Start ${esc(aw.preset.split(' ')[0])}</button>` : ''}
      <span class="spacer"></span>
      <button class="btn sm ghost" data-a="addwin" aria-haspopup="menu">New window</button>
      <button class="btn sm ghost danger icon" data-a="kill" aria-label="End session ${esc(s.name)}" title="End session">✕</button>`;
  });
}

$('#grid').addEventListener('click', async (e) => {
  const card = e.target.closest('.card'); if (!card) return;
  const s = findSess(card.dataset.s); if (!s) return;
  const wb = e.target.closest('.win');
  if (wb) { await act(`${W(s.name, wb.dataset.w)}/select`); return refresh().then(refreshPreviews); }
  if (e.target.closest('.screen')) return openTerm(s.name);
  const a = e.target.closest('[data-a]')?.dataset.a;
  const aw = activeWin(s);
  if (a === 'open') openTerm(s.name);
  else if (a === 'stop') { await act(`${W(s.name, aw.index)}/stop`); toast(`Sent stop to ${aw.cmd}`); setTimeout(refresh, 600); }
  else if (a === 'start') { await act(`${W(s.name, aw.index)}/start`); toast(`Started ${aw.preset}`); setTimeout(refresh, 600); }
  else if (a === 'addwin') presetMenu(e.target, (p) => addWindow(s.name, p));
  else if (a === 'kill' && confirm(`End session "${s.name}"? Everything running in it stops.`)) {
    await act(`/api/sessions/${encodeURIComponent(s.name)}`, null, 'DELETE'); toast(`Ended ${s.name}`); refresh();
  }
});
$('#grid').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('screen')) openTerm(e.target.closest('.card').dataset.s);
});
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  S.filter = b.dataset.f;
  for (const x of $('#filters').children) x.setAttribute('aria-selected', x === b);
  renderWall(); refreshPreviews();
});

async function addWindow(s, preset) {
  const r = await act(`/api/sessions/${encodeURIComponent(s)}/windows`, { preset: preset.id });
  toast(`Opened ${preset.label} in ${s}`);
  await refresh();
  return r;
}

// small popup menu of launchers
function presetMenu(anchor, pick) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = S.presets.map((p, i) => `<button role="menuitem" data-i="${i}"><span>${esc(p.icon || '❯')}</span>${esc(p.label)}</button>`).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = (r.bottom + m.offsetHeight + 8 > innerHeight ? r.top - m.offsetHeight - 4 : r.bottom + 4) + 'px';
  m.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) { closeMenu(); pick(S.presets[b.dataset.i]); } });
  m.querySelector('button')?.focus();
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
  function outside(e) { if (!m.contains(e.target)) closeMenu(); }
  closeMenu.fn = () => { m.remove(); document.removeEventListener('pointerdown', outside); };
}
function closeMenu() { closeMenu.fn?.(); closeMenu.fn = null; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ---------- new session dialog ----------
const dNew = $('#dlg-new');
let newMode = 'session', newPreset = 'shell', nameTouched = false;
function openNew(mode = 'session') {
  newMode = mode; nameTouched = false;
  $('#new-title').textContent = mode === 'session' ? 'New session' : `New window in ${S.cur}`;
  $('#new-name-row').hidden = mode !== 'session';
  $('#new-go').textContent = mode === 'session' ? 'Start session' : 'Open window';
  $('#new-name').value = '';
  $('#new-cwd').value = mode === 'session' ? '' : (activeWin(findSess(S.cur) || { windows: [{ cwd: '' }] })?.cwd || '');
  $('#browser').hidden = true;
  $('#new-presets').innerHTML = S.presets.map((p) => `<button type="button" class="preset" data-id="${esc(p.id)}" aria-pressed="${p.id === newPreset}">
    <span class="ic">${esc(p.icon || '❯')}</span><span>${esc(p.label)}<small>${esc(p.cmd || 'just a shell')}</small></span></button>`).join('');
  const rec = store.get('recent', []);
  $('#recent').innerHTML = rec.map((d) => `<button type="button" data-d="${esc(d)}">${esc(d.replace(/^\/home\/[^/]+/, '~'))}</button>`).join('');
  dNew.showModal();
  (mode === 'session' ? $('#new-name') : $('#new-cwd')).focus();
}
for (const b of document.querySelectorAll('#btn-new, [data-new]')) b.addEventListener('click', () => openNew());
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
$('#new-presets').addEventListener('click', (e) => {
  const b = e.target.closest('.preset'); if (!b) return;
  newPreset = b.dataset.id;
  for (const x of $('#new-presets').children) x.setAttribute('aria-pressed', x === b);
});
$('#new-name').addEventListener('input', () => { nameTouched = true; });
const setCwd = (d) => {
  $('#new-cwd').value = d;
  if (!nameTouched && newMode === 'session') $('#new-name').value = d.split('/').filter(Boolean).pop()?.replace(/[^\w.-]/g, '-').slice(0, 64) || '';
};
$('#recent').addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (b) setCwd(b.dataset.d); });
$('#new-browse').addEventListener('click', () => browse($('#new-cwd').value || '~'));
async function browse(p) {
  let r;
  try { r = await api('/api/fs?path=' + encodeURIComponent(p)); } catch (e) { toast(e.message, true); return; }
  const br = $('#browser');
  br.hidden = false;
  br.innerHTML = `<div class="bh"><button type="button" class="btn sm ghost" data-up aria-label="Parent folder">↑</button><span>${esc(r.path)}</span>
    <button type="button" class="btn sm primary" data-use>Use${r.git ? ' (git)' : ''}</button></div>
    ${r.dirs.map((d) => `<button type="button" class="d" data-d="${esc(d)}">${esc(d)}/</button>`).join('') || '<div class="d muted" style="padding:8px 12px">No subfolders</div>'}`;
  br.onclick = (e) => {
    if (e.target.closest('[data-up]')) return browse(r.parent);
    if (e.target.closest('[data-use]')) { setCwd(r.path); br.hidden = true; return; }
    const d = e.target.closest('[data-d]'); if (d) browse(r.path.replace(/\/$/, '') + '/' + d.dataset.d);
  };
  setCwd(r.path);
}
$('#new-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const cwd = $('#new-cwd').value.trim();
  const name = $('#new-name').value.trim();
  try {
    if (newMode === 'session') {
      const r = await act('/api/sessions', { name: name || undefined, cwd: cwd || undefined, preset: newPreset });
      dNew.close(); remember(cwd); await refresh(); openTerm(r.name);
    } else {
      await act(`/api/sessions/${encodeURIComponent(S.cur)}/windows`, { preset: newPreset, cwd: cwd || undefined });
      dNew.close(); remember(cwd); refresh();
    }
  } catch {}
});
function remember(d) { if (d) store.set('recent', [d, ...store.get('recent', []).filter((x) => x !== d)].slice(0, 6)); }

// ---------- settings ----------
$('#btn-settings').addEventListener('click', () => {
  $('#set-server').textContent = `Connected to ${S.cfg.base}`;
  $('#set-presets').value = JSON.stringify(S.presets, null, 2);
  $('#set-err').textContent = '';
  $('#dlg-settings').showModal();
});
$('#set-save').addEventListener('click', async () => {
  let v;
  try { v = JSON.parse($('#set-presets').value); } catch (e) { $('#set-err').textContent = 'Not valid JSON: ' + e.message; return; }
  try { S.presets = await api('/api/presets', { method: 'PUT', body: v }); $('#dlg-settings').close(); toast('Launchers saved'); }
  catch (e) { $('#set-err').textContent = e.message + '. Each entry needs id (letters, digits, - _ .), label and cmd.'; }
});
$('#set-logout').addEventListener('click', () => {
  store.set('cfg', null); S.cfg = null; $('#dlg-settings').close(); closeTerm(); showLogin();
});

// ---------- palette ----------
const dPal = $('#dlg-palette');
let palItems = [], palSel = 0;
function openPalette() { $('#pal-q').value = ''; renderPal(); dPal.showModal(); $('#pal-q').focus(); }
function renderPal() {
  const q = $('#pal-q').value.toLowerCase();
  palItems = [
    ...S.sessions.flatMap((s) => [
      { label: s.name, meta: `${s.windows.length} windows`, dot: s.windows.some((w) => w.running) ? 'run' : '', go: () => openTerm(s.name) },
      ...s.windows.map((w) => ({ label: `${s.name} › ${w.name}`, meta: w.running ? w.cmd : '', dot: winState(w),
        go: async () => { await act(`${W(s.name, w.index)}/select`); openTerm(s.name); } })),
    ]),
    { label: 'New session…', meta: '', go: () => openNew() },
  ].filter((x) => x.label.toLowerCase().includes(q)).slice(0, 50);
  palSel = Math.min(palSel, palItems.length - 1);
  $('#pal-list').innerHTML = palItems.map((x, i) => `<li role="option" data-i="${i}" aria-selected="${i === palSel}">
    <span class="dot ${x.dot || ''}"></span>${esc(x.label)}<span class="m">${esc(x.meta)}</span></li>`).join('');
}
$('#pal-q').addEventListener('input', () => { palSel = 0; renderPal(); });
$('#pal-q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % palItems.length; renderPal(); }
  if (e.key === 'Enter' && palItems[palSel]) { dPal.close(); palItems[palSel].go(); }
});
$('#pal-list').addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) { dPal.close(); palItems[li.dataset.i].go(); } });
$('#btn-palette').addEventListener('click', openPalette);
document.addEventListener('keydown', (e) => {
  if (!$('#wall').hidden && !document.querySelector('dialog[open]')) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openPalette(); }
    else if (e.key === 'n' && !e.ctrlKey && !e.metaKey && e.target === document.body) { e.preventDefault(); openNew(); }
  }
});

// ---------- terminal ----------
const T = { term: null, fit: null, ws: null, retry: 0, timer: null, mods: { ctrl: false, alt: false }, fontSize: store.get('font', 14) };

function ensureTerm() {
  if (T.term) return;
  T.term = new Terminal({
    fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: T.fontSize, cursorBlink: true, allowProposedApi: true,
    scrollback: 0, // tmux owns history
    theme: { background: '#081113', foreground: '#D8E4E1', cursor: '#F2C14E', selectionBackground: '#5EE6C355',
      black: '#0E1A1C', brightBlack: '#4C6461', red: '#FF7A6B', green: '#5EE6C3', yellow: '#F2C14E', blue: '#6CB6FF',
      magenta: '#D6A2FF', cyan: '#62D7E6', white: '#D8E4E1', brightWhite: '#FFFFFF' },
  });
  T.fit = new FitAddon.FitAddon();
  T.term.loadAddon(T.fit);
  T.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank')));
  T.term.open($('#xterm'));
  T.term.onData((d) => sendInput(applyMods(d)));
  T.term.onResize(({ cols, rows }) => ctl({ t: 'resize', cols, rows }));
  // wheel scrolls tmux history unless the program asked for the mouse
  T.term.attachCustomWheelEventHandler((e) => {
    if (T.term.modes.mouseTrackingMode !== 'none') return true;
    queueScroll(e.deltaY < 0 ? -3 : 3);
    return false;
  });
  new ResizeObserver(() => { if (!$('#term').hidden) T.fit.fit(); }).observe($('.termwrap'));
  document.fonts?.ready.then(() => T.fit.fit());
}

function applyMods(d) {
  if (T.mods.ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) d = String.fromCharCode(c & 0x1f);
    else if (d === ' ') d = '\x00';
  }
  if (T.mods.alt) d = '\x1b' + d;
  if (T.mods.ctrl || T.mods.alt) { T.mods.ctrl = T.mods.alt = false; renderKeys(); }
  return d;
}
const sendInput = (d) => { if (T.ws?.readyState === 1) T.ws.send(d); };
const ctl = (o) => { if (T.ws?.readyState === 1) T.ws.send('\x00' + JSON.stringify(o)); };

function openTerm(name) {
  if (S.cur !== name || $('#term').hidden) history.pushState({ term: name }, '');
  S.cur = name;
  show('term');
  ensureTerm();
  T.term.reset();
  renderTermBar();
  renderKeys();
  requestAnimationFrame(() => { T.fit.fit(); connect(); if (matchMedia('(pointer: fine)').matches) T.term.focus(); });
}

function closeTerm() {
  S.cur = null;
  clearTimeout(T.timer);
  if (T.ws) { T.ws.onclose = null; T.ws.close(); T.ws = null; }
  if (S.cfg) { show('wall'); refresh().then(refreshPreviews); }
}
$('#btn-back').addEventListener('click', () => history.state?.term ? history.back() : closeTerm());
addEventListener('popstate', () => { if (!$('#term').hidden) closeTerm(); });

function setConn(state) {
  const c = $('#t-conn');
  c.className = 'conn ' + state;
  c.title = { ok: 'Connected', wait: 'Connecting…', '': 'Disconnected' }[state];
}

function connect() {
  clearTimeout(T.timer);
  if (T.ws) { T.ws.onclose = null; T.ws.close(); }
  const name = S.cur;
  const u = new URL('/ws', S.cfg.base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.search = new URLSearchParams({ s: name, token: S.cfg.token, cols: T.term.cols, rows: T.term.rows });
  setConn('wait');
  const ws = T.ws = new WebSocket(u);
  ws.onopen = () => { T.retry = 0; setConn('ok'); ctl({ t: 'resize', cols: T.term.cols, rows: T.term.rows }); };
  ws.onmessage = (e) => T.term.write(e.data);
  ws.onclose = async (e) => {
    setConn('');
    if (S.cur !== name) return;
    if (e.code >= 4000) { // tmux attach exited: session ended or client was detached
      await refresh();
      if (!findSess(name)) { toast(`Session ${name} ended`); return history.state?.term ? history.back() : closeTerm(); }
    }
    T.timer = setTimeout(connect, Math.min(10000, 500 * 2 ** T.retry++));
  };
}
// phones suspend sockets in the background; reconnect as soon as we're visible again
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refresh();
  if (S.cur && !$('#term').hidden && T.ws?.readyState !== 1) { T.retry = 0; connect(); }
});
addEventListener('online', () => { if (S.cur && T.ws?.readyState !== 1) { T.retry = 0; connect(); } });

function curWin() { const s = findSess(S.cur); return s && activeWin(s); }

function renderTermBar() {
  const s = findSess(S.cur);
  $('#t-name').textContent = S.cur || '';
  if (!s) return;
  const sig = JSON.stringify(s.windows);
  if ($('#t-tabs').dataset.sig !== sig) {
    $('#t-tabs').dataset.sig = sig;
    $('#t-tabs').innerHTML = s.windows.map((w) => `<button class="tab" data-w="${w.index}" aria-current="${w.active}" title="${esc(w.cwd)}">
      <span class="dot ${winState(w)}"></span><span class="i">${w.index}</span>${esc(w.name)}</button>`).join('');
    $('#t-tabs [aria-current="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
  const w = activeWin(s);
  const tg = $('#w-toggle');
  if (w.running) { tg.textContent = `Stop ${w.cmd}`; tg.className = 'btn sm ghost danger'; tg.dataset.a = 'stop'; tg.hidden = false; }
  else if (w.preset) { tg.textContent = `Start ${w.preset.split(' ')[0]}`; tg.className = 'btn sm run'; tg.dataset.a = 'start'; tg.hidden = false; }
  else { tg.textContent = 'Run…'; tg.className = 'btn sm'; tg.dataset.a = 'run'; tg.hidden = false; }
  $('#w-restart').hidden = !w.preset;
  $('#w-cmd').textContent = w.preset ? `$ ${w.preset}` : w.cwd.replace(/^\/home\/[^/]+/, '~');
  $('#scrollhint').hidden = !w.inMode;
}

$('#t-tabs').addEventListener('click', async (e) => {
  const b = e.target.closest('.tab'); if (!b) return;
  await act(`${W(S.cur, b.dataset.w)}/select`); refresh();
});
// double-tap / double-click a tab to rename the window
$('#t-tabs').addEventListener('dblclick', async (e) => {
  const b = e.target.closest('.tab'); if (!b) return;
  const w = findSess(S.cur)?.windows.find((x) => x.index == b.dataset.w);
  const to = prompt('Rename window', w?.name); if (!to) return;
  await act(`${W(S.cur, b.dataset.w)}/rename`, { to }); refresh();
});
$('#t-name').addEventListener('click', async () => {
  const to = prompt('Rename session (letters, digits, - _ .)', S.cur);
  if (!to || to === S.cur) return;
  await act(`/api/sessions/${encodeURIComponent(S.cur)}/rename`, { to });
  history.replaceState({ term: to }, ''); S.cur = to; await refresh(); connect();
});
$('#btn-addwin').addEventListener('click', (e) => presetMenu(e.currentTarget, async (p) => { await addWindow(S.cur, p); }));
$('#btn-addwin').addEventListener('contextmenu', (e) => { e.preventDefault(); openNew('window'); });

$('#w-toggle').addEventListener('click', async (e) => {
  const w = curWin(); if (!w) return;
  const a = e.currentTarget.dataset.a;
  if (a === 'stop') { await act(`${W(S.cur, w.index)}/stop`); toast(`Sent stop to ${w.cmd}`); }
  else if (a === 'start') { await act(`${W(S.cur, w.index)}/start`); }
  else return presetMenu(e.currentTarget, async (p) => { if (p.cmd) await act(`${W(S.cur, w.index)}/start`, { preset: p.id }); refresh(); });
  setTimeout(refresh, 700);
});
$('#w-restart').addEventListener('click', async () => {
  const w = curWin(); if (!w) return;
  if (w.running) { await act(`${W(S.cur, w.index)}/stop`); await new Promise((r) => setTimeout(r, 900)); }
  await act(`${W(S.cur, w.index)}/start`); toast(`Restarted ${w.preset}`); setTimeout(refresh, 700);
});
$('#w-kill').addEventListener('click', async () => {
  const w = curWin(); if (!w) return;
  if (!confirm(`Close window "${w.name}"?${w.running ? ` ${w.cmd} is still running and will be killed.` : ''}`)) return;
  await act(W(S.cur, w.index), null, 'DELETE'); refresh();
});
$('#w-scroll').addEventListener('click', () => queueScroll(-15));
$('#scroll-exit').addEventListener('click', async () => { const w = curWin(); if (w) await act(`${W(S.cur, w.index)}/scroll`, { dir: 'cancel' }); refresh(); });
for (const [id, d] of [['#w-font-dec', -1], ['#w-font-inc', 1]]) $(id).addEventListener('click', () => {
  T.fontSize = Math.max(9, Math.min(24, T.fontSize + d)); store.set('font', T.fontSize);
  T.term.options.fontSize = T.fontSize; T.fit.fit();
});

// scrolling: coalesce wheel/swipe into one tmux copy-mode request per ~120ms
let scrollAcc = 0, scrollT = null;
function queueScroll(lines) {
  scrollAcc += lines;
  if (scrollT) return;
  scrollT = setTimeout(async () => {
    const n = scrollAcc; scrollAcc = 0; scrollT = null;
    const w = curWin(); if (!w || !n) return;
    if (n > 0 && !w.inMode) return;
    try { await api(`${W(S.cur, w.index)}/scroll`, { method: 'POST', body: { dir: n < 0 ? 'up' : 'down', lines: Math.abs(n) } }); } catch {}
    w.inMode = n < 0 || w.inMode; $('#scrollhint').hidden = !w.inMode;
    clearTimeout(queueScroll.r); queueScroll.r = setTimeout(refresh, 400);
  }, 120);
}
(() => {
  let y0 = null, acc = 0;
  const el = $('.termwrap');
  el.addEventListener('touchstart', (e) => { if (e.touches.length === 1) { y0 = e.touches[0].clientY; acc = 0; } }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (y0 == null || T.term.modes.mouseTrackingMode !== 'none') return;
    const y = e.touches[0].clientY; acc += y - y0; y0 = y;
    const cell = T.fontSize * 1.3;
    const lines = Math.trunc(acc / cell);
    if (lines) { acc -= lines * cell; queueScroll(-lines); } // finger down = back in history
  }, { passive: true });
  el.addEventListener('touchend', () => { y0 = null; });
})();

// extra keys for touch keyboards
const KEYS = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['⇧Tab', '\x1b[Z'], ['Ctrl', 'ctrl'], ['Alt', 'alt'], 'sep',
  ['←', '\x1b[D', 1], ['↓', '\x1b[B', 1], ['↑', '\x1b[A', 1], ['→', '\x1b[C', 1], ['⏎', '\r'], 'sep',
  ['^C', '\x03'], ['^D', '\x04'], ['^Z', '\x1a'], ['^R', '\x12'], ['^L', '\x0c'], ['^B', '\x02', 0, 'tmux prefix'], 'sep',
  ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-'], ['_', '_'], [':', ':'], ['`', '`'], ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'],
];
function renderKeys() {
  $('#keys').innerHTML = KEYS.map((k, i) => k === 'sep' ? '<span class="sep"></span>'
    : `<button type="button" data-k="${i}" ${k[1] === 'ctrl' || k[1] === 'alt' ? `aria-pressed="${T.mods[k[1]]}"` : ''} ${k[3] ? `title="${k[3]}"` : ''}>${esc(k[0])}</button>`).join('');
}
(() => {
  let rep = null;
  const stop = () => { clearInterval(rep); clearTimeout(rep); rep = null; };
  $('#keys').addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    e.preventDefault(); // keep the soft keyboard and terminal focus
    const [, seq, repeat] = KEYS[b.dataset.k];
    if (seq === 'ctrl' || seq === 'alt') { T.mods[seq] = !T.mods[seq]; return renderKeys(); }
    sendInput(applyMods(seq));
    if (repeat) rep = setTimeout(() => { rep = setInterval(() => sendInput(seq), 60); }, 380);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('#keys').addEventListener(ev, stop);
})();

// compose box: reliable typing on Android keyboards, and pasting prompts for agents
const ct = $('#compose-text');
function sendCompose() {
  const v = ct.value;
  // multi-line text goes as a bracketed paste so agents treat it as one prompt
  sendInput(v.includes('\n') ? `\x1b[200~${v}\x1b[201~` : v);
  setTimeout(() => sendInput('\r'), v.includes('\n') ? 60 : 0);
  ct.value = ''; ct.style.height = '';
}
$('#compose').addEventListener('submit', (e) => { e.preventDefault(); sendCompose(); });
ct.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendCompose(); }
});
ct.addEventListener('input', () => { ct.style.height = ''; ct.style.height = Math.min(ct.scrollHeight, innerHeight * 0.3) + 'px'; });

// ---------- boot ----------
let pollers = [];
async function start() {
  pollers.forEach(clearInterval);
  if (!S.cfg) return showLogin();
  try {
    const [info, presets] = await Promise.all([api('/api/info'), api('/api/presets')]);
    S.presets = presets;
    $('#host').textContent = `${info.user}@${info.host}`;
    document.title = `tmuxlab · ${info.host}`;
  } catch (e) {
    if (e.message !== 'unauthorized') showLogin(`Could not reach ${S.cfg.base}. Check the server is running.`);
    return;
  }
  show('wall');
  await refresh();
  refreshPreviews();
  pollers = [setInterval(() => !document.hidden && refresh(), 2000), setInterval(refreshPreviews, 3000)];
}
start();

if ('serviceWorker' in navigator && !isApp && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
