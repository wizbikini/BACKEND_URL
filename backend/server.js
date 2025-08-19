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

// ---- URLs from env (no trailing slash) ----
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const BACKEND_URL  = (process.env.BACKEND_URL  || `http://localhost:${port}`).replace(/\/$/, '');
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || 'https://instagram.com/Wiz_pharoah';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// ---------------- CORS (Render-friendly) ----------------
function allowCors(origin) {
  if (!origin) return false; // curl/same-origin etc.
  try {
    const o = origin.replace(/\/$/, '');
    if (o === FRONTEND_URL) return true;

    const host = new URL(o).host;
    // Allow Render-hosted frontends and GitHub Codespaces (and localhost)
    if (host.endsWith('.onrender.com')) return true;
    if (host.endsWith('.app.github.dev')) return true;
    if (o === 'http://localhost:5173' || o === 'https://localhost:5173') return true;
  } catch (_) {}
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowCors(origin)) {
    // Echo back the requesting origin (required by CORS)
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Helpful CORS log on the payment route
app.use((req, _res, next) => {
  if (req.path === '/api/create-checkout-session') {
    console.log('[CORS]', req.method, 'origin:', req.headers.origin);
  }
  next();
});

// ---------------- Stripe ----------------
const stripeSecret = (process.env.STRIPE_SECRET_KEY || '').trim();
let stripe = null;
if (stripeSecret) {
  try { stripe = new Stripe(stripeSecret, { apiVersion: '2024-06-20' }); }
  catch (e) { console.error('Stripe init failed:', e.message); }
}

// Stripe webhook needs raw body; everything else JSON
app.use('/api/stripe/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

// ---------------- SQLite PATH (free-tier safe) ----------------
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, 'persist', 'votes.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
console.log(`[DB] Using SQLite at: ${DB_PATH}`);

// ---------------- Schema ----------------
db.exec(`CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  tally INTEGER NOT NULL DEFAULT 0
);`);

db.exec(`CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE,
  candidate_id INTEGER NOT NULL,
  votes INTEGER NOT NULL,
  currency TEXT NOT NULL,
  amount_total INTEGER NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);`);

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  question TEXT,
  glow TEXT
);`);

// seed
db.prepare('INSERT OR IGNORE INTO settings (id, question, glow) VALUES (1, ?, ?)').run("Is this week's answer YES?", '#00ffff');
if (db.prepare('SELECT COUNT(*) AS c FROM candidates').get().c === 0) {
  const seeds = (process.env.CANDIDATES || 'Yes,No').split(',').map(s=>s.trim()).filter(Boolean);
  const ins = db.prepare('INSERT INTO candidates (name) VALUES (?)');
  const tx = db.transaction(arr => { for (const n of arr) ins.run(n); });
  tx(seeds);
}

function priceMinor(votes){
  const base = Number(process.env.VOTE_PRICE_MINOR || 100); // 100 = $1.00
  return base * Math.max(1, Number(votes||1));
}

// ---------------- Routes ----------------
app.get('/', (req,res)=>res.send('Backend up ✅ — try /api/health, /api/settings, /api/tally'));
app.get('/api/health', (req,res)=>res.json({ ok:true }));
app.get('/api/settings', (req,res)=>{
  const s = db.prepare('SELECT question, glow FROM settings WHERE id=1').get();
  res.json({ question: s?.question||'', glow: s?.glow||'#00ffff', instagram: INSTAGRAM_URL });
});
app.get('/api/tally', (req,res)=>{
  const rows = db.prepare('SELECT id,name,tally FROM candidates ORDER BY id ASC').all();
  res.json({ tally: rows });
});

app.post('/api/admin/settings', (req,res)=>{
  const auth = req.headers.authorization || '';
  if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`)
    return res.status(401).json({ error:'Unauthorized' });
  const { question, glow } = req.body || {};
  db.prepare('UPDATE settings SET question=COALESCE(?,question), glow=COALESCE(?,glow) WHERE id=1')
    .run(question, glow);
  res.json({ ok:true });
});

// ------------- Stripe Checkout -------------
app.post('/api/create-checkout-session', async (req,res)=>{
  try {
    const candidateId = Number(req.body?.candidateId);
    const votesRaw = Number.parseInt(req.body?.votes, 10);
    const votes = Number.isFinite(votesRaw) && votesRaw > 0 ? votesRaw : 1;
    const currency = String(req.body?.currency || 'USD').toUpperCase();
    const successUrl = req.body?.successUrl || `${FRONTEND_URL}/?status=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl  = req.body?.cancelUrl  || `${FRONTEND_URL}/?status=cancelled`;

    if (!stripe) return res.status(400).json({ error:'Stripe is not configured on the server.' });
    if (!Number.isFinite(candidateId)) return res.status(400).json({ error:'Invalid candidateId' });

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

    db.prepare('INSERT INTO transactions (session_id, candidate_id, votes, currency, amount_total, paid) VALUES (?,?,?,?,?,0)')
      .run(session.id, cand.id, votes, currency, amount);

    res.json({ id: session.id, url: session.url });
  } catch (e) {
    console.error('Create session error:', e);
    const msg = process.env.NODE_ENV === 'production' ? 'Failed to create checkout session' : `Failed to create checkout session: ${e.message}`;
    res.status(500).json({ error: msg });
  }
});

// ------------- Verify after redirect -------------
app.get('/api/verify-session', async (req,res)=>{
  try {
    const { session_id } = req.query || {};
    if (!session_id) return res.status(400).json({ error:'Missing session_id' });

    const trx = db.prepare('SELECT * FROM transactions WHERE session_id=?').get(session_id);
    if (!trx) return res.status(404).json({ error:'Unknown session' });
    if (trx.paid) return res.json({ ok:true
