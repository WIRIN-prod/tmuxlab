// Terminal view: one or more terminal panes (split view), each attached through its own tmux view session.
import { $, $$, esc, S, api, act, W, toast, store, touch, home, winState, activeWin, activePane, findSess, menu, presetItems, vibrate, cfg, ask, afterNav, NAME_RULE, whereHtml, whereText } from './core.js';
import { refresh, refreshPreviews } from './wall.js';
import { openNew, openChanges, openFind, pickWindow } from './sheets.js';

export const THEMES = {
  ink: { background: '#070D18', foreground: '#E2E9F6', cursor: '#5B9BFF', cursorAccent: '#070D18', selectionBackground: '#5B9BFF55',
    black: '#0A1220', brightBlack: '#6178AB', red: '#FF7385', green: '#5BE3A6', yellow: '#FFB04C', blue: '#5B9BFF',
    magenta: '#C79BFF', cyan: '#3FD8F2', white: '#C9D4E8', brightRed: '#FF9AA8', brightGreen: '#8CF0C2', brightYellow: '#FFCB80',
    brightBlue: '#8DB8FF', brightMagenta: '#DDBFFF', brightCyan: '#86E8F8', brightWhite: '#FFFFFF' },
  dusk: { background: '#17141F', foreground: '#E6E1F0', cursor: '#FFB86B', selectionBackground: '#8A7CFF55',
    black: '#17141F', brightBlack: '#5F5873', red: '#FF6F91', green: '#7EE0A1', yellow: '#FFD36B', blue: '#8AB4FF',
    magenta: '#C792EA', cyan: '#7FDBCA', white: '#E6E1F0', brightWhite: '#FFFFFF' },
  paper: { background: '#F7F5EF', foreground: '#22302E', cursor: '#B5651D', selectionBackground: '#2A7F6F33',
    black: '#22302E', brightBlack: '#6B7A77', red: '#C0392B', green: '#1E7F5C', yellow: '#9A6B00', blue: '#2457A6',
    magenta: '#8E44AD', cyan: '#117A8B', white: '#D9D4C7', brightWhite: '#FFFFFF' },
  contrast: { background: '#000000', foreground: '#FFFFFF', cursor: '#FFFF00', selectionBackground: '#FFFFFF55',
    black: '#000000', brightBlack: '#808080', red: '#FF5555', green: '#55FF55', yellow: '#FFFF55', blue: '#5599FF',
    magenta: '#FF55FF', cyan: '#55FFFF', white: '#E0E0E0', brightWhite: '#FFFFFF' },
};

export const T = {
  panes: [], focus: 0, mods: { ctrl: false, alt: false },
  fontSize: store.get('font', touch ? 13 : 14), theme: store.get('theme', 'ink'), wake: null,
};
const MAX_PANES = 4;
const focused = () => T.panes[T.focus];

