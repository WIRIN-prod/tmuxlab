// Boot: connect to the current machine, then poll.
import { $, esc, S, api, cfg, saveMachines, show, isApp, Unauthorized, busy } from './core.js';
import { refresh, refreshPreviews, refreshStats } from './wall.js';
import { closeTerm } from './term.js';
import './sheets.js';

// a link like http://host:7681/#token=... signs this browser in to that machine
(() => {
  const m = location.hash.match(/token=([\w-]+)/);
  if (!m || isApp) return;
  const i = S.machines.findIndex((x) => x.base === location.origin);
  if (i >= 0) { S.machines[i].token = m[1]; S.cur = i; } else { S.machines.push({ name: '', base: location.origin, token: m[1] }); S.cur = S.machines.length - 1; }
  saveMachines();
  history.replaceState(null, '', location.pathname);
})();

function showLogin(err, adding = false) {
  show('login');
  $('#login-err').textContent = err || '';
  $('#login-title').textContent = adding ? 'Add a machine' : 'Connect to a machine';
  // saved machines stay one tap away, e.g. when the current one is offline
  $('#login-saved').hidden = !S.machines.length;
  $('#login-saved').innerHTML = S.machines.length ? '<span class="muted">Saved machines</span>' + S.machines.map((m, i) =>
    `<button type="button" class="btn sm ${i === S.cur && !adding ? 'ghost' : ''}" data-m="${i}">${esc(m.name || new URL(m.base).host)}</button>`).join('') : '';
  if (!isApp && !$('#login-url').value && !S.machines.some((m) => m.base === location.origin)) $('#login-url').value = location.origin;
}
export const addMachine = () => { stop(); $('#login-url').value = ''; $('#login-token').value = ''; showLogin('', true); };
$('#login-saved').addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b) { S.cur = +b.dataset.m; saveMachines(); start(); } });

$('#login-show').addEventListener('click', (e) => {
  const on = $('#login-token').type === 'password';
  $('#login-token').type = on ? 'text' : 'password';
  e.currentTarget.setAttribute('aria-pressed', on); e.currentTarget.setAttribute('aria-label', on ? 'Hide token' : 'Show token');
});
$('#login-form').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter || $('#login-form .btn.primary'), connect); });
async function connect() {
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
  const mach = { name: '', base, token };
  try {
    const info = await api('/api/info', { m: mach, timeout: 6000 });
    mach.name = info.host;
    const i = S.machines.findIndex((x) => x.base === base);
    if (i >= 0) S.machines[i] = { ...S.machines[i], token }; else S.machines.push(mach);
    S.cur = i >= 0 ? i : S.machines.length - 1;
    saveMachines();
    $('#login-token').value = '';
    start();
  } catch (err) {
    $('#login-err').textContent = err instanceof Unauthorized ? err.message : `Could not reach ${base}. Check the server is running and this device can reach it.`;
  }
}

let pollers = [];
const stop = () => { pollers.forEach(clearInterval); pollers = []; };
export async function start() {
  stop();
  if (!$('#term').hidden) closeTerm();
  if (!cfg()) return showLogin();
  S.sessions = []; S.previews = {}; S.stats = null;
  $('#grid').replaceChildren();
  try {
    const [info, presets, stacks, projects, snippets] = await Promise.all([api('/api/info'), api('/api/config/presets'), api('/api/config/stacks'),
      api('/api/config/projects').catch(() => []), api('/api/config/snippets').catch(() => [])]); // older servers lack projects/snippets
    Object.assign(S, { info, presets, stacks, projects, snippets });
    document.title = `tmuxlab · ${cfg().name || info.host}`;
  } catch (e) {
    return showLogin(e instanceof Unauthorized ? e.message : `Could not reach ${cfg().base}. Check the server is running.`, S.machines.length > 1);
  }
  show('wall');
  await refresh();
  refreshPreviews(); refreshStats();
  pollers = [setInterval(() => !document.hidden && refresh(), 2000), setInterval(refreshPreviews, 3000), setInterval(refreshStats, 3000)];
}
start();

if ('serviceWorker' in navigator && !isApp && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
