// Standard 5-field cron: minute hour day-of-month month day-of-week (0 or 7 = Sunday).
// Supports *, n, a-b, lists and /step.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function field(expr, [lo, hi]) {
  const set = new Set();
  for (const part of expr.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad cron field "${part}"`);
    let [a, b] = m[1] === '*' ? [lo, hi] : m[1].split('-').map(Number);
    if (b === undefined) b = m[2] ? hi : a;
    const st = m[2] ? +m[2] : 1;
    if (a < lo || b > hi || a > b || st < 1) throw new Error(`cron field "${part}" out of range ${lo}-${hi}`);
    for (let v = a; v <= b; v += st) set.add(v);
  }
  return set;
}

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron needs 5 fields: minute hour day month weekday');
  const [min, hour, dom, mon, dow] = parts.map((p, i) => field(p, RANGES[i]));
  if (dow.has(7)) dow.add(0);
  return { min, hour, dom, mon, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

export function cronMatches(c, d) {
  if (!c.min.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.mon.has(d.getMonth() + 1)) return false;
  const dm = c.dom.has(d.getDate()), dw = c.dow.has(d.getDay());
  // classic cron: when both day fields are restricted, either may match
  return c.domAny || c.dowAny ? dm && dw : dm || dw;
}

export function nextRun(c, from = new Date()) {
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++, d.setMinutes(d.getMinutes() + 1)) if (cronMatches(c, d)) return d;
  return null;
}