class Pane {
  constructor(s, w) {
    this.s = s; this.w0 = w; this.view = null; this.ws = null; this.retry = 0; this.timer = null;
    this.el = document.createElement('div');
    this.el.className = 'tpane';
    this.el.innerHTML = `<div class="tph"><span class="tpn"></span><button class="btn sm ghost icon" data-x aria-label="Close this view">✕</button></div>
      <div class="tbody"><div class="xt"></div>
      <div class="banner" hidden><span>Reconnecting…</span><button class="btn sm">Retry now</button></div>
      <div class="scrollhint" hidden>History · scroll down to return<button class="btn sm">Exit</button></div></div>`;
    this.term = new Terminal({ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: T.fontSize, cursorBlink: true,
      allowProposedApi: true, scrollback: 0, theme: THEMES[T.theme] }); // tmux owns history
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank')));
    this.term.onData((d) => this.send(applyMods(d)));
    this.term.onResize(({ cols, rows }) => this.ctl({ t: 'resize', cols, rows }));
    // wheel scrolls tmux history unless the program asked for the mouse
    this.term.attachCustomWheelEventHandler((e) => {
      if (this.term.modes.mouseTrackingMode !== 'none') return true;
      queueScroll(this, e.deltaY < 0 ? -3 : 3);
      return false;
    });
    this.el.addEventListener('pointerdown', () => setFocus(T.panes.indexOf(this)), true);
    $('[data-x]', this.el).onclick = (e) => { e.stopPropagation(); closePane(this); };
    $('.banner .btn', this.el).onclick = () => { this.retry = 0; this.connect(); };
    $('.scrollhint .btn', this.el).onclick = async () => { await act(`${W(this.s, this.win.index)}/scroll`, { dir: 'cancel' }); refresh(); };
    touchScroll(this);
  }
  mount(parent) {
    parent.append(this.el);
    this.term.open($('.xt', this.el));
    new ResizeObserver(() => { if (!$('#term').hidden) try { this.fit.fit(); } catch {} }).observe($('.tbody', this.el));
  }
  get sess() { return findSess(this.s); }
  get win() {
    const s = this.sess; if (!s) return null;
    const idx = this.view ? s.views[this.view] : undefined;
    return s.windows.find((w) => w.index === idx) || activeWin(s);
  }
  send(d) { if (this.ws?.readyState === 1) this.ws.send(d); }
  ctl(o) { this.send('\x00' + JSON.stringify(o)); }
  connect() {
    clearTimeout(this.timer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    const u = new URL('/ws', cfg().base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const w = this.wIdx ?? this.w0; // the old view is gone after a disconnect, so remember the window
    u.search = new URLSearchParams({ s: this.s, token: cfg().token, cols: this.term.cols, rows: this.term.rows, ...(w != null ? { w } : {}) });
    this.setConn('wait');
    const ws = this.ws = new WebSocket(u);
    ws.onopen = () => { this.retry = 0; this.setConn('ok'); this.ctl({ t: 'resize', cols: this.term.cols, rows: this.term.rows }); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string' && e.data.startsWith('\x00TL')) {
        const m = JSON.parse(e.data.slice(3));
        if (m.t === 'view') { this.view = m.name; this.term.reset(); setTimeout(refresh, 150); }
        return;
      }
      this.term.write(e.data);
    };
    ws.onclose = async (e) => {
      if (this.ws !== ws) return;
      this.setConn('');
      if (e.code === 4404 || e.code >= 4000) { // tmux attach ended: the session is gone or we were detached
        await refresh();
        if (!this.sess) { toast(`Session ${this.s} ended`); return closePane(this); }
      }
      this.timer = setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.retry++));
    };
  }
  setConn(state) {
    this.conn = state;
    // stays up through retry attempts, so it doesn't flicker
    const b = $('.banner', this.el);
    if (state === 'ok') b.hidden = true;
    if (state === '') { b.hidden = false; $('span', b).textContent = this.retry > 2 ? `Can't reach ${new URL(cfg().base).host}. Retrying…` : 'Reconnecting…'; }
    if (this === focused()) renderConn();
  }
  dispose() {
    clearTimeout(this.timer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.term.dispose(); this.el.remove();
  }
}

function renderConn() {
  const p = focused(), c = $('#t-conn');
  const st = p?.conn ?? '', l = $('#t-conn-l');
  c.className = 'conn ' + st;
  // the dot alone is colour; say it in words whenever something is wrong
  l.textContent = { ok: 'Connected', wait: 'Reconnecting…', '': 'Offline' }[st];
  l.className = st === 'ok' ? 'sr-only' : '';
}

function layout() {
  const g = $('#terms');
  g.dataset.n = T.panes.length;
  for (const [i, p] of T.panes.entries()) {
    p.el.classList.toggle('focus', i === T.focus && T.panes.length > 1);
    $('.tph', p.el).hidden = T.panes.length < 2;
  }
  requestAnimationFrame(() => T.panes.forEach((p) => { try { p.fit.fit(); } catch {} }));
  $('#btn-split').hidden = touch && innerWidth < 900 || T.panes.length >= MAX_PANES;
}

function setFocus(i) {
  if (i < 0 || i === T.focus && T.panes[i]) return;
  T.focus = i;
  layout(); renderTermBar(); renderConn();
}

export function openTerm(name, w) {
  if ($('#term').hidden) afterNav(() => history.pushState({ term: name }, ''));
  for (const p of T.panes) p.dispose();
  T.panes = []; T.focus = 0;
  $('#wall').hidden = true; $('#term').hidden = false;
  addPane(name, w);
  keepAwake(true);
}

