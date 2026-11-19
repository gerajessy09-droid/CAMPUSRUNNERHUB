const { Pool } = require('pg'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), cr = require('crypto');
const KEY = () => process.env.PAYSTACK_SECRET_KEY || '';
const DEMO = () => (!KEY() || /xxx|placeholder|your/i.test(KEY())) && process.env.ALLOW_DEMO === '1';
const pool = global.__pool || (global.__pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } }));
const Q = (s, a) => pool.query(s, a).then(r => r.rows);
async function T(fn) { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn((s, a) => c.query(s, a)); await c.query('COMMIT'); return r; } catch (x) { await c.query('ROLLBACK'); throw x; } finally { c.release(); } }
const out = (s, b) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const bad = (m, s = 400) => out(s, { error: m });
const hits = {}; const limited = (ip, k) => { const n = Date.now(), a = (hits[k + ip] = (hits[k + ip] || []).filter(t => n - t < 9e5)); a.push(n); return a.length > 30; };
const tok = id => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });
const ps = async (path, method = 'GET', body) => { const r = await fetch('https://api.paystack.co' + path, { method, headers: { Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({ status: false, message: 'Paystack sent a bad response.' })); };
const WHEN = ['ASAP', 'Within 30 min', 'Within 1 hour', 'Today'];

let ready;
const init = () => ready || (ready = (async () => {
  await Q(`create table if not exists users(id serial primary key,name text,email text unique,pw text,role text default 'Student',sid text,phone text,verified bool default false,rejected text,suspended text,bank_name text,bank_no text,recipient text,bal int default 0,esc int default 0,created timestamptz default now());
create table if not exists tasks(id serial primary key,client_id int,runner_id int,type text,title text,descr text,pickup text,dropoff text,needed text,price int,items int,status text default 'Pending',funded bool default false,code text,attempts int default 0,delivered_at timestamptz,dispute_by int,dispute_reason text,created timestamptz default now());
create table if not exists tx(id serial primary key,user_id int,task_id int,amt int,type text,ref text unique,status text default 'Success',created timestamptz default now());
create table if not exists logs(id serial primary key,admin_id int,action text,detail text,created timestamptz default now());`);
  const dm = process.env.ALLOW_DEMO === '1';
  const ae = (process.env.ADMIN_EMAIL || (dm ? 'admin@example.com' : '')).trim().toLowerCase(), ap = process.env.ADMIN_PASSWORD || (dm ? 'demo1234' : '');
  if (!(await Q("select 1 from users where role='Admin'")).length && ae && ap)
    await Q("insert into users(name,email,pw,role,verified,phone) values('Platform admin',$1,$2,'Admin',true,'')", [ae, await bcrypt.hash(ap, 10)]);
  if (dm && !(await Q("select 1 from users where role='Student'")).length)
    await Q("insert into users(name,email,pw,sid,phone,verified) values('Ada Obi','ada@example.com',$1,'DEMO001','+2348011111111',true),('Tunde Bello','tunde@example.com',$1,'DEMO002','+2348022222222',true)", [await bcrypt.hash('demo1234', 10)]);
})());

// ---- money (all inside transactions, conditional updates) ----
async function fund(ref, kobo) {
  return T(async c => {
    const t = (await c('select * from tx where ref=$1 and type=$2 for update', [ref, 'Deposit'])).rows[0];
    if (!t || t.status !== 'Pending') return false;
    const k = (await c('select * from tasks where id=$1 for update', [t.task_id])).rows[0];
    if (!k || kobo !== (k.price + k.items) * 100) { await c("update tx set status='Failed' where id=$1", [t.id]); return false; }
    await c("update tx set status='Success' where id=$1", [t.id]);
    const u = await c('update tasks set funded=true where id=$1 and funded=false returning id', [k.id]);
    if (u.rowCount) await c('update users set esc=esc+$1 where id=$2', [k.price + k.items, k.client_id]);
    return true;
  });
}
async function release(c, id, from) {
  const r = await c("update tasks set status='Completed' where id=$1 and status=any($2) returning *", [id, from]);
  if (!r.rowCount) return false;
  const t = r.rows[0], tot = t.price + t.items, cm = Math.round(t.price * 0.1); // commission on service price only
  const a = (await c("select id from users where role='Admin' limit 1")).rows[0].id;
  await c('update users set esc=esc-$1 where id=$2', [tot, t.client_id]);
  await c('update users set bal=bal+$1 where id=$2', [cm, a]);
  await c('update users set bal=bal+$1 where id=$2', [tot - cm, t.runner_id]);
  await c('insert into tx(user_id,task_id,amt,type) values($1,$2,$3,$4),($5,$2,$6,$7)', [a, t.id, cm, 'Commission', t.runner_id, tot - cm, 'Earning']);
  return true;
}
async function refund(c, id, from) {
  const r = await c("update tasks set status='Cancelled' where id=$1 and status=any($2) returning *", [id, from]);
  if (!r.rowCount) return false;
  const t = r.rows[0];
  if (t.funded) { const tot = t.price + t.items; await c('update users set esc=esc-$1,bal=bal+$1 where id=$2', [tot, t.client_id]); await c('insert into tx(user_id,task_id,amt,type) values($1,$2,$3,$4)', [t.client_id, t.id, tot, 'Refund']); }
  return true;
}
async function failPayout(ref) {
  return T(async c => {
    const r = await c("update tx set status='Failed' where ref=$1 and type='Payout' and status<>'Failed' returning *", [ref]);
    if (r.rowCount) await c('update users set bal=bal+$1 where id=$2', [r.rows[0].amt, r.rows[0].user_id]);
  });
}
async function sweep() {
  const r = await Q("select id from tasks where status='Accepted' and delivered_at < now()-interval '12 hours'");
  for (const x of r) await T(c => release(c, x.id, ['Accepted']));
}
const logA = (a, act, d) => Q('insert into logs(admin_id,action,detail) values($1,$2,$3)', [a, act, d]);

// ---- views ----
const tk = (r, v) => ({ id: r.id, clientId: r.client_id, runnerId: r.runner_id, type: r.type, title: r.title, desc: r.descr, pickup: r.pickup, drop: r.dropoff, when: r.needed, price: r.price, items: r.items, status: r.status, funded: r.funded, attempts: r.attempts, deliveredAt: r.delivered_at ? +new Date(r.delivered_at) : null, code: v && v.id === r.client_id && r.status === 'Accepted' ? r.code : null, dispute: r.dispute_by ? { by: r.dispute_by, reason: r.dispute_reason } : null });
const P = r => ({ id: r.id, name: r.name, email: r.email, role: r.role, sid: r.sid, phone: r.phone, verified: r.verified, rejected: r.rejected || '', suspended: r.suspended || '', bal: r.bal, esc: r.esc, bank: r.bank_no ? { name: r.bank_name, no: r.bank_no } : null });
async function state(u) {
  await sweep().catch(() => {});
  const live = ['Accepted', 'Disputed'];
  const txs = (await Q("select * from tx where user_id=$1 and not (type='Deposit' and status<>'Success') order by id desc limit 100", [u.id])).map(x => ({ id: x.id, uid: x.user_id, tid: x.task_id, amt: x.amt, type: x.type, at: +new Date(x.created), status: x.status }));
  if (u.role === 'Admin') {
    const tasks = (await Q('select * from tasks order by id desc')).map(r => tk(r, null));
    const users = (await Q('select * from users order by id')).map(P);
    const log = (await Q('select * from logs order by id desc limit 100')).map(l => ({ at: +new Date(l.created), by: l.admin_id, a: l.action, d: l.detail }));
    return { meId: u.id, users, tasks, tx: txs, log, stats: { esc: users.reduce((s, x) => s + x.esc, 0) }, demo: DEMO() };
  }
  const rows = await Q('select * from tasks where client_id=$1 or runner_id=$1' + (u.verified ? " or (status='Pending' and funded and client_id<>$1)" : '') + ' order by id desc', [u.id]);
  const own = rows.filter(t => t.client_id === u.id || t.runner_id === u.id), vis = new Set();
  own.forEach(t => { if (!live.includes(t.status)) return; vis.add(t.client_id === u.id ? t.runner_id : t.client_id); });
  const ids = [...new Set(own.flatMap(t => [t.client_id, t.runner_id]).filter(x => x && x !== u.id))];
  const others = ids.length ? (await Q('select * from users where id=any($1)', [ids])).map(r => ({ ...P(r), phone: vis.has(r.id) ? r.phone : '', bal: 0, esc: 0, sid: '', email: '' })) : [];
  return { meId: u.id, users: [P(u), ...others], tasks: rows.map(r => tk(r, u)), tx: txs, log: [], stats: { esc: 0 }, demo: DEMO() };
}

// ---- handlers ----
async function register(b, ip) {
  if (limited(ip, 'r')) return bad('Too many attempts. Wait a few minutes and try again.', 429);
  const em = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim(), sid = String(b.sid || '').trim();
  let ph = String(b.phone || '').replace(/\D/g, ''); ph = ph.startsWith('234') ? ph : '234' + ph.replace(/^0/, '');
  const m = !name ? 'Enter your full name.' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) ? 'Enter a valid email address.' : String(b.password || '').length < 8 ? 'Use a password with at least 8 characters.' : !sid ? 'Enter your student ID number.' : !/^234[789]\d{9}$/.test(ph) ? 'Enter a Nigerian phone number like 08012345678.' : !b.consent ? 'Tick the box to agree to the ID check.' : '';
  if (m) return bad(m);
  if ((await Q('select 1 from users where email=$1 or sid=$2', [em, sid])).length) return bad('That email or student ID already has an account. Sign in instead.');
  const r = await Q('insert into users(name,email,pw,sid,phone) values($1,$2,$3,$4,$5) returning id', [name, em, await bcrypt.hash(String(b.password), 10), sid, '+' + ph]);
  return out(200, { token: tok(r[0].id) });
}
async function login(b, ip) {
  if (limited(ip, 'l')) return bad('Too many attempts. Wait a few minutes and try again.', 429);
  const u = (await Q('select * from users where email=$1', [String(b.email || '').trim().toLowerCase()]))[0];
  if (!u || !(await bcrypt.compare(String(b.password || ''), u.pw))) return bad('Email or password is wrong. Check both and try again.', 401);
  if (u.suspended && u.role !== 'Admin') return out(403, { error: 'Your account is suspended: ' + u.suspended, suspended: true });
  return out(200, { token: tok(u.id) });
}
async function createTask(u, b) {
  if (!u.verified) return bad('Your ID is not verified yet.', 403);
  const type = b.type, g = type === 'Food' || type === 'Delivery';
  if (!['Food', 'Delivery', 'Assignment', 'Project'].includes(type)) return bad('Choose a service type.');
  const price = g ? 1250 : Math.floor(+b.price), items = g ? Math.floor(+b.items || 0) : 0;
  const title = String(b.title || '').trim().slice(0, 120), drop = String(b.drop || '').trim().slice(0, 160), pick = String(b.pickup || '').trim().slice(0, 160);
  const m = !title ? 'Add a title.' : !drop ? 'Add a drop-off place.' : g && !pick ? 'Add a pickup place.' : g && !(items >= 0 && items <= 50000) ? 'Items cost must be between ₦0 and ₦50,000.' : !g && !(price >= 500) ? 'Set a price of at least ₦500.' : !WHEN.includes(b.when) ? 'Choose when you need it.' : '';
  if (m) return bad(m);
  const r = await Q('insert into tasks(client_id,type,title,descr,pickup,dropoff,needed,price,items) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id', [u.id, type, title, String(b.desc || '').trim().slice(0, 1000), g ? pick : '', drop, b.when, price, items]);
  return out(200, { id: r[0].id });
}
async function taskAct(u, id, a, m, b) {
  const t = (await Q('select * from tasks where id=$1', [id]))[0];
  if (!t) return bad('Task not found.', 404);
  if (m === 'DELETE') {
    if (t.client_id !== u.id) return bad('Only the poster can cancel this task.', 403);
    const ok = await T(c => refund(c, id, ['Pending']));
    return ok ? out(200, { ok: true }) : bad('This task can no longer be cancelled.');
  }
  if (a === 'accept') {
    if (!u.verified) return bad('Your ID is not verified yet.', 403);
    const code = String(1000 + cr.randomInt(9000));
    const r = await Q("update tasks set status='Accepted',runner_id=$1,code=$2 where id=$3 and status='Pending' and funded=true and client_id<>$1 returning id", [u.id, code, id]);
    return r.length ? out(200, { ok: true }) : bad('That task is no longer available.');
  }
  if (a === 'delivered') {
    const r = await Q("update tasks set delivered_at=now() where id=$1 and runner_id=$2 and status='Accepted' and delivered_at is null returning id", [id, u.id]);
    return r.length ? out(200, { ok: true }) : bad('You cannot mark this task as delivered.');
  }
  if (a === 'confirm-handover') {
    if (t.runner_id !== u.id || t.status !== 'Accepted') return bad('You cannot confirm this task.', 403);
    if (t.attempts >= 5) return bad('Code entry is locked. Use Mark as delivered.');
    if (String(b.code || '') === t.code) { await T(c => release(c, id, ['Accepted'])); return out(200, { ok: true }); }
    const r = await Q("update tasks set attempts=attempts+1 where id=$1 and status='Accepted' returning attempts", [id]);
    const left = 5 - (r[0] ? r[0].attempts : 5);
    return bad(left > 0 ? 'That code is wrong. Ask the poster to check the code in their Post tab. ' + left + ' tries left.' : 'Too many wrong codes. Code entry is locked. Use Mark as delivered.');
  }
  if (a === 'complete') {
    if (t.client_id !== u.id) return bad('Only the poster can mark this complete.', 403);
    const ok = await T(c => release(c, id, ['Accepted']));
    return ok ? out(200, { ok: true }) : bad('This task cannot be completed.');
  }
  if (a === 'dispute') {
    const reason = String(b.reason || '').trim().slice(0, 1000);
    if (!reason) return bad('Write what went wrong.');
    const r = await Q("update tasks set status='Disputed',dispute_by=$1,dispute_reason=$2 where id=$3 and status='Accepted' and (client_id=$1 or runner_id=$1) returning id", [u.id, reason, id]);
    return r.length ? out(200, { ok: true }) : bad('You cannot report this task.');
  }
  return bad('Not found.', 404);
}
async function initPay(u, b) {
  const t = (await Q('select * from tasks where id=$1 and client_id=$2', [+b.taskId, u.id]))[0];
  if (!t || t.status !== 'Pending' || t.funded) return bad('This task cannot be paid for.');
  if (!DEMO() && (!KEY() || /xxx|placeholder|your/i.test(KEY()))) return bad('Payments are not set up yet. Add PAYSTACK_SECRET_KEY in Netlify.', 503);
  const ref = 'CR' + t.id + '_' + Date.now(), tot = t.price + t.items;
  await Q("insert into tx(user_id,task_id,amt,type,ref,status) values($1,$2,$3,'Deposit',$4,'Pending')", [u.id, t.id, tot, ref]);
  if (DEMO()) return out(200, { demo: true, reference: ref });
  const r = await ps('/transaction/initialize', 'POST', { email: u.email, amount: tot * 100, reference: ref, callback_url: (process.env.SITE_URL || process.env.URL || '') + '/' });
  return r.status ? out(200, { url: r.data.authorization_url }) : bad('Payment could not start: ' + (r.message || 'try again.'), 502);
}
async function webhook(ev, raw, ip) {
  if (DEMO() || !KEY()) return out(404, { error: 'Not found' });
  if (limited(ip, 'w')) return bad('Too many requests.', 429);
  const sig = cr.createHmac('sha512', KEY()).update(raw).digest('hex');
  if (sig !== (ev.headers['x-paystack-signature'] || '')) return bad('Bad signature.', 401);
  let e; try { e = JSON.parse(raw); } catch { return bad('Bad body.'); }
  const d = e.data || {};
  if (e.event === 'charge.success') await fund(d.reference, d.amount);
  else if (e.event === 'transfer.success') await Q("update tx set status='Success' where ref=$1 and type='Payout'", [d.reference]);
  else if (e.event === 'transfer.failed' || e.event === 'transfer.reversed') await failPayout(d.reference);
  return out(200, { ok: true });
}
async function bank(u, b) {
  const no = String(b.accountNo || '').trim();
  if (!/^\d{10}$/.test(no)) return bad('Enter a 10-digit account number.');
  if (DEMO()) { await Q('update users set bank_name=$1,bank_no=$2,recipient=$3 where id=$4', [String(b.bankName || 'Demo Bank'), no, 'demo', u.id]); return out(200, { ok: true }); }
  const rs = await ps('/bank/resolve?account_number=' + no + '&bank_code=' + encodeURIComponent(b.bankCode || ''));
  if (!rs.status) return bad('Bank account not found. Check the bank and number.');
  const rc = await ps('/transferrecipient', 'POST', { type: 'nuban', name: rs.data.account_name, account_number: no, bank_code: b.bankCode, currency: 'NGN' });
  if (!rc.status) return bad('Could not save this bank account: ' + (rc.message || 'try again.'), 502);
  await Q('update users set bank_name=$1,bank_no=$2,recipient=$3 where id=$4', [String(b.bankName || '') + ' (' + rs.data.account_name + ')', no, rc.data.recipient_code, u.id]);
  return out(200, { ok: true });
}
async function withdraw(u, b) {
  const a = Math.floor(+b.amount);
  if (!(a >= 1000)) return bad('The minimum withdrawal is ₦1,000.');
  if (!u.recipient) return bad('Add a bank account first.');
  const ref = 'cr-po-' + u.id + '-' + Date.now();
  const ok = await T(async c => {
    const r = await c('update users set bal=bal-$1 where id=$2 and bal>=$1 returning id', [a, u.id]);
    if (!r.rowCount) return false;
    await c("insert into tx(user_id,amt,type,ref,status) values($1,$2,'Payout',$3,'Pending')", [u.id, a, ref]);
    return true;
  });
  if (!ok) return bad('That is more than your available balance.');
  if (DEMO()) { await Q("update tx set status='Success' where ref=$1", [ref]); return out(200, { ok: true }); }
  const r = await ps('/transfer', 'POST', { source: 'balance', amount: a * 100, recipient: u.recipient, reference: ref, reason: 'CampusRunner withdrawal' });
  if (!r.status) { await failPayout(ref); return bad('The transfer could not start, so your money is back in your wallet: ' + (r.message || 'try again.'), 502); }
  return out(200, { ok: true });
}
async function adminAct(u, p, m, b) {
  let r;
  if ((r = p.match(/^\/admin\/verify\/(\d+)$/))) { const x = (await Q('update users set verified=true,rejected=null where id=$1 returning name', [+r[1]]))[0]; if (x) await logA(u.id, 'Approve ID', x.name); return out(200, { ok: true }); }
  if ((r = p.match(/^\/admin\/reject\/(\d+)$/))) { const why = String(b.reason || '').trim(); if (!why) return bad('Give a reason.'); const x = (await Q('update users set rejected=$2 where id=$1 returning name', [+r[1], why]))[0]; if (x) await logA(u.id, 'Reject ID', x.name + ': ' + why); return out(200, { ok: true }); }
  if ((r = p.match(/^\/admin\/disputes\/(\d+)\/resolve$/))) { const pay = !!b.pay, ok = await T(c => pay ? release(c, +r[1], ['Disputed']) : refund(c, +r[1], ['Disputed'])); if (ok) await logA(u.id, pay ? 'Dispute: pay runner' : 'Dispute: refund poster', 'Task ' + r[1]); return ok ? out(200, { ok: true }) : bad('This dispute is already resolved.'); }
  if ((r = p.match(/^\/admin\/tasks\/(\d+)\/force-cancel$/))) { const why = String(b.reason || '').trim(); if (!why) return bad('Give a reason.'); const ok = await T(c => refund(c, +r[1], ['Pending', 'Accepted', 'Disputed'])); if (ok) await logA(u.id, 'Force cancel', 'Task ' + r[1] + ': ' + why); return ok ? out(200, { ok: true }) : bad('This task cannot be cancelled.'); }
  if ((r = p.match(/^\/admin\/users\/(\d+)\/suspend$/))) { const why = String(b.reason || '').trim(); if (!why) return bad('Give a reason.'); const x = (await Q("update users set suspended=$2 where id=$1 and role='Student' returning name", [+r[1], why]))[0]; if (x) await logA(u.id, 'Suspend', x.name + ': ' + why); return out(200, { ok: true }); }
  if ((r = p.match(/^\/admin\/users\/(\d+)\/unsuspend$/))) { const x = (await Q('update users set suspended=null where id=$1 returning name', [+r[1]]))[0]; if (x) await logA(u.id, 'Unsuspend', x.name); return out(200, { ok: true }); }
  return bad('Not found.', 404);
}

exports.sweep = sweep;
exports.handler = async ev => {
  try {
    if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) return bad('Server setup is incomplete: set DATABASE_URL and JWT_SECRET in Netlify.', 500);
    await init();
    const m = ev.httpMethod, p = ev.path.replace(/^(\/\.netlify\/functions\/api|\/api)/, '') || '/';
    const raw = ev.isBase64Encoded ? Buffer.from(ev.body || '', 'base64').toString() : ev.body || '';
    let b = {}; try { b = raw ? JSON.parse(raw) : {}; } catch {}
    const ip = String(ev.headers['x-nf-client-connection-ip'] || ev.headers['x-forwarded-for'] || '').split(',')[0];
    if (p === '/config') return out(200, { demo: DEMO() });
    if (p === '/payments/webhook' && m === 'POST') return await webhook(ev, raw, ip);
    if (p === '/auth/register' && m === 'POST') return await register(b, ip);
    if (p === '/auth/login' && m === 'POST') return await login(b, ip);
    const h = ev.headers.authorization || ev.headers.Authorization || '';
    let id; try { id = jwt.verify(h.replace(/^Bearer /, ''), process.env.JWT_SECRET).id; } catch { return bad('Sign in to continue.', 401); }
    const u = (await Q('select * from users where id=$1', [id]))[0];
    if (!u) return bad('Sign in to continue.', 401);
    if (u.suspended && u.role !== 'Admin') return out(403, { error: 'Your account is suspended: ' + u.suspended, suspended: true });
    if (p === '/state' && m === 'GET') return out(200, await state(u));
    if (p === '/auth/resubmit-id' && m === 'POST') { await Q('update users set rejected=null where id=$1 and not verified', [u.id]); return out(200, { ok: true }); }
    if (p.startsWith('/admin/')) return u.role === 'Admin' ? await adminAct(u, p, m, b) : bad('Admins only.', 403);
    if (p === '/tasks' && m === 'POST') return await createTask(u, b);
    let r;
    if ((r = p.match(/^\/tasks\/(\d+)(?:\/([a-z-]+))?$/))) return await taskAct(u, +r[1], r[2], m, b);
    if (p === '/payments/initialize' && m === 'POST') return await initPay(u, b);
    if (p === '/payments/demo-confirm' && m === 'POST') {
      if (!DEMO()) return out(404, { error: 'Not found' });
      const t = (await Q("select ref,amt from tx where user_id=$1 and task_id=$2 and type='Deposit' and status='Pending' order by id desc limit 1", [u.id, +b.taskId]))[0];
      if (t) await fund(t.ref, t.amt * 100);
      return out(200, { ok: true });
    }
    if ((r = p.match(/^\/payments\/verify\/([\w-]+)$/)) && m === 'GET') {
      if (DEMO()) return out(404, { error: 'Not found' });
      const v = await ps('/transaction/verify/' + r[1]);
      if (v.status && v.data.status === 'success') await fund(r[1], v.data.amount);
      return out(200, { ok: true });
    }
    if (p === '/wallet/banks' && m === 'GET') {
      if (DEMO()) return out(200, { banks: [{ name: 'Demo Bank', code: '000' }] });
      const r2 = await ps('/bank?country=nigeria&currency=NGN&perPage=100');
      return out(200, { banks: (r2.data || []).map(x => ({ name: x.name, code: x.code })) });
    }
    if (p === '/wallet/bank' && m === 'POST') return await bank(u, b);
    if (p === '/wallet/withdraw' && m === 'POST') return await withdraw(u, b);
    return bad('Not found.', 404);
  } catch (x) {
    console.error('api error', x.message);
    return bad('Something went wrong on the server. Try again.', 500);
  }
};
