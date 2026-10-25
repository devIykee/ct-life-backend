/**
 * REST load: N players doing a play session against the CT Life API.
 *
 * Runs on k6 (https://grafana.com/docs/k6/latest/), not Node. Pair it with
 * tools/load/street-players.ts, which drives the same number of players on
 * the realtime server. See docs/LOAD-TEST.md for the full procedure.
 *
 *   k6 run -e API=http://localhost:4010 -e PEAK=300 tools/load/k6/rest-players.js
 *
 * Environment (all optional):
 *   API         base URL (default http://localhost:4010)
 *   PEAK        peak concurrent players (default 300)
 *   STEP_HOLD   how long each plateau (1/3, 2/3, all of PEAK) lasts (default 3m)
 *   THINK       think-time multiplier; 1 = a real player, 0.25 = a 4x heavier player (default 1)
 *   OUT         path for the JSON summary (default load-rest-summary.json)
 *
 * Each virtual user is one player. The first iteration signs in like a new
 * install: POST /v1/auth/dev, the lottery roll, a character, then the app
 * boot reads (/v1/me, /v1/config). Every later iteration is one loop of a
 * session: quests, daily streak (claims once a day), the casino (state and
 * up to three slot spins, inside the per-player 2/s limit), the shop
 * (catalog, owned items, sometimes an order) and claiming any finished
 * quest, with think time between screens.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const API = __ENV.API || 'http://localhost:4010';
const PEAK = Number(__ENV.PEAK || 300);
const HOLD = __ENV.STEP_HOLD || '3m';
const THINK = Number(__ENV.THINK || 1);
const OUT = __ENV.OUT || 'load-rest-summary.json';

const serverErrors = new Counter('server_errors');
const rateLimited = new Counter('rate_limited');

const ENDPOINTS = [
  'POST /v1/auth/dev',
  'POST /v1/lottery/roll',
  'POST /v1/characters',
  'GET /v1/me',
  'GET /v1/config',
  'GET /v1/quests',
  'POST /v1/quests/:id/claim',
  'GET /v1/daily/status',
  'POST /v1/daily/claim',
  'GET /v1/casino/state',
  'POST /v1/casino/slots/spin',
  'GET /v1/shop/catalog',
  'GET /v1/me/items',
  'POST /v1/shop/orders',
];

const thresholds = {
  // A 5xx or a dropped connection is a failure; 4xx (caps, cooldowns,
  // insufficient Cash) are game answers, counted but not failed.
  server_errors: ['count<1'],
  http_req_duration: ['p(95)<500'],
};
// A threshold per endpoint makes k6 keep its own latency trend in the summary.
for (const name of ENDPOINTS) thresholds[`http_req_duration{name:${name}}`] = ['p(95)<1000'];

export const options = {
  scenarios: {
    players: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: Math.ceil(PEAK / 3) },
        { duration: HOLD, target: Math.ceil(PEAK / 3) },
        { duration: '1m', target: Math.ceil((2 * PEAK) / 3) },
        { duration: HOLD, target: Math.ceil((2 * PEAK) / 3) },
        { duration: '1m', target: PEAK },
        { duration: HOLD, target: PEAK },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 403, 404, 409, 422, 429));

// --- Helpers ---------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A random 32-byte Solana-shaped public key in base58 (dev auth only parses it). */
function randomWallet() {
  const bytes = [];
  for (let i = 0; i < 32; i++) bytes.push(Math.floor(Math.random() * 256));
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const b of bytes) {
    if (b !== 0) break;
    out += '1';
  }
  for (let k = digits.length - 1; k >= 0; k--) out += B58[digits[k]];
  return out;
}

