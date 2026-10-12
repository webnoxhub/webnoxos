import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Browser-safe config only. The secret key never leaves the server.
app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || ''
  });
});

// Local development only. On Vercel, public/** is served by the CDN.
if (!process.env.VERCEL) {
  const pub = path.join(__dirname, 'public');
  app.get('/master-signin', (_req, res) => res.sendFile(path.join(pub, 'master-signin.html')));
  app.use(express.static(pub));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Webnox OS running on http://localhost:${port}`));
}

export default app;
