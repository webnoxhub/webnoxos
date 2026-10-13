import { esc, icon } from '/js/ui.js';
import { todayISO, fmtDate, money } from '/js/time.js';
import { statusInfo, TYPE_LABEL, CYCLE_LABEL } from '/js/billing.js';

const FILTERS = [
  ['all', 'All'], ['trial', 'Trial'], ['active', 'Active'], ['suspended', 'Suspended'], ['archived', 'Archived'],
];

export default async function render({ el, sb, setTitle }) {
  setTitle('Workspaces');
  const today = todayISO();
  el.innerHTML = '<p class="muted pad">Loading…</p>';

  const [wsR, memR] = await Promise.all([
    sb.from('workspaces').select('id,name,slug,type,status,subscriptions(cycle,amount_original,currency,next_due,trial_ends_on,status)')
      .order('created_at', { ascending: false }),
    sb.from('master_member_list').select('workspace_id'),
  ]);
  if (wsR.error || memR.error) {
    el.innerHTML = '<div class="empty"><p>Could not load workspaces.</p><button class="btn" id="retry" type="button">Try again</button></div>';
    el.querySelector('#retry').addEventListener('click', () => render({ el, sb, setTitle }));
    return;
  }

  const members = {};
  (memR.data || []).forEach((m) => { members[m.workspace_id] = (members[m.workspace_id] || 0) + 1; });
  const list = (wsR.data || []).map((w) => {
    const sub = Array.isArray(w.subscriptions) ? w.subscriptions[0] : w.subscriptions;
    return { w, sub: sub || null, info: statusInfo(w, sub || null, today), n: members[w.id] || 0 };
  });

  if (!list.length) {
    el.innerHTML = '<div class="empty">' + icon('building', 36) +
      '<p>No workspaces yet.</p><p class="muted small">Workspaces you create will appear here.</p></div>';
    return;
  }

  const count = (k) => (k === 'all' ? list.length : list.filter((x) => x.w.status === k).length);
  let filter = 'all', q = '';

  el.innerHTML =
    '<div class="toolbar">' +
      '<div class="chips" role="group" aria-label="Filter by status">' + FILTERS.map(([k, label]) =>
        '<button class="fchip" type="button" data-f="' + k + '" aria-pressed="' + (k === 'all') + '">' +
        esc(label) + ' <span class="fcount">' + count(k) + '</span></button>').join('') + '</div>' +
      '<label class="search">' + icon('search', 16) +
        '<input id="q" type="search" placeholder="Search workspaces" aria-label="Search workspaces" autocomplete="off"></label>' +
    '</div>' +
    '<div class="table-wrap"><table class="wtable"><thead><tr>' +
      '<th>Workspace</th><th>Type</th><th>Members</th><th>Plan</th><th>Next due</th><th>Days left</th><th>Status</th>' +
    '</tr></thead><tbody id="rows"></tbody></table></div>' +
    '<div class="empty" id="none" hidden><p>No workspaces match.</p></div>';

  const rows = el.querySelector('#rows'), none = el.querySelector('#none');

  function paint() {
    const shown = list.filter((x) =>
      (filter === 'all' || x.w.status === filter) &&
      (!q || (x.w.name + ' ' + x.w.slug).toLowerCase().includes(q)));
    rows.innerHTML = shown.map(({ w, sub, info, n }) => {
      const days = info.days === null ? '—' : String(info.days);
      return '<tr>' +
        '<td data-l="Workspace" class="c-name"><strong>' + esc(w.name) + '</strong><span class="muted small">/' + esc(w.slug) + '</span></td>' +
        '<td data-l="Type">' + esc(TYPE_LABEL[w.type] || w.type) + '</td>' +
        '<td data-l="Members">' + n + '</td>' +
        '<td data-l="Plan">' + (sub ? esc(CYCLE_LABEL[sub.cycle] || sub.cycle) + '<span class="muted small">' +
            esc(sub.currency) + ' ' + esc(Number(sub.amount_original).toLocaleString('en-US')) + '</span>' : '—') + '</td>' +
        '<td data-l="Next due">' + esc(sub ? fmtDate(sub.next_due || sub.trial_ends_on) : '—') + '</td>' +
        '<td data-l="Days left" class="c-days' + (info.days !== null && info.days < 0 ? ' neg' : '') + '">' + esc(days) + '</td>' +
        '<td data-l="Status"><span class="chip chip-' + info.tone + '">' + esc(info.label) + '</span></td>' +
      '</tr>';
    }).join('');
    none.hidden = shown.length > 0;
    el.querySelector('.table-wrap').hidden = shown.length === 0;
  }

  el.querySelectorAll('.fchip').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    el.querySelectorAll('.fchip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    paint();
  }));
  el.querySelector('#q').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); paint(); });
  paint();
}
