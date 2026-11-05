// The session wall: live previews, status, approvals, machine stats.
import { $, $$, esc, S, api, act, W, toast, ago, bytes, home, winState, activeWin, activePane, findSess, menu, presetItems, cfg, saveMachines, store, touch, ask, icon, NAME_RULE, busy, whereHtml, whereText, presetIcon, onBack } from './core.js';
import { openTerm, renderTermBar } from './term.js';
import { openNew, openChanges, openPalette, openSettings, openSchedules } from './sheets.js';
import { start, addMachine } from './main.js';

const seenPrompts = new Set();
let fails = 0;
let primed = false; // prompts already waiting when the app opens don't pop up
export async function refresh() {
  try { S.sessions = await api('/api/sessions'); fails = 0; $('#offline').hidden = true; }
  catch { if (++fails >= 2) $('#offline').hidden = false; return; } // one blip isn't worth a banner
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
    $('.use', card).textContent = st ? `${Math.round(st.cpu)}%${card.classList.contains('srow') ? '' : ' CPU'} · ${bytes(st.rss)}` : '';
  }
  if (Date.now() - countsAt > 15000) countMachines();
}

function renderStats() {
  const all = S.sessions, m = S.stats?.machine;
  const runs = all.flatMap((s) => s.windows).filter((w) => w.running).length;
  const waiting = all.flatMap((s) => s.windows).filter((w) => w.prompt).length;
  const n = { all: all.length, running: runs, waiting, idle: all.filter((s) => !s.windows.some((w) => w.running)).length };
  for (const b of $('#filters').children) b.dataset.n = n[b.dataset.f] || '';
  $('#stats').innerHTML = `${m ? `<span class="machine"><span class="mstat" title="${m.cores} cores, load ${m.load.toFixed(2)}">CPU <b>${m.cpu == null ? '…' : Math.round(m.cpu) + '%'}</b></span>
    <span class="mstat" title="${bytes(m.mem.used)} of ${bytes(m.mem.total)}">RAM <b>${Math.round(100 * m.mem.used / m.mem.total)}%</b></span>
    ${m.disk ? `<span class="mstat ${m.disk.used / m.disk.total > 0.9 ? 'warn' : ''}">Disk <b>${Math.round(100 * m.disk.used / m.disk.total)}%</b></span>` : ''}</span>` : ''}`;
}

export async function refreshPreviews() {
  if ($('#wall').hidden || document.hidden) return;
  const list = visible().filter((s) => !S.projects.length || !collapsed.has(projectOf(s))).slice(0, 24);
  await Promise.all(list.map(async (s) => {
    const w = activeWin(s);
    try { S.previews[s.name] = (await api(`${W(s.name, w.index)}/capture?lines=14`)).text.replace(/\s+$/, ''); } catch {}
  }));
  for (const s of list) {
    const pre = document.querySelector(`.card[data-s="${CSS.escape(s.name)}"] pre`);
    if (pre && pre.textContent !== S.previews[s.name]) pre.textContent = S.previews[s.name] ?? '';
  }
}

let view = store.get('view', 'list');
const matches = (s) => { const q = $('#q').value.trim().toLowerCase(); return !q || `${s.name} ${s.windows.map((w) => `${w.name} ${whereText(w)} ${w.branch || ''}`).join(' ')}`.toLowerCase().includes(q); };
const visible = () => S.sessions.filter(matches).filter((s) => S.filter === 'all' ||
  (S.filter === 'running' ? s.windows.some((w) => w.running) : S.filter === 'waiting' ? s.windows.some((w) => w.prompt) : !s.windows.some((w) => w.running)));

function promptHtml(s, w) {
  const p = w.panes.find((x) => x.prompt);
  return `<div class="ask" data-t="${w.index}.${p.index}"><div class="aq"><span class="dot ask-dot"></span><b>${esc(w.name)}</b> ${esc(p.prompt.question)}</div>
    <div class="aopts">${p.prompt.options.map((o) => `<button class="btn sm ${o.n === 1 ? 'primary' : ''}" data-n="${o.n}" title="${esc(o.label)}">${o.n}. ${esc(o.label.length > 34 ? o.label.slice(0, 32) + '…' : o.label)}</button>`).join('')}</div></div>`;
}

const FOLDER = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 014.5 5h4.3l2 2.2h8.7A1.5 1.5 0 0121 8.7v9.8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z" fill="currentColor" opacity=".85"/></svg>';
const collapsed = new Set(store.get('collapsed', []));
export const projectOf = (s) => S.projects.some((p) => p.id === s.project) ? s.project : '';

