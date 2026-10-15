// Turns a workspace + its subscription into a status chip and "days left".
// Works from dates only, so it is correct even if no billing sweep has run yet.
import { daysBetween } from '/js/time.js';

export const TYPE_LABEL = { master_project: 'Personal', rented: 'On rent' };
export const CYCLE_LABEL = { trial_7: '7-day trial', trial_14: '14-day trial', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };

const plural = (n) => n + (n === 1 ? ' day' : ' days');

export function statusInfo(ws, sub, today) {
  if (ws.type === 'master_project') return { label: 'Internal — no rent', tone: 'muted', days: null };
  if (ws.status === 'archived') return { label: 'Archived', tone: 'muted', days: null };
  if (ws.status === 'suspended') return { label: 'Suspended', tone: 'err', days: sub && sub.next_due ? daysBetween(today, sub.next_due) : null };
  if (ws.status === 'setup') return { label: 'Setup', tone: 'muted', days: null };
  if (!sub) return { label: 'No plan', tone: 'muted', days: null };
  if (sub.status === 'cancelled') return { label: 'Cancelled', tone: 'muted', days: null };

  const inTrial = sub.trial_ends_on && !sub.next_due;
  if (inTrial) {
    const d = daysBetween(today, sub.trial_ends_on);
    if (d >= 0) return { label: d === 0 ? 'Trial · ends today' : 'Trial · ' + plural(d) + ' left', tone: 'accent', days: d };
  }
  if (sub.next_due) {
    const d = daysBetween(today, sub.next_due);
    if (d < 0) return { label: 'Overdue by ' + plural(-d), tone: 'err', days: d };
    if (d === 0) return { label: 'Due today', tone: 'warn', days: 0 };
    if (d <= 3) return { label: 'Due in ' + plural(d), tone: 'warn', days: d };
    return { label: 'Active', tone: 'ok', days: d };
  }
  return { label: 'Active', tone: 'ok', days: null };
}

// Workspaces that need the Master's attention, most urgent first.
export function needsAttention(info) {
  return info.tone === 'err' || info.tone === 'warn' || (info.tone === 'accent' && info.days !== null && info.days <= 3);
}
