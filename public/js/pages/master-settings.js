import { esc } from '/js/ui.js';
import { openProfile, openPassword } from '/js/profile.js';

export default function render({ el, sb, profile, setTitle }) {
  setTitle('Settings');
  el.innerHTML = '<section class="card"><h2>Master account</h2>' +
    '<p>' + esc(profile.name || '') + '</p><p class="muted">' + esc(profile.email || '') + '</p>' +
    '<div class="row"><button class="btn btn-ghost" type="button" data-profile>View profile</button>' +
    '<button class="btn" type="button" data-password>Change password</button></div></section>';
  el.querySelector('[data-profile]').onclick = () => openProfile(sb, profile, 'Webnox OS');
  el.querySelector('[data-password]').onclick = () => openPassword(sb);
}
