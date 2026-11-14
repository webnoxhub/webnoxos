// Creates one Supabase browser client from GET /api/config (publishable key only).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let clientPromise;

export function getClient({ isolated = false } = {}) {
  if (!isolated && clientPromise) return clientPromise;
  const client = fetch('/api/config', { cache: 'no-store' })
    .then(r => r.json())
    .then(cfg => createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
      auth: {
        persistSession: !isolated, autoRefreshToken: !isolated,
        detectSessionInUrl: !isolated, flowType: 'implicit',
        ...(isolated ? { storageKey: 'webnox-password-recovery' } : {}),
      },
    }));
  if (!isolated) clientPromise = client;
  return client;
}
