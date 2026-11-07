// Dialogs: new session, changes, schedules, settings, find & copy, jump palette.
import { $, $$, esc, S, api, act, W, toast, store, busy, home, winState, activeWin, activePane, findSess, cfg, saveMachines, touch, ask, whereText, icon, presetIcon, ago } from './core.js';
import { refresh } from './wall.js';
import { openTerm, setFont, setTheme, T, THEMES } from './term.js';
import { start } from './main.js';
import qrcode from '../vendor/qrcode.js';

// ---------- new session / window ----------
const dNew = $('#dlg-new');
let nw = { mode: 'session', pick: 'p:shell', session: null, nameTouched: false, git: false };
export function openNew(mode = 'session', session = null, project = '') {
  nw = { mode, session, pick: nw.pick, nameTouched: false, git: false };
  $('#new-project-row').hidden = mode !== 'session' || !S.projects.length;
  $('#new-project').innerHTML = '<option value="">No project</option>' + S.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  $('#new-project').value = project;
  $('#new-title').textContent = mode === 'session' ? 'New session' : `New window in ${session}`;
  $('#new-name-row').hidden = mode !== 'session';
  $('#new-go').textContent = mode === 'session' ? 'Start session' : 'Open window';
  $('#new-name').value = '';
  const s = session && findSess(session);
  $('#new-cwd').value = s ? activePane(activeWin(s)).cwd : projDir(project);
  $('#browser').hidden = true;
  const chip = (key, ic, label, sub, cls = '') => `<button type="button" class="preset ${cls}" data-k="${esc(key)}" aria-pressed="${key === nw.pick}">
    <span class="ic">${icon(ic)}</span><span>${esc(label)}<small>${esc(sub)}</small></span></button>`;
  const stacks = mode === 'session' ? S.stacks : [];
  if (!S.presets.some((p) => 'p:' + p.id === nw.pick) && !stacks.some((x) => 's:' + x.id === nw.pick)) nw.pick = 'p:' + (S.presets[0]?.id || 'shell');
  $('#new-presets').innerHTML = S.presets.map((p) => chip('p:' + p.id, presetIcon(p), p.label, p.cmd || 'just a shell')).join('') +
    stacks.map((x) => chip('s:' + x.id, 'layers', x.label, `${x.windows.length} windows`, 'stack')).join('');
  $('#recent').innerHTML = store.get('recent', []).map((d) => `<button type="button" data-d="${esc(d)}">${esc(home(d))}</button>`).join('');
  $('#wt-row').hidden = true; $('#wt-on').checked = false; $('#wt-branch').hidden = true;
  dNew.showModal();
  if (s || $('#new-cwd').value) checkGit();
  if (!s && $('#new-cwd').value && !nw.nameTouched) setCwd($('#new-cwd').value);
  (mode === 'session' && !touch ? $('#new-name') : $('#new-cwd')).focus();
}
$('#new-presets').addEventListener('click', (e) => {
  const b = e.target.closest('.preset'); if (!b) return;
  nw.pick = b.dataset.k;
  for (const x of $('#new-presets').children) x.setAttribute('aria-pressed', x === b);
});
const projDir = (id) => S.projects.find((p) => p.id === id)?.cwd || '';
// picking a project fills in its folder unless you already chose one
$('#new-project').addEventListener('change', (e) => {
  const cur = $('#new-cwd').value.trim();
  if (!cur || S.projects.some((p) => p.cwd === cur)) { const d = projDir(e.target.value); if (d) setCwd(d); }
});
$('#new-name').addEventListener('input', () => { nw.nameTouched = true; suggestBranch(); });
function setCwd(d, git) {
  $('#new-cwd').value = d;
  if (!nw.nameTouched && nw.mode === 'session') $('#new-name').value = d.split('/').filter(Boolean).pop()?.replace(/[^\w.-]/g, '-').slice(0, 64) || '';
  if (git === undefined) checkGit(); else showGit(git);
}
let gitT;
function checkGit() {
  clearTimeout(gitT);
  gitT = setTimeout(async () => {
    const p = $('#new-cwd').value.trim();
    if (!p) return showGit(false);
    try { await api('/api/git?path=' + encodeURIComponent(p)); showGit(true); } catch { showGit(false); }
  }, 300);
}
function showGit(g) { nw.git = g; $('#wt-row').hidden = !g || nw.mode !== 'session'; suggestBranch(); }
function suggestBranch() {
  const b = $('#wt-branch');
  if (b.dataset.touched) return;
  const n = ($('#new-name').value || 'task').replace(/[^\w.-]/g, '-');
  b.value = `agent/${n}-${new Date().toISOString().slice(5, 10).replace('-', '')}`;
}
$('#wt-on').addEventListener('change', (e) => { $('#wt-branch').hidden = !e.target.checked; });
$('#wt-branch').addEventListener('input', (e) => { e.target.dataset.touched = 1; });
$('#new-cwd').addEventListener('input', checkGit);
$('#recent').addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (b) setCwd(b.dataset.d); });
$('#new-browse').addEventListener('click', () => browse($('#new-cwd').value || '~'));
async function browse(p) {
  let r;
  try { r = await api('/api/fs?path=' + encodeURIComponent(p)); } catch (e) { toast(e.message, true); return; }
  const br = $('#browser');
  br.hidden = false;
  br.innerHTML = `<div class="bh"><button type="button" class="btn sm ghost" data-up aria-label="Parent folder">↑</button><span>${esc(r.path)}</span>
    <button type="button" class="btn sm primary" data-use>Use${r.git ? ' (git)' : ''}</button></div>
    ${r.dirs.map((d) => `<button type="button" class="d" data-d="${esc(d)}">${esc(d)}/</button>`).join('') || '<div class="d muted">No subfolders</div>'}`;
  br.onclick = (e) => {
    if (e.target.closest('[data-up]')) return browse(r.parent);
    if (e.target.closest('[data-use]')) { setCwd(r.path, r.git); br.hidden = true; return; }
    const d = e.target.closest('[data-d]'); if (d) browse(r.path.replace(/\/$/, '') + '/' + d.dataset.d);
  };
  setCwd(r.path, r.git);
}
$('#new-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const cwd = $('#new-cwd').value.trim() || undefined;
  const [kind, id] = nw.pick.split(':');
  const what = kind === 's' ? { stack: id } : { preset: id };
  const btn = $('#new-go'); btn.disabled = true;
  try {
    if (nw.mode === 'session') {
      const wt = !$('#wt-row').hidden && $('#wt-on').checked ? { worktree: { branch: $('#wt-branch').value.trim() } } : {};
      const project = $('#new-project').value || undefined;
      const r = await act('/api/sessions', { name: $('#new-name').value.trim() || undefined, cwd, project, ...what, ...wt });
      dNew.close(); remember(cwd); if (wt.worktree) toast(`Branch ${wt.worktree.branch} in ${home(r.cwd)}`);
      await refresh(); openTerm(r.name);
    } else {
      await act(`/api/sessions/${encodeURIComponent(nw.session)}/windows`, { ...what, cwd });
      dNew.close(); remember(cwd); refresh();
    }
  } catch {} finally { btn.disabled = false; }
});
function remember(d) { if (d) store.set('recent', [d, ...store.get('recent', []).filter((x) => x !== d)].slice(0, 6)); }

