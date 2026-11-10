// Terminal view: one or more terminal panes (split view), each attached through its own tmux view session.
import { $, $$, esc, S, api, act, W, toast, store, touch, home, winState, activeWin, activePane, findSess, menu, presetItems, vibrate, cfg, origin, failover, ask, afterNav, onBack, NAME_RULE, whereHtml, whereText, icon, openPort, ago } from './core.js';
import { refresh, refreshPreviews } from './wall.js';
import { openNew, openChanges, openFind, pickWindow, openSettings, openAgent, openPalette } from './sheets.js';

export const THEMES = {
  ink: { background: '#121215', foreground: '#e4e4e7', cursor: '#34d399', cursorAccent: '#121215', selectionBackground: '#10b98140',
    black: '#18181b', brightBlack: '#71717a', red: '#f87171', green: '#34d399', yellow: '#fbbf24', blue: '#60a5fa',
    magenta: '#c084fc', cyan: '#38bdf8', white: '#d4d4d8', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fde68a',
    brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#7dd3fc', brightWhite: '#fafafa' },
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
  fontSize: store.get('font', 13), theme: store.get('theme', 'ink'), wake: null,
};
const MAX_PANES = 4;
let lastCopy = '';
function copyText(t) {
  if (!t || t === lastCopy && Date.now() - copyText.at < 1000) return;
  lastCopy = t; copyText.at = Date.now();
  const done = () => toast(`Copied ${t.length > 40 ? `${t.length} characters` : `“${t.trim()}”`}`);
  const legacy = () => { // plain-http pages have no navigator.clipboard
    const a = document.createElement('textarea'); a.value = t; a.style.cssText = 'position:fixed;opacity:0';
    const f = document.activeElement; document.body.append(a); a.select();
    const ok = document.execCommand('copy'); a.remove(); f?.focus?.();
    ok ? done() : toast('The browser blocked copying: use Find to copy output', true);
  };
  navigator.clipboard?.writeText ? navigator.clipboard.writeText(t).then(done, legacy) : legacy();
}
const focused = () => T.panes[T.focus];

class Pane {
  constructor(s, w) {
    this.s = s; this.w0 = w; this.view = null; this.ws = null; this.retry = 0; this.timer = null;
    this.el = document.createElement('div');
    this.el.className = 'tpane';
    this.el.innerHTML = `<div class="tph"><span class="tps"></span><button class="tpn" aria-haspopup="menu" title="Change what this view shows, move or close it"></button><button class="btn sm ghost icon" data-x aria-label="Close this view">✕</button></div>
      <div class="tbody"><div class="xt"></div>
      <div class="banner" hidden><span>Reconnecting…</span><button class="btn sm">Retry now</button></div>
      <div class="scrollhint" hidden>History · scroll down to return<button class="btn sm">Exit</button></div></div>`;
    this.term = new Terminal({ rightClickSelectsWord: false, fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace", fontSize: T.fontSize, lineHeight: 1.25, cursorBlink: true,
      allowProposedApi: true, scrollback: 0, theme: THEMES[T.theme] }); // tmux owns history
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank')));
    this.term.onData((d) => this.input(applyMods(d)));
    // tmux (and apps) copy by sending OSC 52 to the terminal: put that text on the device clipboard
    this.term.parser.registerOscHandler(52, (d) => {
      const b = d.slice(d.indexOf(';') + 1);
      if (b && b !== '?') try { copyText(new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)))); } catch {}
      return true;
    });
    this.term.onResize(({ cols, rows }) => this.ctl({ t: 'resize', cols, rows }));
    // the wheel always goes through the server, which scrolls tmux history or, for an app that takes the mouse, sends it
    // the wheel; never through tmux's own mouse handling, which turns it into arrow keys in some apps
    this.term.attachCustomWheelEventHandler((e) => {
      queueScroll(this, e.deltaY < 0 ? -3 : 3);
      return false;
    });
    this.el.addEventListener('pointerdown', () => setFocus(T.panes.indexOf(this)), true);
    // a mouse selection in the terminal itself (Shift+drag when the program uses the mouse) copies on release
    this.el.addEventListener('mouseup', () => { if (this.term.hasSelection()) copyText(this.term.getSelection()); });
    // the left button always selects text, even when the program (tmux, Claude Code) uses the mouse: xterm does that for
    // Shift+drag, so restart the press with Shift held. Alt+click still reaches the program.
    this.term.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyV'));
    const xt = $('.xt', this.el);
    xt.addEventListener('mousedown', (e) => {
      if (!e.isTrusted || e.altKey || e.shiftKey || this.term.modes.mouseTrackingMode === 'none') return;
      if (e.button === 2) { // right button pastes, not a program click
        e.stopImmediatePropagation(); e.preventDefault();
        if (!navigator.clipboard?.readText) { // plain http: put the input under the mouse so the browser's own menu offers Paste
          const ta = $('.xterm-helper-textarea', this.el), b = xt.getBoundingClientRect();
          Object.assign(ta.style, { left: `${e.clientX - b.left - 10}px`, top: `${e.clientY - b.top - 10}px`, width: '20px', height: '20px', zIndex: 1000 });
          ta.focus(); setTimeout(() => Object.assign(ta.style, { left: '', top: '', width: '', height: '', zIndex: '' }), 200);
        }
        return;
      }
      if (e.button !== 0) return;
      e.stopImmediatePropagation(); e.preventDefault();
      this.term.clearSelection(); // or Shift would extend the old selection
      e.target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, detail: e.detail, screenX: e.screenX, screenY: e.screenY,
        clientX: e.clientX, clientY: e.clientY, button: 0, buttons: e.buttons, shiftKey: true }));
    }, true);
    xt.addEventListener('contextmenu', (e) => {
      if (touch || e.altKey || !navigator.clipboard?.readText) return; // phones and plain http keep the browser's own menu (it has Paste)
      e.preventDefault(); e.stopPropagation();
      navigator.clipboard.readText().then((t) => { if (t) { paste(t); this.term.focus(); } }, () => toast('The browser blocked reading the clipboard: press Ctrl+V instead', true));
    }, true);
    $('[data-x]', this.el).onclick = (e) => { e.stopPropagation(); closePane(this); };
    $('.tpn', this.el).onclick = (e) => slotMenu(this, e.currentTarget);
    $('.tph', this.el).ondblclick = (e) => { if (!e.target.closest('button')) toggleZoom(); };
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
  // typing while scrolled back returns to the bottom first, so the keys reach the program (tmux copy mode would eat them)
  input(d) {
    if (this.win?.inMode && !this.back) this.back = api(`${W(this.s, this.win.index)}/scroll`, { method: 'POST', body: { dir: 'cancel' } }).catch(() => {})
      .finally(() => { if (this.win) this.win.inMode = false; $('.scrollhint', this.el).hidden = true; });
    if (this.back) { const b = this.back; b.then(() => { if (this.back === b) this.back = null; this.send(d); }); return; }
    this.send(d);
  }
  ctl(o) { this.send('\x00' + JSON.stringify(o)); }
  connect() {
    clearTimeout(this.timer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    const u = new URL('/ws', origin());
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
      if (this.retry === 1) await failover(); // the address may have changed (another network, Tailscale): try the others
      if (this.ws !== ws) return;
      this.timer = setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.retry++));
    };
  }
  setConn(state) {
    this.conn = state;
    // stays up through retry attempts, so it doesn't flicker
    const b = $('.banner', this.el);
    if (state === 'ok') b.hidden = true;
    if (state === '') { b.hidden = false; $('span', b).textContent = this.retry > 2 ? `Can't reach ${new URL(origin()).host}. Retrying…` : 'Reconnecting…'; }
    if (this === focused()) renderConn();
  }
  dispose() {
    clearTimeout(this.timer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    const hd = $('#t-head', this.el); if (hd) { $('#t-ask').hidden = true; $('#term .tmain').before(hd); }
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

const layoutKey = () => `layout:${cfg()?.base}`;
function layout() {
  const g = $('#terms');
  if (T.panes.length < 2) T.zoom = false;
  g.dataset.n = T.zoom ? 1 : T.panes.length;
  g.dataset.arr = T.arr || 'main';
  g.classList.toggle('zoom', !!T.zoom);
  // remembered, so leaving the terminal and coming back (or reloading) brings the same views back
  if (T.panes.length && !$('#term').hidden) store.set(layoutKey(), { slots: T.panes.map((p) => [p.s, p.win?.index ?? p.w0 ?? null]), arr: T.arr || 'main' });
  for (const [i, p] of T.panes.entries()) {
    p.el.classList.toggle('focus', i === T.focus && T.panes.length > 1);
    $('.tph', p.el).hidden = T.panes.length < 2;
  }
  requestAnimationFrame(() => T.panes.forEach((p) => { try { p.fit.fit(); } catch {} }));
  $('#btn-split').setAttribute('aria-label', T.panes.length > 1 ? `Layout: ${T.panes.length} views` : 'Layout');
}
const canSplit = () => !(touch && innerWidth < 768);
$('#t-where').addEventListener('click', (e) => { if (T.panes.length > 1) slotMenu(focused(), e.currentTarget); else if (narrow()) openPalette(); });
const narrow = () => innerWidth < 700;
function toggleZoom() { T.zoom = !T.zoom && T.panes.length > 1; layout(); }
// what a view shows can be changed, moved or closed from its own header
function slotMenu(p, anchor) {
  const i = T.panes.indexOf(p);
  setFocus(i);
  menu(anchor, [
    { label: 'Show something else here…', icon: 'terminal', run: () => pickWindow('Show in this view', (s, w) => showIn(i, s, w), shownNote) },
    { label: 'Move left', icon: 'left', disabled: i === 0, run: () => moveSlot(i, -1) },
    { label: 'Move right', icon: 'right', disabled: i === T.panes.length - 1, run: () => moveSlot(i, 1) },
    { label: T.zoom ? 'Show all views' : 'Zoom this view', icon: 'columns', run: toggleZoom },
    '-',
    { label: 'Close this view', icon: 'x', run: () => closePane(p) },
  ]);
}
function swapSlots(i, j) {
  const ps = T.panes; if (i === j || !ps[i] || !ps[j]) return;
  [ps[i], ps[j]] = [ps[j], ps[i]];
  for (const p of ps) $('#terms').appendChild(p.el); // DOM order = slot order
  T.focus = j; layout(); renderTermBar();
}
const moveSlot = (i, d) => swapSlots(i, i + d);
const shownNote = (s, w) => { const i = T.panes.findIndex((p) => p.s === s && p.win?.index === w); return i < 0 ? '' : T.panes.length > 1 ? `showing in view ${i + 1}` : 'showing now'; };
// put a window in view i; if it already shows in another view, the two swap
function showIn(i, s, w) {
  const j = T.panes.findIndex((p) => p.s === s && (w == null || p.win?.index === w));
  if (j === i) return setFocus(i);
  if (j >= 0) { swapSlots(j, i); return; }
  T.focus = i; replaceFocused(s, w);
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
  morph(rowOf(name), () => {
    for (const p of T.panes) p.dispose();
    T.panes = []; T.focus = 0; T.zoom = false;
    $('#wall').hidden = true; $('#term').hidden = false;
    const saved = store.get(layoutKey(), null);
    const slots = (saved?.slots || []).filter(([s]) => findSess(s)).slice(0, MAX_PANES);
    T.arr = saved?.arr || 'main';
    if (slots.length > 1 && canSplit() && slots.some(([s]) => s === name)) {
      for (const [s, wi] of slots) addPane(s, s === name && w != null ? w : wi ?? undefined);
      setFocus(slots.findIndex(([s]) => s === name));
    } else addPane(name, w);
    syncVolume();
    return focused()?.el;
  });
  keepAwake(true);
}
const rowOf = (name) => name && $(`#grid .card[data-s="${CSS.escape(name)}"]`);
// one element morphs into another across the page change (View Transitions); plain swap without support or with reduced motion
function morph(from, update) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return update();
  if (from) from.style.viewTransitionName = 'sess';
  let to = null;
  const vt = document.startViewTransition(() => { if (from) from.style.viewTransitionName = ''; to = update(); if (to) to.style.viewTransitionName = 'sess'; });
  vt.finished.finally(() => { if (to) to.style.viewTransitionName = ''; });
}

// ---------- session tabs: sessions you have open, one tap apart ----------
const tabsKey = () => `tabs:${cfg()?.base}`;
const openTabs = () => store.get(tabsKey(), []);
const saveTabs = (l) => { store.set(tabsKey(), l); renderSessTabs(); };
function addTab(name) { const l = openTabs(); if (!l.includes(name)) saveTabs([...l, name].slice(-12)); }
// the focused view shows another session; the others in a split stay as they are
function switchTo(name, w, push = false) {
  const old = focused();
  if (!old) return addPane(name, w);
  const j = T.panes.findIndex((p) => p.s === name && (w == null || p.win?.index === w));
  if (j >= 0) { if (j !== T.focus) setFocus(j); if (T.zoom) layout(); return; }
  if (push) history.pushState({ term: name, w }, ''); else history.replaceState({ term: name, w }, '');
  replaceFocused(name, w);
}
function replaceFocused(name, w) {
  const old = focused();
  addTab(name);
  const p = new Pane(name, w);
  p.mount($('#terms'), old.el);
  old.dispose(); T.panes[T.focus] = p;
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
    const s = findSess(n), on = n === cur, shown = !on && T.panes.some((p) => p.s === n);
    const unread = !on && s && s.activity > (lastSeen[`s:${n}`] || 0) && lastSeen[`s:${n}`] !== undefined;
    return `<div class="stab ${on ? 'on' : ''} ${shown ? 'shown' : ''} ${unread ? 'unread' : ''}"><button class="stab-b" draggable="${!touch}" data-s="${esc(n)}" aria-current="${on}" ${on ? `title="${narrow() ? 'Tap for every session' : 'Long-press or right-click for more'}"` : ''}>
      <span class="dot ${s ? sessState(s) : 'dead'}"></span><span class="n">${esc(n)}</span>${on && narrow() ? '<span class="chev" aria-hidden="true">▾</span>' : ''}</button>${on ? `<button class="stab-x" data-x="${esc(n)}" aria-label="Close tab ${esc(n)}">${icon('x')}</button>` : ''}</div>`;
  }).join('');
  if ($('#t-stabs').dataset.sig === html) return;
  $('#t-stabs').dataset.sig = html; $('#t-stabs').innerHTML = html;
  $('#t-stabs .stab.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
$('#t-stabs').addEventListener('click', (e) => {
  const x = e.target.closest('[data-x]'); if (x) return closeTab(x.dataset.x);
  const b = e.target.closest('[data-s]'); if (!b) return;
  if (b.dataset.s === focused()?.s && narrow()) return openPalette();
  switchTo(b.dataset.s);
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
  const anchor = e.currentTarget;
  menu(anchor, [...rest.map((s) => ({ label: s.name, sub: whereText(activeWin(s)), icon: s.windows.some((w) => w.prompt) ? 'spark' : 'terminal', run: () => openTerm(s.name) })),
    ...(rest.length ? ['-'] : []), { label: `New window in ${focused()?.s}…`, icon: 'plus', disabled: !focused(), run: () => setTimeout(() => newWindowMenu(anchor), 0) },
    { label: 'New session…', icon: 'plus', run: () => openNew() }]);
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
  addTab(name); T.zoom = false;
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
  const name = focused()?.s;
  morph(focused()?.el, () => {
    for (const p of T.panes) p.dispose();
    T.panes = [];
    $('#term').hidden = true; $('#wall').hidden = false;
    document.body.classList.remove('rail');
    syncVolume();
    return rowOf(name);
  });
  keepAwake(false);
  refresh().then(refreshPreviews);
}
$('#btn-back').addEventListener('click', () => history.state?.term ? history.back() : closeTerm());
addEventListener('popstate', () => { if ($('#term').hidden) return; const st = history.state; if (st?.term && T.panes.length) switchTo(st.term, st.w ?? undefined); else closeTerm(); });
$('#btn-split').addEventListener('click', (e) => {
  const n = T.panes.length;
  menu(e.currentTarget, [
    { label: 'Add a view beside…', icon: 'columns', disabled: n >= MAX_PANES || !canSplit(), sub: canSplit() ? `up to ${MAX_PANES}` : 'on a wider screen', run: () => pickWindow('Show beside', (s, w) => addPane(s, w), shownNote) },
    ...(n > 2 ? ['-', { label: 'Big view and a stack', checked: (T.arr || 'main') === 'main', run: () => { T.arr = 'main'; layout(); } },
      { label: 'Side by side', checked: T.arr === 'cols', run: () => { T.arr = 'cols'; layout(); } }] : []),
    ...(n > 1 ? ['-', { label: T.zoom ? 'Show all views' : 'Zoom the focused view', icon: 'columns', run: toggleZoom },
      { label: 'Back to one view', icon: 'x', run: () => { for (const p of T.panes.filter((x) => x !== focused())) closePane(p); } }] : []),
    '-', { label: document.body.classList.contains('focusmode') ? 'Show the toolbars' : 'Hide the toolbars (focus mode)', icon: 'layers', run: () => setFocusMode(!document.body.classList.contains('focusmode')) },
  ]);
});
function setFocusMode(on) { document.body.classList.toggle('focusmode', on); store.set('focusmode', on); layout(); }
document.body.classList.toggle('focusmode', store.get('focusmode', false));
$('#btn-unfocus').addEventListener('click', () => setFocusMode(false));

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
  return out.sort((a, b) => a.s.name.localeCompare(b.s.name) || a.w.index - b.w.index || a.p.index - b.p.index);
}
function renderAgents() {
  const list = allAgents(), cur = focused();
  const n = list.filter((a) => a.state === 'blocked').length;
  $('#t-agents-n').hidden = !n; $('#t-agents-n').textContent = n;
  const shells = S.sessions.filter((s) => !s.windows.some((w) => (w.panes || []).some((p) => p.agent))).sort((a, b) => a.name.localeCompare(b.name));
  $('#btn-agents').hidden = !list.length && !shells.length;
  const show = (list.length > 0 || shells.length > 0) && agentsOpen();
  $('#t-agents').hidden = !show; $('#btn-agents').setAttribute('aria-expanded', String(show));
  document.body.classList.toggle('rail', show && wide.matches);
  // with three or more views the panel folds to its state dots, so the terminals keep their width
  $('#t-agents').classList.toggle('mini', wide.matches && T.panes.length >= 3);
  if (!show) return;
  const sig = JSON.stringify([list.map((a) => [a.p.id, a.state, a.p.prompt?.question, a.p.status?.last, a.w.name]), shells.map((s) => [s.name, s.windows.some((w) => w.running)]), cur?.s, cur?.win?.index, T.panes.map((p) => p.s), T.panes.length >= 3]);
  if ($('#t-agents').dataset.sig === sig) return;
  $('#t-agents').dataset.sig = sig;
  $('#t-agents').innerHTML = `<h2 class="small muted">Agents</h2><ul>${list.map((a) => `<li><button draggable="true" class="ag ag-${a.state} ${T.panes.some((x) => x.s === a.s.name) ? 'shown' : ''}" title="${esc(`${a.agent} ${a.s.name}: ${AG_LABEL[a.state]}`)}" data-s="${esc(a.s.name)}" data-w="${a.w.index}" data-p="${a.p.index}"
    aria-current="${cur?.s === a.s.name && cur?.win?.index === a.w.index}">
    <span class="dot"></span><span class="ag-t"><b>${esc(a.agent)}</b> <span class="muted">${esc(a.s.name)}${a.s.windows.length > 1 ? ` › ${esc(a.w.name)}` : ''}</span></span>
    <span class="ag-st">${AG_LABEL[a.state]} · ${ago(a.since / 1000)}</span>
    ${a.p.prompt?.question || a.p.status?.last ? `<span class="ag-l">${esc(a.p.prompt?.question || a.p.status.last)}</span>` : ''}</button></li>`).join('')}</ul>
    ${shells.length ? `<h2 class="small muted">Other sessions</h2><ul>${shells.map((s) => { const w = activeWin(s); return `<li><button draggable="true" class="ag ag-shell ${T.panes.some((x) => x.s === s.name) ? 'shown' : ''}" title="${esc(s.name)}" data-s="${esc(s.name)}" data-w="${w.index}" data-p="${activePane(w).index}" aria-current="${cur?.s === s.name}">
    <span class="dot ${s.windows.some((x) => x.running) ? 'run' : ''}"></span><span class="ag-t"><b>${esc(s.name)}</b> <span class="muted">${esc(activePane(w).cmd || 'shell')}</span></span></button></li>`; }).join('')}</ul>` : ''}`;
}
$('#btn-agents').addEventListener('click', () => {
  if (wide.matches) store.set('agentsPanel', !store.get('agentsPanel', true));
  else {
    const open = !agentsOpen();
    $('#btn-agents').setAttribute('aria-expanded', String(open));
    if (open) agentsBack = onBack(closeAgents); else { agentsBack?.(); agentsBack = null; }
  }
  $('#t-agents').dataset.sig = ''; renderAgents(); layout();
});
let agentsBack = null;
function closeAgents() { agentsBack = null; $('#btn-agents').setAttribute('aria-expanded', 'false'); $('#t-agents').hidden = true; layout(); }
addEventListener('keydown', (e) => { if (e.key === 'Escape' && agentsBack && !wide.matches && !document.querySelector('dialog[open], .menu')) { e.preventDefault(); agentsBack(); closeAgents(); } }, true); // capture: xterm swallows Esc
$('#t-agents').addEventListener('click', async (e) => {
  const b = e.target.closest('.ag'); if (!b) return;
  if (!wide.matches && agentsBack) { agentsBack(); closeAgents(); }
  await act(`${W(b.dataset.s, `${b.dataset.w}.${b.dataset.p}`)}/select`).catch(() => {}); // land on the agent's pane, not just its window
  if ($('#term').hidden || !T.panes.length) openTerm(b.dataset.s, +b.dataset.w); else { addTab(b.dataset.s); switchTo(b.dataset.s, +b.dataset.w, !wide.matches); }
  refresh();
});
wide.addEventListener('change', () => { $('#t-agents').dataset.sig = ''; renderAgents(); });

export function renderTermBar() {
  renderAgents();
  const p = focused(); if (!p) return;
  // toolbar and question sit inside the focused view, so moving focus never shifts the other views
  if ($('#t-head').parentElement !== p.el) { $('.tph', p.el).after($('#t-head')); $('#t-ask').dataset.sig = ''; }
  const s = p.sess, w = p.win;
  renderSessTabs();
  for (const x of T.panes) {
    const st = x.win?.prompt ? 'blocked' : x.win?.panes?.find((q) => q.agent)?.agent.state || (x.win?.running ? 'running' : '');
    $('.tps', x.el).textContent = st === 'blocked' ? 'needs you' : st; $('.tps', x.el).className = `tps st-${st}`;
    $('.tpn', x.el).textContent = `${x.s} › ${x.win?.name ?? ''}${x.win ? ` · ${whereText(x.win)}` : ''}`; if (x.view && x.sess?.views[x.view] != null) x.wIdx = x.sess.views[x.view]; }
  if (!s || !w) return;
  $('#term .termbar').hidden = s.windows.length < 2;
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
  else if (ap.preset) { tg.textContent = `Start ${ap.preset.split(' ')[0].split('/').pop()}`; tg.className = 'btn sm run'; tg.dataset.a = 'start'; }
  else { tg.textContent = 'Run…'; tg.className = 'btn sm'; tg.dataset.a = 'run'; }
  tg.title = ap.preset || '';
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
      ab.innerHTML = `<div class="aq"><span class="dot ask-dot"></span>${esc(asking.prompt.question)}${asking.prompt.context ? `<code class="actx">${esc(asking.prompt.context)}</code>` : ''}</div><div class="aopts">${asking.prompt.options.map((o) =>
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
$('#btn-addwin').addEventListener('click', (e) => newWindowMenu(e.currentTarget));
function newWindowMenu(anchor) {
  const p = focused(); if (!p) return;
  const cwd = p.win ? activePane(p.win).cwd : '';
  menu(anchor, [
    { label: 'Claude Code…', icon: 'spark', sub: 'new, continue or resume', run: () => openAgent({ kind: 'claude', s: p.s, cwd, where: 'window' }) },
    { label: 'Codex…', icon: 'target', sub: 'new, continue or resume', run: () => openAgent({ kind: 'codex', s: p.s, cwd, where: 'window' }) },
    '-',
    ...presetItems(async (pr) => {
      await act(`/api/sessions/${encodeURIComponent(p.s)}/windows`, { preset: pr.id }); toast(`Opened ${pr.label}`); refresh();
    }), '-', { label: 'In another folder…', icon: 'folder', run: () => openNew('window', p.s) }]);
}

const renameWin = (value) => ask({ title: 'Rename window', label: 'Name', value, ok: 'Rename', validate: (v) => v ? '' : 'Enter a name.' });
const cur = () => { const p = focused(); const w = p?.win; return w && { p, w, ap: activePane(w), t: W(p.s, w.index) }; };
$('#w-toggle').addEventListener('click', async (e) => {
  const c = cur(); if (!c) return;
  const a = e.currentTarget.dataset.a;
  if (a === 'stop') { if (!await ask({ title: `Stop ${c.ap.cmd}?`, message: 'Sends Ctrl+C. The session and its shell stay open.', ok: 'Stop', danger: true })) return; await act(`${c.t}/stop`); toast(`Sent stop to ${c.ap.cmd}`); }
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
  if (c.ap.running && !await ask({ title: `Restart ${c.ap.cmd}?`, message: 'Sends Ctrl+C, then runs the command again.', ok: 'Restart', danger: true })) return;
  if (c.ap.running) { await act(`${c.t}/stop`); await new Promise((r) => setTimeout(r, 900)); }
  await act(`${c.t}/start`); toast(`Restarted ${c.ap.preset}`); setTimeout(refresh, 700);
});
$('#w-panes').addEventListener('click', (e) => panesMenu(e.currentTarget));
function panesMenu(anchor) {
  const c = cur(); if (!c) return;
  const pane = (action) => async () => { await act(`${c.t}/pane`, { action }); refresh(); };
  const split = (dir) => () => menu(anchor, presetItems(async (pr) => { await act(`${c.t}/split`, { dir, preset: pr.id }); refresh(); }));
  menu(anchor, [
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
}
// narrow views fold the less-used tools into ⋯ (container query decides which show inline)
$('#w-more').addEventListener('click', (e) => {
  const a = e.currentTarget, click = (id) => () => $(id).click();
  menu(a, [
    ...(!$('#w-restart').hidden ? [{ label: 'Restart', icon: 'refresh', run: click('#w-restart') }] : []),
    { label: 'Panes…', icon: 'columns', run: () => setTimeout(() => panesMenu(a), 0) },
    { label: 'Snippets…', icon: 'terminal', run: () => setTimeout(() => snippets(a), 0) },
    { label: 'Attach a file', icon: 'plus', run: click('#attach') },
    ...(!$('#mic').hidden ? [{ label: 'Dictate', icon: 'spark', run: click('#mic') }] : []),
    { label: 'Find in output', icon: 'search', run: click('#w-find') },
    { label: 'Scroll back', icon: 'left', run: click('#w-scroll') },
    '-',
    { label: 'Smaller text', run: click('#w-font-dec') }, { label: 'Larger text', run: click('#w-font-inc') },
    '-',
    { label: 'Close window', icon: 'trash', danger: true, run: click('#w-kill') },
  ]);
});
// drag a session (tab or Agents row) onto a view: the middle shows it there, the left/right edge adds a view on that side
let dragDrop = null;
const dragData = (e) => { try { return JSON.parse(e.dataTransfer.getData('text/x-tmuxlab')); } catch { return null; } };
document.addEventListener('dragstart', (e) => {
  const b = e.target.closest?.('#t-agents .ag, #t-stabs .stab-b'); if (!b) return;
  e.dataTransfer.setData('text/x-tmuxlab', JSON.stringify({ s: b.dataset.s, w: b.dataset.w != null ? +b.dataset.w : null }));
  e.dataTransfer.effectAllowed = 'copy'; document.body.classList.add('dragging');
});
document.addEventListener('dragend', () => { document.body.classList.remove('dragging'); for (const x of $$('.tpane[data-drop]')) delete x.dataset.drop; });
$('#terms').addEventListener('dragover', (e) => {
  const el = e.target.closest('.tpane'); if (!el || !e.dataTransfer.types.includes('text/x-tmuxlab')) return;
  e.preventDefault();
  const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
  const zone = T.panes.length < MAX_PANES && canSplit() ? (x < .22 ? 'left' : x > .78 ? 'right' : 'here') : 'here';
  for (const o of $$('.tpane[data-drop]')) if (o !== el) delete o.dataset.drop;
  el.dataset.drop = zone; dragDrop = { el, zone };
});
$('#terms').addEventListener('dragleave', (e) => { if (!e.relatedTarget || !$('#terms').contains(e.relatedTarget)) for (const x of $$('.tpane[data-drop]')) delete x.dataset.drop; });
$('#terms').addEventListener('drop', (e) => {
  const d = dragData(e); if (!d || !dragDrop) return;
  e.preventDefault(); delete dragDrop.el.dataset.drop;
  const i = T.panes.findIndex((p) => p.el === dragDrop.el), w = d.w ?? undefined;
  if (dragDrop.zone === 'here') return showIn(i, d.s, w);
  if (T.panes.some((p) => p.s === d.s && (w == null || p.win?.index === w))) return toast(`${d.s} is already on screen: drop it in the middle of a view to swap`);
  addPane(d.s, w);
  const to = dragDrop.zone === 'left' ? i : i + 1;
  for (let k = T.panes.length - 1; k > to; k--) swapSlots(k, k - 1);
  setFocus(to);
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
// app chrome: dark (default), light, or follow the system
export function setUi(v) { document.documentElement.dataset.ui = ['light', 'auto'].includes(v) ? v : 'dark'; store.set('ui', document.documentElement.dataset.ui); }
document.documentElement.dataset.ui = store.get('ui', 'dark');

// ---------- volume buttons (Android app): up and down scroll the terminal ----------
// The app asks Android to hand the volume keys to the page only while a terminal is open and the setting is on.
export const syncVolume = () => { try { window.TmuxlabNative?.setVolumeScroll(!$('#term').hidden && store.get('volScroll', true)); } catch {} };
window.tlVolume = (dir) => { const p = focused(); if (p) queueScroll(p, (dir === 'up' ? -1 : 1) * Math.max(3, Math.floor(p.term.rows / 2))); };
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
  // Termius-style gestures: long-press then drag = arrow keys (further = faster, hold = repeat); long-press and let go =
  // select the word (or a Paste menu on empty space); double-tap = Tab; three-finger tap = paste
  let hold = null, press = null, tapAt = 0, three = 0, downAt = 0, moved = 0, x0 = 0, ty0 = 0;
  const el = $('.tbody', p.el);
  el.addEventListener('contextmenu', (e) => { if (touch) e.preventDefault(); }); // a long-press is ours
  const stopHold = () => { clearTimeout(press); press = null; if (hold) { clearInterval(hold.tick); hold = null; } };
  const pasteClip = () => (navigator.clipboard?.readText ? navigator.clipboard.readText().then((t) => t && paste(t), () => toast('Allow clipboard access to paste', true))
    : toast('Pasting from here needs https or the app', true));
  function holdMenu(x, y) { // a word under the finger gets selected; the menu offers Copy and Paste
    const t = p.term, b = $('.xterm-screen', p.el).getBoundingClientRect(), buf = t.buffer.active;
    const col = Math.floor((x - b.left) / (b.width / t.cols)), row = Math.floor((y - b.top) / (b.height / t.rows)) + buf.viewportY;
    const line = buf.getLine(row)?.translateToString(true) ?? '';
    let a = col, z = col;
    if (line[col] && /\S/.test(line[col])) { while (a > 0 && /\S/.test(line[a - 1])) a--; while (z < line.length - 1 && /\S/.test(line[z + 1])) z++; t.select(a, row, z - a + 1); }
    const anchor = { getBoundingClientRect: () => ({ left: x, top: y, bottom: y }), setAttribute() {}, isConnected: false };
    menu(anchor, [...(t.hasSelection() ? [{ label: 'Copy', run: () => { copyText(t.getSelection()); t.clearSelection(); } },
      { label: 'Select line', run: () => t.selectLines(row, row) }] : []), { label: 'Paste', run: pasteClip }]);
  }
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
    cancelAnimationFrame(fling); stopHold();
    if (e.touches.length === 3) { three = performance.now(); y0 = null; pinch = null; return; }
    if (e.touches.length === 2) { pinch = { d: dist(e.touches), size: T.fontSize }; y0 = null; three = 0; }
    else if (e.touches.length === 1) {
      y0 = ty0 = e.touches[0].clientY; x0 = e.touches[0].clientX; acc = 0; moved = 0; downAt = performance.now(); samples = [[downAt, y0]];
      press = setTimeout(() => { // held still: from here the finger steers the cursor instead of scrolling
        press = null; y0 = null; vibrate();
        hold = { x: x0, y: ty0, cx: x0, cy: ty0, sent: false, last: 0 };
        hold.tick = setInterval(() => {
          const dx = hold.cx - hold.x, dy = hold.cy - hold.y, d = Math.hypot(dx, dy), now = performance.now();
          if (d < 16 || now - hold.last < (d < 48 ? 260 : d < 96 ? 100 : 35)) return; // three gears
          hold.last = now; hold.sent = true;
          const k = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'C' : 'D') : (dy > 0 ? 'B' : 'A');
          sendInput(`\x1b${p.term.modes.applicationCursorKeysMode ? 'O' : '['}${k}`); vibrate(4);
        }, 30);
      }, 450);
    }
  }, o);
  el.addEventListener('touchmove', (e) => {
    if (hold) { hold.cx = e.touches[0].clientX; hold.cy = e.touches[0].clientY; return; }
    if (press && Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - ty0) > 10) { clearTimeout(press); press = null; } // a drag, not a press
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
    if (three && performance.now() - three < 600) { three = 0; vibrate(); pasteClip(); return; }
    three = 0;
    if (hold) { const h = hold; stopHold(); if (!h.sent) setTimeout(() => holdMenu(h.cx, h.cy), 120); return; } // after the browser's own mouse events, which clear a selection
    if (press) { // a quick tap: two in a row send Tab
      stopHold(); const now = performance.now();
      if (now - downAt < 250 && !e.touches.length) { if (now - tapAt < 320) { tapAt = 0; sendInput('\t'); vibrate(); } else tapAt = now; }
    }
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
export const sendInput = (d) => focused()?.input(d);
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
