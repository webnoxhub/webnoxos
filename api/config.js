// Vercel serverless function: GET /api/config
// Browser-safe values only. The secret key never leaves the server.
export default function handler(_req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || ''
  }));
}