export function addPane(name, w) {
  if (T.panes.length >= MAX_PANES) return toast(`Up to ${MAX_PANES} views side by side`, true);
  const p = new Pane(name, w);
  T.panes.push(p);
  p.mount($('#terms'));
  T.focus = T.panes.length - 1;
  layout(); renderTermBar(); renderKeys();
  requestAnimationFrame(() => { p.fit.fit(); p.connect(); if (!touch) p.term.focus(); });
}

function closePane(p) {
  const i = T.panes.indexOf(p); if (i < 0) return;
  p.dispose(); T.panes.splice(i, 1);
  if (!T.panes.length) return history.state?.term ? history.back() : closeTerm();
  T.focus = Math.min(T.focus, T.panes.length - 1);
  layout(); renderTermBar();
}

export function closeTerm() {
  for (const p of T.panes) p.dispose();
  T.panes = [];
  keepAwake(false);
  $('#term').hidden = true; $('#wall').hidden = false;
  refresh().then(refreshPreviews);
}
$('#btn-back').addEventListener('click', () => history.state?.term ? history.back() : closeTerm());
addEventListener('popstate', () => { if (!$('#term').hidden) closeTerm(); });
$('#btn-split').addEventListener('click', () => pickWindow('Show next to this', (s, w) => addPane(s, w)));

// phones suspend sockets in the background; reconnect as soon as we're visible again
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refresh();
  for (const p of T.panes) if (p.ws?.readyState !== 1) { p.retry = 0; p.connect(); }
  if (T.panes.length) keepAwake(true);
});
addEventListener('online', () => { for (const p of T.panes) if (p.ws?.readyState !== 1) { p.retry = 0; p.connect(); } });

async function keepAwake(on) {
  try {
    if (on && store.get('awake', touch) && !T.wake && navigator.wakeLock) T.wake = await navigator.wakeLock.request('screen');
    if (!on && T.wake) { await T.wake.release(); T.wake = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.hidden) T.wake = null; }); // released by the browser

