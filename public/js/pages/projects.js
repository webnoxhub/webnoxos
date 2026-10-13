import { esc, icon, toast } from '/js/ui.js';
import { openModal, api, fieldError } from '/js/modal.js';
import { bindCombo } from '/js/combo.js';
import { DEPARTMENTS, DESIGNATIONS } from '/js/lists.js';

const STATUS = { active: ['Active', 'chip-ok'], on_hold: ['On hold', 'chip-warn'], completed: ['Completed', 'chip-muted'] };
const REQ = { pending: ['Waiting for approval', 'chip-warn'], discussing: ['In discussion', 'chip-accent'], approved: ['Approved', 'chip-ok'], declined: ['Declined', 'chip-err'] };
const chip = (map, k) => '<span class="chip ' + (map[k] ? map[k][1] : 'chip-muted') + '">' + esc(map[k] ? map[k][0] : k) + '</span>';
const when = (iso) => iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
const itemText = (i) => i.qty + ' × ' + i.designation + (i.department ? ' (' + i.department + ')' : '');

export default async function render(ctx) {
  const { el, setTitle } = ctx;
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  const id = q.get('id');
  el.innerHTML = '<p class="muted pad">Loading…</p>';
  try {
    if (id) return await detail(ctx, id);
    setTitle('Projects');
    return await list(ctx);
  } catch (e) {
    el.innerHTML = '<div class="empty"><p>' + esc(e.message || 'Could not load projects.') + '</p><button class="btn" id="retry" type="button">Try again</button></div>';
    el.querySelector('#retry').addEventListener('click', () => render(ctx));
  }
}