// ---------- changes: diff, commit, push, PR, worktree ----------
const dCh = $('#dlg-changes');
let chPath = null;
export async function openChanges(path) {
  chPath = path;
  $('#ch-body').innerHTML = '<p class="muted">Reading git status…</p>';
  $('#ch-msg').value = '';
  dCh.showModal();
  await loadChanges();
}
async function loadChanges() {
  let g;
  try { g = await api('/api/git?path=' + encodeURIComponent(chPath)); } catch (e) { $('#ch-body').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  $('#ch-title').textContent = `⎇ ${g.branch}`;
  $('#ch-sub').textContent = [home(g.root), g.upstream && `tracks ${g.upstream}${g.track ? ` (${g.track})` : ''}`, g.isWorktree && 'separate worktree'].filter(Boolean).join(' · ');
  $('#ch-wt').hidden = !g.isWorktree;
  $('#ch-pr').disabled = $('#ch-push').disabled = !g.remote;
  $('#ch-commit').disabled = !g.files.length;
  $('#ch-body').innerHTML = g.files.length ? `<ul class="files">${g.files.map((f) => `<li><button class="file" data-f="${esc(f.file)}">
      <span class="st st-${esc(f.status[0] === '?' ? 'n' : f.status[0])}">${esc(f.status === '??' ? 'new' : f.status)}</span>
      <span class="fn">${esc(f.file)}</span><span class="num">${f.status === '??' ? '' : `<i class="a">+${f.add}</i> <i class="d">−${f.del}</i>`}</span></button><div class="diff" hidden></div></li>`).join('')}</ul>`
    : `<p class="muted">No changes. Last commit: ${esc(g.last || 'none')}</p>`;
}
$('#ch-body').addEventListener('click', async (e) => {
  const b = e.target.closest('.file'); if (!b) return;
  const box = b.nextElementSibling;
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false; box.textContent = 'Loading…';
  try {
    const { diff } = await api(`/api/git/diff?path=${encodeURIComponent(chPath)}&file=${encodeURIComponent(b.dataset.f)}`);
    box.innerHTML = diff.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode)/.test(l)).map((l) =>
      `<div class="${l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('@@') ? 'hunk' : ''}">${esc(l) || ' '}</div>`).join('') || '<div class="muted">Binary or empty file</div>';
  } catch (err) { box.textContent = err.message; }
});
$('#ch-commit').addEventListener('click', async () => {
  const message = $('#ch-msg').value.trim();
  if (!message) { $('#ch-msg').focus(); return toast('Write a commit message first', true); }
  const r = await act('/api/git/commit', { path: chPath, message }); toast(r.result); $('#ch-msg').value = ''; loadChanges();
});
$('#ch-push').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await act('/api/git/push', { path: chPath }); toast('Pushed'); loadChanges(); } catch {} finally { e.target.disabled = false; }
});
$('#ch-pr').addEventListener('click', async (e) => {
  const title = await ask({ title: 'Create pull request', label: 'Title', placeholder: 'Uses the commit messages if empty', ok: 'Create pull request' });
  if (title === null) return;
  e.target.disabled = true;
  try {
    const { url } = await act('/api/git/pr', { path: chPath, title: title.trim() || undefined });
    toast('Pull request ready', false, { action: 'Open', run: () => window.open(url, '_blank') });
  } catch {} finally { e.target.disabled = false; }
});
$('#ch-wt').addEventListener('click', async () => {
  if (!await ask({ title: 'Remove this worktree?', message: 'The folder is deleted. The branch stays in the repository.', ok: 'Remove worktree', danger: true })) return;
  try { await api('/api/git/worktree', { method: 'DELETE', body: { path: chPath } }); }
  catch (e) {
    if (!await ask({ title: 'Worktree has uncommitted changes', message: `${e.message}. Removing it anyway loses them.`, ok: 'Remove and lose changes', danger: true })) return;
    await act('/api/git/worktree', { path: chPath, force: true }, 'DELETE');
  }
  toast('Worktree removed'); dCh.close();
});

