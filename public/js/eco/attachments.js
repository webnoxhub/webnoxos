// Attachments (PDF / image) on expenses and bills. Files live in the private
// Storage bucket "finance-files" at <workspace>/expense/<id>/… or <workspace>/bill/<id>/… (schema PART 16).
import { supabase } from './supabase.js';
import { state } from './state.js';
import { q } from './data.js';
import { esc, icon, openModal, toast, busy } from './ui.js';

const BUCKET = 'finance-files';
export const ATTACH_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
export const ATTACH_MAX_BYTES = 10 * 1048576;
export const ATTACH_MAX_FILES = 10;
const TABLE = { expense: 'expenses', bill: 'recurring_expenses' };

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const isImg = (t) => String(t || '').startsWith('image/');

// The field inside a form
export function attachFieldHTML(id) {
  return `<div class="field span-2"><label for="${id}-files">Attachments</label>
    <div class="attach-box" id="${id}-attach">
      <div class="attach-list" data-list></div>
      <label class="attach-drop" for="${id}-files">${icon('upload', 16)}<span><b>Upload PDF or image</b><small>Receipt, invoice or screenshot · up to 10 MB each</small></span></label>
      <input id="${id}-files" type="file" multiple accept="${ATTACH_TYPES.join(',')},.pdf,.png,.jpg,.jpeg,.webp" class="hidden">
    </div></div>`;
}

// Keeps track of files kept / added / removed in an open form
export function bindAttachments(root, id, existing = []) {
  const box = root.querySelector(`#${id}-attach`); const input = root.querySelector(`#${id}-files`); const list = box.querySelector('[data-list]');
  let kept = (Array.isArray(existing) ? existing : []).map((a) => ({ ...a }));
  const removed = []; let added = [];
  const draw = () => {
    const rows = [...kept.map((a, k) => ({ ...a, k, old: true })), ...added.map((f, k) => ({ name: f.name, size: f.size, type: f.type, k, old: false }))];
    list.innerHTML = rows.map((a) => `<div class="attach-item">
        <span class="attach-ico">${icon(isImg(a.type) ? 'eye' : 'file', 14)}</span>
        <span class="grow"><b>${esc(a.name)}</b><small>${esc(kb(a.size || 0))}${a.old ? '' : ' · uploads when you save'}</small></span>
        ${a.old ? `<button type="button" class="btn btn-sm btn-ghost" data-open="${esc(a.path)}">Open</button>` : ''}
        <button type="button" class="btn btn-sm btn-ghost btn-icon" data-rm="${a.old ? 'o' : 'n'}${a.k}" aria-label="Remove ${esc(a.name)}">${icon('x', 13)}</button>
      </div>`).join('');
  };
  input.addEventListener('change', () => {
    const files = [...(input.files || [])]; input.value = '';
    for (const f of files) {
      if (!ATTACH_TYPES.includes(f.type)) { toast(`${f.name}: only PDF, PNG, JPG or WEBP`, 'error'); continue; }
      if (f.size > ATTACH_MAX_BYTES) { toast(`${f.name} is bigger than 10 MB`, 'error'); continue; }
      if (kept.length + added.length >= ATTACH_MAX_FILES) { toast(`Up to ${ATTACH_MAX_FILES} files`, 'error'); break; }
      added.push(f);
    }
    draw();
  });
  list.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]'); if (o) { openAttachment(o.dataset.open, o); return; }
    const r = e.target.closest('[data-rm]'); if (!r) return;
    const k = Number(r.dataset.rm.slice(1));
    if (r.dataset.rm[0] === 'o') removed.push(...kept.splice(k, 1)); else added.splice(k, 1);
    draw();
  });
  draw();
  return { get changed() { return added.length > 0 || removed.length > 0; }, kept: () => kept, added: () => added, removed: () => removed };
}

// After the row is saved: upload new files, delete removed ones, store the list on the row.
// Returns false if something failed (the row itself is already saved).
export async function saveAttachments(kind, recordId, ctl) {
  if (!ctl || !ctl.changed) return true;
  const list = [...ctl.kept()]; let ok = true;
  for (const f of ctl.added()) {
    const safe = f.name.replace(/[^\w.\-]+/g, '_').slice(-100) || 'file';
    const path = `${state.workspace.id}/${kind}/${recordId}/${crypto.randomUUID()}-${safe}`;
    const up = await supabase.storage.from(BUCKET).upload(path, f, { contentType: f.type });
    if (up.error) { ok = false; toast(`${f.name}: ${up.error.message}`, 'error'); continue; }
    list.push({ path, name: f.name.slice(0, 200), size: f.size, type: f.type });
  }
  try { await q(supabase.from(TABLE[kind]).update({ attachments: list }).eq('id', recordId)); }
  catch (e) {
    ok = false; toast(e.message, 'error');
    const fresh = list.filter((a) => !ctl.kept().includes(a)).map((a) => a.path);
    if (fresh.length) await supabase.storage.from(BUCKET).remove(fresh);
    return ok;
  }
  const gone = ctl.removed().map((a) => a.path);
  if (gone.length) await supabase.storage.from(BUCKET).remove(gone);
  return ok;
}

// Remove all files of a row (call before deleting the row, while access checks still pass)
export async function removeAllAttachments(row) {
  const paths = (row?.attachments || []).map((a) => a.path).filter(Boolean);
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
}

export async function openAttachment(path, btn = null) {
  const run = async () => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 120);
    if (error) { toast(error.message, 'error'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  };
  return btn ? busy(btn, run) : run();
}

// Small clip button for a table row / list item
export function attachChip(row, key) {
  const n = (row.attachments || []).length;
  return n ? `<button type="button" class="attach-chip" data-attach="${esc(key)}" title="${n} attachment${n === 1 ? '' : 's'}">${icon('paperclip', 12)}${n}</button>` : '';
}

// Opens the file directly when there is one; a short list when there are more
export function showAttachments(row, title = 'Attachments') {
  const list = row.attachments || [];
  if (list.length === 1) return openAttachment(list[0].path);
  const m = openModal({
    title: esc(title), icon: 'paperclip',
    body: `<div class="attach-list">${list.map((a) => `<div class="attach-item"><span class="attach-ico">${icon(isImg(a.type) ? 'eye' : 'file', 14)}</span>
      <span class="grow"><b>${esc(a.name)}</b><small>${esc(kb(a.size || 0))}</small></span>
      <button type="button" class="btn btn-sm" data-open="${esc(a.path)}">${icon('download', 13)}Open</button></div>`).join('')}</div>`,
  });
  m.addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openAttachment(b.dataset.open, b); });
}
