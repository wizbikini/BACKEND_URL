// PAY-PER-VOTE — Weekly YES/NO with neon, Stripe, live tally
import React, { useEffect, useMemo, useState } from 'react';

/* ------------------------------ small helpers ------------------------------ */
function normalizeVotes(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}
function buildSuccessUrl(origin) {
  return `${origin}/?status=success&session_id={CHECKOUT_SESSION_ID}`;
}
function isValidCurrency(c, set) {
  return set.includes(String(c || '').toUpperCase());
}
/** Resolve backend URL from (in order): Vite env → global/window → default */
function resolveBackendUrl(
  env = (typeof import.meta !== 'undefined' ? import.meta.env : undefined),
  globals = (typeof globalThis !== 'undefined' ? globalThis : {})
) {
  if (env && env.VITE_BACKEND_URL) return { url: env.VITE_BACKEND_URL, source: 'vite-env' };
  if (globals && globals.VITE_BACKEND_URL) return { url: globals.VITE_BACKEND_URL, source: 'global' };
  if (globals && globals.__BACKEND_URL)   return { url: globals.__BACKEND_URL,   source: 'window' };
  return { url: 'http://localhost:8787', source: 'default' };
}
function neonStyle(color) {
  const c = color || '#00ffff';
  return {
    textShadow: `0 0 1px ${c}, 0 0 4px ${c}, 0 0 12px ${c}, 0 0 32px ${c}`,
    boxShadow: `0 0 1px ${c}, 0 0 8px ${c}, inset 0 0 6px ${c}80`,
    borderColor: c,
  };
}

/* ----------------------------- debug: show URL ----------------------------- */
// This runs in the module (OK to use import.meta here). It exposes the value
// in DevTools without needing `import.meta` in the console (which would error).
if (typeof window !== 'undefined') {
  // Don’t clobber if the page already set a custom value:
  if (!window.__BACKEND_URL && typeof import.meta !== 'undefined' && import.meta.env?.VITE_BACKEND_URL) {
    window.__BACKEND_URL = import.meta.env.VITE_BACKEND_URL;
  }
  // Log once on load
  // eslint-disable-next-line no-console
  console.log('[frontend] VITE_BACKEND_URL =', window.__BACKEND_URL || '(unset)');
}