export function renderWall() {
  renderStats();
  $('#machine-name').textContent = cfg()?.name || (S.info ? `${S.info.user}@${S.info.host}` : '');
  $('#empty').hidden = S.sessions.length > 0 || S.projects.length > 0;
  const grid = $('#grid');
  grid.classList.toggle('list', view === 'list');
  const list = visible();
  $('#noresults').hidden = !$('#q').value.trim() || list.length > 0;
  renderMachines();
  // with projects, the wall is a set of folders; without, just cards
  const nodes = [];
  const item = view === 'list' ? rowFor : cardFor;
  if (!S.projects.length) nodes.push(...list.map(item));
  else {
    for (const p of [...S.projects, { id: '', label: 'No project' }]) {
      const mine = list.filter((s) => projectOf(s) === p.id);
      const total = S.sessions.filter((s) => projectOf(s) === p.id);
      if (!mine.length && (S.filter !== 'all' || $('#q').value.trim() || (!p.id && !total.length))) continue;
      nodes.push(headerFor(p, total));
      if (!collapsed.has(p.id) || $('#q').value.trim()) nodes.push(...mine.map(item));
    }
  }
  const keep = new Set(nodes);
  for (const c of [...grid.children]) if (!keep.has(c)) c.remove();
  nodes.forEach((n, i) => { if (grid.children[i] !== n) grid.insertBefore(n, grid.children[i] || null); });
}

function headerFor(p, sessions) {
  const grid = $('#grid');
  let h = [...grid.children].find((x) => x.dataset.h === p.id);
  if (!h) { h = document.createElement('div'); h.className = 'phead'; h.dataset.h = p.id; }
  const runs = sessions.filter((s) => s.windows.some((w) => w.running)).length;
  const asks = sessions.filter((s) => s.windows.some((w) => w.prompt)).length;
  const open = !collapsed.has(p.id);
  const sig = JSON.stringify([p, sessions.length, runs, asks, open]);
  if (h.dataset.sig === sig) return h;
  h.dataset.sig = sig;
  h.classList.toggle('none', !p.id);
  h.innerHTML = `<button class="pt" data-ptoggle aria-expanded="${open}">${icon('down', 'ico chev')}${p.id ? FOLDER : ''}<b>${esc(p.label)}</b>
      <span class="pc">${sessions.length ? `${sessions.length} session${sessions.length > 1 ? 's' : ''}` : 'empty'}${runs ? ` · <i class="r">${runs} running</i>` : ''}${asks ? ` · <i class="q">${asks} waiting</i>` : ''}</span></button>
    ${p.cwd ? `<span class="pd" title="${esc(home(p.cwd))}"><bdi>${esc(home(p.cwd))}</bdi></span>` : ''}<span class="spacer"></span>
    <button class="btn sm ghost" data-pnew title="New session in ${esc(p.label)}" aria-label="New session in ${esc(p.label)}">${icon('plus')}<span class="lbl">Session</span></button>
    ${p.id ? `<button class="btn sm ghost icon" data-pmore aria-haspopup="menu" aria-label="Project actions for ${esc(p.label)}">${icon('more')}</button>` : ''}`;
  return h;
}

