// Small helpers shared by Team pages: modal shell, link rows, inline field errors, API calls.
import { esc, icon } from '/js/ui.js';

export function openModal({ title, body, foot, wide }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal' + (wide ? ' modal-wide' : '') + '" role="dialog" aria-modal="true">' +
      '<div class="modal-head"><h3 class="modal-title"></h3>' +
        '<button class="modal-close" type="button" aria-label="Close">' + icon('x', 18) + '</button></div>' +
      '<div class="modal-body"></div><div class="modal-foot"></div></div>';
  overlay.querySelector('.modal-title').textContent = title;
  overlay.querySelector('.modal-body').innerHTML = body || '';
  overlay.querySelector('.modal-foot').innerHTML = foot || '';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  return { overlay, body: overlay.querySelector('.modal-body'), foot: overlay.querySelector('.modal-foot'), close,
           setTitle: (t) => { overlay.querySelector('.modal-title').textContent = t; } };
}

export async function api(sb, url, opts = {}) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(url, { ...opts, headers: { 'Authorization': 'Bearer ' + (session?.access_token || ''), 'Content-Type': 'application/json' } });
  let json = {}; try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(json.error || 'Something went wrong.');
  return json;
}

export function fieldError(el, msg) {
  el.focus();
  el.classList.add('is-invalid');
  let h = el.parentElement.querySelector('.wf-err');
  if (!h) { h = document.createElement('p'); h.className = 'wf-err'; el.parentElement.appendChild(h); }
  h.textContent = msg; h.hidden = false;
  el.addEventListener('input', () => { el.classList.remove('is-invalid'); h.hidden = true; }, { once: true });
}

export function waLink(text) { return 'https://wa.me/?text=' + encodeURIComponent(text); }

export function copyText(text) {
  if (navigator.clipboard) { navigator.clipboard.writeText(text).catch(() => fallback(text)); } else fallback(text);
}
function fallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
}

export function linkRow(label, link, message) {
  return '<div class="wf-group"><label class="wf-label">' + esc(label) + '</label>' +
    '<div class="copy-row"><input class="wf-input" readonly value="' + esc(link) + '">' +
    '<button class="btn btn-sm" type="button" data-copy>Copy</button>' +
    '<a class="btn btn-sm btn-wa" href="' + waLink(message + link) + '" target="_blank" rel="noopener">WhatsApp</a></div></div>';
}
export function bindCopy(root) {
  root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    copyText(b.parentElement.querySelector('input').value);
    b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  }));
}
