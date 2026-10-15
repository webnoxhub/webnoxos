// Shared helpers for invite / set-password links (server only).
export function siteUrl() {
  return (process.env.SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'))
    .replace(/\/+$/, '');
}

// Real, one-time link the person opens to set their password. Nothing is emailed:
// the Master shares it (copy / WhatsApp). Works for brand-new and half-set-up users.
export async function makeLink(admin, email, meta) {
  const redirectTo = `${siteUrl()}/set-password.html`;
  // Existing user (invite expired, or lost) -> recovery link.
  let r = await admin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
  if (!r.error && r.data?.properties?.action_link) return { link: r.data.properties.action_link, user: r.data.user };
  // New user -> invite link (creates the user, no email sent).
  r = await admin.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo, data: meta || {} } });
  if (r.error || !r.data?.properties?.action_link) return { error: r.error?.message || 'Could not create link' };
  return { link: r.data.properties.action_link, user: r.data.user };
}

export function maskEmail(e) {
  if (!e || !e.includes('@')) return '';
  const [u, d] = e.split('@');
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***') + '@' + d;
}

export async function readJson(req) {
  const raw = await new Promise((resolve, reject) => {
    let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => resolve(d)); req.on('error', reject);
  });
  return raw ? JSON.parse(raw) : {};
}