// ---------- find & copy over tmux history ----------
const dFind = $('#dlg-find');
let fText = '', fHits = [], fIdx = 0;
export async function openFind(target, title) {
  $('#find-title').textContent = title;
  $('#find-q').value = '';
  $('#find-pre').textContent = 'Loading history…';
  dFind.showModal();
  try { fText = (await api(`${target}/capture?lines=3000`)).text.replace(/\s+$/, ''); } catch (e) { fText = e.message; }
  renderFind();
  const pre = $('#find-pre'); pre.scrollTop = pre.scrollHeight;
  if (!touch) $('#find-q').focus();
}
function renderFind() {
  const q = $('#find-q').value;
  const pre = $('#find-pre');
  if (!q) { pre.textContent = fText; fHits = []; $('#find-n').textContent = ''; return; }
  const low = fText.toLowerCase(), ql = q.toLowerCase();
  let html = '', at = 0, i; fHits = [];
  while ((i = low.indexOf(ql, at)) >= 0 && fHits.length < 2000) {
    html += esc(fText.slice(at, i)) + `<mark data-h="${fHits.length}">${esc(fText.slice(i, i + q.length))}</mark>`;
    fHits.push(i); at = i + q.length;
  }
  pre.innerHTML = html + esc(fText.slice(at));
  fIdx = fHits.length - 1; // newest match first
  jump(0);
}
function jump(d) {
  if (!fHits.length) { $('#find-n').textContent = $('#find-q').value ? 'no matches' : ''; return; }
  fIdx = (fIdx + d + fHits.length) % fHits.length;
  $$('#find-pre mark.cur').forEach((m) => m.classList.remove('cur'));
  const m = $(`#find-pre mark[data-h="${fIdx}"]`);
  m.classList.add('cur'); m.scrollIntoView({ block: 'center' });
  $('#find-n').textContent = `${fIdx + 1} of ${fHits.length}`;
}
$('#find-q').addEventListener('input', renderFind);
$('#find-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? 1 : -1); } });
$('#find-prev').addEventListener('click', () => jump(-1));
$('#find-next').addEventListener('click', () => jump(1));
$('#find-copy').addEventListener('click', async () => {
  const sel = getSelection().toString();
  try { await navigator.clipboard.writeText(sel || fText); toast(sel ? 'Copied selection' : 'Copied all'); }
  catch { toast('Select the text and use your device\'s copy', true); }
});

// ---------- jump palette (also picks a window for split view) ----------
const dPal = $('#dlg-palette');
let pal = { items: [], sel: 0, pick: null };
export function openPalette() { pal.pick = null; $('#pal-q').placeholder = 'Jump to session or window…'; openPal(); }
export function pickWindow(title, cb) { pal.pick = cb; $('#pal-q').placeholder = title; openPal(); }
function openPal() { $('#pal-q').value = ''; pal.sel = 0; renderPal(); dPal.showModal(); $('#pal-q').focus(); }
function renderPal() {
  const q = $('#pal-q').value.toLowerCase();
  const go = (s, w) => pal.pick ? () => pal.pick(s, w) : async () => { if (w != null) await act(`${W(s, w)}/select`); openTerm(s); };
  pal.items = [
    ...S.sessions.flatMap((s) => [
      ...(pal.pick ? [] : [{ label: s.name, meta: [S.projects.find((p) => p.id === s.project)?.label, `${s.windows.length} window${s.windows.length > 1 ? 's' : ''}`].filter(Boolean).join(' · '), dot: s.windows.some((w) => w.running) ? 'run' : '', go: go(s.name) }]),
      ...s.windows.map((w) => ({ label: `${s.name} › ${w.name}`, meta: whereText(w), dot: w.prompt ? 'ask-dot' : winState(w), go: go(s.name, w.index) })),
    ]),
    ...(pal.pick ? [] : [{ label: 'New session…', meta: '', go: () => openNew() }, { label: 'Schedules', meta: '', go: openSchedules }, { label: 'Settings', meta: '', go: openSettings }]),
  ].filter((x) => `${x.label} ${x.meta}`.toLowerCase().includes(q)).slice(0, 60);
  pal.sel = Math.min(pal.sel, Math.max(0, pal.items.length - 1));
  $('#pal-list').innerHTML = pal.items.map((x, i) => `<li role="option" data-i="${i}" aria-selected="${i === pal.sel}">
    <span class="dot ${x.dot || ''}"></span><span class="l">${esc(x.label)}</span><span class="m">${esc(x.meta)}</span></li>`).join('');
}
$('#pal-q').addEventListener('input', () => { pal.sel = 0; renderPal(); });
$('#pal-q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pal.sel = (pal.sel + (e.key === 'ArrowDown' ? 1 : -1) + pal.items.length) % pal.items.length; renderPal(); }
  if (e.key === 'Enter' && pal.items[pal.sel]) { dPal.close(); pal.items[pal.sel].go(); }
});
$('#pal-list').addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) { dPal.close(); pal.items[li.dataset.i].go(); } });