// ── List ────────────────────────────────────────────────────────────────────
async function list({ el, sb }) {
  const d = await api(sb, '/api/projects?a=list');
  el.innerHTML =
    '<div class="page-head"><h2 class="page-title">Projects</h2>' +
      (d.can_create ? '<button class="btn" id="newProj" type="button">' + icon('plus', 16) + ' New project</button>' : '') + '</div>' +
    (d.projects.length
      ? '<div class="table-wrap"><table class="wtable"><thead><tr><th>Project</th><th>Status</th><th>Project Manager</th><th>People</th><th>Requests</th></tr></thead><tbody>' +
        d.projects.map((p) =>
          '<tr class="row-link" data-id="' + esc(p.id) + '" tabindex="0"><td data-l="Project" class="c-name"><strong>' + esc(p.name) + '</strong><span class="muted small">' + esc(p.client || '') + '</span></td>' +
          '<td data-l="Status">' + chip(STATUS, p.status) + '</td><td data-l="Project Manager">' + esc(p.manager_name || '—') + '</td>' +
          '<td data-l="People">' + p.members + '</td>' +
          '<td data-l="Requests">' + (p.open_requests ? '<span class="chip chip-warn">' + p.open_requests + ' open</span>' : '—') + '</td></tr>').join('') +
        '</tbody></table></div>'
      : '<div class="empty"><p>' + (d.can_create ? 'No projects yet. Create the first one.' : 'You are not part of any project yet.') + '</p></div>');
  el.querySelectorAll('.row-link').forEach((r) => {
    const go = () => { location.hash = '#/projects?id=' + r.dataset.id; };
    r.addEventListener('click', go); r.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  const nb = el.querySelector('#newProj');
  if (nb) nb.addEventListener('click', () => projectModal({ sb, pms: d.pms, onDone: () => list({ el, sb }) }));
}

function projectModal({ sb, pms, project, onDone }) {
  const editing = !!project;
  const m = openModal({
    title: editing ? 'Edit project' : 'New project', wide: true,
    body:
      '<div class="wf-group"><label class="wf-label" for="pName">Project name <span class="req">*</span></label><input class="wf-input" id="pName" maxlength="120" value="' + esc(project ? project.name : '') + '"></div>' +
      '<div class="wf-row"><div class="wf-group"><label class="wf-label" for="pClient">Client</label><input class="wf-input" id="pClient" maxlength="120" value="' + esc(project ? project.client || '' : '') + '"></div>' +
      (editing ? '<div class="wf-group"><label class="wf-label" for="pStatus">Status</label><select class="wf-select" id="pStatus">' +
        Object.entries(STATUS).map(([k, v]) => '<option value="' + k + '"' + (project.status === k ? ' selected' : '') + '>' + v[0] + '</option>').join('') + '</select></div>' : '<div></div>') + '</div>' +
      '<div class="wf-group"><label class="wf-label" for="pMgr">Project Manager</label><select class="wf-select" id="pMgr"><option value="">Not assigned yet</option>' +
        pms.map((p) => '<option value="' + esc(p.id) + '"' + (project && project.manager_id === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>' +
        (pms.length ? '' : '<p class="wf-hint">No one has the Project Manager role yet. Add it to a team member first.</p>') + '</div>' +
      '<div class="wf-group"><label class="wf-label" for="pDesc">Description</label><textarea class="wf-input wf-area" id="pDesc" maxlength="2000">' + esc(project ? project.description || '' : '') + '</textarea></div>' +
      '<p class="wf-err" id="pErr" hidden></p>',
    foot: '<button class="btn btn-ghost" id="pCancel" type="button">Cancel</button><button class="btn" id="pSave" type="button">' + (editing ? 'Save changes' : 'Create project') + '</button>',
  });
  const $ = (i) => m.overlay.querySelector('#' + i);
  $('pCancel').addEventListener('click', m.close);
  $('pSave').addEventListener('click', async (e) => {
    const name = $('pName').value.trim();
    if (!name) return fieldError($('pName'), 'Project name is required.');
    const body = { name, client: $('pClient').value.trim(), description: $('pDesc').value.trim(), manager_id: $('pMgr').value || null };
    if (editing) body.status = $('pStatus').value;
    e.target.disabled = true;
    try {
      if (editing) await api(sb, '/api/projects?a=update&id=' + encodeURIComponent(project.id), { method: 'POST', body: JSON.stringify(body) });
      else await api(sb, '/api/projects?a=create', { method: 'POST', body: JSON.stringify(body) });
      m.close(); toast(editing ? 'Saved' : 'Project created'); onDone();
    } catch (x) { $('pErr').textContent = x.message; $('pErr').hidden = false; e.target.disabled = false; }
  });
}

// ── Detail ──────────────────────────────────────────────────────────────────
async function detail(ctx, id) {
  const { el, sb, setTitle } = ctx;
  const d = await api(sb, '/api/projects?a=get&id=' + encodeURIComponent(id));
  const p = d.project;
  setTitle(p.name);
  const reload = () => detail(ctx, id);

  el.innerHTML =
    '<p class="back"><a href="#/projects">← Projects</a></p>' +
    '<div class="page-head"><div><h2 class="page-title">' + esc(p.name) + '</h2>' +
      '<p class="muted small">' + esc(p.client || 'No client') + ' · Project Manager: ' + esc(p.manager_name || 'not assigned') + '</p></div>' +
      '<span class="spacer"></span>' + chip(STATUS, p.status) +
      (d.can.manage ? '<button class="btn btn-ghost" id="editProj" type="button">' + icon('edit', 16) + ' Edit</button>' : '') + '</div>' +
    (p.description ? '<p class="proj-desc">' + esc(p.description) + '</p>' : '') +

    '<section class="card sect"><div class="sect-head"><h3>People</h3></div>' +
      (d.members.length ? '<ul class="plist">' + d.members.map((x) =>
        '<li><span><strong>' + esc(x.name || '—') + '</strong> <span class="muted small">' + esc([x.job_title, x.department].filter(Boolean).join(' · ')) + '</span></span>' +
        (d.can.remove ? '<button class="btn btn-sm btn-ghost" type="button" data-rm="' + esc(x.id) + '">Remove</button>' : '') + '</li>').join('') + '</ul>'
        : '<p class="muted small">No one added yet.' + (d.can.request ? ' Send a request below to get people approved.' : '') + '</p>') +
      slotsHTML(d) + '</section>' +

    '<section class="card sect"><div class="sect-head"><h3>Requests for people</h3>' +
      (d.can.request ? '<button class="btn btn-sm" id="newReq" type="button">' + icon('plus', 14) + ' New request</button>' : '') + '</div>' +
      (d.requests.length ? d.requests.map((r) => requestHTML(r, d)).join('') : '<p class="muted small">No requests yet.</p>') + '</section>';

  const ed = el.querySelector('#editProj');
  if (ed) ed.addEventListener('click', async () => {
    const l = await api(sb, '/api/projects?a=list');
    projectModal({ sb, pms: l.pms, project: p, onDone: reload });
  });
  el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this person from the project?')) return;
    b.disabled = true;
    try { await api(sb, '/api/projects?a=removemember&id=' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ user_id: b.dataset.rm }) }); toast('Removed'); reload(); }
    catch (x) { toast(x.message); b.disabled = false; }
  }));
  el.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', async () => {
    const sel = el.querySelector('select[data-slot="' + b.dataset.add + '"]');
    if (!sel.value) return toast('Choose a person first');
    b.disabled = true;
    try { await api(sb, '/api/projects?a=addmember&id=' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ user_id: sel.value, item_id: b.dataset.add }) }); toast('Added'); reload(); }
    catch (x) { toast(x.message); b.disabled = false; }
  }));
  const nr = el.querySelector('#newReq');
  if (nr) nr.addEventListener('click', () => requestModal({ sb, id, onDone: reload }));

  el.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', () => decideModal({ sb, reqId: b.dataset.req, decision: b.dataset.decide, onDone: reload })));
  el.querySelectorAll('form[data-comment]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = f.querySelector('input'); const body = inp.value.trim(); if (!body) return;
    inp.disabled = true;
    try { await api(sb, '/api/projects?a=comment&id=' + encodeURIComponent(f.dataset.comment), { method: 'POST', body: JSON.stringify({ body }) }); reload(); }
    catch (x) { toast(x.message); inp.disabled = false; }
  }));
}

