// POST /api/public/workspace-brand   { slug }   ->  { name, slug } or {}
// Runs on the server so no table is readable from the login page. Same status and
// about the same timing whether the workspace exists or not. Only live workspaces answer.
import { createClient } from '@supabase/supabase-js';
import { readJson } from '../../lib/invites.js';

const FLOOR_MS = 250;
const SLUG = /^[a-z0-9-]{1,40}$/;

export default async function handler(req, res) {
  const started = Date.now();
  let out = {};
  try {
    if (req.method === 'POST') {
      const { slug } = await readJson(req);
      const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
      if (typeof slug === 'string' && SLUG.test(slug) && url && key) {
        const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data } = await admin.from('workspaces').select('name,slug,status,logo_url').eq('slug', slug).maybeSingle();
        if (data && (data.status === 'trial' || data.status === 'active')) out = { name: data.name, slug: data.slug, logo_url: data.logo_url || null };
      }
    }
  } catch { out = {}; }
  await new Promise((r) => setTimeout(r, Math.max(0, FLOOR_MS - (Date.now() - started))));
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out));
}
