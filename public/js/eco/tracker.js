// Automatic presence tracking.
// Records that interaction happened (never what was typed), sends a heartbeat every minute,
// and switches to idle after the configured minutes with no interaction.
import { supabase } from './supabase.js';
import { syncServerTime } from './time.js';

const HEARTBEAT_MS = 60_000;
const CHECK_MS = 10_000;
const SHARED_KEY = 'ehos.lastActivity';

let uid = null;
let sessionId = null;
let idleMs = 5 * 60_000;
let state = 'active';
let lastLocal = Date.now();
let lastShared = 0;
let timers = [];
let inflight = null;
let unbind = null;

const sidKey = () => `ehos.sid.${uid}`;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

function deviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}

function lastActivity() {
  const shared = Number(store.get(SHARED_KEY)) || 0;
  return Math.max(lastLocal, shared);
}

function markActivity() {
  const now = Date.now();
  lastLocal = now;
  if (now - lastShared > 5000) { lastShared = now; store.set(SHARED_KEY, String(now)); }
  if (state === 'idle') { state = 'active'; emit(); beat(); }
}

function emit() { window.dispatchEvent(new CustomEvent('ehos:presence', { detail: { state } })); }

async function newSession(via) {
  const { data, error } = await supabase.rpc('session_start', {
    p_user_agent: navigator.userAgent, p_device: deviceLabel(), p_via: via,
  });
  if (error) throw error;
  sessionId = data;
  store.set(sidKey(), sessionId);
  state = 'active';
  emit();
}

function beat() {
  if (!sessionId) return Promise.resolve();
  if (inflight) return inflight;
  const idleFor = Math.round((Date.now() - lastActivity()) / 1000);
  inflight = supabase.rpc('session_heartbeat', { p_session_id: sessionId, p_state: state, p_idle_for: idleFor })
    .then(async ({ data, error }) => {
      if (error) return; // offline or token refreshing — try again next round
      if (data?.server_now) syncServerTime(data.server_now);
      if (data && data.ok === false) {
        // session ended (laptop slept, lost connection, or account deactivated)
        try { await newSession('resume'); }
        catch (e) {
          if (/inactive|suspended|not active/i.test(e?.message || '')) {
            window.dispatchEvent(new CustomEvent('ehos:account-inactive'));
          }
        }
      }
    })
    .catch(() => {})
    .finally(() => { inflight = null; });
  return inflight;
}

function check() {
  const idleFor = Date.now() - lastActivity();
  if (state === 'active' && idleFor >= idleMs) { state = 'idle'; emit(); beat(); }
  else if (state === 'idle' && idleFor < idleMs) { state = 'active'; emit(); beat(); }
}

export async function startTracking({ userId, idleMinutes = 5, via = 'resume' }) {
  stopTimers();
  uid = userId;
  idleMs = Math.max(1, idleMinutes) * 60_000;
  lastLocal = Date.now();
  store.set(SHARED_KEY, String(lastLocal));

  sessionId = via === 'login' ? null : store.get(sidKey());
  if (sessionId) {
    const { data, error } = await supabase.rpc('session_heartbeat', { p_session_id: sessionId, p_state: 'active', p_idle_for: 0 });
    if (error || !data?.ok) sessionId = null;
    else if (data.server_now) syncServerTime(data.server_now);
  }
  if (!sessionId) await newSession(via);

  if (!unbind) {
    const opts = { passive: true, capture: true };
    let lastMove = 0;
    const onMove = () => { const n = Date.now(); if (n - lastMove > 2000) { lastMove = n; markActivity(); } };
    const onVis = () => { if (document.visibilityState === 'visible') { markActivity(); beat(); } };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
    evs.forEach((ev) => window.addEventListener(ev, markActivity, opts));
    window.addEventListener('mousemove', onMove, opts);
    window.addEventListener('focus', markActivity);
    document.addEventListener('visibilitychange', onVis);
    unbind = () => {
      evs.forEach((ev) => window.removeEventListener(ev, markActivity, opts));
      window.removeEventListener('mousemove', onMove, opts);
      window.removeEventListener('focus', markActivity);
      document.removeEventListener('visibilitychange', onVis);
    };
  }
  timers.push(setInterval(check, CHECK_MS), setInterval(beat, HEARTBEAT_MS));
}

function stopTimers() { timers.forEach(clearInterval); timers = []; }

export function setIdleMinutes(min) { idleMs = Math.max(1, min) * 60_000; }
export const presenceState = () => state;

// Explicit sign-out: ends the session on the server (and pauses a running task timer)
export async function endTracking() {
  stopTimers();
  unbind?.(); unbind = null;
  if (sessionId) {
    try { await supabase.rpc('session_end', { p_session_id: sessionId }); } catch { /* offline: the server ends it after 3 min */ }
  }
  if (uid) store.del(sidKey());
  sessionId = null;
}

export function forgetSessions() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith('ehos.sid.')).forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}