function key() {
  return `k6-${__VU}-${__ITER}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function track(res) {
  if (res.status === 0 || res.status >= 500) serverErrors.add(1);
  if (res.status === 429) rateLimited.add(1);
  return res;
}

function get(path, name) {
  return track(http.get(`${API}${path}`, { headers: authHeaders(), tags: { name } }));
}

function post(path, name, body) {
  const headers = Object.assign(
    { 'content-type': 'application/json', 'idempotency-key': key() },
    authHeaders(),
  );
  return track(
    http.post(`${API}${path}`, body === undefined ? '{}' : JSON.stringify(body), {
      headers,
      tags: { name },
    }),
  );
}

function think(minS, maxS) {
  sleep((minS + Math.random() * (maxS - minS)) * THINK);
}

// --- Per-VU state (each VU is one player) ----------------------------------

let token = null;
let dailyClaimedOn = '';
let ordered = false;

function authHeaders() {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function signUp() {
  token = null;
  const wallet = randomWallet();
  const auth = post('/v1/auth/dev', 'POST /v1/auth/dev', { wallet });
  if (!check(auth, { 'signed in': (r) => r.status === 200 })) return false;
  token = auth.json('accessToken');
  post('/v1/lottery/roll', 'POST /v1/lottery/roll');
  const ch = post('/v1/characters', 'POST /v1/characters', {
    alias: `k6_${wallet.slice(0, 12)}`,
    look: {
      skinTone: '#f5d0a9',
      headId: 'head_default',
      hairId: 'hair_short',
      topId: 'top_hoodie',
      bottomId: 'bottom_jeans',
      shoesId: 'shoes_sneakers',
      accId: 'acc_none',
    },
    traitIds: ['fast_talker', 'deep_pockets'],
    dreamId: 'make_10k',
    tribeId: 'trencher',
    ageConfirmed: true,
  });
  check(ch, { 'character created': (r) => r.status === 201 || r.status === 200 });
  // App boot.
  get('/v1/me', 'GET /v1/me');
  get('/v1/config', 'GET /v1/config');
  return true;
}

export default function () {
  if (token === null) {
    if (!signUp()) {
      sleep(2);
      return;
    }
    think(1, 3);
  }

  // Occasionally the app comes back from the background.
  if (Math.random() < 0.2) {
    get('/v1/me', 'GET /v1/me');
    get('/v1/config', 'GET /v1/config');
  }

  // Quests screen.
  const quests = get('/v1/quests', 'GET /v1/quests');
  think(2, 5);

  // Daily streak, once per UTC day.
  const status = get('/v1/daily/status', 'GET /v1/daily/status');
  const today = new Date().toISOString().slice(0, 10);
  if (status.status === 200 && status.json('claimedToday') === false && dailyClaimedOn !== today) {
    const c = post('/v1/daily/claim', 'POST /v1/daily/claim');
    if (c.status === 200 || c.status === 409) dailyClaimedOn = today;
  }
  think(2, 5);

  // The Rug Room: state, then up to three spins at the 2/s per-player limit.
  get('/v1/casino/state', 'GET /v1/casino/state');
  think(1, 3);
  const spins = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < spins; i++) {
    const r = post('/v1/casino/slots/spin', 'POST /v1/casino/slots/spin', { stakeCents: 100 });
    if (r.status !== 201) break;
    sleep(1);
  }
  think(2, 5);

  // Duo Shop: browse, look at owned items, one small order per player.
  get('/v1/shop/catalog', 'GET /v1/shop/catalog');
  think(2, 6);
  get('/v1/me/items', 'GET /v1/me/items');
  if (!ordered && Math.random() < 0.1) {
    const o = post('/v1/shop/orders', 'POST /v1/shop/orders', {
      items: [{ itemId: 'plant_zebra', qty: 1 }],
      window: 'asap',
      destination: 'door',
    });
    if (o.status === 201) ordered = true;
  }
  think(2, 5);

  // Claim anything finished (casino and daily progress feed some quests).
  if (quests.status === 200) {
    const body = quests.json();
    const all = [].concat(
      (body.daily && body.daily.quests) || [],
      (body.weekly && body.weekly.quests) || [],
    );
    for (const q of all) {
      if (q.completed && !q.claimed) post(`/v1/quests/${q.id}/claim`, 'POST /v1/quests/:id/claim');
    }
  }
  think(5, 15);
}

// --- Summary ---------------------------------------------------------------

function trend(metric) {
  if (!metric) return null;
  const v = metric.values;
  const r = (n) => Math.round(n * 10) / 10;
  return { avg: r(v.avg), p50: r(v.med), p95: r(v['p(95)']), p99: r(v['p(99)']), max: r(v.max) };
}

export function handleSummary(data) {
  const m = data.metrics;
  const endpoints = {};
  for (const name of ENDPOINTS) {
    const t = m[`http_req_duration{name:${name}}`];
    if (t && t.values.max > 0) endpoints[name] = trend(t);
  }
  const summary = {
    at: new Date().toISOString(),
    api: API,
    peak: PEAK,
    stepHold: HOLD,
    think: THINK,
    requests: m.http_reqs ? m.http_reqs.values.count : 0,
    rps: m.http_reqs ? Math.round(m.http_reqs.values.rate * 10) / 10 : 0,
    latencyMs: trend(m.http_req_duration),
    waitingMs: trend(m.http_req_waiting),
    serverErrors: m.server_errors ? m.server_errors.values.count : 0,
    rateLimited: m.rate_limited ? m.rate_limited.values.count : 0,
    failedRate: m.http_req_failed ? m.http_req_failed.values.rate : 0,
    checks: m.checks ? m.checks.values.rate : null,
    endpoints,
  };
  const lines = [
    `requests ${summary.requests} (${summary.rps}/s), 5xx/conn errors ${summary.serverErrors}, 429s ${summary.rateLimited}`,
    `all     p50 ${summary.latencyMs.p50}  p95 ${summary.latencyMs.p95}  p99 ${summary.latencyMs.p99}  max ${summary.latencyMs.max} ms`,
  ];
  for (const [name, t] of Object.entries(endpoints)) {
    lines.push(`${name.padEnd(28)} p50 ${t.p50}  p95 ${t.p95}  p99 ${t.p99}  max ${t.max} ms`);
  }
  return { stdout: lines.join('\n') + '\n', [OUT]: JSON.stringify(summary, null, 2) };
}
