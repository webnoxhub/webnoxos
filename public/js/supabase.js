// Creates one Supabase browser client from GET /api/config (publishable key only).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let clientPromise;

export function getClient() {
  if (!clientPromise) {
    clientPromise = fetch('/api/config', { cache: 'no-store' })
      .then(r => r.json())
      .then(cfg => createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      }));
  }
  return clientPromise;
}
