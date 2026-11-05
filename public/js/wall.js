// The session wall: live previews, status, approvals, machine stats.
import { $, $$, esc, S, api, act, W, toast, ago, bytes, home, winState, activeWin, activePane, findSess, menu, presetItems, cfg, saveMachines } from './core.js';
import { openTerm, renderTermBar } from './term.js';
import { openNew, openChanges, openPalette, openSettings, openSchedules } from './sheets.js';
import { start, addMachine } from './main.js';

const seenPrompts = new Set();
let primed = false; // prompts already waiting when the app opens don't pop up
export async function refresh() {
  try { S.sessions = await api('/api/sessions'); } catch { return; }
  // tell the user about new questions from agents (phone alerts cover the app being closed)
  for (const s of S.sessions) for (const w of s.windows) for (const p of w.panes || []) {
    const k = `${s.name}:${w.index}.${p.index}:${p.prompt?.question}`;
    if (p.prompt && !seenPrompts.has(k)) {
      seenPrompts.add(k);
      if (primed) toast(`${s.name} › ${w.name}: ${p.prompt.question}`, false, { action: 'Open', run: () => openTerm(s.name) });
    }
  }
  primed = true;
  if (!$('#wall').hidden) renderWall();
  if (!$('#term').hidden) renderTermBar();
}

export async function refreshStats() {
  if ($('#wall').hidden || document.hidden) return;
  try { S.stats = await api('/api/stats'); } catch { return; }
  renderStats();
  for (const card of $$('#grid .card')) {
    const st = S.stats.sessions[card.dataset.s];
    $('.use', card).textContent = st ? `${Math.round(st.cpu)}% CPU · ${bytes(st.rss)}` : '';
  }
}

function renderStats() {
  const all = S.sessions, m = S.stats?.machine;
  const runs = all.flatMap((s) => s.windows).filter((w) => w.running).length;
  const waiting = all.flatMap((s) => s.windows).filter((w) => w.prompt).length;
  $('#stats').innerHTML = `<span><b>${all.length}</b> sessions</span><span class="r"><b>${runs}</b> running</span>
    ${waiting ? `<span class="q"><b>${waiting}</b> waiting for you</span>` : ''}
    ${m ? `<span class="mstat" title="${m.cores} cores, load ${m.load.toFixed(2)}">CPU <b>${m.cpu == null ? '…' : Math.round(m.cpu) + '%'}</b></span>
    <span class="mstat">RAM <b>${bytes(m.mem.used)}</b> / ${bytes(m.mem.total)}</span>
    ${m.disk ? `<span class="mstat ${m.disk.used / m.disk.total > 0.9 ? 'warn' : ''}">Disk <b>${Math.round(100 * m.disk.used / m.disk.total)}%</b></span>` : ''}` : ''}`;
}

export async function refreshPreviews() {
  if ($('#wall').hidden || document.hidden) return;
  const list = visible().slice(0, 24);
  await Promise.all(list.map(async (s) => {
    const w = activeWin(s);
    try { S.previews[s.name] = (await api(`${W(s.name, w.index)}/capture?lines=14`)).text.replace(/\s+$/, ''); } catch {}
  }));
  for (const s of list) {
    const pre = document.querySelector(`.card[data-s="${CSS.escape(s.name)}"] pre`);
    if (pre && pre.textContent !== S.previews[s.name]) pre.textContent = S.previews[s.name] ?? '';
  }
}

const visible = () => S.sessions.filter((s) => S.filter === 'all' ||
  (S.filter === 'running' ? s.windows.some((w) => w.running) : S.filter === 'waiting' ? s.windows.some((w) => w.prompt) : !s.windows.some((w) => w.running)));

function promptHtml(s, w) {
  const p = w.panes.find((x) => x.prompt);
  return `<div class="ask" data-t="${w.index}.${p.index}"><div class="aq"><span class="dot ask-dot"></span><b>${esc(w.name)}</b> ${esc(p.prompt.question)}</div>
    <div class="aopts">${p.prompt.options.map((o) => `<button class="btn sm ${o.n === 1 ? 'primary' : ''}" data-n="${o.n}" title="${esc(o.label)}">${o.n}. ${esc(o.label.length > 34 ? o.label.slice(0, 32) + '…' : o.label)}</button>`).join('')}</div></div>`;
}