// ---------- bars ----------
const lastSeen = store.get('seen', {});
export function renderTermBar() {
  const p = focused(); if (!p) return;
  const s = p.sess, w = p.win;
  $('#t-name').textContent = p.s;
  for (const x of T.panes) { $('.tpn', x.el).textContent = `${x.s} › ${x.win?.name ?? ''}${x.win ? ` · ${whereText(x.win)}` : ''}`; if (x.view && x.sess?.views[x.view] != null) x.wIdx = x.sess.views[x.view]; }
  if (!s || !w) return;
  // tabs: dot = state, ring = output you haven't looked at
  const key = (i) => `${p.s}:${i}`;
  lastSeen[key(w.index)] = Math.max(lastSeen[key(w.index)] || 0, w.activity);
  store.set('seen', lastSeen);
  const sig = JSON.stringify([s.windows.map((x) => [x.index, x.name, x.activity, x.running, x.prompt?.question, x.bell, x.dead]), w.index, p.s]);
  if ($('#t-tabs').dataset.sig !== sig) {
    $('#t-tabs').dataset.sig = sig;
    $('#t-tabs').innerHTML = s.windows.map((x) => {
      const unread = x.index !== w.index && x.activity > (lastSeen[key(x.index)] || 0) && lastSeen[key(x.index)] !== undefined;
      return `<button class="tab ${unread ? 'unread' : ''} ${x.bell ? 'bell' : ''}" data-w="${x.index}" aria-current="${x.index === w.index}" title="${esc(home(x.cwd))}">
        <span class="dot ${x.prompt ? 'ask-dot' : winState(x)}"></span><span class="i">${x.index}</span>${esc(x.name)}</button>`;
    }).join('');
    for (const x of s.windows) lastSeen[key(x.index)] ??= x.activity;
    $('#t-tabs [aria-current="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
  const ap = activePane(w);
  const tg = $('#w-toggle');
  if (ap.running) { tg.textContent = `Stop ${ap.cmd}`; tg.className = 'btn sm ghost danger'; tg.dataset.a = 'stop'; }
  else if (ap.preset) { tg.textContent = `Start ${ap.preset.split(' ')[0]}`; tg.className = 'btn sm run'; tg.dataset.a = 'start'; }
  else { tg.textContent = 'Run…'; tg.className = 'btn sm'; tg.dataset.a = 'run'; }
  $('#w-restart').hidden = !ap.preset;
  $('#w-changes').hidden = !w.branch;
  $('#w-changes').textContent = w.branch ? `⎇ ${w.branch}` : '';
  $('#t-where').innerHTML = whereHtml(w, { branch: false }); // the branch has its own button
  $('#w-panes').textContent = w.panes.length > 1 ? `Panes ${w.panes.length}${w.zoomed ? ' · zoomed' : ''}${w.sync ? ' · synced' : ''}` : 'Panes';
  // tmux panes inside this window
  const pr = $('#t-panes');
  pr.hidden = w.panes.length < 2;
  pr.innerHTML = w.panes.map((x) => `<button class="pchip" data-p="${x.index}" aria-current="${x.active}">
    <span class="dot ${x.prompt ? 'ask-dot' : x.dead ? 'dead' : x.running ? 'run' : ''}"></span>${x.index} ${esc(x.cmd)}</button>`).join('');
  // a question from the agent, answered with one tap
  const asking = w.panes.find((x) => x.prompt);
  const ab = $('#t-ask');
  ab.hidden = !asking;
  if (asking) {
    const sig2 = JSON.stringify(asking.prompt);
    if (ab.dataset.sig !== sig2) {
      ab.dataset.sig = sig2; ab.dataset.t = `${w.index}.${asking.index}`;
      ab.innerHTML = `<div class="aq"><span class="dot ask-dot"></span>${esc(asking.prompt.question)}</div><div class="aopts">${asking.prompt.options.map((o) =>
        `<button class="btn sm ${o.n === 1 ? 'primary' : ''}" data-n="${o.n}" title="${esc(o.label)}">${o.n}. ${esc(o.label)}</button>`).join('')}</div>`;
    }
  }
  for (const x of T.panes) $('.scrollhint', x.el).hidden = !x.win?.inMode;
  renderConn();
}

$('#t-tabs').addEventListener('click', async (e) => {
  const b = e.target.closest('.tab'); const p = focused(); if (!b || !p) return;
  await act(`${W(p.view || p.s, b.dataset.w)}/select`); refresh();
});
$('#t-tabs').addEventListener('dblclick', async (e) => {
  const b = e.target.closest('.tab'); const p = focused(); if (!b || !p) return;
  const w = p.sess?.windows.find((x) => x.index == b.dataset.w);
  const to = await renameWin(w?.name); if (!to) return;
  await act(`${W(p.s, b.dataset.w)}/rename`, { to }); refresh();
});
// long-press a tab on touch screens: rename / move / close
$('#t-tabs').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('.tab'); const p = focused(); if (!b || !p) return;
  e.preventDefault();
  const idx = +b.dataset.w, wins = p.sess.windows, pos = wins.findIndex((x) => x.index === idx);
  menu(b, [
    { label: 'Rename', icon: 'edit', run: async () => { const to = await renameWin(wins[pos].name); if (to) { await act(`${W(p.s, idx)}/rename`, { to }); refresh(); } } },
    { label: 'Move left', icon: 'left', disabled: pos === 0, run: async () => { await act(`${W(p.s, idx)}/move`, { to: wins[pos - 1].index }); refresh(); } },
    { label: 'Move right', icon: 'right', disabled: pos === wins.length - 1, run: async () => { await act(`${W(p.s, idx)}/move`, { to: wins[pos + 1].index }); refresh(); } },
    { label: 'Open beside', icon: 'columns', disabled: T.panes.length >= MAX_PANES, run: () => addPane(p.s, idx) },
    '-',
    { label: 'Close window', icon: 'trash', danger: true, run: async () => { if (await ask({ title: `Close window "${wins[pos].name}"?`, message: 'Whatever runs in it stops.', ok: 'Close window', danger: true })) { await act(W(p.s, idx), null, 'DELETE'); refresh(); } } },
  ]);
});
$('#t-panes').addEventListener('click', async (e) => {
  const b = e.target.closest('.pchip'); const p = focused(); if (!b || !p) return;
  await act(`${W(p.s, `${p.win.index}.${b.dataset.p}`)}/select`); refresh();
});
$('#t-ask').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-n]'); const p = focused(); if (!b || !p) return;
  await act(`${W(p.s, $('#t-ask').dataset.t)}/choose`, { n: +b.dataset.n });
  $('#t-ask').hidden = true; setTimeout(refresh, 500);
});
$('#t-name').addEventListener('click', async () => {
  const p = focused(); if (!p) return;
  const to = await ask({ title: 'Rename session', label: 'Name', value: p.s, ok: 'Rename', validate: NAME_RULE });
  if (!to || to === p.s) return;
  await act(`/api/sessions/${encodeURIComponent(p.s)}/rename`, { to });
  history.replaceState({ term: to }, ''); p.s = to; await refresh(); p.connect();
});
$('#btn-addwin').addEventListener('click', (e) => {
  const p = focused(); if (!p) return;
  menu(e.currentTarget, [...presetItems(async (pr) => {
    await act(`/api/sessions/${encodeURIComponent(p.s)}/windows`, { preset: pr.id }); toast(`Opened ${pr.label}`); refresh();
  }), '-', { label: 'In another folder…', icon: 'folder', run: () => openNew('window', p.s) }]);
});

