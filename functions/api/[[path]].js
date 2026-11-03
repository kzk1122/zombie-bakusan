// ゾンビ爆散: the world ranking (2026-11-03, kazu: 世界ランキングいきましょう). A Cloudflare Pages Function in front of a D1
// database bound as DB (the project's Settings > Bindings, for Production and Preview). The game (src/81-rank.js) calls:
//   POST /api/start {pid}                                   -> {t}: the round's start, signed, sent back with the score
//   POST /api/score {pid, name, score, kills, weapon, stage, lang, t} -> where the player stands today and of all time
//   POST /api/name  {pid, name}                             -> renames the player (today's entry and the all-time one)
//   GET  /api/board?b=day|all                               -> the top 100 and how many are on the board
// pid is a random id the browser keeps (localStorage zb3d-pid); the boards never show it, only a short hash of it (h) by
// which a player finds their own row. Bodies are JSON sent as text/plain, so the github.io copy's requests need no preflight.
// Previews (*.zombie-bakusan.pages.dev) and a local `wrangler pages dev` write to t_ tables, so trying them out never
// touches the real boards.
//
// D1's free plan reads 5 million rows and writes 100,000 a day, counting the rows a query scans. So a rank is never a count
// over the whole board: each board keeps how many players stand in each 100,000-point band (hist), and a rank is the sum of
// the bands above plus a count within the player's own band (at most 500 rows). A score: about a dozen rows written at most.
// Cheating can't be stopped in a game that runs in the browser; this keeps out the casual kind: a score needs a round
// started (and signed here) at least 14 s before, each start counts once, and score, kills and the grade must add up.

const PROD_HOST = 'zombie-bakusan.pages.dev';
const ORIGINS = ['https://zombie-bakusan.pages.dev', 'https://kzk1122.github.io'];
const WEAPONS = ['rocket', 'tank', 'hole', 'rail', 'wave', 'flame', 'shock', 'missile', 'bits'];
const STAGES = ['avenue', 'park', 'fest', 'hwy'];
// the rank lines (RANKS in src/70-game.js)
const GRADES = [['SSS', 9200000], ['SS', 7800000], ['S', 6000000], ['A', 4000000], ['B', 1200000], ['C', 0]];
const BAND = 100000, TOP = 100, MAX_SCORE = 30000000, MIN_ROUND_MS = 14000, MAX_ROUND_MS = 30 * 60 * 1000, KEEP_DAYS = 3;
// a kill is worth at most 100 x 50 (the combo's cap) x 2 (from the 11th of a chain); the bonuses (buildings, the giant,
// cars, happenings, set pieces, contraptions) come to a couple of million at most
const PER_KILL = 10000, BONUS_ROOM = 5000000;
// names that would put the board to shame: these anywhere in it (spaces and symbols taken out, lower case), these as words
// (a 'grape' or a 'Dickens' is fine), and no links
const NG = ['fuck', 'shit', 'cunt', 'nigg', 'fagg', 'porn', 'whore', 'pussy', 'penis', 'vagina', 'retard', 'hitler',
  'ちんこ', 'ちんぽ', 'まんこ', 'せっくす', 'セックス', 'ちんちん', 'レイプ', 'れいぷ', 'ガイジ', 'がいじ', 'キチガイ', 'きちがい', '氏ね', '死ね', 'ころす', '殺す', 'ぶっころ',
  'ファック', 'ふぁっく', 'エロ', 'ポルノ', '支那', 'シナ人', '在日', 'おっぱい', 'オッパイ', '精子', '陰茎', '膣', 'ニガー', 'ナチ'];
const NG_WORD = /\b(rape[sd]?|rapist|dick|cock|fag|slut|bitch|nazi|kkk|sex|anal|cum|tits?)\b/i;
const LINKY = /(https?:|www\.|\.com|\.net|\.jp|\.io|\.xyz|\.ru|discord|t\.me)/i;

const enc = new TextEncoder();
const ready = new Map();   // per table prefix: the tables made and the signing key, once per isolate