function cardFor(s) {
  const grid = $('#grid');
  let card = grid.querySelector(`.card:not(.srow)[data-s="${CSS.escape(s.name)}"]`);
  if (!card) {
    card = document.createElement('article');
    card.className = 'card';
    card.dataset.s = s.name;
    card.draggable = !touch;
    card.innerHTML = `<div class="card-h"></div><div class="where"></div><div class="wins"></div><div class="asks"></div>
      <div class="screen" role="button" tabindex="0" aria-label="Open ${esc(s.name)}"><pre></pre></div>
      <div class="card-f"></div>`;
    $('pre', card).textContent = S.previews[s.name] ?? '';
  }
  const aw = activeWin(s);
  const rp = aw.panes.find((x) => x.running && x.active) || aw.panes.find((x) => x.running); // Stop targets the pane that runs something
  const hasRun = s.windows.some((w) => w.running);
  const asks = s.windows.filter((w) => w.prompt);
  card.classList.toggle('has-run', hasRun);
  card.classList.toggle('has-ask', asks.length > 0);
  const sig = JSON.stringify([s.windows, s.attached, ago(s.activity)]);
  if (card.dataset.sig === sig) return card;
  card.dataset.sig = sig;
  const st = S.stats?.sessions[s.name];
  $('.card-h', card).innerHTML = `<span class="dot ${hasRun ? 'run' : ''}"></span><h3>${esc(s.name)}</h3>
    <span class="when">${s.attached ? `<span class="att">${s.attached} viewing</span> · ` : ''}${ago(s.activity)}</span>`;
  $('.wins', card).hidden = s.windows.length < 2; // one window: the where-line already says what runs
  $('.wins', card).innerHTML = s.windows.map((w) => `<button class="win ${w.active ? 'active' : ''}" data-w="${w.index}" title="${esc(w.cmd)}">
    <span class="dot ${w.prompt ? 'ask-dot' : winState(w)}"></span>${esc(w.name)}${w.panes.length > 1 ? `<span class="c">${w.panes.length} panes</span>` : w.running && w.cmd !== w.name ? `<span class="c">${esc(w.cmd)}</span>` : ''}</button>`).join('');
  $('.asks', card).innerHTML = asks.map((w) => promptHtml(s, w)).join('');
  $('.where', card).innerHTML = whereHtml(aw);
  $('.card-f', card).innerHTML = `<button class="btn sm primary" data-a="open">Open</button>
    ${rp ? `<button class="btn sm ghost danger" data-a="stop" data-t="${aw.index}.${rp.index}" aria-label="Stop ${esc(rp.cmd)}">Stop</button>`
      : aw.preset ? `<button class="btn sm run" data-a="start" title="${esc(aw.preset)}">Start ${esc(aw.preset.split(' ')[0])}</button>` : ''}
    <span class="use">${st ? `${Math.round(st.cpu)}% CPU · ${bytes(st.rss)}` : ''}</span>
    <button class="btn sm ghost icon" data-a="more" aria-haspopup="menu" aria-label="More actions for ${esc(s.name)}">${icon('more')}</button>`;
  return card;
}

function rowFor(s) {
  let row = $('#grid').querySelector(`.srow[data-s="${CSS.escape(s.name)}"]`);
  if (!row) {
    row = document.createElement('article');
    row.className = 'card srow'; row.dataset.s = s.name; row.draggable = !touch;
    row.innerHTML = `<div class="srow-m" data-a="open" role="button" tabindex="0"></div>
      <button class="btn ghost icon" data-a="more" aria-haspopup="menu" aria-label="More actions for ${esc(s.name)}">${icon('more')}</button><div class="asks"></div>`;
  }
  const aw = activeWin(s), asks = s.windows.filter((w) => w.prompt);
  const rp = aw.panes.find((x) => x.running && x.active) || aw.panes.find((x) => x.running);
  const st = asks.length ? 'ask' : s.windows.some((w) => w.running) ? 'run' : 'idle';
  const sig = JSON.stringify([s.windows, s.attached, ago(s.activity)]);
  if (row.dataset.sig === sig) return row;
  row.dataset.sig = sig;
  row.classList.toggle('has-ask', asks.length > 0);
  const usage = S.stats?.sessions[s.name];
  $('.srow-m', row).setAttribute('aria-label', `Open ${s.name}`);
  $('.srow-m', row).innerHTML = `<span class="tile st-${st}" title="${st === 'ask' ? 'Waiting for you' : st === 'run' ? 'Running' : 'Idle'}">${icon(rp ? presetIcon({ cmd: rp.cmd }) : 'terminal')}</span>
    <span class="srow-t"><span class="l1"><h3>${esc(s.name)}</h3>${s.windows.length > 1 ? `<span class="cnt">${s.windows.length} windows</span>` : ''}${s.attached ? `<span class="cnt att">${s.attached} viewing</span>` : ''}</span>
    <span class="where">${whereHtml(aw)}</span></span>
    <span class="srow-r"><span class="when">${ago(s.activity)}</span><span class="use">${usage ? `${Math.round(usage.cpu)}% · ${bytes(usage.rss)}` : ''}</span></span>`;
  $('.asks', row).innerHTML = asks.map((w) => promptHtml(s, w)).join('');
  return row;
}