const renameWin = (value) => ask({ title: 'Rename window', label: 'Name', value, ok: 'Rename', validate: (v) => v ? '' : 'Enter a name.' });
const cur = () => { const p = focused(); const w = p?.win; return w && { p, w, ap: activePane(w), t: W(p.s, w.index) }; };
$('#w-toggle').addEventListener('click', async (e) => {
  const c = cur(); if (!c) return;
  const a = e.currentTarget.dataset.a;
  if (a === 'stop') { await act(`${c.t}/stop`); toast(`Sent stop to ${c.ap.cmd}`); }
  else if (a === 'start') await act(`${c.t}/start`);
  else return menu(e.currentTarget, presetItems(async (pr) => { if (pr.cmd) await act(`${c.t}/start`, { preset: pr.id }); refresh(); }));
  setTimeout(refresh, 700);
});
$('#w-restart').addEventListener('click', async () => {
  const c = cur(); if (!c) return;
  if (c.ap.running) { await act(`${c.t}/stop`); await new Promise((r) => setTimeout(r, 900)); }
  await act(`${c.t}/start`); toast(`Restarted ${c.ap.preset}`); setTimeout(refresh, 700);
});
$('#w-panes').addEventListener('click', (e) => {
  const c = cur(); if (!c) return;
  const pane = (action) => async () => { await act(`${c.t}/pane`, { action }); refresh(); };
  const split = (dir) => () => menu(e.target, presetItems(async (pr) => { await act(`${c.t}/split`, { dir, preset: pr.id }); refresh(); }));
  menu(e.currentTarget, [
    { label: 'Split right', icon: 'columns', run: split('right') },
    { label: 'Split down', icon: 'rows', run: split('down') },
    { label: 'Next pane', icon: 'next', disabled: c.w.panes.length < 2, run: pane('next') },
    { label: c.w.zoomed ? 'Unzoom pane' : 'Zoom pane', icon: 'expand', disabled: c.w.panes.length < 2, run: pane('zoom') },
    { label: 'Change layout', icon: 'grid', disabled: c.w.panes.length < 2, run: pane('layout') },
    { label: 'Type into all panes', checked: c.w.sync, icon: '', disabled: c.w.panes.length < 2, run: pane('sync') },
    '-',
    { label: 'Close pane', icon: 'trash', danger: true, disabled: c.w.panes.length < 2, run: async () => {
      if (await ask({ title: `Close pane ${c.ap.index}?`, message: `${c.ap.cmd} in this pane stops.`, ok: 'Close pane', danger: true })) { await act(W(c.p.s, `${c.w.index}.${c.ap.index}`), null, 'DELETE'); refresh(); }
    } },
  ]);
});
$('#w-changes').addEventListener('click', () => { const c = cur(); if (c) openChanges(c.ap.cwd); });
$('#w-find').addEventListener('click', () => { const c = cur(); if (c) openFind(c.t, `${c.p.s} › ${c.w.name}`); });
$('#w-scroll').addEventListener('click', () => { const p = focused(); if (p) queueScroll(p, -15); });
$('#w-kill').addEventListener('click', async () => {
  const c = cur(); if (!c) return;
  if (!await ask({ title: `Close window "${c.w.name}"?`, message: c.w.running ? `${c.ap.cmd} is still running and will be stopped.` : 'The window and its panes close.', ok: 'Close window', danger: true })) return;
  await act(c.t, null, 'DELETE'); refresh();
});
for (const [id, d] of [['#w-font-dec', -1], ['#w-font-inc', 1]]) $(id).addEventListener('click', () => setFont(T.fontSize + d));

