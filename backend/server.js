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

// ---------------- CORS FIX ----------------
function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin/curl
  try {
    const o = origin.replace(/\/$/, '');
    if (o === FRONTEND_URL) return true;
    const host = new URL(o).host;
    if (host.endsWith('.app.github.dev')) return true; // Codespaces
    if (o === 'http://localhost:5173' || o === 'https://localhost:5173') return true;
  } catch (_) {}
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// (Optional) small log to verify CORS on the payment route
app.use((req, _res, next) => {
  if (req.path === '/api/create-checkout-session') {
    console.log('[CORS]', req.method, 'origin:', req.headers.origin);
  }
  next();
});
// ------------------------------------------

// Stripe
const stripeSecret = (process.env.STRIPE_SECRET_KEY || '').trim();
let stripe = null;
if (stripeSecret) {
  try { stripe = new Stripe(stripeSecret, { apiVersion: '2024-06-20' }); }
  catch (e) { console.error('Stripe init failed:', e.message); }
}

// Stripe webhook **must** see raw body
app.use('/api/stripe/webhook', bodyParser.raw({ type: 'application/json' }));
// Normal JSON for the rest
app.use(bodyParser.json());

// ---------------- SQLite PATH (FREE PLAN-FRIENDLY) ----------------
// Default to a local folder inside backend/ so it works on free Render.
// If you later add a persistent disk, just set DB_PATH=/data/votes.db.
const DATA_DIR = process.env.DB_DIR || path.join(__dirname, 'persist');
const DB_PATH  = process.env.DB_PATH || path.join(DATA_DIR, 'votes.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
console.log(`[DB] Using SQLite at: ${DB_PATH}`);
// ------------------------------------------------------------------

// Schema
const SQL_CREATE_CANDIDATES = `CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  tally INTEGER NOT NULL DEFAULT 0
)`;
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
)`;
const SQL_CRE_