$('#grid').addEventListener('click', async (e) => {
  const ph = e.target.closest('.phead');
  if (ph) return projectAction(e, ph.dataset.h);
  const card = e.target.closest('.card'); if (!card) return;
  const s = findSess(card.dataset.s); if (!s) return;
  const choice = e.target.closest('.ask [data-n]');
  if (choice) { await act(`${W(s.name, choice.closest('.ask').dataset.t)}/choose`, { n: +choice.dataset.n }); toast('Answered'); return setTimeout(refresh, 500); }
  const wb = e.target.closest('.win');
  if (wb) { await act(`${W(s.name, wb.dataset.w)}/select`); return refresh().then(refreshPreviews); }
  if (e.target.closest('.screen')) return openTerm(s.name);
  const a = e.target.closest('[data-a]')?.dataset.a;
  const aw = activeWin(s);
  if (a === 'open') openTerm(s.name);
  else if (a === 'stop') { const b = e.target.closest('[data-a]'); await act(`${W(s.name, b.dataset.t)}/stop`); toast(`Sent ${b.textContent.toLowerCase()}`); setTimeout(refresh, 600); }
  else if (a === 'start') { await act(`${W(s.name, aw.index)}/start`); toast(`Started ${aw.preset}`); setTimeout(refresh, 600); }
  else if (a === 'more') menu(e.target.closest('button'), [
    ...(() => { const rp = aw.panes.find((x) => x.running && x.active) || aw.panes.find((x) => x.running);
      return rp ? [{ label: `Stop ${rp.cmd}`, icon: 'x', run: async () => { await act(`${W(s.name, `${aw.index}.${rp.index}`)}/stop`); toast(`Sent stop to ${rp.cmd}`); setTimeout(refresh, 600); } }]
        : aw.preset ? [{ label: `Start ${aw.preset.split(' ')[0]}`, icon: 'play', run: async () => { await act(`${W(s.name, aw.index)}/start`); toast(`Started ${aw.preset}`); setTimeout(refresh, 600); } }] : []; })(),
    { label: 'New window', icon: 'plus', run: () => menu(e.target.closest('button'), presetItems(async (p) => {
      await act(`/api/sessions/${encodeURIComponent(s.name)}/windows`, { preset: p.id }); toast(`Opened ${p.label}`); refresh();
    })) },
    ...(aw.branch ? [{ label: 'Changes', icon: 'diff', run: () => openChanges(activePane(aw).cwd) }] : []),
    { label: 'Move to project', icon: 'folder', run: () => menu(e.target.closest('button'), moveItems([s.name], projectOf(s))) },
    { label: 'Rename', icon: 'edit', run: async () => {
      const to = await ask({ title: 'Rename session', label: 'Name', value: s.name, ok: 'Rename', validate: NAME_RULE });
      if (to && to !== s.name) { await act(`/api/sessions/${encodeURIComponent(s.name)}/rename`, { to }); refresh(); }
    } },
    '-',
    { label: 'End session', icon: 'trash', danger: true, run: async () => {
      if (!await ask({ title: `End session "${s.name}"?`, message: 'Everything running in it stops. This can\'t be undone.', ok: 'End session', danger: true })) return;
      await act(`/api/sessions/${encodeURIComponent(s.name)}`, null, 'DELETE'); toast(`Ended ${s.name}`); refresh();
    } },
  ]);
});
async function moveTo(names, project) {
  for (const n of names) await act(`/api/sessions/${encodeURIComponent(n)}/project`, { project });
  const p = S.projects.find((x) => x.id === project);
  toast(names.length === 1 ? `Moved ${names[0]} to ${p ? p.label : 'No project'}` : `Moved ${names.length} sessions`);
  collapsed.delete(project); store.set('collapsed', [...collapsed]);
  refresh();
}
const moveItems = (names, cur) => [
  ...S.projects.map((p) => ({ label: p.label, icon: 'folder', checked: p.id === cur, run: () => moveTo(names, p.id) })),
  { label: 'No project', icon: '', checked: !cur, run: () => moveTo(names, '') },
  '-',
  { label: 'New project…', icon: 'plus', run: async () => { const p = await newProject(); if (p) moveTo(names, p.id); } },
];

export async function saveProjects(list) {
  S.projects = await act('/api/config/projects', list, 'PUT');
  renderWall();
}
export async function newProject() {
  const label = await ask({ title: 'New project', label: 'Name', placeholder: 'My app', ok: 'Next',
    validate: (v) => !v ? 'Enter a name.' : v.length > 40 ? 'Keep it under 40 characters.' : '' }); if (!label) return null;
  const cwd = await ask({ title: `Folder for ${label}`, label: 'Default folder', value: '~/', ok: 'Create project',
    help: 'New sessions in this project start here. Leave as ~/ for none.' });
  if (cwd === null) return null;
  const base = label.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'project';
  let id = base, n = 2; while (S.projects.some((p) => p.id === id)) id = `${base}-${n++}`;
  const p = { id, label, ...(cwd && cwd !== '~/' ? { cwd } : {}) };
  await saveProjects([...S.projects, p]);
  return p;
}