// Approved slots that still have room: the Project Manager picks matching people here.
function slotsHTML(d) {
  if (!d.can.add_members) return '';
  const rows = [];
  d.requests.filter((r) => r.status === 'approved').forEach((r) => r.items.forEach((it) => {
    if (it.used >= it.qty) return;
    const c = d.candidates[it.id] || [];
    rows.push('<div class="slot"><div><strong>' + esc(it.designation) + '</strong> <span class="muted small">' + it.used + ' of ' + it.qty + ' added' + (it.department ? ' · ' + esc(it.department) : '') + '</span></div>' +
      (c.length ? '<div class="slot-pick"><select class="wf-select" data-slot="' + esc(it.id) + '"><option value="">Choose a person</option>' +
        c.map((x) => '<option value="' + esc(x.id) + '">' + esc(x.name || '—') + (x.department ? ' (' + esc(x.department) + ')' : '') + '</option>').join('') +
        '</select><button class="btn btn-sm" type="button" data-add="' + esc(it.id) + '">Add</button></div>'
        : '<p class="muted small">No available Project Agent with this designation.</p>') + '</div>');
  }));
  return rows.length ? '<div class="slots"><h4>Approved, ready to fill</h4>' + rows.join('') + '</div>' : '';
}

function requestHTML(r, d) {
  const open = r.status === 'pending' || r.status === 'discussing';
  const mine = r.requested_by === d.me.id;
  const canAct = d.can.manage && !mine;          // Admin / Manager, never on your own request
  const canTalk = open && (d.can.manage || mine);
  return '<article class="rqcard">' +
    '<div class="req-head">' + chip(REQ, r.status) + '<span class="muted small">' + esc(r.requester || 'Someone') + ' · ' + esc(when(r.created_at)) + '</span></div>' +
    '<ul class="req-items">' + r.items.map((i) => '<li>' + esc(itemText(i)) + (r.status === 'approved' ? ' <span class="muted small">(' + i.used + ' added)</span>' : '') + '</li>').join('') + '</ul>' +
    (r.note ? '<p class="small">' + esc(r.note) + '</p>' : '') +
    (r.decided_by ? '<p class="small req-decision">' + (r.status === 'approved' ? 'Approved' : 'Declined') + ' by <strong>' + esc(r.decided_by) + '</strong> · ' + esc(when(r.decided_at)) + (r.decision_note ? ' · “' + esc(r.decision_note) + '”' : '') + '</p>' : '') +
    (r.comments.length ? '<ul class="thread">' + r.comments.map((c) => '<li><strong>' + esc(c.author) + '</strong> <span class="muted small">' + esc(when(c.created_at)) + '</span><br>' + esc(c.body) + '</li>').join('') + '</ul>' : '') +
    (canTalk ? '<form class="comment-form" data-comment="' + esc(r.id) + '"><input class="wf-input" maxlength="1000" placeholder="Write a comment" aria-label="Comment"><button class="btn btn-sm btn-ghost" type="submit">Send</button></form>' : '') +
    (open && canAct ? '<div class="req-actions">' +
      '<button class="btn btn-sm" type="button" data-req="' + esc(r.id) + '" data-decide="approve">Approve</button>' +
      '<button class="btn btn-sm btn-ghost" type="button" data-req="' + esc(r.id) + '" data-decide="decline">Decline</button>' +
      (r.status === 'pending' ? '<button class="btn btn-sm btn-ghost" type="button" data-req="' + esc(r.id) + '" data-decide="discuss">Discuss</button>' : '') + '</div>' : '') +
    '</article>';
}