export function setFont(n) {
  T.fontSize = Math.max(8, Math.min(28, Math.round(n))); store.set('font', T.fontSize);
  for (const p of T.panes) { p.term.options.fontSize = T.fontSize; try { p.fit.fit(); } catch {} }
}
export function setTheme(name) {
  T.theme = THEMES[name] ? name : 'ink'; store.set('theme', T.theme);
  for (const p of T.panes) p.term.options.theme = THEMES[T.theme];
  document.documentElement.dataset.term = T.theme;
}
document.documentElement.dataset.term = T.theme;

// ---------- scrolling and pinch zoom ----------
// The server picks the right kind of scroll: tmux history for shells, wheel events for full-screen
// apps with mouse support (Claude Code, codex), arrow keys for other full-screen apps (less, man).
const scr = new WeakMap();
function queueScroll(p, lines) {
  const st = scr.get(p) || { acc: 0, t: null }; scr.set(p, st);
  st.acc += lines;
  if (st.t) return;
  st.t = setTimeout(async () => {
    const n = st.acc; st.acc = 0; st.t = null;
    const w = p.win; if (!w || !n) return;
    let r = {};
    try { r = await api(`${W(p.s, w.index)}/scroll`, { method: 'POST', body: { dir: n < 0 ? 'up' : 'down', lines: Math.abs(n) } }); } catch {}
    if (r.mode === 'copy' && n < 0) { w.inMode = true; $('.scrollhint', p.el).hidden = false; }
    clearTimeout(st.r); st.r = setTimeout(refresh, 400);
  }, 60);
}
function touchScroll(p) {
  let y0 = null, acc = 0, pinch = null, samples = [], fling = 0;
  const el = $('.tbody', p.el);
  const cell = () => T.fontSize * 1.3;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const move = (dy) => { // finger down = back in history
    acc += dy;
    const lines = Math.trunc(acc / cell());
    if (lines) { acc -= lines * cell(); queueScroll(p, -lines); }
  };
  // capture phase: we see the gesture even if xterm handles the touch itself
  const o = { passive: true, capture: true };
  el.addEventListener('touchstart', (e) => {
    cancelAnimationFrame(fling);
    if (e.touches.length === 2) { pinch = { d: dist(e.touches), size: T.fontSize }; y0 = null; }
    else if (e.touches.length === 1) { y0 = e.touches[0].clientY; acc = 0; samples = [[performance.now(), y0]]; }
  }, o);
  el.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      const n = Math.round(pinch.size * dist(e.touches) / pinch.d);
      if (n !== T.fontSize) setFont(n);
      return;
    }
    if (y0 == null) return;
    const y = e.touches[0].clientY;
    move(y - y0); y0 = y;
    samples.push([performance.now(), y]); if (samples.length > 5) samples.shift();
  }, o);
  el.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinch = null;
    if (e.touches.length || y0 == null) return;
    y0 = null;
    // momentum, like native lists: keep going at the release speed, slowing down
    const [t0, ya] = samples[0], [t1, yb] = samples.at(-1);
    let v = t1 - t0 > 0 && performance.now() - t1 < 80 ? (yb - ya) / (t1 - t0) : 0; // px per ms
    if (Math.abs(v) < 0.3 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let last = performance.now();
    const step = (now) => {
      const dt = now - last; last = now;
      move(v * dt); v *= Math.pow(0.996, dt);
      if (Math.abs(v) > 0.05) fling = requestAnimationFrame(step);
    };
    fling = requestAnimationFrame(step);
  }, o);
}