// ---------- schedules ----------
const dSch = $('#dlg-sched');
let sch = [], schStatus = {}, editing = null;
const EVERY = [['hourly', 'Every hour'], ['daily', 'Every day at'], ['weekdays', 'Weekdays at'], ['weekly', 'Every Monday at'], ['custom', 'Custom (cron)']];
const toCron = (kind, time, custom) => {
  const [h, m] = (time || '09:00').split(':').map(Number);
  return { hourly: `${m} * * * *`, daily: `${m} ${h} * * *`, weekdays: `${m} ${h} * * 1-5`, weekly: `${m} ${h} * * 1`, custom }[kind];
};
const fromCron = (c) => {
  const m = c.match(/^(\d+) (\*|\d+) \* \* (\*|1-5|1)$/);
  if (!m) return { kind: 'custom', time: '09:00' };
  const time = `${String(m[2] === '*' ? 9 : m[2]).padStart(2, '0')}:${String(m[1]).padStart(2, '0')}`;
  return { kind: m[2] === '*' ? (m[3] === '*' ? 'hourly' : 'custom') : { '*': 'daily', '1-5': 'weekdays', 1: 'weekly' }[m[3]], time };
};
const human = (c) => { const f = fromCron(c); return f.kind === 'custom' ? `cron ${c}` : f.kind === 'hourly' ? `every hour at :${f.time.slice(3)}` : `${EVERY.find((x) => x[0] === f.kind)[1].toLowerCase()} ${f.time}`; };
export async function openSchedules() {
  dSch.showModal();
  editing = null;
  await loadSched();
}
async function loadSched() {
  try { [sch, schStatus] = await Promise.all([api('/api/config/schedules'), api('/api/schedules/status')]); } catch (e) { toast(e.message, true); }
  renderSched();
}
function renderSched() {
  $('#sch-form').hidden = editing === null;
  $('#sch-list').hidden = editing !== null;
  $('#sch-add').hidden = editing !== null;
  if (editing !== null) return fillForm();
  const when = (iso) => iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  $('#sch-list').innerHTML = sch.length ? sch.map((s, i) => `<li class="sch">
      <label class="sw"><input type="checkbox" data-on="${i}" ${s.enabled ? 'checked' : ''} aria-label="Enabled"><span></span></label>
      <div class="si"><b>${esc(s.label)}</b><small>${esc(human(s.cron))} · ${esc(s.cmd ?? S.presets.find((p) => p.id === s.preset)?.label ?? '')} · in ${esc(s.session || 'scheduled')}</small>
      <small class="muted">next ${when(schStatus[s.id]?.next)}${schStatus[s.id]?.last ? ` · last ran ${when(schStatus[s.id].last)}` : ''}</small></div>
      <button class="btn sm" data-run="${i}">Run now</button><button class="btn sm ghost" data-edit="${i}">Edit</button></li>`).join('')
    : '<li class="muted empty-s">Nothing scheduled. Add nightly tests, a morning review by Claude, or a periodic build.</li>';
}
function fillForm() {
  const s = sch[editing] || { label: '', cron: '0 9 * * 1-5', session: 'scheduled', cwd: '', preset: S.presets[0]?.id, enabled: true };
  const f = fromCron(s.cron);
  $('#sf-label').value = s.label; $('#sf-kind').value = f.kind; $('#sf-time').value = f.time; $('#sf-cron').value = s.cron;
  $('#sf-cwd').value = s.cwd || ''; $('#sf-session').value = s.session || 'scheduled';
  $('#sf-what').innerHTML = S.presets.map((p) => `<option value="p:${esc(p.id)}">${esc(p.label)}</option>`).join('') + '<option value="cmd">Command…</option>';
  $('#sf-what').value = s.cmd !== undefined ? 'cmd' : `p:${s.preset}`;
  $('#sf-cmd').value = s.cmd || '';
  $('#sf-del').hidden = !sch[editing];
  syncForm();
}
function syncForm() {
  const k = $('#sf-kind').value;
  $('#sf-time').hidden = k === 'custom';
  $('#sf-cron').hidden = k !== 'custom';
  $('#sf-cmd').hidden = $('#sf-what').value !== 'cmd';
}
$('#sf-kind').addEventListener('change', syncForm);
$('#sf-what').addEventListener('change', syncForm);
$('#sch-add').addEventListener('click', () => { editing = sch.length; renderSched(); $('#sf-label').focus(); });
$('#sf-cancel').addEventListener('click', () => { editing = null; renderSched(); });
const saveSched = async (list) => { await act('/api/config/schedules', list, 'PUT'); sch = list; schStatus = await api('/api/schedules/status').catch(() => ({})); editing = null; renderSched(); };
$('#sf-save').addEventListener('click', async () => {
  const label = $('#sf-label').value.trim();
  if (!label) return toast('Give the schedule a name', true);
  const what = $('#sf-what').value;
  const old = sch[editing];
  const s = { id: old?.id || `s${Date.now().toString(36)}`, label, cron: toCron($('#sf-kind').value, $('#sf-time').value, $('#sf-cron').value.trim()),
    session: $('#sf-session').value.trim() || 'scheduled', enabled: old?.enabled ?? true,
    ...($('#sf-cwd').value.trim() ? { cwd: $('#sf-cwd').value.trim() } : {}),
    ...(what === 'cmd' ? { cmd: $('#sf-cmd').value } : { preset: what.slice(2) }) };
  const list = [...sch]; list[editing] = s;
  try { await saveSched(list); toast(`Saved ${label}`); } catch {}
});
$('#sf-del').addEventListener('click', async () => {
  if (!await ask({ title: `Delete schedule "${sch[editing].label}"?`, message: 'It stops running. Sessions it already started keep going.', ok: 'Delete schedule', danger: true })) return;
  await saveSched(sch.filter((_, i) => i !== editing)).catch(() => {});
});
$('#sch-list').addEventListener('click', async (e) => {
  const run = e.target.closest('[data-run]'), ed = e.target.closest('[data-edit]');
  if (run) { await act(`/api/schedules/${sch[run.dataset.run].id}/run`); toast(`Started ${sch[run.dataset.run].label}`); refresh(); loadSched(); }
  if (ed) { editing = +ed.dataset.edit; renderSched(); }
});
$('#sch-list').addEventListener('change', async (e) => {
  const i = e.target.dataset.on; if (i === undefined) return;
  const list = sch.map((s, j) => j === +i ? { ...s, enabled: e.target.checked } : s);
  await saveSched(list).catch(() => { e.target.checked = !e.target.checked; });
});