function projectAction(e, id) {
  const p = S.projects.find((x) => x.id === id) || { id: '', label: 'No project' };
  if (e.target.closest('[data-ptoggle]')) {
    collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
    store.set('collapsed', [...collapsed]); return renderWall();
  }
  if (e.target.closest('[data-pnew]')) return openNew('session', null, id);
  if (!e.target.closest('[data-pmore]')) return;
  const edit = (patch) => saveProjects(S.projects.map((x) => x.id === id ? { ...x, ...patch } : x));
  const i = S.projects.indexOf(p);
  menu(e.target.closest('button'), [
    { label: 'Rename', icon: 'edit', run: async () => {
      const l = await ask({ title: 'Rename project', label: 'Name', value: p.label, ok: 'Rename', validate: (v) => !v ? 'Enter a name.' : v.length > 40 ? 'Keep it under 40 characters.' : '' });
      if (l) edit({ label: l }); } },
    { label: 'Default folder', icon: 'folder', sub: p.cwd ? home(p.cwd) : 'none', run: async () => {
      const c = await ask({ title: 'Default folder', label: 'Folder', value: p.cwd || '', placeholder: '~/code/app', ok: 'Save', help: 'Leave empty for none.' }); if (c == null) return;
      const { cwd, ...rest } = p; saveProjects(S.projects.map((x) => x.id === id ? { ...rest, ...(c.trim() ? { cwd: c.trim() } : {}) } : x));
    } },
    { label: 'Move up', icon: 'up', disabled: i === 0, run: () => { const l = [...S.projects]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; saveProjects(l); } },
    { label: 'Move down', icon: 'down', disabled: i === S.projects.length - 1, run: () => { const l = [...S.projects]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; saveProjects(l); } },
    '-',
    { label: 'Delete project', icon: 'trash', danger: true, run: async () => {
      const inside = S.sessions.filter((s) => s.project === id);
      if (!await ask({ title: `Delete project "${p.label}"?`, message: inside.length ? `Its ${inside.length} session${inside.length > 1 ? 's keep' : ' keeps'} running under No project.` : 'It has no sessions.', ok: 'Delete project', danger: true })) return;
      for (const s of inside) await act(`/api/sessions/${encodeURIComponent(s.name)}/project`, { project: '' }).catch(() => {});
      await saveProjects(S.projects.filter((x) => x.id !== id)); refresh();
    } },
  ]);
}
$('#btn-project').addEventListener('click', () => newProject());
$('#offline-retry').addEventListener('click', (e) => busy(e.currentTarget, refresh));
addEventListener('online', () => refresh());

// desktop: drag a card onto a project heading
$('#grid').addEventListener('dragstart', (e) => { const c = e.target.closest('.card'); if (c) e.dataTransfer.setData('text/x-tmuxlab-session', c.dataset.s); });
$('#grid').addEventListener('dragover', (e) => {
  const h = e.target.closest('.phead');
  if (h && e.dataTransfer.types.includes('text/x-tmuxlab-session')) { e.preventDefault(); h.classList.add('drop'); }
});
$('#grid').addEventListener('dragleave', (e) => e.target.closest('.phead')?.classList.remove('drop'));
$('#grid').addEventListener('drop', (e) => {
  const h = e.target.closest('.phead'); if (!h) return;
  e.preventDefault(); h.classList.remove('drop');
  const name = e.dataTransfer.getData('text/x-tmuxlab-session');
  if (name && projectOf(findSess(name) || {}) !== h.dataset.h) moveTo([name], h.dataset.h);
});

