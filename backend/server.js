// backend/server.js
const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const Stripe = require('stripe');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
const port = process.env.PORT || 8787;

/* ---------- URLs / ENV (no trailing slash) ---------- */
function noSlash(v, fallback) {
  return String(v || fallback).replace(/\/$/, '');
}
const FRONTEND_URL = noSlash(process.env.FRONTEND_URL, 'http://localhost:5173');
const BACKEND_URL  = noSlash(process.env.BACKEND_URL,  `http://localhost:${port}`);
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || 'https://instagram.com/Wiz_pharoah';
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN || '';           // for admin routes
const PRICE_MINOR   = Number(process.env.VOTE_PRICE_MINOR || 100); // 100 = $1.00

/* ---------- CORS (allow your static site) ---------- */
const ALLOW_PATTERNS = [
  new RegExp('^.+' + '\\.app\\.github\\.dev$'),  // Codespaces, if you use it
];
function isAllowedOrigin(origin) {
  if (!origin) return true; // curl, same-origin
  try {
    const u = new URL(origin);
    if (noSlash(origin) === FRONTEND_URL) return true;
    if (ALLOW_PATTERNS.some(re => re.test(u.host))) return true;
  } catch (_) {}
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || FRONTEND_URL);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Small log when the button is pressed
app.use((req, _res, next) => {
  if (req.path === '/api/create-checkout-session') {
    console.log('[Checkout] origin:', req.headers.origin, 'referer:', req.headers.referer);
  }
  next();
});

/* ---------- Stripe ---------- */
const STRIPE_SECRET = (process.env.STRIPE_SECRET_KEY || '').trim();
let stripe = null;
if (STRIPE_SECRET) {
  try { stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' }); }
  catch (e) { console.error('Stripe init failed:', e.message); }
}

/* ---------- Body parsers ---------- */
// Webhook needs raw body
app.use('/api/stripe/webhook', bodyParser.raw({ type: 'application/json' }));
// Everything else is JSON
app.use(bodyParser.json());

/* ---------- SQLite (free-tier safe) ---------- */
// Default: file under backend/persist/votes.db (works on Render free)
// You can override with DB_PATH if you want.
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, 'persist', 'votes.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log('--- Backend starting ---');
console.log('FRONTEND_URL:', FRONTEND_URL);
console.log('BACKEND_URL :', BACKEND_URL);
console.log('[DB] Using SQLite at:', DB_PATH);

/* ---------- Schema ---------- */
const SQL_CREATE_CANDIDATES = `CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  tally INTEGER NOT NULL DEFAULT 0
);`;

const SQL_CREATE_TRANSACTIONS = `CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE,
  candidate_id INTEGER NOT NULL,
  votes INTEGER NOT NULL,
  currency TEXT NOT NULL,
  amount_total INTEGER NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);`;

const SQL_CREATE_SETTINGS = `CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  question TEXT,
  glow TEXT
);`;

db.exec(SQL_CREATE_CANDIDATES);
db.exec(SQL_CREATE_TRANSACTIONS);
db.exec(SQL_CREATE_SETTINGS);

// Seed defaults if empty
db.prepare('INSERT OR IGNORE INTO settings (id, question, glow) VALUES (1, ?, ?)')
  .run("Is this week's answer YES?", '#00ffff');

if (db.prepare('SELECT COUNT(*) AS c FROM candidates').get().c === 0) {
  const seeds = (process.env.CANDIDATES || 'Yes,No')
    .split(',').map(s => s.trim()).filter(Boolean);
  const ins = db.prepare('INSERT INTO candidates (name) VALUES (?)');
  const tx  = db.transaction(arr => { for (const n of arr) ins.run(n); });
  tx(seeds);
  console.log('[DB] Seeded candidates:', seeds.join(', '));
}

/* ---------- Helpers ---------- */
function priceMinor(votes) {
  return PRICE_MINOR * Math.max(1, Number(votes || 1));
}

/* ---------- Basic routes ---------- */
app.get('/', (req,res)=>res.send('Backend up ✅ — try /api/health, /api/settings, /api/tally'));
app.get('/api/health', (_req,res)=>res.json({ ok:true }));

app.get('/api/settings', (_req,res)=>{
  const s = db.prepare('SELECT question, glow FROM settings WHERE id=1').get();
  res.json({ question: s?.question || '', glow: s?.glow || '#00ffff', instagram: INSTAGRAM_URL });
});

app.get('/api/tally', (_req,res)=>{
  const rows = db.prepare('SELECT id,name,tally FROM candidates ORDER BY id ASC').all();
  res.json({ tally: rows });
});

/* ---------- Admin routes ---------- */
// POST /api/admin/seed  (run once if tally is empty)
// Header: Authorization: Bearer <ADMIN_TOKEN>
app.post('/api/admin/seed', (req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error:'Unauthorized' });

  const seeds = (process.env.CANDIDATES || 'Yes,No')
    .split(',').map(s => s.trim()).filter(Boolean);

  const ins = db.prepare('INSERT OR IGNORE INTO candidates (name) VALUES (?)');
  const tx  = db.transaction(arr => { for (const n of arr) ins.run(n); });
  tx(seeds);

  const rows = db.prepare('SELECT id,name,tally FROM candidates ORDER BY id').all();
  res.json({ ok:true, tally: rows });
});

