// Email validation: browser copy and server copy must agree.
import { isEmail as client } from '../public/js/validate.js';
import { isEmail as server } from '../lib/validate.js';

let failed = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed++; };

const good = ['webnoxhub@gmail.com', 'a.b+tag@sub.example.co.uk', ' User_1@Example.COM ', 'x@y.io'];
const bad = ['webnoxhub@gmail.cop,', 'a@b', 'a@b.', '@b.com', 'a b@c.com', 'a@@b.com', 'a..b@c.com',
             '.a@b.com', 'a.@b.com', 'a@-b.com', 'a@b-.com', 'a@b.c', 'a@b.com,c@d.com', '', '   ', 'plain'];

for (const e of good) check('valid: "' + e + '"', client(e) && server(e));
for (const e of bad)  check('refused: "' + e + '"', !client(e) && !server(e));
check('server refuses non-string', !server(null) && !server(undefined) && !server(123));
check('overlong refused', !client('a'.repeat(250) + '@b.com'));

console.log(failed ? `\n${failed} FAILED` : '\nEmail validation checks passed');
process.exit(failed ? 1 : 0);