export function renderWall() {
  renderStats();
  $('#machine-name').textContent = cfg()?.name || (S.info ? `${S.info.user}@${S.info.host}` : '');
  $('#empty').hidden = S.sessions.length > 0;
  const grid = $('#grid');
  const list = visible();
  const keep = new Set(list.map((s) => s.name));
  for (const c of [...grid.children]) if (!keep.has(c.dataset.s)) c.remove();
  list.forEach((s, i) => {
    let card = grid.querySelector(`.card[data-s="${CSS.escape(s.name)}"]`);
    if (!card) {
      card = document.createElement('article');
      card.className = 'card';
      card.dataset.s = s.name;
      card.innerHTML = `<div class="card-h"></div><div class="wins"></div><div class="asks"></div>
        <div class="screen" role="button" tabindex="0" aria-label="Open ${esc(s.name)}"><span class="path"></span><pre></pre></div>
        <div class="card-f"></div>`;
      $('pre', card).textContent = S.previews[s.name] ?? '';
    }
    if (grid.children[i] !== card) grid.insertBefore(card, grid.children[i] || null);
    const aw = activeWin(s);
    const rp = aw.panes.find((x) => x.running && x.active) || aw.panes.find((x) => x.running); // Stop targets the pane that runs something
    const hasRun = s.windows.some((w) => w.running);
    const asks = s.windows.filter((w) => w.prompt);
    card.classList.toggle('has-run', hasRun);
    card.classList.toggle('has-ask', asks.length > 0);
    const sig = JSON.stringify([s.windows, s.attached, ago(s.activity)]);
    if (card.dataset.sig === sig) return;
    card.dataset.sig = sig;
    const st = S.stats?.sessions[s.name];
    $('.card-h', card).innerHTML = `<span class="dot ${hasRun ? 'run' : ''}"></span><h3>${esc(s.name)}</h3>
      ${aw.branch ? `<span class="branch" title="git branch">⎇ ${esc(aw.branch)}</span>` : ''}
      <span class="when">${s.attached ? `<span class="att">${s.attached} viewing</span> · ` : ''}${ago(s.activity)}</span>`;
    $('.wins', card).innerHTML = s.windows.map((w) => `<button class="win ${w.active ? 'active' : ''}" data-w="${w.index}" title="${esc(w.cmd)}">
      <span class="dot ${w.prompt ? 'ask-dot' : winState(w)}"></span>${esc(w.name)}${w.panes.length > 1 ? `<span class="c">${w.panes.length} panes</span>` : w.running ? `<span class="c">${esc(w.cmd)}</span>` : ''}</button>`).join('');
    $('.asks', card).innerHTML = asks.map((w) => promptHtml(s, w)).join('');
    $('.path', card).textContent = home(aw.cwd);
    $('.card-f', card).innerHTML = `<button class="btn sm primary" data-a="open">Open</button>
      ${rp ? `<button class="btn sm ghost danger" data-a="stop" data-t="${aw.index}.${rp.index}">Stop ${esc(rp.cmd)}</button>`
        : aw.preset ? `<button class="btn sm run" data-a="start" title="${esc(aw.preset)}">Start ${esc(aw.preset.split(' ')[0])}</button>` : ''}
      <span class="use">${st ? `${Math.round(st.cpu)}% CPU · ${bytes(st.rss)}` : ''}</span>
      <button class="btn sm ghost icon" data-a="more" aria-haspopup="menu" aria-label="More actions for ${esc(s.name)}">⋯</button>`;
  });
}