// ---------- start or resume Claude Code / Codex ----------
const dAg = $('#dlg-agent');
const ag = { kind: 'claude', conv: 'new', list: [], ctx: {} };
const OPTS = {
  claude: [
    ['mode', 'Permissions', [['', 'Ask before acting (default)'], ['acceptEdits', 'Accept edits without asking'], ['plan', 'Plan only, change nothing'], ['auto', 'Auto mode'], ['bypassPermissions', 'Skip every permission check']]],
    ['model', 'Model', [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']]],
  ],
  codex: [
    ['mode', 'Permissions', [['', 'Default'], ['ro', 'Read only'], ['auto', 'Edit this folder, ask for anything else'], ['full', 'Full access, never ask']]],
    ['model', 'Model', null],
  ],
};
export function openAgent(ctx) {
  ag.ctx = ctx; ag.conv = 'new'; $('#ag-err').textContent = ''; $('#ag-fork').checked = false;
  ag.where = ctx.t ? ctx.where : 'window';
  for (const b of $$('#ag-where [data-w]')) { b.setAttribute('aria-checked', b.dataset.w === ag.where); b.disabled = b.dataset.w === 'pane' && !ctx.t; }
  setKind(ctx.kind || store.get('agentKind', 'claude'));
  dAg.showModal();
}
async function setKind(k) {
  ag.kind = k; store.set('agentKind', k); ag.conv = 'new';
  for (const b of $$('#ag-kind [data-k]')) b.setAttribute('aria-selected', b.dataset.k === k);
  $('#ag-title').textContent = k === 'claude' ? 'Start Claude Code' : 'Start Codex';
  const saved = store.get(`agentOpts:${k}`, {});
  $('#ag-opts').innerHTML = OPTS[k].map(([id, label, choices]) => choices
    ? `<label>${label}<select id="ag-${id}">${choices.map(([v, l]) => `<option value="${v}" ${saved[id] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`
    : `<label>${label}<input id="ag-${id}" value="${esc(saved[id] || '')}" placeholder="Default" autocapitalize="off" spellcheck="false"></label>`).join('');
  $('#ag-rc-row').hidden = k !== 'claude'; $('#ag-search-row').hidden = k !== 'codex';
  $('#ag-rc').checked = !!saved.rc; $('#ag-search').checked = !!saved.search;
  $('#ag-convs').innerHTML = '<p class="muted small">Looking for earlier conversations…</p>';
  renderAgCmd();
  try { ag.list = await api(`/api/agents/${k}/history?cwd=${encodeURIComponent(ag.ctx.cwd || '~')}`); } catch { ag.list = []; }
  if (ag.kind === k) renderConvs();
}
function renderConvs() {
  const row = (v, title, sub) => `<label class="conv"><input type="radio" name="agc" value="${esc(v)}" ${ag.conv === v ? 'checked' : ''}><span><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`;
  $('#ag-convs').innerHTML = row('new', 'New conversation', '') +
    (ag.list.length ? row('last', 'Continue the latest', ag.list[0].title) : '') +
    ag.list.map((c) => row(c.id, c.title || 'Conversation', `${ago(Date.parse(c.when) / 1000)}${c.first && c.first !== c.title ? ` · ${c.first}` : ''}`)).join('') +
    (ag.list.length ? '' : '<p class="muted small">No earlier conversations in this folder.</p>');
  renderAgCmd();
}
function agCmd() {
  const v = (id) => $(`#ag-${id}`)?.value.trim() || '', c = ag.conv, model = v('model');
  if (model && !/^[\w.:-]{1,64}$/.test(model)) throw new Error('Model names use letters, digits, dots, dashes and colons.');
  if (!/^(new|last|[\w-]{1,80})$/.test(c)) throw new Error('That conversation id looks wrong.'); // it is typed into a shell
  if (ag.kind === 'claude') return ['claude', c === 'last' && '--continue', c !== 'new' && c !== 'last' && `--resume ${c}`,
    c !== 'new' && $('#ag-fork').checked && '--fork-session', v('mode') && `--permission-mode ${v('mode')}`, model && `--model ${model}`,
    $('#ag-rc').checked && `--remote-control ${ag.ctx.s || 'tmuxlab'}`].filter(Boolean).join(' ');
  const mode = { ro: '-s read-only', auto: '-s workspace-write -a on-request', full: '--dangerously-bypass-approvals-and-sandbox' }[v('mode')];
  return [c === 'new' ? 'codex' : c === 'last' ? 'codex resume --last' : `codex resume ${c}`, mode, model && `-m ${model}`, $('#ag-search').checked && '--search'].filter(Boolean).join(' ');
}
function renderAgCmd() {
  $('#ag-fork-row').hidden = ag.kind !== 'claude' || ag.conv === 'new';
  try { $('#ag-cmd').textContent = agCmd(); $('#ag-err').textContent = ''; } catch (e) { $('#ag-err').textContent = e.message; }
}
$('#ag-kind').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b && b.dataset.k !== ag.kind) setKind(b.dataset.k); });
$('#ag-where').addEventListener('click', (e) => {
  const b = e.target.closest('[data-w]'); if (!b || b.disabled) return;
  ag.where = b.dataset.w; for (const x of $$('#ag-where [data-w]')) x.setAttribute('aria-checked', x === b);
});
$('#agent-form').addEventListener('change', (e) => { if (e.target.name === 'agc') ag.conv = e.target.value; renderAgCmd(); });
$('#agent-form').addEventListener('input', renderAgCmd);
$('#ag-go').addEventListener('click', () => busy($('#ag-go'), async () => {
  let cmd; try { cmd = agCmd(); } catch (e) { $('#ag-err').textContent = e.message; return; }
  store.set(`agentOpts:${ag.kind}`, { mode: $('#ag-mode').value, model: $('#ag-model').value.trim(), rc: $('#ag-rc').checked, search: $('#ag-search').checked });
  const { s, t, cwd } = ag.ctx;
  try {
    if (ag.where === 'pane') await api(`${t}/start`, { method: 'POST', body: { cmd } });
    else await api(`/api/sessions/${encodeURIComponent(s)}/windows`, { method: 'POST', body: { cmd, label: ag.kind, ...(cwd ? { cwd } : {}) } });
  } catch (e) { $('#ag-err').textContent = e.message; return; }
  dAg.close(); toast(`Started ${ag.kind === 'claude' ? 'Claude Code' : 'Codex'}`); setTimeout(refresh, 600);
}));

// ---------- pair a phone: this machine's link as a QR code ----------
// an address other devices can reach: "localhost" means nothing to a phone
const reachable = () => {
  const base = cfg().base;
  if (!isLocal(base) || !S.info?.addrs?.length) return base;
  const u = new URL(base); u.hostname = S.info.addrs[0]; return u.origin;
};
// each QR is a new device key, so a lost phone can be removed on its own
$('#set-pair').addEventListener('click', () => busy($('#set-pair'), async () => {
  const base = reachable();
  const d = await act('/api/devices', { name: 'Paired device' });
  const url = `${base}/#token=${d.token}`;
  const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
  $('#pair-qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
  $('#pair-url').textContent = isLocal(base) ? 'This page was opened as localhost, which a phone cannot reach. Open tmuxlab by its network address, or run npm run pair.' : base;
  $('#dlg-pair').showModal();
  renderDevices();
}));

// ---------- search output: all sessions, live and ended ----------
const dLg = $('#dlg-logs');
let lgQ = '';
const mark = (line, q) => { const i = line.toLowerCase().indexOf(q.toLowerCase()); return i < 0 ? esc(line) : `${esc(line.slice(0, i))}<mark>${esc(line.slice(i, i + q.length))}</mark>${esc(line.slice(i + q.length))}`; };
export function openLogs() { $('#lg-body').innerHTML = ''; dLg.showModal(); $('#lg-q').focus(); }
$('#lg-form').addEventListener('submit', (e) => { e.preventDefault(); busy($('#lg-go'), async () => {
  lgQ = $('#lg-q').value.trim();
  if (lgQ.length < 2) { $('#lg-body').innerHTML = '<p class="muted">Type at least 2 characters.</p>'; return; }
  let res;
  try { res = await api('/api/logs/search?q=' + encodeURIComponent(lgQ), { timeout: 30000 }); } catch (err) { $('#lg-body').innerHTML = `<p class="err">${esc(err.message)}</p>`; return; }
  $('#lg-body').innerHTML = res.length ? res.map((r) => `<section class="lg">
    <div class="row"><b>${esc(r.s)}</b><span class="muted small">${esc(r.name)} · ${r.live ? 'running now' : `ended · saved ${ago(r.at / 1000)}`}</span><span class="spacer"></span>
      <button type="button" class="btn sm ${r.live ? 'primary' : ''}" ${r.live ? `data-s="${esc(r.s)}" data-w="${r.w}"` : `data-log="${esc(r.log)}"`}>${r.live ? 'Open' : 'Read'}</button></div>
    <pre class="lg-hits">${r.hits.map((h) => mark(h.line, lgQ)).join('\n')}</pre></section>`).join('') : `<p class="muted">Nothing printed “${esc(lgQ)}”.</p>`;
}); });
$('#lg-body').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.s) { dLg.close(); return openTerm(b.dataset.s, +b.dataset.w); }
  if (b.dataset.back !== undefined) return $('#lg-form').requestSubmit();
  if (!b.dataset.log) return;
  let l; try { l = await api('/api/logs/' + encodeURIComponent(b.dataset.log)); } catch (err) { return toast(err.message, true); }
  $('#lg-body').innerHTML = `<div class="row"><button type="button" class="btn sm ghost" data-back>${icon('left')}Results</button><b>${esc(l.meta.s)}</b><span class="muted small">${esc(l.meta.name)} · ${esc(home(l.meta.cwd))}</span></div>
    <pre class="lg-log">${l.text.split('\n').map((x) => mark(x, lgQ)).join('\n')}</pre>`;
  $('#lg-body mark')?.scrollIntoView({ block: 'center' });
});

