// Boot: connect to the current machine, then poll.
import { $, esc, S, api, act, toast, cfg, saveMachines, learnAddrs, origin, show, isApp, Unauthorized, busy, VERSION } from './core.js';
import { refresh, refreshPreviews, refreshStats } from './wall.js';
import { closeTerm, openTerm } from './term.js';
import './sheets.js';

// a watch link (#watch=...) opens one session view-only; it is never saved over this browser's own sign-in
(() => {
  const m = location.hash.match(/watch=([\w-]+)/);
  if (!m) return;
  S.watch = true; S.machines = [{ name: '', base: location.origin, token: m[1] }]; S.cur = 0;
  history.replaceState(null, '', location.pathname);
})();
// a link like http://host:7681/#token=... signs this browser in to that machine
(() => {
  const m = location.hash.match(/token=([\w-]+)/);
  if (!m || isApp || S.watch) return;
  const i = S.machines.findIndex((x) => x.base === location.origin);
  if (i >= 0) { S.machines[i].token = m[1]; S.machines[i].named = false; S.cur = i; } else { S.machines.push({ name: '', base: location.origin, token: m[1] }); S.cur = S.machines.length - 1; }
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
$('#login-scan').hidden = !('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia);
$('#login-scan').addEventListener('click', async () => {
  const d = $('#dlg-scan'), v = $('#scan-v');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch { $('#login-err').textContent = 'The camera is not available. Allow camera access for tmuxlab, or paste the link instead.'; return; }
  d.addEventListener('close', () => stream.getTracks().forEach((t) => t.stop()), { once: true });
  v.srcObject = stream; d.showModal();
  try { await v.play(); } catch {}
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  while (d.open) {
    try {
      const [c] = await det.detect(v);
      if (c?.rawValue) {
        if (!/#token=/.test(c.rawValue)) { $('#scan-err').textContent = 'That QR code is not a tmuxlab link.'; }
        else { d.close(); $('#login-url').value = c.rawValue; $('#login-token').value = ''; return busy($('#login-form .btn.primary'), connect); }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
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
    if (i >= 0) S.machines[i] = { ...S.machines[i], token, named: false }; else S.machines.push(mach);
    S.cur = i >= 0 ? i : S.machines.length - 1;
    saveMachines();
    $('#login-token').value = '';
    start();
  } catch (err) {
    $('#login-err').textContent = err instanceof Unauthorized ? err.message : `Could not reach ${base}. Check the server is running and this device can reach it.`;
  }
}

// the server token only signs a device in: swap it for this device's own revocable token
const devName = () => {
  if (isApp) return 'Android app';
  const u = navigator.userAgent;
  const b = /Edg\//.test(u) ? 'Edge' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'Browser';
  const o = /Android/.test(u) ? 'Android' : /iPhone|iPad/.test(u) ? 'iOS' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : '';
  return o ? `${b} on ${o}` : b;
};
async function adoptDevice(info) {
  const m = cfg();
  if (info.auth === 'server') {
    const d = await api('/api/devices', { method: 'POST', body: { name: devName() } }).catch(() => null); // older servers: keep the server token
    if (d?.token) { m.token = d.token; m.named = true; saveMachines(); }
  } else if (info.auth === 'device' && info.role === 'full' && !m.named) {
    await api('/api/devices/self/name', { method: 'POST', body: { name: devName() } }).catch(() => {});
    m.named = true; saveMachines();
  }
}

// the app: when the machine has a newer APK, offer it (Android asks before installing)
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
function offerUpdate(info) {
  const on = isApp && !!info?.apk && newer(info.apk, VERSION);
  $('#update').hidden = !on;
  if (on) $('#up-title').textContent = `tmuxlab ${info.apk} is ready (you have ${VERSION})`;
}
$('#up-go').addEventListener('click', () => window.open(origin() + '/tmuxlab.apk', '_blank'));
// reopening the app resumes it rather than restarting it, so check again whenever it comes back
document.addEventListener('visibilitychange', () => { if (isApp && !document.hidden && cfg()) api('/api/info').then(offerUpdate, () => {}); });

// after a reboot: the sessions that were open before, one tap away
async function offerRestore() {
  const o = await api('/api/restore').catch(() => null); // older servers: nothing to offer
  $('#restore').hidden = !o?.sessions?.length;
  if (!o?.sessions?.length) return;
  const n = o.sessions.length;
  $('#rs-title').textContent = `${n} session${n > 1 ? 's were' : ' was'} open before this machine restarted`;
  $('#rs-list').textContent = o.sessions.map((s) => s.name).join(', ');
  $('#rs-run').closest('label').hidden = !o.sessions.some((s) => s.run.length);
  $('#rs-run').closest('label').title = o.sessions.flatMap((s) => s.run).join('\n');
}
$('#rs-go').addEventListener('click', () => busy($('#rs-go'), async () => {
  const r = await act('/api/restore', { run: $('#rs-run').checked });
  $('#restore').hidden = true; toast(`Restored ${r.restored.length} session${r.restored.length === 1 ? '' : 's'}`); refresh();
}));
$('#rs-no').addEventListener('click', async () => { $('#restore').hidden = true; await act('/api/restore', undefined, 'DELETE').catch(() => {}); });

let pollers = [];
const stop = () => { pollers.forEach(clearInterval); pollers = []; };
export async function start() {
  stop();
  if (!$('#term').hidden) closeTerm();
  if (!cfg()) return showLogin();
  S.sessions = []; S.previews = {}; S.stats = null;
  $('#grid').replaceChildren();
  try {
    const info = await api('/api/info');
    learnAddrs(cfg(), info);
    const get = (p) => info.role === 'view' ? [] : api(p).catch(() => []); // watch links can't read config; older servers lack projects/snippets
    const [presets, stacks, projects, snippets] = await Promise.all(['/api/config/presets', '/api/config/stacks', '/api/config/projects', '/api/config/snippets'].map(get));
    Object.assign(S, { info, presets, stacks, projects, snippets });
    await adoptDevice(info);
    document.title = `tmuxlab · ${cfg().name || info.host}`;
  } catch (e) {
    return showLogin(e instanceof Unauthorized ? e.message : `Could not reach ${origin()}. Check the server is running.`, S.machines.length > 1);
  }
  if (S.info.role === 'view') { // watch link: just that session, nothing to change
    document.body.classList.add('viewer');
    await refresh(); openTerm(S.info.session);
    pollers = [setInterval(() => !document.hidden && refresh(), 3000)];
    return;
  }
  show('wall');
  offerRestore(); offerUpdate(S.info);
  await refresh();
  refreshPreviews(); refreshStats();
  pollers = [setInterval(() => !document.hidden && refresh(), 2000), setInterval(refreshPreviews, 3000), setInterval(refreshStats, 3000)];
}
start();

if ('serviceWorker' in navigator && !isApp && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
