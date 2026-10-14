// Task timer state + live clocks. The server owns the timestamps; the browser only displays.
import { rpc } from './data.js';
import { nowMs, syncServerTime, fmtClock, fmtDuration } from './time.js';
import { esc, icon, toast } from './ui.js';

let running = null; // { task_id, title, started_at }
const listeners = new Set();

export const runningTimer = () => running;
export const onTimerChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => listeners.forEach((fn) => { try { fn(running); } catch (e) { console.error(e); } });

export async function refreshTimer() {
  const before = JSON.stringify(running);
  try {
    const r = await rpc('my_timer');
    if (r?.server_now) syncServerTime(r.server_now);
    running = r?.running || null;
  } catch { /* keep last known */ }
  if (JSON.stringify(running) !== before) notify();
  return running;
}

async function act(fn, okMsg) {
  try {
    await fn();
    await refreshTimer();
    window.dispatchEvent(new CustomEvent('ehos:data-changed'));
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message, 'error');
    await refreshTimer();
  }
}
export const startTimer = (taskId) => act(() => rpc('timer_start', { p_task_id: taskId }), 'Timer started');
export const pauseTimer = () => act(() => rpc('timer_pause'), 'Timer paused');
export const stopTimer = (taskId) => act(() => rpc('timer_stop', { p_task_id: taskId }), 'Timer stopped');

// Timer state of one task for the current member, from task_time_totals
export function timerStateFor(totalsRow) {
  if (!totalsRow) return 'none';
  if (totalsRow.running) return 'running';
  if (totalsRow.last_end_reason && totalsRow.last_end_reason !== 'stop') return 'paused';
  return 'stopped';
}

// ---------- Live clocks ----------
// <span data-live-base="120" data-live-since="1700000000000" data-live-format="clock|duration">
export function liveAttrs(baseSec, sinceMs, format = 'duration') {
  return `data-live-base="${Math.round(baseSec || 0)}" data-live-since="${sinceMs || ''}" data-live-format="${format}"`;
}
function tick() {
  const now = nowMs();
  document.querySelectorAll('[data-live-since]').forEach((el) => {
    const since = Number(el.dataset.liveSince);
    if (!since) return;
    const sec = Number(el.dataset.liveBase || 0) + (now - since) / 1000;
    const text = el.dataset.liveFormat === 'clock' ? fmtClock(sec) : fmtDuration(sec);
    if (el.textContent !== text) el.textContent = text;
  });
}
setInterval(tick, 1000);

// ---------- Top bar pill ----------
export function mountTimerPill(container, openTask) {
  const render = () => {
    if (!running) { container.innerHTML = ''; return; }
    const since = Date.parse(running.started_at);
    container.innerHTML = `
      <div class="timer-pill" role="status" aria-label="Timer running">
        <span class="pulse"></span>
        <span class="t-title" data-open title="${esc(running.title)}">${esc(running.title)}</span>
        <span class="t-clock" ${liveAttrs(0, since, 'clock')}>${fmtClock((nowMs() - since) / 1000)}</span>
        <button class="btn btn-sm btn-icon" data-pause title="Pause timer" aria-label="Pause timer">${icon('pause', 14)}</button>
        <button class="btn btn-sm btn-icon" data-stop title="Stop timer" aria-label="Stop timer">${icon('stop', 13)}</button>
      </div>`;
    container.querySelector('[data-open]').onclick = () => openTask(running.task_id);
    container.querySelector('[data-pause]').onclick = () => pauseTimer();
    container.querySelector('[data-stop]').onclick = () => stopTimer(running.task_id);
  };
  onTimerChange(render);
  render();
}
