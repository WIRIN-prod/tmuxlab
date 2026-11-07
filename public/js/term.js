// Terminal view: one or more terminal panes (split view), each attached through its own tmux view session.
import { $, $$, esc, S, api, act, W, toast, store, touch, home, winState, activeWin, activePane, findSess, menu, presetItems, vibrate, cfg, ask, afterNav, NAME_RULE, whereHtml, whereText, icon, openPort, ago } from './core.js';
import { refresh, refreshPreviews } from './wall.js';
import { openNew, openChanges, openFind, pickWindow, openSettings, openAgent } from './sheets.js';

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
  mount(parent, before = null) {
    parent.insertBefore(this.el, before);
    this.term.open($('.xt', this.el));
    if (touch) softKeyboard(this);
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
  addTab(name);
  if (!$('#term').hidden && T.panes.length) return switchTo(name, w);
  afterNav(() => history.pushState({ term: name }, ''));
  for (const p of T.panes) p.dispose();
  T.panes = []; T.focus = 0;
  $('#wall').hidden = true; $('#term').hidden = false;
  addPane(name, w);
  keepAwake(true);
}

// ---------- session tabs: sessions you have open, one tap apart ----------
const tabsKey = () => `tabs:${cfg()?.base}`;
const openTabs = () => store.get(tabsKey(), []);
const saveTabs = (l) => { store.set(tabsKey(), l); renderSessTabs(); };
function addTab(name) { const l = openTabs(); if (!l.includes(name)) saveTabs([...l, name].slice(-12)); }
// the focused view shows another session; the others in a split stay as they are
function switchTo(name, w) {
  const old = focused();
  if (!old) return addPane(name, w);
  if (old.s === name && w == null) return;
  const p = new Pane(name, w);
  p.mount($('#terms'), old.el);
  old.dispose(); T.panes[T.focus] = p;
  history.replaceState({ term: name }, '');
  $('#t-tabs').dataset.sig = '';
  layout(); renderTermBar(); renderSessTabs();
  requestAnimationFrame(() => { p.fit.fit(); p.connect(); if (!touch) p.term.focus(); });
}
function closeTab(name) {
  const l = openTabs(), i = l.indexOf(name);
  saveTabs(l.filter((x) => x !== name));
  if (focused()?.s !== name) return;
  const next = l.filter((x) => x !== name)[Math.min(i, l.length - 2)];
  if (next) switchTo(next); else history.state?.term ? history.back() : closeTerm();
}
const sessState = (s) => s.windows.some((w) => w.prompt) ? 'ask-dot' : s.windows.some((w) => w.running) ? 'run' : '';
function renderSessTabs() {
  const cur = focused()?.s;
  let l = openTabs();
  if (S.sessions.length && l.some((n) => !findSess(n) && n !== cur)) { l = l.filter((n) => findSess(n) || n === cur); store.set(tabsKey(), l); }
  if (cur && !l.includes(cur)) l = [...l, cur];
  const html = l.map((n) => {
    const s = findSess(n), on = n === cur;
    const unread = !on && s && s.activity > (lastSeen[`s:${n}`] || 0) && lastSeen[`s:${n}`] !== undefined;
    return `<div class="stab ${on ? 'on' : ''} ${unread ? 'unread' : ''}"><button class="stab-b" data-s="${esc(n)}" aria-current="${on}" ${on ? 'title="Long-press or right-click for more"' : ''}>
      <span class="dot ${s ? sessState(s) : 'dead'}"></span><span class="n">${esc(n)}</span></button>${on ? `<button class="stab-x" data-x="${esc(n)}" aria-label="Close tab ${esc(n)}">${icon('x')}</button>` : ''}</div>`;
  }).join('');
  if ($('#t-stabs').dataset.sig === html) return;
  $('#t-stabs').dataset.sig = html; $('#t-stabs').innerHTML = html;
  $('#t-stabs .stab.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
$('#t-stabs').addEventListener('click', (e) => {
  const x = e.target.closest('[data-x]'); if (x) return closeTab(x.dataset.x);
  const b = e.target.closest('[data-s]'); if (b) switchTo(b.dataset.s);
});
$('#t-stabs').addEventListener('dblclick', (e) => { if (e.target.closest('.stab.on')) renameSession(); });
$('#t-stabs').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('[data-s]'); if (!b) return;
  e.preventDefault();
  const n = b.dataset.s;
  menu(b, [
    { label: 'Rename session', icon: 'edit', disabled: n !== focused()?.s, run: renameSession },
    { label: 'Open beside', icon: 'columns', disabled: T.panes.length >= MAX_PANES || n === focused()?.s, run: () => addPane(n) },
    { label: 'Close tab', icon: 'x', run: () => closeTab(n) },
    { label: 'Close other tabs', icon: 'x', disabled: openTabs().length < 2, run: () => saveTabs([focused()?.s].filter(Boolean)) },
  ]);
});
$('#btn-opensess').addEventListener('click', (e) => {
  const l = openTabs();
  const rest = S.sessions.filter((s) => !l.includes(s.name));
  menu(e.currentTarget, [...rest.map((s) => ({ label: s.name, sub: whereText(activeWin(s)), icon: s.windows.some((w) => w.prompt) ? 'spark' : 'terminal', run: () => openTerm(s.name) })),
    ...(rest.length ? ['-'] : []), { label: 'New session…', icon: 'plus', run: () => openNew() }]);
});
// Alt+1..9 jumps to a tab; Alt+[ / Alt+] steps through them
addEventListener('keydown', (e) => {
  if ($('#term').hidden || !e.altKey || e.ctrlKey || e.metaKey) return;
  const l = openTabs(), i = l.indexOf(focused()?.s);
  const to = /^Digit[1-9]$/.test(e.code) ? l[+e.code.slice(5) - 1] : e.code === 'BracketRight' ? l[(i + 1) % l.length] : e.code === 'BracketLeft' ? l[(i - 1 + l.length) % l.length] : null;
  if (to) { e.preventDefault(); e.stopPropagation(); switchTo(to); }
}, true);

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
// ---------- agents panel: every agent on this machine, the ones that need you first ----------
const AG_ORDER = { blocked: 0, done: 1, working: 2, idle: 3 };
const AG_LABEL = { blocked: 'needs you', done: 'done', working: 'working', idle: 'idle' };
const wide = matchMedia('(min-width: 1100px)');
const agentsOpen = () => wide.matches ? store.get('agentsPanel', true) : $('#btn-agents').getAttribute('aria-expanded') === 'true';
function allAgents() {
  const out = [];
  for (const s of S.sessions) for (const w of s.windows) for (const p of w.panes || []) if (p.agent) out.push({ s, w, p, ...p.agent });
  return out.sort((a, b) => AG_ORDER[a.state] - AG_ORDER[b.state] || b.since - a.since);
}
function renderAgents() {
  const list = allAgents(), cur = focused();
  const n = list.filter((a) => a.state === 'blocked' || a.state === 'done').length;
  $('#t-agents-n').hidden = !n; $('#t-agents-n').textContent = n;
  $('#btn-agents').hidden = !list.length;
  const show = list.length > 0 && agentsOpen();
  $('#t-agents').hidden = !show; $('#btn-agents').setAttribute('aria-expanded', String(show));
  if (!show) return;
  const sig = JSON.stringify([list.map((a) => [a.p.id, a.state, a.p.status?.last, a.w.name]), cur?.s, cur?.win?.index]);
  if ($('#t-agents').dataset.sig === sig) return;
  $('#t-agents').dataset.sig = sig;
  $('#t-agents').innerHTML = `<h2 class="small muted">Agents</h2><ul>${list.map((a) => `<li><button class="ag ag-${a.state}" data-s="${esc(a.s.name)}" data-w="${a.w.index}" data-p="${a.p.index}"
    aria-current="${cur?.s === a.s.name && cur?.win?.index === a.w.index}">
    <span class="dot"></span><span class="ag-t"><b>${esc(a.agent)}</b> <span class="muted">${esc(a.s.name)}${a.s.windows.length > 1 ? ` › ${esc(a.w.name)}` : ''}</span></span>
    <span class="ag-st">${AG_LABEL[a.state]} · ${ago(a.since / 1000)}</span>
    ${a.p.status?.last ? `<span class="ag-l">${esc(a.p.status.last)}</span>` : ''}</button></li>`).join('')}</ul>`;
}
$('#btn-agents').addEventListener('click', () => {
  if (wide.matches) store.set('agentsPanel', !store.get('agentsPanel', true));
  else $('#btn-agents').setAttribute('aria-expanded', String(!agentsOpen()));
  $('#t-agents').dataset.sig = ''; renderAgents(); layout();
});
$('#t-agents').addEventListener('click', async (e) => {
  const b = e.target.closest('.ag'); if (!b) return;
  if (!wide.matches) $('#btn-agents').setAttribute('aria-expanded', 'false');
  await act(`${W(b.dataset.s, `${b.dataset.w}.${b.dataset.p}`)}/select`).catch(() => {}); // land on the agent's pane, not just its window
  openTerm(b.dataset.s, +b.dataset.w); refresh();
});
wide.addEventListener('change', () => { $('#t-agents').dataset.sig = ''; renderAgents(); });