function decideModal({ sb, reqId, decision, onDone }) {
  const T = { approve: ['Approve request', 'Approve', 'Add a note (optional)'], decline: ['Decline request', 'Decline', 'Reason (optional)'], discuss: ['Start a discussion', 'Start discussion', 'What would you like to discuss?'] }[decision];
  const m = openModal({
    title: T[0],
    body: '<div class="wf-group"><label class="wf-label" for="dNote">' + T[2] + '</label><textarea class="wf-input wf-area" id="dNote" maxlength="500"></textarea></div><p class="wf-err" id="dErr" hidden></p>',
    foot: '<button class="btn btn-ghost" id="dCancel" type="button">Cancel</button><button class="btn" id="dGo" type="button">' + T[1] + '</button>',
  });
  const $ = (i) => m.overlay.querySelector('#' + i);
  $('dCancel').addEventListener('click', m.close);
  $('dGo').addEventListener('click', async (e) => {
    const note = $('dNote').value.trim();
    if (decision === 'discuss' && !note) return fieldError($('dNote'), 'Write what you want to discuss.');
    e.target.disabled = true;
    try { await api(sb, '/api/projects?a=decide&id=' + encodeURIComponent(reqId), { method: 'POST', body: JSON.stringify({ decision, note }) }); m.close(); toast('Done'); onDone(); }
    catch (x) { $('dErr').textContent = x.message; $('dErr').hidden = false; e.target.disabled = false; }
  });
}

function requestModal({ sb, id, onDone }) {
  const rowHTML = () => '<div class="rq-row"><div class="combo"><input class="wf-input rq-des" autocomplete="off" maxlength="60" placeholder="Designation" aria-label="Designation"><span class="combo-chev"></span></div>' +
    '<div class="combo"><input class="wf-input rq-dep" autocomplete="off" maxlength="60" placeholder="Department (optional)" aria-label="Department"><span class="combo-chev"></span></div>' +
    '<input class="wf-input rq-qty" type="number" min="1" max="20" value="1" aria-label="Quantity"><button class="btn btn-sm btn-ghost rq-del" type="button" aria-label="Remove">' + icon('x', 14) + '</button></div>';
  const m = openModal({
    title: 'Ask for people', wide: true,
    body: '<p class="wf-hint role-intro">What does this project need? An Admin or Manager will approve, decline or discuss it. After approval you choose the people.</p>' +
      '<div id="rqRows">' + rowHTML() + '</div><button class="btn btn-sm btn-ghost" id="rqAdd" type="button">' + icon('plus', 14) + ' Add another</button>' +
      '<div class="wf-group rq-note"><label class="wf-label" for="rqNote">Note (optional)</label><textarea class="wf-input wf-area" id="rqNote" maxlength="500"></textarea></div><p class="wf-err" id="rqErr" hidden></p>',
    foot: '<button class="btn btn-ghost" id="rqCancel" type="button">Cancel</button><button class="btn" id="rqSend" type="button">Send request</button>',
  });
  const $ = (i) => m.overlay.querySelector('#' + i);
  const wire = (row) => {
    bindCombo(row.querySelector('.rq-des'), DESIGNATIONS); bindCombo(row.querySelector('.rq-dep'), DEPARTMENTS);
    row.querySelector('.rq-del').addEventListener('click', () => { if ($('rqRows').children.length > 1) row.remove(); });
  };
  wire($('rqRows').firstElementChild);
  $('rqAdd').addEventListener('click', () => {
    if ($('rqRows').children.length >= 8) return;
    $('rqRows').insertAdjacentHTML('beforeend', rowHTML()); wire($('rqRows').lastElementChild);
  });
  $('rqCancel').addEventListener('click', m.close);
  $('rqSend').addEventListener('click', async (e) => {
    const items = [...$('rqRows').children].map((r) => ({ designation: r.querySelector('.rq-des').value.trim(), department: r.querySelector('.rq-dep').value.trim(), qty: Number(r.querySelector('.rq-qty').value) }));
    if (items.some((i) => !i.designation)) return fieldError($('rqRows').querySelector('.rq-des'), 'Every row needs a designation.');
    e.target.disabled = true;
    try { await api(sb, '/api/projects?a=request&id=' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ items, note: $('rqNote').value.trim() }) }); m.close(); toast('Request sent'); onDone(); }
    catch (x) { $('rqErr').textContent = x.message; $('rqErr').hidden = false; e.target.disabled = false; }
  });
}