// ---------- repos: worktrees, what changed in each, and who works there ----------
const dRp = $('#dlg-repos');
// the sessions with a pane inside a folder (the deepest worktree wins, so the main checkout doesn't claim them all)
const sessionsIn = (dir, all) => S.sessions.filter((s) => s.windows.some((w) => w.panes.some((p) => {
  const inside = (d) => p.cwd === d || p.cwd.startsWith(d + '/');
  return inside(dir) && !all.some((d) => d !== dir && d.length > dir.length && inside(d));
})));
export async function openRepos() {
  if (!dRp.open) dRp.showModal();
  $('#rp-body').innerHTML = '<p class="muted">Reading repos…</p>';
  let repos;
  try { repos = await api('/api/repos', { timeout: 30000 }); } catch (e) { $('#rp-body').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (!repos.length) { $('#rp-body').innerHTML = '<p class="muted">No session is inside a git repo yet. Start one in a repo folder and it shows up here.</p>'; return; }
  const all = repos.flatMap((r) => r.worktrees.map((w) => w.path));
  $('#rp-body').innerHTML = repos.map((r) => `<section class="rp" data-root="${esc(r.root)}">
    <div class="row"><h3>${esc(r.name)}</h3><span class="muted small mono">${esc(home(r.root))}</span><span class="spacer"></span>
      <button type="button" class="btn sm" data-a="task">${icon('plus')}New task…</button></div>
    <ul class="rp-wts">${r.worktrees.map((w) => { const ss = sessionsIn(w.path, all); return `<li data-path="${esc(w.path)}" data-s="${esc(ss[0]?.name || '')}">
      <div class="rp-l"><b>⎇ ${esc(w.branch)}</b>${w.main ? ' <span class="muted small">main checkout</span>' : ''}
        <span class="rp-m small">${[w.changed ? `<span class="attn">${w.changed} changed</span>` : '<span class="muted">clean</span>',
          w.ahead ? `↑${w.ahead}` : '', w.behind ? `↓${w.behind}` : '', !w.upstream ? '<span class="muted">not pushed</span>' : ''].filter(Boolean).join(' · ')}</span>
        ${w.last ? `<span class="muted small rp-c">${esc(w.last)} · ${ago(w.when)}</span>` : ''}
        ${ss.length ? `<span class="small">${ss.map((s) => { const a = s.windows.flatMap((x) => x.panes).find((p) => p.running); return `${esc(s.name)}${a ? ` <span class="muted">(${esc(a.cmd)})</span>` : ''}`; }).join(', ')}</span>` : ''}</div>
      <div class="rp-a">${ss.length ? '<button type="button" class="btn sm primary" data-a="open">Open</button>' : '<button type="button" class="btn sm" data-a="start">Start here</button>'}
        <button type="button" class="btn sm ghost" data-a="changes">Changes</button></div></li>`; }).join('')}</ul></section>`).join('');
}
$('#rp-refresh').addEventListener('click', () => openRepos());
$('#rp-body').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const li = b.closest('li'), root = b.closest('[data-root]').dataset.root;
  if (b.dataset.a === 'open') { dRp.close(); openTerm(li.dataset.s); }
  else if (b.dataset.a === 'changes') openChanges(li.dataset.path);
  else if (b.dataset.a === 'start') {
    const r = await act('/api/sessions', { cwd: li.dataset.path }).catch(() => null); if (!r) return;
    dRp.close(); await refresh(); openTerm(r.name);
  } else if (b.dataset.a === 'task') {
    const branch = await ask({ title: 'New task', message: 'A new branch in its own folder, with a session there. Then pick the agent to start.', label: 'Branch name', value: '', ok: 'Create',
      validate: (v) => (/^(?!.*\.\.)(?!\/)(?!.*\/$)[\w./-]{1,100}$/.test(v) ? '' : 'Use letters, digits, dots, dashes and slashes.') });
    if (!branch) return;
    const r = await act('/api/sessions', { cwd: root, worktree: { branch } }).catch(() => null); if (!r) return;
    dRp.close(); await refresh(); openTerm(r.name);
    openAgent({ kind: 'claude', s: r.name, t: W(r.name, r.window), cwd: r.cwd, where: 'pane' });
  }
});