export async function onRequest(ctx) {
  const { request, env } = ctx, url = new URL(request.url);
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
  const reply = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors, ...extra } });
  if (!env.DB) return reply({ ok: false, err: 'nodb' }, 503);
  const P = isTest(url.host) ? 't_' : '';
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  try {
    const R = await prepare(env.DB, P);
    if (route === 'board' && request.method === 'GET') return await board(ctx, R, url, reply);
    if (request.method !== 'POST') return reply({ ok: false, err: 'method' }, 405);
    const body = await readBody(request);
    if (!body) return reply({ ok: false, err: 'body' }, 400);
    if (route === 'start') return await start(R, body, reply);
    if (route === 'score') return await score(R, body, request, reply);
    if (route === 'name') return await rename(R, body, reply);
    return reply({ ok: false, err: 'route' }, 404);
  } catch (e) {
    console.log('rank error', route, e && e.message);
    return reply({ ok: false, err: 'server' }, 500);
  }
}

function isTest(host) { return host !== PROD_HOST && (host.endsWith('.' + PROD_HOST) || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)); }
function corsHeaders(request) {
  const o = request.headers.get('Origin') || '';
  return ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? { 'Access-Control-Allow-Origin': o, 'Vary': 'Origin' } : {};
}
async function readBody(request) {
  try { const t = await request.text(); if (t.length > 2000) return null; const o = JSON.parse(t); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
}
const today = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const band = s => Math.floor(s / BAND);
const gradeOf = s => GRADES.find(g => s >= g[1])[0];
const validPid = p => typeof p === 'string' && /^[A-Za-z0-9_-]{12,40}$/.test(p);

// the tables (made on first use, so nothing has to be run by hand) and the key that signs the starts (kept in the database:
// no secret to set up)
async function prepare(db, P) {
  let R = ready.get(P);
  if (R) return R;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS ${P}players (pid TEXT PRIMARY KEY, h TEXT, name TEXT, cc TEXT, best INTEGER, weapon TEXT, stage TEXT, grade TEXT, at INTEGER, last_t INTEGER)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS ${P}players_best ON ${P}players (best DESC, at ASC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ${P}daily (day TEXT, pid TEXT, h TEXT, name TEXT, cc TEXT, score INTEGER, weapon TEXT, stage TEXT, grade TEXT, at INTEGER, PRIMARY KEY (day, pid))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS ${P}daily_score ON ${P}daily (day, score DESC, at ASC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ${P}hist (board TEXT, b INTEGER, n INTEGER, PRIMARY KEY (board, b))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ${P}meta (k TEXT PRIMARY KEY, v TEXT)`),
  ]);
  const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
  await db.prepare(`INSERT OR IGNORE INTO ${P}meta (k, v) VALUES ('key', ?1)`).bind(fresh).run();
  const row = await db.prepare(`SELECT v FROM ${P}meta WHERE k = 'key'`).first();
  const key = await crypto.subtle.importKey('raw', enc.encode(row.v), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  R = { db, P, key };
  ready.set(P, R);
  return R;
}
async function sign(R, text) {
  const s = new Uint8Array(await crypto.subtle.sign('HMAC', R.key, enc.encode(text)));
  return [...s.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function shortHash(pid) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(pid)));
  return [...d.slice(0, 5)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// a name as shown on the board: NFKC, no control, zero-width or direction characters, spaces squeezed, 1 to 16 characters
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff0-\uffff]/g, '').replace(/\s+/g, ' ').trim();
  const cps = [...s];
  if (!cps.length) return null;
  if (cps.length > 16) s = cps.slice(0, 16).join('').trim();
  const flat = s.toLowerCase().replace(/[\s._\-・~〜!！?？*＊#＃@＠]/g, '');
  if (LINKY.test(s) || NG_WORD.test(s.replace(/[_\-.]/g, ' ')) || NG.some(w => flat.includes(w.toLowerCase()))) return null;
  return s;
}
const fallbackName = (pid, lang) => (lang === 'ja' ? 'ゾンビハンター' : 'Hunter') + (parseInt(pid.slice(-6).replace(/[^0-9a-f]/gi, '0'), 16) % 10000).toString().padStart(4, '0');
function countryOf(request) {
  const c = request.cf && request.cf.country;
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : '';
}

async function start(R, body, reply) {
  if (!validPid(body.pid)) return reply({ ok: false, err: 'pid' }, 400);
  const ts = Date.now();
  return reply({ ok: true, t: ts + '.' + await sign(R, body.pid + '.' + ts) });
}

// where a score stands on one board: the bands above it, then the ones above it in its own band
async function standing(R, boardKey, value) {
  const { db, P } = R, b = band(value);
  const h = await db.prepare(`SELECT COALESCE(SUM(n), 0) AS tot, COALESCE(SUM(CASE WHEN b > ?2 THEN n ELSE 0 END), 0) AS above FROM ${P}hist WHERE board = ?1`).bind(boardKey, b).first();
  const lo = value, hi = (b + 1) * BAND;
  const w = boardKey === 'all'
    ? await db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${P}players WHERE best > ?1 AND best < ?2 LIMIT 500)`).bind(lo, hi).first()
    : await db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${P}daily WHERE day = ?1 AND score > ?2 AND score < ?3 LIMIT 500)`).bind(boardKey.slice(2), lo, hi).first();
  return { rank: h.above + w.n + 1, of: Math.max(h.tot, h.above + w.n + 1), approx: w.n >= 500 };
}
const bump = (R, boardKey, b, d) => R.db.prepare(`INSERT INTO ${R.P}hist (board, b, n) VALUES (?1, ?2, MAX(0, ?3)) ON CONFLICT (board, b) DO UPDATE SET n = MAX(0, n + ?3)`).bind(boardKey, b, d);

async function score(R, body, request, reply) {
  const { db, P } = R, now = Date.now();
  const { pid, t } = body, sc = body.score, kills = body.kills;
  if (!validPid(pid)) return reply({ ok: false, err: 'pid' }, 400);
  if (!Number.isSafeInteger(sc) || sc < 0 || sc > MAX_SCORE || !Number.isSafeInteger(kills) || kills < 0 || kills > 5000 || sc > kills * PER_KILL + BONUS_ROOM)
    return reply({ ok: false, err: 'score' }, 400);
  if (!WEAPONS.includes(body.weapon) || !STAGES.includes(body.stage)) return reply({ ok: false, err: 'meta' }, 400);
  // the round's start, as signed here: long enough ago for a round, not too long, and not used before
  const m = /^(\d{13})\.([0-9a-f]{32})$/.exec(typeof t === 'string' ? t : '');
  if (!m) return reply({ ok: false, err: 'token' }, 403);
  const ts = +m[1];
  if (m[2] !== await sign(R, pid + '.' + ts)) return reply({ ok: false, err: 'token' }, 403);
  if (now - ts < MIN_ROUND_MS || now - ts > MAX_ROUND_MS) return reply({ ok: false, err: 'time' }, 403);
  let name = cleanName(body.name), nameOk = !!name;
  if (!name) name = fallbackName(pid, body.lang);
  const day = today(now), dKey = 'd:' + day, grade = gradeOf(sc), cc = countryOf(request), h = await shortHash(pid);
  const [p0, d0] = await db.batch([
    db.prepare(`SELECT best, last_t FROM ${P}players WHERE pid = ?1`).bind(pid),
    db.prepare(`SELECT score FROM ${P}daily WHERE day = ?1 AND pid = ?2`).bind(day, pid),
  ]);
  const pRow = p0.results[0], dRow = d0.results[0];
  if (pRow && pRow.last_t >= ts) return reply({ ok: false, err: 'used' }, 409);
  const writes = [];
  let upAll = false, upDay = false;
  if (!pRow) {
    upAll = true;
    writes.push(db.prepare(`INSERT INTO ${P}players (pid, h, name, cc, best, weapon, stage, grade, at, last_t) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`).bind(pid, h, name, cc, sc, body.weapon, body.stage, grade, now, ts), bump(R, 'all', band(sc), 1));
  } else if (sc > pRow.best) {
    upAll = true;
    writes.push(db.prepare(`UPDATE ${P}players SET name = ?2, cc = ?3, best = ?4, weapon = ?5, stage = ?6, grade = ?7, at = ?8, last_t = ?9 WHERE pid = ?1`).bind(pid, name, cc, sc, body.weapon, body.stage, grade, now, ts), bump(R, 'all', band(pRow.best), -1), bump(R, 'all', band(sc), 1));
  } else writes.push(db.prepare(`UPDATE ${P}players SET name = ?2, last_t = ?3 WHERE pid = ?1`).bind(pid, name, ts));
  if (!dRow) {
    upDay = true;
    writes.push(db.prepare(`INSERT INTO ${P}daily (day, pid, h, name, cc, score, weapon, stage, grade, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`).bind(day, pid, h, name, cc, sc, body.weapon, body.stage, grade, now), bump(R, dKey, band(sc), 1));
  } else if (sc > dRow.score) {
    upDay = true;
    writes.push(db.prepare(`UPDATE ${P}daily SET name = ?3, cc = ?4, score = ?5, weapon = ?6, stage = ?7, grade = ?8, at = ?9 WHERE day = ?1 AND pid = ?2`).bind(day, pid, name, cc, sc, body.weapon, body.stage, grade, now), bump(R, dKey, band(dRow.score), -1), bump(R, dKey, band(sc), 1));
  }
  // now and then, the days gone by go (a few days kept, for a board opened over midnight)
  if (Math.random() < 0.01) {
    const old = today(now - KEEP_DAYS * 864e5);
    writes.push(db.prepare(`DELETE FROM ${P}daily WHERE day < ?1`).bind(old), db.prepare(`DELETE FROM ${P}hist WHERE board LIKE 'd:%' AND board < ?1`).bind('d:' + old));
  }
  await db.batch(writes);
  const bestAll = upAll ? sc : pRow.best, bestDay = upDay ? sc : dRow.score;
  const [all, dayS] = await Promise.all([standing(R, 'all', bestAll), standing(R, dKey, bestDay)]);
  return reply({ ok: true, name, nameOk, h, day, all: { ...all, best: bestAll, up: upAll }, today: { ...dayS, best: bestDay, up: upDay } });
}

async function rename(R, body, reply) {
  const { db, P } = R;
  if (!validPid(body.pid)) return reply({ ok: false, err: 'pid' }, 400);
  const name = cleanName(body.name);
  if (!name) return reply({ ok: true, nameOk: false });
  await db.batch([
    db.prepare(`UPDATE ${P}players SET name = ?2 WHERE pid = ?1`).bind(body.pid, name),
    db.prepare(`UPDATE ${P}daily SET name = ?3 WHERE day = ?1 AND pid = ?2`).bind(today(), body.pid, name),
  ]);
  return reply({ ok: true, nameOk: true, name });
}

// the top 100 of a board, kept at the edge for a few seconds (a board is read far more often than it changes)
async function board(ctx, R, url, reply) {
  const which = url.searchParams.get('b') === 'all' ? 'all' : 'day';
  const day = today(), cacheKey = new Request(`https://${PROD_HOST}/api/board-cache/${R.P || 'p'}/${which}/${which === 'all' ? '' : day}`);
  let cache = null;
  try { cache = caches.default; const hit = await cache.match(cacheKey); if (hit) return reply(await hit.json(), 200); } catch (e) { cache = null; }
  const { db, P } = R;
  const rows = which === 'all'
    ? await db.prepare(`SELECT h, name, cc, best AS score, weapon, stage, grade FROM ${P}players ORDER BY best DESC, at ASC LIMIT ${TOP}`).all()
    : await db.prepare(`SELECT h, name, cc, score, weapon, stage, grade FROM ${P}daily WHERE day = ?1 ORDER BY score DESC, at ASC LIMIT ${TOP}`).bind(day).all();
  const tot = await db.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM ${P}hist WHERE board = ?1`).bind(which === 'all' ? 'all' : 'd:' + day).first();
  const out = { ok: true, b: which, day, players: Math.max(tot.n, rows.results.length), list: rows.results };
  if (cache) ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=15' } })).catch(() => {}));
  return reply(out);
}