$('#grid').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.screen, .srow-m')) { e.preventDefault(); openTerm(e.target.closest('.card').dataset.s); }
});
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  S.filter = b.dataset.f;
  for (const x of $('#filters').children) x.setAttribute('aria-selected', x === b);
  store.set('filter', S.filter);
  renderWall(); refreshPreviews();
});
$('#btn-new').addEventListener('click', () => openNew());
$('#fab').addEventListener('click', () => openNew());
$('#q').addEventListener('input', () => { renderWall(); refreshPreviews(); });
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target.value) { e.stopPropagation(); e.target.value = ''; renderWall(); } });
const setView = (v) => {
  view = v; store.set('view', v);
  for (const b of $$('.view-sw [data-v]')) b.setAttribute('aria-checked', b.dataset.v === v);
  $('#grid').replaceChildren(); renderWall(); refreshPreviews();
};
$('.view-sw').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) setView(b.dataset.v); });
for (const b of $$('.view-sw [data-v]')) b.setAttribute('aria-checked', b.dataset.v === view);

// sidebar: saved machines with live counts; a drawer on phones
let counts = {}, countsAt = 0;
async function countMachines() {
  countsAt = Date.now();
  await Promise.all(S.machines.map((m, i) => i === S.cur ? null : api('/api/sessions', { m, timeout: 3000 })
    .then((l) => { counts[m.base] = { n: l.length, run: l.filter((s) => s.windows.some((w) => w.running)).length }; }, () => { counts[m.base] = null; })));
  renderMachines();
}
function renderMachines() {
  const run = S.sessions.filter((s) => s.windows.some((w) => w.running)).length;
  const html = S.machines.map((m, i) => {
    const host = new URL(m.base).host, name = m.name || host, c = i === S.cur ? { n: S.sessions.length, run } : counts[m.base];
    return `<button class="nav-item mach" data-m="${i}" ${i === S.cur ? 'aria-current="true"' : ''}>
      <span class="tile ${c === null ? 'st-off' : c?.run ? 'st-run' : 'st-idle'}">${esc(name[0].toUpperCase())}</span>
      <span class="mt"><b>${esc(name)}</b><small>${c === null ? 'offline' : c ? `${c.n} session${c.n === 1 ? '' : 's'}${c.run ? ` · ${c.run} running` : ''}` : esc(host)}</small></span></button>`;
  }).join('');
  if ($('#machines').dataset.sig !== html) { $('#machines').dataset.sig = html; $('#machines').innerHTML = html; } // keep focus steady while polling
}
$('#machines').addEventListener('click', (e) => {
  const b = e.target.closest('[data-m]'); if (!b) return;
  closeNav();
  if (+b.dataset.m !== S.cur) { S.cur = +b.dataset.m; saveMachines(); counts = {}; countsAt = 0; start(); }
});
let navRelease = null;
function openNav() {
  document.body.classList.add('nav-open'); $('#nav-scrim').hidden = false; $('#btn-nav').setAttribute('aria-expanded', 'true');
  navRelease = onBack(closeNav);
  ($('#machines [aria-current]') || $('#nav button'))?.focus();
}
function closeNav() {
  if (!document.body.classList.contains('nav-open')) return;
  document.body.classList.remove('nav-open'); $('#nav-scrim').hidden = true; $('#btn-nav').setAttribute('aria-expanded', 'false');
  const r = navRelease; navRelease = null; r?.();
}
$('#btn-nav').addEventListener('click', openNav);
$('#nav-scrim').addEventListener('click', closeNav);
$('#nav').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
$('#nav').addEventListener('click', (e) => { if (e.target.closest('.nav-item:not(.mach)')) closeNav(); });
$('#btn-addmachine').addEventListener('click', () => addMachine());
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
    { label: 'Add machine', icon: 'plus', run: () => addMachine() },
    { label: 'Rename this machine', icon: 'edit', run: async () => {
      const n = await ask({ title: 'Rename this machine', label: 'Name on this device', value: cfg().name || S.info?.host || '', ok: 'Rename' }); if (n == null) return;
      cfg().name = n; saveMachines(); renderWall();
    } },
    { label: 'Remove this machine', icon: 'trash', danger: true, run: async () => {
      if (!await ask({ title: `Remove ${cfg().name || new URL(cfg().base).host}?`, message: 'This device forgets the address and token. Sessions on the machine keep running.', ok: 'Remove', danger: true })) return;
      S.machines.splice(S.cur, 1); S.cur = 0; saveMachines(); start();
    } },
  ]);
});

document.addEventListener('keydown', (e) => {
  if ($('#wall').hidden || document.querySelector('dialog[open]')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openPalette(); }
  else if (e.key === 'n' && !e.ctrlKey && !e.metaKey && e.target === document.body) { e.preventDefault(); openNew(); }
});
for (const x of $('#filters').children) x.setAttribute('aria-selected', x.dataset.f === S.filter);
