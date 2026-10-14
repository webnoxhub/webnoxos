// Time helpers. Everything is stored in UTC; everything is shown in the app timezone.

let TZ = 'Asia/Karachi';
let serverOffset = 0; // server clock − browser clock (ms)

export const setTimezone = (tz) => { TZ = tz || TZ; };
export const timezone = () => TZ;
export function syncServerTime(serverNowIso) {
  const t = Date.parse(serverNowIso);
  if (!Number.isNaN(t)) serverOffset = t - Date.now();
}
export const nowMs = () => Date.now() + serverOffset;

const fmtCache = new Map();
function fmt(opts) {
  const key = JSON.stringify(opts) + TZ;
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }));
  return fmtCache.get(key);
}

// ---------- Durations ----------
export function fmtDuration(sec, { zero = '0m' } = {}) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (sec === 0) return zero;
  if (sec < 60) return '<1m';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
export const hours = (sec) => (Math.round((Number(sec) || 0) / 36) / 100).toFixed(2);

// ---------- Timestamps (ISO) ----------
export const fmtTime = (iso) => (iso ? fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—');
export const fmtDateTime = (iso) => (iso ? fmt({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—');
export const fmtDateOfIso = (iso) => (iso ? fmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso)) : '—');
export function fmtRelative(iso) {
  if (!iso) return 'never';
  const s = Math.round((nowMs() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return fmtDateOfIso(iso);
}
// Calendar date (YYYY-MM-DD) of an instant, in the app timezone
export function localDate(iso) {
  const p = Object.fromEntries(fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export const todayStr = () => localDate(new Date(nowMs()).toISOString());
export function secondsIntoDay() {
  const p = Object.fromEntries(fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs())).map((x) => [x.type, x.value]));
  return (+p.hour) * 3600 + (+p.minute) * 60 + (+p.second);
}

// ---------- Calendar dates (YYYY-MM-DD strings, no timezone) ----------
const parse = (d) => { const [y, m, day] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, day)); };
const iso = (dt) => dt.toISOString().slice(0, 10);
export const addDays = (d, n) => { const x = parse(d); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
export function startOfWeek(d) { const x = parse(d); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return iso(x); }
export function startOfMonth(d) { return d.slice(0, 8) + '01'; }
export function endOfMonth(d) { const x = parse(startOfMonth(d)); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return iso(x); }
export function addMonths(d, n) { const x = parse(startOfMonth(d)); x.setUTCMonth(x.getUTCMonth() + n); return iso(x); }
const utcFmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts });
export const fmtDate = (d) => (d ? utcFmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(parse(d)) : '—');
export const fmtDateShort = (d) => (d ? utcFmt({ month: 'short', day: 'numeric' }).format(parse(d)) : '—');
export const fmtWeekday = (d) => utcFmt({ weekday: 'short' }).format(parse(d));
export const fmtMonth = (d) => utcFmt({ month: 'long', year: 'numeric' }).format(parse(d));
export const fmtLongDay = (d) => utcFmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(parse(d));

export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// UTC instant of local midnight for a calendar date in the app timezone
function tzOffset(utcMs) {
  const p = Object.fromEntries(fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
export function zonedMidnightIso(d) {
  const guess = parse(d).getTime();
  let t = guess - tzOffset(guess);
  const second = guess - tzOffset(t);
  if (second !== t) t = second;
  return new Date(t).toISOString();
}

// Due-date helpers
export function dueState(task) {
  if (!task.due_date || task.status === 'completed') return '';
  const today = todayStr();
  if (task.due_date < today) return 'over';
  if (daysBetween(today, task.due_date) <= 2) return 'soon';
  return '';
}
export function dueLabel(d) {
  if (!d) return '';
  const diff = daysBetween(todayStr(), d);
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  if (diff === -1) return 'Due yesterday';
  if (diff < 0) return `${-diff} days overdue`;
  return `Due ${fmtDateShort(d)}`;
}

export function greeting() {
  const h = Math.floor(secondsIntoDay() / 3600);
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// Period picker → { from, to } calendar dates
export function periodRange(p) {
  if (p.mode === 'day') return { from: p.anchor, to: p.anchor };
  if (p.mode === 'week') { const from = startOfWeek(p.anchor); return { from, to: addDays(from, 6) }; }
  if (p.mode === 'month') return { from: startOfMonth(p.anchor), to: endOfMonth(p.anchor) };
  return { from: p.from, to: p.to };
}
export function periodLabel(p) {
  const { from, to } = periodRange(p);
  if (p.mode === 'day') return fmtLongDay(from);
  if (p.mode === 'month') return fmtMonth(from);
  if (from.slice(0, 4) === to.slice(0, 4)) return `${fmtDateShort(from)} – ${fmtDateShort(to)}, ${to.slice(0, 4)}`;
  return `${fmtDate(from)} – ${fmtDate(to)}`;
}
export function shiftPeriod(p, dir) {
  if (p.mode === 'day') return { ...p, anchor: addDays(p.anchor, dir) };
  if (p.mode === 'week') return { ...p, anchor: addDays(p.anchor, 7 * dir) };
  if (p.mode === 'month') return { ...p, anchor: addMonths(p.anchor, dir) };
  return p;
}
