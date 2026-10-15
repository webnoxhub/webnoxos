// Member: own sign-ins and own activity log
import { icon } from '../ui.js';
import { mountLogins } from './logins.js';
import { mountLogs } from './logs.js';

export async function render({ el, params }) {
  let tab = params.get('tab') === 'log' ? 'log' : 'sessions';
  let cleanup = null;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>My activity</h1><p>Everything Webnox OS has recorded about your sessions and actions.</p></div>
      <div class="seg" role="group" aria-label="Section">
        <button data-tab="sessions" aria-pressed="${tab === 'sessions'}">${icon('login', 14)} Sign-ins</button>
        <button data-tab="log" aria-pressed="${tab === 'log'}">${icon('activity', 14)} Activity log</button>
      </div>
    </div>
    <div id="tab"></div>`;
  const box = el.querySelector('#tab');
  const show = async () => {
    if (typeof cleanup === 'function') cleanup();
    cleanup = tab === 'sessions' ? await mountLogins(box, { self: true }) : await mountLogs(box, { self: true });
  };
  el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
    tab = b.dataset.tab;
    el.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    show();
  });
  await show();
  return () => { if (typeof cleanup === 'function') cleanup(); };
}