// ---------- extra keys for touch keyboards ----------
const KEYS = [
  ['Snippets', 'snip', 0, 'Run a saved command'], 'sep', ['Esc', '\x1b'], ['Tab', '\t'], ['⇧Tab', '\x1b[Z', 0, 'Shift+Tab (Claude: switch mode)'], ['Ctrl', 'ctrl'], ['Alt', 'alt'], 'sep',
  ['←', '\x1b[D', 1], ['↓', '\x1b[B', 1], ['↑', '\x1b[A', 1], ['→', '\x1b[C', 1], ['⏎', '\r'], 'sep',
  ['Paste', 'paste'], ['^C', '\x03'], ['^D', '\x04'], ['^Z', '\x1a'], ['^R', '\x12'], ['^L', '\x0c'], ['^B', '\x02', 0, 'tmux prefix'], 'sep',
  ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-'], ['_', '_'], [':', ':'], ['`', '`'], ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'],
];
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
export const sendInput = (d) => focused()?.send(d);
const paste = (t) => sendInput(t.includes('\n') ? `\x1b[200~${t}\x1b[201~` : t);
// snippets: the launcher commands plus what was recently sent from the message box, typed and run in the focused pane
function snippets(anchor) {
  const cmds = [...new Set([...S.presets.map((p) => p.cmd).filter(Boolean), ...store.get('sent', [])])].slice(0, 16);
  if (!cmds.length) return toast('No snippets yet. Commands you send from the message box show up here.');
  menu(anchor, cmds.map((c) => ({ label: c.length > 48 ? c.slice(0, 46) + '…' : c, icon: 'snippet', run: () => { paste(c); setTimeout(() => sendInput('\r'), 30); } })));
}
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
    vibrate();
    const [, seq, repeat] = KEYS[b.dataset.k];
    if (seq === 'ctrl' || seq === 'alt') { T.mods[seq] = !T.mods[seq]; return renderKeys(); }
    if (seq === 'snip') return snippets(b);
    if (seq === 'paste') {
      return navigator.clipboard?.readText ? navigator.clipboard.readText().then(paste, () => toast('Long-press the message box and paste there', true))
        : toast('Long-press the message box and paste there', true);
    }
    sendInput(applyMods(seq));
    if (repeat) rep = setTimeout(() => { rep = setInterval(() => sendInput(seq), 60); }, 380);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('#keys').addEventListener(ev, stop);
})();

// ---------- message box: reliable typing on phones, pasting prompts, attaching files ----------
const ct = $('#compose-text');
function sendCompose() {
  const v = ct.value;
  if (v.trim() && !v.includes('\n')) store.set('sent', [v.trim(), ...store.get('sent', []).filter((x) => x !== v.trim())].slice(0, 12));
  // multi-line text goes as a bracketed paste so agents treat it as one prompt
  paste(v);
  setTimeout(() => sendInput('\r'), v.includes('\n') ? 60 : 0);
  ct.value = ''; ct.style.height = '';
}
$('#compose').addEventListener('submit', (e) => { e.preventDefault(); sendCompose(); });
ct.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendCompose(); } });
ct.addEventListener('input', () => { ct.style.height = ''; ct.style.height = Math.min(ct.scrollHeight, innerHeight * 0.3) + 'px'; });
$('#attach').addEventListener('click', () => $('#attach-file').click());
$('#attach-file').addEventListener('change', async (e) => {
  const c = cur(); if (!c) return;
  for (const f of e.target.files) {
    toast(`Uploading ${f.name}…`);
    try {
      const r = await api(`/api/upload?dir=${encodeURIComponent(c.ap.cwd)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f, timeout: 120000 });
      ct.value = (ct.value ? ct.value.replace(/\s*$/, ' ') : '') + r.path + ' ';
      ct.dispatchEvent(new Event('input'));
      toast(`Attached ${f.name}`);
    } catch (err) { toast(`${f.name}: ${err.message}`, true); }
  }
  e.target.value = '';
  ct.focus();
});
renderKeys();

$('#w-snip').addEventListener('click', (e) => snippets(e.currentTarget));
