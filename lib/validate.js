// Email format check on the server. Mirrors public/js/validate.js — keep the two identical.
const EMAIL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

export function isEmail(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length > 254 || v.includes('..')) return false;
  return EMAIL_RE.test(v);
}