/* ---------- Create checkout ---------- */
app.post('/api/create-checkout-session', async (req,res)=>{
  try {
    if (!stripe) return res.status(400).json({ error:'Stripe is not configured on the server.' });

    const candidateId = Number(req.body?.candidateId);
    const votesRaw = Number.parseInt(req.body?.votes, 10);
    const votes = Number.isFinite(votesRaw) && votesRaw > 0 ? votesRaw : 1;
    const currency = String(req.body?.currency || 'USD').toUpperCase();

    const successUrl = req.body?.successUrl ||
      `${FRONTEND_URL}/?status=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl  = req.body?.cancelUrl ||
      `${FRONTEND_URL}/?status=cancelled`;

    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error:'Invalid candidateId' });
    }
    const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(candidateId);
    if (!cand) return res.status(404).json({ error:'Candidate not found' });

    const amount = priceMinor(votes);
    const session = await stripe.checkout.sessions.create({
      mode:'payment',
      currency,
      line_items:[{
        price_data:{
          currency,
          product_data:{ name:`${cand.name} — ${votes} vote${votes>1?'s':''}` },
          unit_amount: amount
        },
        quantity:1
      }],
      success_url: successUrl,
      cancel_url:  cancelUrl,
      allow_promotion_codes:false,
      metadata:{ candidate_id:String(cand.id), votes:String(votes) }
    });

    db.prepare('INSERT INTO transactions (session_id, candidate_id, votes, currency, amount_total, paid)')
      .run(session.id, cand.id, votes, currency, amount, 0);

    res.json({ id: session.id, url: session.url });
  } catch (e) {
    console.error('Create session error:', e);
    const msg = process.env.NODE_ENV === 'production'
      ? 'Failed to create checkout session'
      : `Failed to create checkout session: ${e.message}`;
    res.status(500).json({ error: msg });
  }
});

/* ---------- Verify after redirect ---------- */
app.get('/api/verify-session', async (req,res)=>{
  try {
    if (!stripe) return res.status(400).json({ error:'Stripe not configured' });

    const { session_id } = req.query || {};
    if (!session_id) return res.status(400).json({ error:'Missing session_id' });

    const trx = db.prepare('SELECT * FROM transactions WHERE session_id=?').get(session_id);
    if (!trx) return res.status(404).json({ error:'Unknown session' });
    if (trx.paid) return res.json({ ok:true, alreadyCounted:true });

    const session = await stripe.checkout.sessions.retrieve(String(session_id));
    if (session.payment_status === 'paid') {
      const mark = db.prepare('UPDATE transactions SET paid=1 WHERE session_id=?');
      const inc  = db.prepare('UPDATE candidates SET tally=tally+? WHERE id=?');
      const tx   = db.transaction(() => { mark.run(String(session_id)); inc.run(trx.votes, trx.candidate_id); });
      tx();
      return res.json({ ok:true, counted:true });
    }
    res.json({ ok:false, paid:false });
  } catch (e) {
    console.error('Verify error:', e);
    res.status(500).json({ error:'Verification failed' });
  }
});

/* ---------- Optional webhook ---------- */
app.post('/api/stripe/webhook', (req,res)=>{
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !stripe) return res.json({ received:true, note:'webhook not configured' });

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, secret);
    if (event.type === 'checkout.session.completed') {
      const { id } = event.data.object;
      const trx = db.prepare('SELECT * FROM transactions WHERE session_id=?').get(id);
      if (trx && !trx.paid) {
        const mark = db.prepare('UPDATE transactions SET paid=1 WHERE session_id=?');
        const inc  = db.prepare('UPDATE candidates SET tally=tally+? WHERE id=?');
        const tx   = db.transaction(() => { mark.run(id); inc.run(trx.votes, trx.candidate_id); });
        tx();
      }
    }
  } catch (e) {
    console.error('Webhook error:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  res.json({ received:true });
});

/* ---------- Start ---------- */
app.listen(port, () => {
  console.log(`Backend running on ${BACKEND_URL}`);
});