/* --------------------------------- app ---------------------------------- */
export default function App() {
  const { url: BACKEND, source: BACKEND_SOURCE } = resolveBackendUrl();

  const [question, setQuestion] = useState('');
  const [glow, setGlow] = useState('#00ffff');
  const [tally, setTally] = useState([]);
  const [instagram, setInstagram] = useState('https://instagram.com');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const [choiceId, setChoiceId] = useState(null);
  const [votes, setVotes] = useState(1);
  const [currency, setCurrency] = useState('USD');
  const [creating, setCreating] = useState(false);

  const currencies = useMemo(
    () => ['USD','CAD','EUR','GBP','AUD','NZD','JPY','AED','SAR','INR','NGN','ZAR','BRL','MXN','CHF','SEK','NOK','DKK','PLN','RON','TRY','ILS','HKD','SGD','CZK'],
    []
  );

  // initial load + poll tally
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const s = await fetch(`${BACKEND}/api/settings`).then(r => r.json());
        if (cancelled) return;
        setQuestion(s.question || '');
        setGlow(s.glow || '#00ffff');
        setInstagram(s.instagram || 'https://instagram.com');

        const t = await fetch(`${BACKEND}/api/tally`).then(r => r.json());
        if (cancelled) return;
        setTally(t.tally || []);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[frontend] settings/tally fetch failed:', e);
        setMessage('Cannot reach backend. Check VITE_BACKEND_URL and server.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    init();

    const iv = setInterval(async () => {
      try {
        const t = await fetch(`${BACKEND}/api/tally`).then(r => r.json());
        if (!cancelled) setTally(t.tally || []);
      } catch {
        /* swallow polling errors */
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [BACKEND]);

  // post-checkout verify
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const status = p.get('status');
    const session_id = p.get('session_id');

    if (status === 'success' && session_id) {
      fetch(`${BACKEND}/api/verify-session?session_id=${encodeURIComponent(session_id)}`)
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            setMessage(d.alreadyCounted ? 'Payment already verified earlier.' : 'Payment verified! Votes counted.');
          } else {
            setMessage('Payment not verified yet. Refresh in a moment.');
          }
        })
        .catch(() => setMessage('Verification failed. Contact support with your receipt.'));
    } else if (status === 'cancelled') {
      setMessage('Payment cancelled. No votes were cast.');
    }
  }, [BACKEND]);

  // create checkout session → Stripe redirect
  const createCheckout = async () => {
    setMessage('');
    if (!choiceId) {
      setMessage('Pick YES or NO.');
      return;
    }
    if (!isValidCurrency(currency, currencies)) {
      setMessage('Unsupported currency.');
      return;
    }
    const v = normalizeVotes(votes);
    setVotes(v);
    setCreating(true);

    try {
      const res = await fetch(`${BACKEND}/api/create-checkout-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId: choiceId,
          votes: v,
          currency,
          successUrl: buildSuccessUrl(window.location.origin),
          cancelUrl: `${window.location.origin}/?status=cancelled`,
        }),
      });
      const data = await res.json();
      if (data?.url) {
        window.location.assign(data.url);
      } else {
        setMessage(data?.error || 'Unable to create checkout session.');
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[frontend] create-checkout error:', e);
      setMessage('Error connecting to payment server.');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center text-xl text-white" style={{ background: '#000' }}>
        Loading…
      </div>
    );
  }

  const yes = tally.find(x => String(x.name).toLowerCase() === 'yes');
  const no  = tally.find(x => String(x.name).toLowerCase() === 'no');

  return (
    <div className="min-h-screen" style={{ background: '#000' }}>
      <header className="sticky top-0 z-10 bg-black/60 backdrop-blur border-b border-white/10">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between text-white">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-white text-black grid place-items-center font-bold">V</div>
            <div>
              <h1 className="text-xl font-semibold">Today Question</h1>
              <p className="text-xs text-gray-400">Pay-per-vote • Multi-currency • Live tally</p>
            </div>
          </div>
          <a
            href={instagram}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-white/20 hover:bg-white/5 text-sm"
          >
            Instagram
          </a>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-10 text-white">
        <div className="text-center mb-10">
          {BACKEND_SOURCE !== 'vite-env' && (
            <div className="mx-auto mb-5 max-w-2xl p-3 text-xs rounded-md border border-amber-400 bg-amber-900/30 text-amber-200">
              Tip: Set <code>VITE_BACKEND_URL</code> in <code>frontend/.env</code> and restart Vite. Using{' '}
              <b>{BACKEND}</b> from <b>{BACKEND_SOURCE}</b>.
            </div>
          )}
          <h2 className="text-3xl md:text-5xl font-extrabold" style={neonStyle(glow)}>
            {question || 'This week’s question'}
          </h2>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-8 md:gap-16 mb-12">
          <button
            onClick={() => setChoiceId(yes?.id)}
            className={`px-10 py-10 rounded-2xl border text-3xl font-extrabold transition hover:scale-105 ${
              choiceId === yes?.id ? 'ring-2 ring-white' : ''
            }`}
            style={neonStyle(glow)}
          >
            YES
          </button>

          <button
            onClick={() => setChoiceId(no?.id)}
            className={`px-10 py-10 rounded-2xl border text-3xl font-extrabold transition hover:scale-105 ${
              choiceId === no?.id ? 'ring-2 ring-white' : ''
            }`}
            style={neonStyle(glow)}
          >
            NO
          </button>
        </div>

        <div className="max-w-xl mx-auto bg-white/5 border border-white/10 rounded-2xl p-6">
          <div className="grid sm:grid-cols-3 gap-4 items-end">
            <div>
              <label className="text-sm text-gray-300">Votes</label>
              <input
                type="number"
                min={1}
                value={votes}
                onChange={(e) => setVotes(normalizeVotes(e.target.value))}
                className="mt-1 w-full bg-black/40 border border-white/20 text-white rounded-xl px-3 py-2"
              />
            </div>
            <div>
              <label className="text-sm text-gray-300">Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="mt-1 w-full bg-black/40 border border-white/20 text-white rounded-xl px-3 py-2"
              >
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <button
                onClick={createCheckout}
                disabled={creating}
                className="w-full bg-white text-black font-semibold px-4 py-3 rounded-xl hover:bg-gray-200 disabled:opacity-60"
              >
                {creating ? 'Redirecting…' : 'Pay & Cast Vote'}
              </button>
            </div>
          </div>

          {message && <div className="mt-4 text-sm text-amber-200">{message}</div>}

          <p className="mt-4 text-xs text-gray-400">
            Each vote is a small payment. Your votes are counted after successful payment.
          </p>
        </div>

        <div className="mt-12 max-w-xl mx-auto">
          <h3 className="text-lg font-semibold mb-3">Live Tally</h3>
          <ul className="space-y-2">
            {tally.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl px-3 py-2"
              >
                <span className="font-medium">{t.name}</span>
                <span className="text-sm">{t.tally}</span>
              </li>
            ))}
          </ul>
        </div>
      </main>

      <footer className="py-8 text-center text-xs text-gray-500">
        © {new Date().getFullYear()} Weekly Vote. All rights reserved.
      </footer>
    </div>
  );
}
