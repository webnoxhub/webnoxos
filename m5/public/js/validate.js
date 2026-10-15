// Email format check shared by every form in the browser.
// Mirrored on the server in lib/validate.js — keep the two identical.
const EMAIL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

export function isEmail(value) {
  const v = String(value == null ? '' : value).trim();
  if (v.length > 254 || v.includes('..')) return false;
  return EMAIL_RE.test(v);
}

export const EMAIL_MSG = 'Enter a valid email address.';