export function renderTermBar() {
  renderAgents();
  const p = focused(); if (!p) return;
  const s = p.sess, w = p.win;
  renderSessTabs();
  for (const x of T.panes) { $('.tpn', x.el).textContent = `${x.s} › ${x.win?.name ?? ''}${x.win ? ` · ${whereText(x.win)}` : ''}`; if (x.view && x.sess?.views[x.view] != null) x.wIdx = x.sess.views[x.view]; }
  if (!s || !w) return;
  // tabs: dot = state, ring = output you haven't looked at
  const key = (i) => `${p.s}:${i}`;
  lastSeen[key(w.index)] = Math.max(lastSeen[key(w.index)] || 0, w.activity);
  lastSeen[`s:${p.s}`] = Math.max(lastSeen[`s:${p.s}`] || 0, s.activity);
  for (const n of openTabs()) if (n !== p.s && lastSeen[`s:${n}`] === undefined) lastSeen[`s:${n}`] = findSess(n)?.activity || 0;
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
  const ag = agentOf(ap);
  $('#w-agent').hidden = !ag;
  if (ag) $('#w-agent').innerHTML = `${icon(ag === 'claude' ? 'spark' : 'target')}${ag === 'claude' ? 'Claude' : 'Codex'}${ap.status?.mode ? ` <small>${esc(ap.status.mode)}</small>` : ''}`;
  const ports = S.stats?.sessions[p.s]?.ports || [];
  $('#w-ports').hidden = !ports.length;
  $('#w-ports').innerHTML = ports.length ? `${icon('globe')}${ports.length === 1 ? `:${ports[0].port}` : `${ports.length} ports`}` : '';
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
async function renameSession() {
  const p = focused(); if (!p) return;
  const from = p.s;
  const to = await ask({ title: 'Rename session', label: 'Name', value: from, ok: 'Rename', validate: NAME_RULE });
  if (!to || to === from) return;
  await act(`/api/sessions/${encodeURIComponent(from)}/rename`, { to });
  store.set(tabsKey(), openTabs().map((n) => n === from ? to : n));
  history.replaceState({ term: to }, ''); p.s = to; await refresh(); p.connect();
}
$('#btn-addwin').addEventListener('click', (e) => {
  const p = focused(); if (!p) return;
  const cwd = p.win ? activePane(p.win).cwd : '';
  menu(e.currentTarget, [
    { label: 'Claude Code…', icon: 'spark', sub: 'new, continue or resume', run: () => openAgent({ kind: 'claude', s: p.s, cwd, where: 'window' }) },
    { label: 'Codex…', icon: 'target', sub: 'new, continue or resume', run: () => openAgent({ kind: 'codex', s: p.s, cwd, where: 'window' }) },
    '-',
    ...presetItems(async (pr) => {
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
  else return menu(e.currentTarget, [
    { label: 'Claude Code…', icon: 'spark', sub: 'new, continue or resume', run: () => openAgent({ kind: 'claude', s: c.p.s, t: c.t, cwd: c.ap.cwd, where: 'pane' }) },
    { label: 'Codex…', icon: 'target', sub: 'new, continue or resume', run: () => openAgent({ kind: 'codex', s: c.p.s, t: c.t, cwd: c.ap.cwd, where: 'pane' }) },
    '-',
    ...presetItems(async (pr) => { if (pr.cmd) await act(`${c.t}/start`, { preset: pr.id }); refresh(); })]);
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
// ---------- agent controls: the commands and keys Claude Code and Codex understand ----------
export const agentOf = (pane) => pane?.agent ? (/^(claude|codex)$/.test(pane.agent.agent) ? pane.agent.agent : null) : /^(claude|codex)$/.test(pane?.cmd) ? pane.cmd : /\b(claude|codex)\b/.exec(pane?.running ? pane.preset || '' : '')?.[1] || null;
const slash = (t, cmd) => async () => { await act(`${t}/keys`, { text: cmd }); await new Promise((r) => setTimeout(r, 120)); await act(`${t}/keys`, { keys: ['Enter'] }); };
const keys = (t, ...k) => async () => { await act(`${t}/keys`, { keys: k }); setTimeout(refresh, 400); };
$('#w-agent').addEventListener('click', (e) => {
  const c = cur(); if (!c) return;
  const t = `${W(c.p.s, `${c.w.index}.${c.ap.index}`)}`;
  const claude = agentOf(c.ap) === 'claude';
  const confirm = (title, message, run) => async () => { if (await ask({ title, message, ok: title.replace(/\?$/, ''), danger: true })) run(); };
  menu(e.currentTarget, claude ? [
    { label: 'Interrupt', sub: 'Esc · stops the current step', icon: 'x', run: keys(t, 'Escape') },
    { label: 'Switch mode', sub: `Shift+Tab${c.ap.status?.mode ? ` · now ${c.ap.status.mode}` : ''}`, icon: 'refresh', run: keys(t, 'BTab') },
    { label: 'Rewind', sub: '/rewind · go back to an earlier message', icon: 'left', run: slash(t, '/rewind') },
    '-',
    { label: 'Compact the conversation', sub: '/compact', icon: 'layers', run: slash(t, '/compact') },
    { label: 'Context used', sub: '/context', icon: 'grid', run: slash(t, '/context') },
    { label: 'Change model', sub: '/model', icon: 'spark', run: slash(t, '/model') },
    { label: 'Resume another conversation', sub: '/resume', icon: 'list', run: slash(t, '/resume') },
    { label: 'Remote Control', sub: '/remote-control · continue in the Claude app', icon: 'target', run: slash(t, '/remote-control') },
    { label: 'Status', sub: '/status', icon: 'check', run: slash(t, '/status') },
    { label: 'All commands', sub: '/help', icon: 'snippet', run: slash(t, '/help') },
    '-',
    { label: 'Clear the conversation…', sub: '/clear', icon: 'trash', danger: true, run: confirm('Clear the conversation?', 'Claude starts fresh in this window. The old conversation can still be resumed later.', slash(t, '/clear')) },
  ] : [
    { label: 'Interrupt', sub: 'Esc · stops the current step', icon: 'x', run: keys(t, 'Escape') },
    '-',
    { label: 'Change model', sub: '/model', icon: 'spark', run: slash(t, '/model') },
    { label: 'Permissions', sub: '/permissions · what it may do without asking', icon: 'check', run: slash(t, '/permissions') },
    { label: 'Show changes', sub: '/diff', icon: 'diff', run: slash(t, '/diff') },
    { label: 'Review changes', sub: '/review', icon: 'target', run: slash(t, '/review') },
    { label: 'Compact the conversation', sub: '/compact', icon: 'layers', run: slash(t, '/compact') },
    { label: 'Resume another conversation', sub: '/resume', icon: 'list', run: slash(t, '/resume') },
    { label: 'Status', sub: '/status', icon: 'grid', run: slash(t, '/status') },
    '-',
    { label: 'New conversation…', sub: '/new', icon: 'plus', run: confirm('Start a new conversation?', 'Codex starts fresh in this window. The old one can still be resumed later.', slash(t, '/new')) },
  ]);
});
$('#w-ports').addEventListener('click', (e) => {
  const p = focused(); const ports = S.stats?.sessions[p?.s]?.ports || []; if (!ports.length) return;
  if (ports.length === 1) return openPort(ports[0].port);
  menu(e.currentTarget, ports.map((x) => ({ label: `Open :${x.port}`, sub: x.local ? 'only on this machine, opened through tmuxlab' : 'opened through tmuxlab', icon: 'globe', run: () => openPort(x.port) })));
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

// ---------- phone keyboards ----------
// Android keyboards edit whole words (autocorrect, predictions), which xterm misreads: backspace could bring the
// deleted text back. So on touch screens we read what the keyboard did to the text box and send the difference:
// one DEL per removed character, then the new text. Real key presses (Enter, arrows, a hardware keyboard) still go to xterm.
const PAD = '  '; // keeps something in the box, so backspace on an "empty" line still reaches us
function softKeyboard(p) {
  const ta = $('textarea', p.el); if (!ta) return;
  let prev = ta.value = PAD, composing = false;
  const reset = () => { ta.value = prev = PAD; };
  const mine = (e) => e.target === ta;
  p.el.addEventListener('keydown', (e) => { if (mine(e) && (e.keyCode === 229 || e.isComposing)) e.stopPropagation(); }, true);
  for (const ev of ['compositionstart', 'compositionupdate', 'compositionend']) {
    p.el.addEventListener(ev, (e) => {
      if (!mine(e)) return;
      e.stopPropagation(); composing = ev !== 'compositionend';
      if (!composing) setTimeout(() => { if (!composing && ta.value === prev && /\s$/.test(prev)) reset(); });
    }, true);
  }
  p.el.addEventListener('input', (e) => {
    if (!mine(e)) return;
    e.stopPropagation();
    const v = ta.value;
    let k = 0; while (k < v.length && k < prev.length && v[k] === prev[k]) k++;
    const out = '\x7f'.repeat(prev.length - k) + v.slice(k).replace(/\r?\n/g, '\r');
    prev = v;
    if (out) p.send(applyMods(out));
    if (!composing && (v.length < PAD.length || /[\s]$/.test(v) || v.length > 200)) reset(); // between words: start fresh
  }, true);
  p.el.addEventListener('focusin', (e) => { if (mine(e) && !composing) reset(); }, true);
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
// snippets: saved ones (Settings > Snippets), then recent message-box sends; typed and run in the focused pane
function snippets(anchor) {
  const cut = (c) => (c.length > 48 ? c.slice(0, 46) + '…' : c);
  const run = (c) => async () => {
    // {{name}} asks for a value each time; a value never contains a newline, so it can't run a second command
    for (const name of new Set([...c.matchAll(/\{\{\s*([^{}]{1,40}?)\s*\}\}/g)].map((m) => m[1]))) {
      const v = await ask({ title: 'Fill in the snippet', message: c, label: name, ok: 'Run', validate: (x) => (x ? '' : `Enter ${name}.`) });
      if (v === null) return;
      c = c.replace(new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g'), () => v.replace(/[\r\n]+/g, ' '));
    }
    paste(c); setTimeout(() => sendInput('\r'), 30);
  };
  const saved = S.snippets.map((s) => ({ label: s.label || cut(s.cmd), sub: s.label ? cut(s.cmd) : '', icon: 'snippet', run: run(s.cmd) }));
  const recent = store.get('sent', []).filter((c) => !S.snippets.some((s) => s.cmd === c)).slice(0, 8)
    .map((c) => ({ label: cut(c), icon: 'refresh', run: run(c) }));
  menu(anchor, [...saved, ...(saved.length && recent.length ? ['-'] : []), ...recent, ...(saved.length || recent.length ? ['-'] : []),
    { label: saved.length ? 'Edit snippets…' : 'Add snippets…', icon: 'edit', run: () => openSettings('snippets') }]);
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
      return navigator.clipboard?.readText ? navigator.clipboard.readText().then(paste, () => toast('This app may not read the clipboard', true))
        : toast('This app may not read the clipboard', true);
    }
    sendInput(applyMods(seq));
    if (repeat) rep = setTimeout(() => { rep = setInterval(() => sendInput(seq), 60); }, 380);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('#keys').addEventListener(ev, stop);
})();

// ---------- attach: upload a file and type its path ----------
$('#attach').addEventListener('click', () => $('#attach-file').click());
$('#attach-file').addEventListener('change', async (e) => {
  const c = cur(); if (!c) return;
  for (const f of e.target.files) {
    toast(`Uploading ${f.name}…`);
    try {
      const r = await api(`/api/upload?dir=${encodeURIComponent(c.ap.cwd)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f, timeout: 120000 });
      paste(r.path + ' ');
      toast(`Attached ${f.name}`);
    } catch (err) { toast(`${f.name}: ${err.message}`, true); }
  }
  e.target.value = '';
});
renderKeys();

$('#w-snip').addEventListener('click', (e) => snippets(e.currentTarget));

const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
$('#mic').hidden = !Speech || !!window.Capacitor?.isNativePlatform?.(); // the WebView has the API but no recogniser; the keyboard's mic works there
$('#mic').addEventListener('click', () => {
  if (rec) return rec.stop();
  rec = new Speech(); rec.lang = navigator.language; rec.continuous = true;
  rec.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) paste(e.results[i][0].transcript + ' '); };
  rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast(e.error === 'not-allowed' ? 'Microphone access is blocked for this page.' : `Dictation stopped: ${e.error}`, true); };
  rec.onend = () => { rec = null; $('#mic').setAttribute('aria-pressed', 'false'); };
  rec.start(); $('#mic').setAttribute('aria-pressed', 'true');
});
