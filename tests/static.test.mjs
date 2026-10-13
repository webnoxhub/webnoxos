// Static checks for the Master sign-in page. Run: npm test
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ROUTE = 'master-signin';
const allowed = new Set(['master-signin.html', 'robots.txt']);
let failed = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed++; };

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

const files = walk(root);
const leaks = files.filter(f => !allowed.has(path.relative(root, f).replace(/\\/g, '/'))
  && fs.readFileSync(f, 'utf8').includes(ROUTE));
check('route string appears only in master-signin.html and robots.txt', leaks.length === 0);

const html = fs.readFileSync(path.join(root, 'master-signin.html'), 'utf8');
check('title is "Sign in · Webnox OS"', html.includes('<title>Sign in · Webnox OS</title>'));
check('noindex meta present', html.includes('<meta name="robots" content="noindex, nofollow">'));
const visible = html.replace(/<script[\s\S]*?<\/script>/g, '');
check('word "Master" appears exactly once in the page', (visible.match(/Master/g) || []).length === 1);
check('page has no links', !/<a\s/i.test(html));

const sp = fs.readFileSync(path.join(root, 'set-password.html'), 'utf8');
check('set-password page is noindex', sp.includes('<meta name="robots" content="noindex, nofollow">'));
check('set-password page has no links', !/<a\s/i.test(sp));
const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
check('index forwards invite/recovery links to set-password', idx.includes('/set-password.html'));

const js = fs.readFileSync(path.join(root, 'js', 'auth.js'), 'utf8');
check('no console logging in auth.js', !/console\./.test(js));
check('no localStorage use in auth.js', !/localStorage/.test(js));

const robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8');
check('robots.txt disallows the route', robots.includes('Disallow: /' + ROUTE));

process.exit(failed ? 1 : 0);