// ---------- send one message to several sessions ----------
// each session gets it in the pane running an agent, else its active pane
const AGENTS = /^(claude|codex|aider|gemini|opencode|amp)$/;
function bcTarget(s) {
  for (const w of s.windows) {
    const p = w.panes.find((x) => x.agent || AGENTS.test(x.cmd));
    // a session waiting on a question isn't ticked: typed text plus Enter could pick its highlighted answer
    if (p) return p.prompt || p.agent?.state === 'blocked' ? { w: `${w.index}.${p.index}`, what: `${p.cmd} · waiting for an answer`, agent: false } : { w: `${w.index}.${p.index}`, what: p.cmd, agent: true };
  }
  const w = activeWin(s), p = activePane(w);
  return { w: `${w.index}.${p.index}`, what: p.running ? p.cmd : 'shell', agent: false };
}
const dBc = $('#dlg-bcast');
export function openBroadcast() {
  $('#bc-err').textContent = '';
  $('#bc-list').innerHTML = S.sessions.map((s) => { const t = bcTarget(s); return `<li><label class="check"><input type="checkbox" value="${esc(s.name)}" data-w="${t.w}" data-agent="${t.agent}" ${t.agent ? 'checked' : ''}>
    <span><b>${esc(s.name)}</b> <span class="muted small">${esc(t.what)}</span></span></label></li>`; }).join('') || '<li class="muted">No sessions.</li>';
  dBc.showModal(); $('#bc-text').focus();
}
const bcPick = (f) => { for (const c of $$('#bc-list input')) c.checked = f(c); };
$('#bc-agents').addEventListener('click', () => bcPick((c) => c.dataset.agent === 'true'));
$('#bc-all').addEventListener('click', () => bcPick(() => true));
$('#bc-none').addEventListener('click', () => bcPick(() => false));
$('#bc-form').addEventListener('submit', (e) => { e.preventDefault(); busy($('#bc-go'), async () => {
  const text = $('#bc-text').value.replace(/\s+$/, '');
  const to = $$('#bc-list input:checked');
  if (!text) { $('#bc-err').textContent = 'Write a message first.'; return; }
  if (!to.length) { $('#bc-err').textContent = 'Pick at least one session.'; return; }
  // multi-line text goes as a bracketed paste, so agents read it as one prompt
  const body = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
  const failed = [];
  await Promise.all(to.map(async (c) => {
    const t = W(c.value, c.dataset.w);
    try {
      await api(`${t}/keys`, { method: 'POST', body: { text: body } });
      if ($('#bc-enter').checked) { await new Promise((r) => setTimeout(r, 150)); await api(`${t}/keys`, { method: 'POST', body: { keys: ['Enter'] } }); }
    } catch { failed.push(c.value); }
  }));
  if (failed.length) { $('#bc-err').textContent = `Couldn't reach ${failed.join(', ')}.`; return; }
  dBc.close(); $('#bc-text').value = ''; toast(`Sent to ${to.length} session${to.length > 1 ? 's' : ''}`);
}); });

// ---------- watch links: view-only, one session, expire ----------
const dShare = $('#dlg-share');
let shareS = '';
export function openShare(name) {
  shareS = name; $('#share-s').textContent = name;
  $('#share-out').hidden = true; $('#share-err').textContent = '';
  dShare.showModal();
}
$('#share-h').addEventListener('click', (e) => {
  const b = e.target.closest('[data-h]'); if (!b) return;
  for (const x of $$('#share-h [data-h]')) x.setAttribute('aria-checked', x === b);
});
$('#share-go').addEventListener('click', () => busy($('#share-go'), async () => {
  $('#share-err').textContent = '';
  try {
    const d = await api('/api/share', { method: 'POST', body: { session: shareS, hours: +$('#share-h [aria-checked="true"]').dataset.h } });
    const url = `${reachable()}/#watch=${d.token}`;
    $('#share-url').value = url;
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    $('#share-qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
    $('#share-out').hidden = false;
  } catch (e) { $('#share-err').textContent = e.message; }
}));
$('#share-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#share-url').value); toast('Link copied'); }
  catch { $('#share-url').select(); toast('Select the link and copy it', true); }
});

