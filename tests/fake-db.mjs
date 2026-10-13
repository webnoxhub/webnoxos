// A tiny Supabase-style query builder over PGlite, enough for the handlers under test.
export function makeFake(db, tokens) {
function from(table) {
  const st = { op: 'select', cols: '*', where: [], order: null, limit: null, payload: null, ret: false, count: false, head: false, single: null };
  const run = async () => {
    const params = []; const P = (v) => { params.push(v); return '$' + params.length; };
    const w = st.where.map(([c, o, v]) => o === 'in' ? `${c} = any(${P(v)})` : o === 'is' ? `${c} is null` : `${c} = ${P(v)}`);
    const W = w.length ? ' where ' + w.join(' and ') : '';
    let sql;
    try {
      if (st.op === 'select') {
        sql = `select ${st.count && st.head ? 'count(*)::int as n' : st.cols} from public.${table}${W}` +
          (st.order ? ` order by ${st.order[0]} ${st.order[1]}` : '') + (st.limit ? ` limit ${st.limit}` : '');
      } else if (st.op === 'insert') {
        const rows = Array.isArray(st.payload) ? st.payload : [st.payload];
        const cols = Object.keys(rows[0]);
        sql = `insert into public.${table} (${cols.join(',')}) values ` +
          rows.map((r) => '(' + cols.map((c) => P(r[c] ?? null)).join(',') + ')').join(',') + (st.ret ? ` returning ${st.cols}` : '');
      } else if (st.op === 'update') {
        const ks = Object.keys(st.payload);
        sql = `update public.${table} set ${ks.map((k) => `${k} = ${P(st.payload[k])}`).join(',')}` + W + (st.ret ? ` returning ${st.cols}` : '');
      } else {
        sql = `delete from public.${table}` + W + (st.ret ? ` returning ${st.cols}` : '');
      }
      // the where params were allocated first for select/delete but after set-values for update; rebuild in order
      const res = await db.query(sql, params);
      if (st.count && st.head) return { data: null, error: null, count: res.rows[0].n };
      if (st.single) {
        if (res.rows.length > 1 || (st.single === 'one' && !res.rows.length)) return { data: null, error: { message: 'single row expected' } };
        return { data: res.rows[0] || null, error: null };
      }
      return { data: res.rows, error: null };
    } catch (e) { return { data: null, error: { message: e.message } }; }
  };
  const b = {
    select(cols, opts) { if (st.op === 'select') { st.cols = cols || '*'; if (opts && opts.count) { st.count = true; st.head = !!opts.head; } } else { st.ret = true; st.cols = cols || '*'; } return b; },
    insert(p) { st.op = 'insert'; st.payload = p; return b; },
    update(p) { st.op = 'update'; st.payload = p; return b; },
    delete() { st.op = 'delete'; return b; },
    eq(c, v) { st.where.push([c, '=', v]); return b; },
    in(c, v) { st.where.push([c, 'in', v]); return b; },
    is(c, v) { st.where.push([c, 'is', v]); return b; },
    order(c, o) { st.order = [c, o && o.ascending === false ? 'desc' : 'asc']; return b; },
    limit(n) { st.limit = n; return b; },
    maybeSingle() { st.single = 'maybe'; return run(); },
    single() { st.single = 'one'; return run(); },
    then(res, rej) { return run().then(res, rej); },
  };
  return b;
}
  const rpc = async (name, args) => {
    try {
      const key = Object.keys(args)[0];
      const r = await db.query(`select public.${name}($1) as v`, [args[key]]);
      return { data: r.rows[0].v, error: null };
    } catch (e) { return { data: null, error: { message: e.message } }; }
  };
  const admin = {
    getUserById: async (id) => ({ data: { user: { id } } }),
    deleteUser: async (id) => { try { await db.query('delete from auth.users where id = $1', [id]); return { error: null }; } catch (e) { return { error: { message: e.message } }; } },
  };
  return { from, rpc, auth: { admin, getUser: async (t) => tokens[t] ? { data: { user: { id: tokens[t] } }, error: null } : { data: { user: null }, error: { message: 'bad' } } } };
}
