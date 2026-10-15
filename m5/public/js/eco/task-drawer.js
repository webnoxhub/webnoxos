// Task detail drawer (admin + member) and the admin task form.
import { supabase } from './supabase.js';
import { state, roleName } from './state.js';
import { q, rpc, TASK_FIELDS, loadTotals, loadMembers, loadDirectory, dirName, dirLabel } from './data.js';
import {
  esc, icon, openDrawer, closeDrawer, openModal, confirmDialog, toast, busy, loadingBlock,
  statusBadge, prioTag, roleChip, avatar, fullName, STATUS_LABEL, PRIORITY_LABEL,
} from './ui.js';
import { fmtDuration, fmtClock, fmtDate, fmtDateTime, fmtTime, localDate, fmtDateShort, dueLabel, dueState, fmtRelative } from './time.js';
import { liveAttrs, startTimer, pauseTimer, stopTimer, timerStateFor, refreshTimer } from './timer.js';

const changed = () => window.dispatchEvent(new CustomEvent('ehos:data-changed'));
const END_REASON = { pause: 'Paused', stop: 'Stopped', switch: 'Switched task', logout: 'Signed out', auto: 'Auto-paused' };

export function openTaskDrawer(taskId) {
  const drawer = openDrawer({ title: 'Task', body: loadingBlock(5), onClose: () => window.removeEventListener('ehos:data-changed', onExternal) });
  let reloading = false;
  let clientRow = null;
  let projectRow = null;
  let dirCache = [];
  const onExternal = () => { if (!reloading) load(); };
  window.addEventListener('ehos:data-changed', onExternal);

  async function load() {
    reloading = true;
    try {
      const [task, comments, totals, entries, history] = await Promise.all([
        q(supabase.from('tasks').select(TASK_FIELDS).eq('id', taskId).maybeSingle()),
        q(supabase.from('task_comments').select('*').eq('task_id', taskId).order('created_at')),
        loadTotals([taskId]),
        q(supabase.from('task_time_entries').select('*').eq('task_id', taskId).order('started_at', { ascending: false }).limit(60)),
        state.isAdmin
          ? q(supabase.from('activity_logs').select('*').eq('entity_type', 'task').eq('entity_id', String(taskId)).order('created_at', { ascending: false }).limit(40))
          : Promise.resolve([]),
      ]);
      if (!drawer.isConnected) return;
      if (!task) {
        drawer.querySelector('.drawer-head h2').textContent = 'Task not found';
        drawer.querySelector('.drawer-body').innerHTML = '<p class="muted">This task was deleted or is no longer assigned to you.</p>';
        return;
      }
      dirCache = await loadDirectory().catch(() => []);
      [clientRow, projectRow] = await Promise.all([
        task.client_id ? q(supabase.from('clients').select('id, name, project_manager').eq('id', task.client_id).maybeSingle()).catch(() => null) : null,
        task.project_id ? q(supabase.from('projects').select('id, name, project_manager').eq('id', task.project_id).maybeSingle()).catch(() => null) : null,
      ]);
      render(task, comments, totals.get(task.id), entries, history, totals.fetchedAt);
    } catch (e) {
      drawer.querySelector('.drawer-body').innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
    } finally { setTimeout(() => { reloading = false; }, 400); }
  }

  function render(task, comments, tot, entries, history, fetchedAt) {
    const mine = task.assigned_to === state.profile.id;
    const manage = state.isAdmin || Boolean(clientRow && clientRow.project_manager === state.profile.id)
      || Boolean(projectRow && projectRow.project_manager === state.profile.id && state.pmPerms.projects?.edit);
    const myTotals = tot?.byUser?.[state.profile.id];
    const tState = timerStateFor(myTotals);
    const canTime = mine && ['todo', 'in_progress'].includes(task.status);
    const total = tot?.total || 0;
    const due = dueState(task);

    drawer.querySelector('.drawer-head h2').textContent = task.title;

    const banner = task.status === 'in_review'
      ? `<div class="note info">Submitted for review ${fmtRelative(task.submitted_at)}. ${state.isAdmin ? 'Approve it or request changes below.' : 'The admin will approve it or send it back with notes.'}</div>`
      : task.status === 'in_progress' && task.review_note
        ? `<div class="note warn"><b>Changes requested:</b> ${esc(task.review_note)}</div>`
        : task.status === 'completed' && task.review_note
          ? `<div class="note ok"><b>Approved:</b> ${esc(task.review_note)}</div>`
          : '';

    const timerBlock = canTime ? `
      <div class="timer-ctl ${tState === 'running' ? 'running' : ''}">
        <div class="clock"><span class="label">${tState === 'running' ? 'Timer running' : tState === 'paused' ? 'Timer paused' : 'Time on this task'}</span>
          <span ${tot?.running ? liveAttrs(total, fetchedAt, 'clock') : ''}>${fmtClock(total)}</span></div>
        ${tState === 'running'
          ? `<button class="btn" data-act="pause">${icon('pause', 14)}Pause</button><button class="btn" data-act="stop">${icon('stop', 13)}Stop</button>`
          : tState === 'paused'
            ? `<button class="btn btn-success" data-act="start">${icon('play', 14)}Resume</button><button class="btn" data-act="stop">${icon('stop', 13)}Stop</button>`
            : `<button class="btn btn-success" data-act="start">${icon('play', 14)}Start timer</button>`}
      </div>` : `
      <div class="timer-ctl ${tot?.running ? 'running' : ''}">
        <div class="clock"><span class="label">${tot?.running ? 'Timer running now' : 'Time tracked'}</span>
          <span ${tot?.running ? liveAttrs(total, fetchedAt, 'clock') : ''}>${fmtClock(total)}</span></div>
      </div>`;

    const body = `
      <div class="row wrap">${statusBadge(task.status)}${prioTag(task.priority)}${task.team_role ? roleChip(task.team_role, state.roles) : ''}
        ${task.due_date ? `<span class="due ${due}">${icon('calendar', 13)}${esc(dueLabel(task.due_date))}</span>` : ''}</div>
      ${banner}
      ${timerBlock}
      <dl class="kv">
        <dt>Assigned by</dt><dd>${(() => { const l = dirLabel(dirCache, task.created_by, state.roles); return l ? `<div class="who">${avatar({ first_name: l.name.split(' ')[0], last_name: l.name.split(' ')[1] || '' }, 'sm')}<div><div class="name">${esc(l.name)}</div>${l.title ? `<div class="sub">${esc(l.title)}</div>` : ''}</div></div>` : '<span class="muted">—</span>'; })()}</dd>
        <dt>Assigned to</dt><dd>${task.assignee ? `<div class="who">${avatar(task.assignee, 'sm')}<span>${esc(fullName(task.assignee))}</span></div>` : '<span class="muted">Nobody yet</span>'}</dd>
        <dt>Role</dt><dd>${task.team_role ? esc(roleName(task.team_role)) : '<span class="muted">Any role</span>'}</dd>
        ${projectRow ? `<dt>Project</dt><dd><a href="#/project/${projectRow.id}?tab=tasks">${esc(projectRow.name)}</a></dd>` : ''}
        ${clientRow ? `<dt>Client</dt><dd>${esc(clientRow.name)}</dd>` : ''}
        <dt>Due date</dt><dd>${task.due_date ? esc(fmtDate(task.due_date)) : '<span class="muted">No due date</span>'}</dd>
        ${task.start_date ? `<dt>Start date</dt><dd>${esc(fmtDate(task.start_date))}</dd>` : ''}
        <dt>Created</dt><dd>${esc(fmtDateTime(task.created_at))}</dd>
        ${task.completed_at ? `<dt>Completed</dt><dd>${esc(fmtDateTime(task.completed_at))}</dd>` : ''}
      </dl>
      <div><div class="section-title">Description</div>${task.description ? `<div class="desc">${esc(task.description)}</div>` : '<p class="muted">No description.</p>'}</div>

      <div>
        <div class="section-title">Time entries <span class="muted small">${entries.length ? fmtDuration(total) + ' total' : ''}</span></div>
        ${entries.length ? `<div class="panel"><div class="list">${entries.map((e) => `
          <div class="list-item" style="padding:9px 14px">
            <div class="grow"><div class="small">${esc(fmtDateShort(localDate(e.started_at)))}, ${esc(fmtTime(e.started_at))} – ${e.ended_at ? esc(fmtTime(e.ended_at)) : '<b style="color:#15803D">running</b>'}</div>
            ${state.isAdmin && task.assigned_to !== e.user_id ? '<div class="small muted">Previous assignee</div>' : ''}</div>
            <span class="small muted">${e.end_reason ? esc(END_REASON[e.end_reason] || e.end_reason) : ''}</span>
            <span class="num small" style="min-width:64px;text-align:right">${e.ended_at ? fmtDuration((Date.parse(e.ended_at) - Date.parse(e.started_at)) / 1000) : `<span ${liveAttrs((Date.now() - Date.parse(e.started_at)) / 1000, Date.now())}></span>`}</span>
          </div>`).join('')}</div></div>` : '<p class="muted small">No time recorded yet.</p>'}
      </div>

      <div>
        <div class="section-title">Comments</div>
        <div class="comments">
          ${comments.map((c) => `
            <div class="comment">${avatar({ first_name: (c.author_name || '').split(' ')[0], last_name: (c.author_name || '').split(' ')[1] || '' }, 'sm')}
              <div class="bubble"><div class="h"><b>${esc(c.author_name || 'Member')}</b><span class="muted small">${esc(fmtDateTime(c.created_at))}</span></div><p>${esc(c.body)}</p></div>
            </div>`).join('') || '<p class="muted small">No comments yet.</p>'}
          ${(mine || state.isAdmin) ? `
          <form data-comment class="stack" style="gap:8px">
            <label class="sr-only" for="c-body">Add a comment</label>
            <textarea id="c-body" class="textarea" style="min-height:70px" placeholder="Add a comment or share a link to your work" maxlength="4000"></textarea>
            <div><button class="btn btn-sm" type="submit">${icon('send', 13)}Post comment</button></div>
          </form>` : ''}
        </div>
      </div>

      ${state.isAdmin && history.length ? `
      <div>
        <div class="section-title">History</div>
        <div class="panel"><div class="list">${history.map((h) => `
          <div class="list-item" style="padding:9px 14px"><div class="grow small"><b style="font-weight:500">${esc(h.actor_name)}</b> <span class="muted">${esc(h.description)}</span></div><span class="small muted num">${esc(fmtDateTime(h.created_at))}</span></div>`).join('')}</div></div>
      </div>` : ''}`;

    // footer actions
    let foot = '';
    if (manage) {
      foot += `<button class="btn btn-ghost btn-danger" data-act="delete">${icon('trash', 14)}Delete</button><span style="flex:1"></span>`;
      foot += `<button class="btn" data-act="edit">${icon('edit', 14)}Edit</button>`;
      if (task.status === 'in_review') foot += `<button class="btn" data-act="changes">${icon('undo', 14)}Request changes</button><button class="btn btn-success" data-act="approve">${icon('check', 14)}Approve</button>`;
    }
    if (mine) {
      if (manage) foot += '<span style="flex-basis:100%;height:0"></span>';
      if (task.status === 'todo') foot += `<button class="btn" data-act="to-progress">Mark in progress</button>`;
      if (task.status === 'in_progress') foot += `<button class="btn btn-ghost" data-act="to-todo">Move back to To do</button>`;
      if (['todo', 'in_progress'].includes(task.status)) foot += `<button class="btn btn-primary" data-act="submit">${icon('send', 14)}Submit for review</button>`;
    }
    let footEl = drawer.querySelector('.drawer-foot');
    if (foot) {
      if (!footEl) { footEl = document.createElement('div'); footEl.className = 'drawer-foot'; drawer.append(footEl); }
      footEl.innerHTML = foot;
    } else footEl?.remove();

    drawer.querySelector('.drawer-body').innerHTML = body;
    bind(task);
  }

  function bind(task) {
    drawer.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => busy(btn, () => handle(btn.dataset.act, task));
    });
    const form = drawer.querySelector('[data-comment]');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ta = form.querySelector('textarea');
      const text = ta.value.trim();
      if (!text) return ta.focus();
      await busy(form.querySelector('button'), async () => {
        try {
          await q(supabase.from('task_comments').insert({ task_id: task.id, author_id: state.profile.id, body: text }));
          await load();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  async function handle(act, task) {
    try {
      if (act === 'start') { await startTimer(task.id); return; }
      if (act === 'pause') { await pauseTimer(); return; }
      if (act === 'stop') { await stopTimer(task.id); return; }
      if (act === 'to-progress' || act === 'to-todo') {
        await rpc('task_set_status', { p_task_id: task.id, p_status: act === 'to-todo' ? 'todo' : 'in_progress' });
        toast(`Moved to ${act === 'to-todo' ? 'To do' : 'In progress'}`);
      }
      if (act === 'submit') {
        const note = await confirmDialog({
          title: 'Submit for review?', text: 'The admin will be able to approve it or send it back. Your timer on this task stops.',
          confirm: 'Submit for review', note: { label: 'Note for the admin (optional)', placeholder: 'What did you do? Add links to your work.' },
        });
        if (note === null) return;
        await rpc('task_set_status', { p_task_id: task.id, p_status: 'in_review', p_note: note || null });
        await refreshTimer();
        toast('Submitted for review');
      }
      if (act === 'approve') {
        const note = await confirmDialog({ title: 'Approve this task?', text: 'It moves to Completed.', confirm: 'Approve', note: { label: 'Note (optional)', placeholder: 'Great work…' } });
        if (note === null) return;
        await rpc('task_review', { p_task_id: task.id, p_approve: true, p_note: note || null });
        toast('Task approved');
      }
      if (act === 'changes') {
        const note = await confirmDialog({
          title: 'Request changes', confirm: 'Send back',
          note: { label: 'What needs to change?', placeholder: 'Be specific so it can be fixed quickly', required: true, requiredText: 'Add a note so the member knows what to change' },
        });
        if (note === null) return;
        await rpc('task_review', { p_task_id: task.id, p_approve: false, p_note: note });
        toast('Sent back with your notes');
      }
      if (act === 'edit') { openTaskForm({ task, clientName: clientRow?.name || '', projectName: projectRow?.name || '', onSaved: () => { changed(); load(); } }); return; }
      if (act === 'delete') {
        if (state.isAdmin) {
          // Admin / manager: force delete — works even when time was tracked (recorded in the activity log)
          const ok = await confirmDialog({ title: 'Delete this task for good?', text: `"${task.title}", its comments and all its tracked time will be removed. This can't be undone. A note stays in the activity log.`, confirm: 'Delete task', danger: true });
          if (!ok) return;
          await rpc('task_force_delete', { p_task: task.id });
        } else {
          const ok = await confirmDialog({ title: 'Delete this task?', text: `"${task.title}" and its comments will be removed. Tasks with tracked time can't be deleted.`, confirm: 'Delete task', danger: true });
          if (!ok) return;
          await q(supabase.from('tasks').delete().eq('id', task.id));
        }
        toast('Task deleted');
        closeDrawer(); changed(); return;
      }
      changed(); // the open drawer and the page both reload on this event
    } catch (e) { toast(e.message, 'error'); }
  }

  load();
  return drawer;
}

// ---------------- Admin: create / edit task ----------------
let membersCache = null;
export async function openTaskForm({ task = null, presetMember = null, presetRole = null, clientId = null, clientName = '', projectId = null, projectName = '', memberOptions = null, onSaved } = {}) {
  clientId = clientId || task?.client_id || null;
  projectId = projectId || task?.project_id || null;
  let members = memberOptions;
  if (!members) {
    if (!state.isAdmin && projectId) {
      const [team, dir, pr] = await Promise.all([
        q(supabase.from('project_members').select('member_id, role_label').eq('project_id', projectId).eq('status', 'approved')), loadDirectory(),
        q(supabase.from('projects').select('project_manager').eq('id', projectId).maybeSingle()),
      ]);
      members = team.map((t) => ({ id: t.member_id, first_name: `${dirName(dir, t.member_id)} (${t.role_label})`, last_name: '', roles: [], status: 'active' }));
      if (pr?.project_manager) members.unshift({ id: pr.project_manager, first_name: `${dirName(dir, pr.project_manager)} (project manager)`, last_name: '', roles: [], status: 'active' });
    } else if (!state.isAdmin && clientId) {
      const [team, dir] = await Promise.all([q(supabase.from('client_members').select('member_id, role_label').eq('client_id', clientId)), loadDirectory()]);
      members = team.map((t) => ({ id: t.member_id, first_name: `${dirName(dir, t.member_id)} (${t.role_label})`, last_name: '', roles: [], status: 'active' }));
    } else {
      if (!membersCache || !task) membersCache = (await loadMembers()).filter((m) => ['active', 'invited'].includes(m.status));
      members = membersCache;
    }
  }
  const t = task || { title: '', description: '', team_role: presetRole || '', assigned_to: presetMember || '', priority: 'medium', start_date: '', due_date: '', status: 'todo' };

  const m = openModal({
    title: task ? 'Edit task' : 'New task',
    subtitle: projectName ? `For project ${esc(projectName)}${clientName ? ` (${esc(clientName)})` : ''}` : clientName ? `For client ${esc(clientName)}` : '',
    wide: true,
    body: `
      <form id="task-form" class="form-grid" novalidate>
        <div class="field span-2"><label for="tf-title">Title</label><input id="tf-title" class="input" maxlength="200" value="${esc(t.title)}" placeholder="e.g. Call 40 leads from the Shopify list" required></div>
        <div class="field span-2"><label for="tf-desc">Description</label><textarea id="tf-desc" class="textarea" placeholder="What does done look like? Add links and details.">${esc(t.description)}</textarea></div>
        <div class="field"><label for="tf-role">Role</label>
          <select id="tf-role" class="select"><option value="">Any role</option>${state.roles.map((r) => `<option value="${esc(r.key)}" ${t.team_role === r.key ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
          <span class="hint">The task shows under this role's tab for the member.</span></div>
        <div class="field"><label for="tf-member">Assign to</label><select id="tf-member" class="select"></select><span class="hint" id="tf-member-hint"></span></div>
        <div class="field span-2"><span class="label">Priority</span>
          <div class="seg" role="group" aria-label="Priority" id="tf-prio">${Object.entries(PRIORITY_LABEL).map(([k, v]) => `<button type="button" data-p="${k}" aria-pressed="${t.priority === k}">${v}</button>`).join('')}</div></div>
        <div class="field"><label for="tf-start">Start date (optional)</label><input id="tf-start" type="date" class="input" value="${esc(t.start_date || '')}"></div>
        <div class="field"><label for="tf-due">Due date</label><input id="tf-due" type="date" class="input" value="${esc(t.due_date || '')}"></div>
        ${task ? `<div class="field"><label for="tf-status">Status</label><select id="tf-status" class="select">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>` : ''}
        <div class="form-error hidden span-2" id="tf-err"></div>
      </form>`,
    foot: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>${task ? 'Save changes' : 'Create task'}</button>`,
  });

  let priority = t.priority;
  m.querySelectorAll('#tf-prio button').forEach((b) => b.onclick = () => {
    priority = b.dataset.p;
    m.querySelectorAll('#tf-prio button').forEach((x) => x.setAttribute('aria-pressed', x === b));
  });

  const roleSel = m.querySelector('#tf-role');
  const memberSel = m.querySelector('#tf-member');
  const fillMembers = () => {
    const role = roleSel.value;
    const current = memberSel.value || t.assigned_to || '';
    const list = members.filter((x) => !role || memberOptions || !x.roles.length || x.roles.includes(role));
    memberSel.innerHTML = `<option value="">Unassigned</option>${list.map((x) => `<option value="${x.id}" ${x.id === current ? 'selected' : ''}>${esc(fullName(x))}${x.status === 'invited' ? ' (invited)' : ''}</option>`).join('')}`;
    m.querySelector('#tf-member-hint').textContent = projectId ? 'People on this project\'s team.' : clientId && memberOptions ? 'Agents working on this client.' : role
      ? (list.length ? `Showing members with the ${roleName(role)} role.` : `Nobody has the ${roleName(role)} role yet. Add it from the Team page.`)
      : '';
  };
  roleSel.onchange = fillMembers;
  fillMembers();

  m.querySelector('[data-cancel]').onclick = () => m.close();
  const save = m.querySelector('[data-save]');
  const err = m.querySelector('#tf-err');
  const submit = () => busy(save, async () => {
    err.classList.add('hidden');
    const payload = {
      title: m.querySelector('#tf-title').value.trim(),
      description: m.querySelector('#tf-desc').value.trim(),
      team_role: roleSel.value || null,
      assigned_to: memberSel.value || null,
      priority,
      start_date: m.querySelector('#tf-start').value || null,
      due_date: m.querySelector('#tf-due').value || null,
    };
    if (task) payload.status = m.querySelector('#tf-status').value;
    if (clientId) payload.client_id = clientId;
    if (projectId) payload.project_id = projectId;
    if (!payload.title) { err.textContent = 'Give the task a title.'; err.classList.remove('hidden'); return; }
    if (payload.start_date && payload.due_date && payload.due_date < payload.start_date) {
      err.textContent = 'The due date is before the start date.'; err.classList.remove('hidden'); return;
    }
    try {
      if (task) await q(supabase.from('tasks').update(payload).eq('id', task.id));
      else await q(supabase.from('tasks').insert(payload));
      toast(task ? 'Task updated' : 'Task created');
      m.close();
      onSaved?.();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
  save.onclick = submit;
  m.querySelector('#task-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

export function invalidateMembers() { membersCache = null; }