// ---------- devices ----------
async function renderDevices() {
  try {
    const { self, devices } = await api('/api/devices');
    $('#dev-list').innerHTML = devices.sort((a, b) => (b.seen || b.created) - (a.seen || a.created)).map((d) => `<li>
      <span class="dev-n"><b>${esc(d.name)}${d.id === self ? ' <span class="muted">(this device)</span>' : ''}</b>
      <span class="muted small">${d.role === 'view' ? `watch only · ${esc(d.session)} · ends ${new Date(d.exp).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : d.seen ? `last used ${ago(d.seen / 1000)}` : 'not used yet'}</span></span>
      <button type="button" class="btn sm ghost danger" data-rm="${d.id}" data-self="${d.id === self}">Remove</button></li>`).join('') || '<li class="muted empty-row">No devices yet.</li>';
  } catch (e) { $('#dev-list').innerHTML = `<li class="muted empty-row">${esc(e.message)}</li>`; }
}
$('#dev-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  const me = b.dataset.self === 'true';
  if (!await ask({ title: 'Remove this device?', message: me ? 'This device is signed out and needs a new link to connect again.' : 'It is signed out at once.', ok: 'Remove', danger: true })) return;
  try { await act(`/api/devices/${b.dataset.rm}`, undefined, 'DELETE'); } catch { return; }
  if (me) { dSet.close(); return start(); }
  renderDevices();
});
$('#dev-rotate').addEventListener('click', async () => {
  if (!await ask({ title: 'Make a new server token?', message: 'Signed-in devices stay signed in. Links and QR codes made with the old token stop working; npm run pair shows the new one.', ok: 'New token', danger: true })) return;
  try { await act('/api/token/rotate'); toast('New server token made'); } catch {}
});

// ---------- settings ----------
const dSet = $('#dlg-settings');
export async function openSettings(tab = 'alerts') {
  $('#set-err').textContent = '';
  $('#set-server').textContent = `${cfg().name || S.info?.host || ''} · ${cfg().base}`;
  $('#set-presets').value = JSON.stringify(S.presets, null, 2);
  $('#set-stacks').value = JSON.stringify(S.stacks, null, 2);
  renderSnips(S.snippets);
  $('#set-theme').innerHTML = Object.keys(THEMES).map((k) => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join('');
  $('#set-theme').value = T.theme;
  $('#set-font').value = T.fontSize;
  $('#set-awake').checked = store.get('awake', touch);
  setTab(tab);
  dSet.showModal();
  try {
    const st = alertCfg = await api('/api/config/settings');
    $('#al-url').value = st.ntfy; $('#al-prompts').checked = st.alerts.prompts; $('#al-quiet').checked = st.alerts.quiet;
    $('#al-finished').checked = st.alerts.finished; $('#al-machine').checked = st.alerts.machine !== false; $('#al-secs').value = st.alerts.quietSeconds; $('#al-agents').value = st.agents.join(', ');
    $('#al-sub').hidden = !st.ntfy; $('#al-sub').href = st.ntfy.replace(/^http:/, 'https:');
  } catch (e) { $('#set-err').textContent = e.message; }
}
function setTab(t) {
  for (const b of $$('#set-tabs [data-tab]')) b.setAttribute('aria-selected', b.dataset.tab === t);
  for (const p of $$('#settings-form [data-pane]')) p.hidden = p.dataset.pane !== t;
  if (t === 'devices') renderDevices();
}
// snippets editor: one row per command, a name is optional
const snipRow = (s) => `<li><input class="sn-l" value="${esc(s.label || '')}" placeholder="Name (optional)" aria-label="Snippet name" maxlength="60">
  <input class="sn-c mono" value="${esc(s.cmd)}" placeholder="Command, e.g. git pull --rebase" aria-label="Command" spellcheck="false" autocapitalize="off" autocomplete="off">
  <button type="button" class="btn ghost icon" data-del aria-label="Delete snippet">${icon('trash')}</button></li>`;
function renderSnips(list) {
  $('#snip-list').innerHTML = list.map(snipRow).join('') || '<li class="muted empty-row">No snippets yet.</li>';
}
const readSnips = () => $$('#snip-list li:not(.empty-row)').map((li) => ({ label: $('.sn-l', li).value.trim(), cmd: $('.sn-c', li).value.trim() })).filter((s) => s.cmd);
$('#snip-add').addEventListener('click', () => {
  $('#snip-list .empty-row')?.remove();
  $('#snip-list').insertAdjacentHTML('beforeend', snipRow({ cmd: '' }));
  $('#snip-list li:last-child .sn-c').focus();
});
$('#snip-list').addEventListener('click', (e) => {
  const li = e.target.closest('[data-del]')?.closest('li'); if (!li) return;
  li.remove(); if (!$('#snip-list li')) renderSnips([]);
});
$('#set-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
$('#al-gen').addEventListener('click', () => {
  $('#al-url').value = `https://ntfy.sh/tmuxlab-${crypto.getRandomValues(new Uint32Array(2)).reduce((a, n) => a + n.toString(36), '')}`;
});
let alertCfg = {};
const isLocal = (b) => /^https?:\/\/(localhost|127\.|\[::1\])/.test(b);
async function saveAlerts() {
  const url = $('#al-url').value.trim();
  const base = isLocal(cfg().base) ? alertCfg.base : cfg().base; // localhost means nothing to a phone
  const body = { ...(base ? { base } : {}), ntfy: url, alerts: { prompts: $('#al-prompts').checked, quiet: $('#al-quiet').checked, finished: $('#al-finished').checked, machine: $('#al-machine').checked,
    quietSeconds: Math.max(5, +$('#al-secs').value || 20) }, agents: $('#al-agents').value.split(/[,\s]+/).filter(Boolean) };
  await act('/api/config/settings', body, 'PUT');
  $('#al-sub').hidden = !url; $('#al-sub').href = url.replace(/^http:/, 'https:');
}
$('#al-test').addEventListener('click', async () => { try { await saveAlerts(); await act('/api/alerts/test'); toast('Test alert sent. Check your phone.'); } catch {} });
$('#set-save').addEventListener('click', async () => {
  const parse = (id, name) => { try { return JSON.parse($(id).value); } catch (e) { throw new Error(`${name}: not valid JSON (${e.message})`); } };
  try {
    const presets = parse('#set-presets', 'Launchers'), stacks = parse('#set-stacks', 'Stacks');
    [S.presets, S.stacks, S.snippets] = await Promise.all([api('/api/config/presets', { method: 'PUT', body: presets }), api('/api/config/stacks', { method: 'PUT', body: stacks }),
      api('/api/config/snippets', { method: 'PUT', body: readSnips() })]);
    await saveAlerts();
    setTheme($('#set-theme').value); setFont(+$('#set-font').value); store.set('awake', $('#set-awake').checked);
    dSet.close(); toast('Settings saved');
  } catch (e) { $('#set-err').textContent = e.message; }
});
$('#set-logout').addEventListener('click', async () => {
  if (!await ask({ title: 'Forget this machine?', message: 'This device forgets the address and token. Sessions on the machine keep running.', ok: 'Forget machine', danger: true })) return;
  S.machines.splice(S.cur, 1); S.cur = 0; saveMachines(); dSet.close(); start();
});
