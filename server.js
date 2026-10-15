// Local development server. On Vercel, public/** is served by the CDN and api/** runs as functions.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './api/config.js';
import masterPing from './api/master/ping.js';
import publicForm from './api/public/form.js';
import publicLead from './api/public/lead.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/api/config', (req, res) => config(req, res));
app.get('/api/public/form', (req, res) => publicForm(req, res));
app.all('/api/public/lead', (req, res) => publicLead(req, res));
app.all('/api/master/ping', (req, res) => masterPing(req, res));

if (!process.env.VERCEL) {
  const pub = path.join(__dirname, 'public');
  app.get('/master-signin', (_req, res) => res.sendFile(path.join(pub, 'master-signin.html')));
  app.use(express.static(pub));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Webnox OS running on http://localhost:${port}`));
}

export default app;