$('#grid').addEventListener('click', async (e) => {
  const card = e.target.closest('.card'); if (!card) return;
  const s = findSess(card.dataset.s); if (!s) return;
  const ask = e.target.closest('.ask [data-n]');
  if (ask) { await act(`${W(s.name, ask.closest('.ask').dataset.t)}/choose`, { n: +ask.dataset.n }); toast('Answered'); return setTimeout(refresh, 500); }
  const wb = e.target.closest('.win');
  if (wb) { await act(`${W(s.name, wb.dataset.w)}/select`); return refresh().then(refreshPreviews); }
  if (e.target.closest('.screen')) return openTerm(s.name);
  const a = e.target.closest('[data-a]')?.dataset.a;
  const aw = activeWin(s);
  if (a === 'open') openTerm(s.name);
  else if (a === 'stop') { const b = e.target.closest('[data-a]'); await act(`${W(s.name, b.dataset.t)}/stop`); toast(`Sent ${b.textContent.toLowerCase()}`); setTimeout(refresh, 600); }
  else if (a === 'start') { await act(`${W(s.name, aw.index)}/start`); toast(`Started ${aw.preset}`); setTimeout(refresh, 600); }
  else if (a === 'more') menu(e.target.closest('button'), [
    { label: 'New window', icon: '+', run: () => menu(e.target.closest('button'), presetItems(async (p) => {
      await act(`/api/sessions/${encodeURIComponent(s.name)}/windows`, { preset: p.id }); toast(`Opened ${p.label}`); refresh();
    })) },
    ...(aw.branch ? [{ label: 'Changes', icon: '±', run: () => openChanges(activePane(aw).cwd) }] : []),
    { label: 'Rename', icon: '✎', run: async () => {
      const to = prompt('Rename session (letters, digits, - _ .)', s.name);
      if (to && to !== s.name) { await act(`/api/sessions/${encodeURIComponent(s.name)}/rename`, { to }); refresh(); }
    } },
    '-',
    { label: 'End session', icon: '✕', danger: true, run: async () => {
      if (!confirm(`End session "${s.name}"? Everything running in it stops.`)) return;
      await act(`/api/sessions/${encodeURIComponent(s.name)}`, null, 'DELETE'); toast(`Ended ${s.name}`); refresh();
    } },
  ]);
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
$('#btn-new').addEventListener('click', () => openNew());
$('#empty [data-new]').addEventListener('click', () => openNew());
$('#btn-palette').addEventListener('click', () => openPalette());
$('#btn-settings').addEventListener('click', () => openSettings());
$('#btn-sched').addEventListener('click', () => openSchedules());

// machine switcher: shows how busy each saved machine is
$('#machine').addEventListener('click', async (e) => {
  const anchor = e.currentTarget;
  const counts = await Promise.all(S.machines.map((m) => api('/api/sessions', { m, timeout: 3000 })
    .then((l) => `${l.length} sessions, ${l.flatMap((s) => s.windows).filter((w) => w.running).length} running`, () => 'offline')));
  menu(anchor, [
    ...S.machines.map((m, i) => ({ label: m.name || new URL(m.base).host, sub: `${new URL(m.base).host} · ${counts[i]}`, checked: i === S.cur,
      run: () => { S.cur = i; saveMachines(); start(); } })),
    '-',
    { label: 'Add machine', icon: '+', run: () => addMachine() },
    { label: 'Rename this machine', icon: '✎', run: () => {
      const n = prompt('Name for this machine', cfg().name || S.info?.host || ''); if (n == null) return;
      cfg().name = n.trim(); saveMachines(); renderWall();
    } },
    { label: 'Remove this machine', icon: '✕', danger: true, run: () => {
      if (!confirm(`Remove ${cfg().name || cfg().base} from this device? Sessions keep running.`)) return;
      S.machines.splice(S.cur, 1); S.cur = 0; saveMachines(); start();
    } },
  ]);
});

document.addEventListener('keydown', (e) => {
  if ($('#wall').hidden || document.querySelector('dialog[open]')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openPalette(); }
  else if (e.key === 'n' && !e.ctrlKey && !e.metaKey && e.target === document.body) { e.preventDefault(); openNew(); }
});
