const MLB = 'https://statsapi.mlb.com/api/v1/schedule';
const ALLOWED = new Set(['https://hattrick.nyc', 'https://www.hattrick.nyc', 'https://hattricknyc.myshopify.com']);
const STAKES = new Set([25, 50, 100]);
const STOREFRONT = 'https://hattrick.nyc';
const CALLBACK = 'https://hat-trick-sportsbook.bronson-16e.workers.dev/auth/callback';
const CONTEST_END = '2026-09-29T04:59:59.999Z';
const RULES_VERSION = '2026-08-27-pick-em-final-1';
const SESSION_DAYS = 30;
const ARCHIVE_ROUND = 'comeback-verified-01';
const ARCHIVE_CANDIDATES = new Set([
  'cheers-sitcom-hat-beer-bottle-green',
  'detroit-improvement-hat',
  'fantasy-football-hat',
  'mariner-sitcom-hat',
  'rockies',
  'yankee-sitcom-hat',
  'yankee-sitcom-away-gray',
  'yankee-sitcom-hat-blue',
  'yankee-sitcom-hat-season-8'
]);
const BLOCKED_NICKNAMES = ['admin','administrator','hattrick','hat trick','shopify','mlb','major league baseball','moderator','staff','support','fuck','shit','bitch','cunt','nigger','faggot'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    try {
      let response;
      if (url.pathname === '/health') response = json({ ok: true, service: 'hat-trick-pick-em', scoreSource: 'MLB Stats API' });
      else if (url.pathname === '/games' && request.method === 'GET') response = await gamesRoute(url, env, ctx);
      else if (url.pathname === '/auth/start' && request.method === 'GET') response = await authStart(request, url, env);
      else if (url.pathname === '/auth/callback' && request.method === 'GET') response = await authCallback(url, env);
      else if (url.pathname === '/auth/exchange' && request.method === 'POST') response = await authExchange(request, env);
      else if (url.pathname === '/auth/logout' && request.method === 'POST') response = await authLogout(request, env);
      else if (url.pathname === '/auth/guest-proof' && request.method === 'POST') response = await guestProof(request, env);
      else if (url.pathname === '/account/claim' && request.method === 'POST') response = await accountClaim(request, env);
      else if (url.pathname === '/profile' && request.method === 'POST') response = await profileRoute(request, env);
      else if (url.pathname === '/eligibility' && request.method === 'POST') response = await eligibilityRoute(request, env);
      else if (url.pathname === '/leaderboard' && request.method === 'GET') response = await leaderboardRoute(request, env, ctx);
      else if (url.pathname === '/state' && request.method === 'GET') response = await stateRoute(request, env, ctx);
      else if (url.pathname === '/wagers' && request.method === 'POST') response = await wagerRoute(request, env, ctx);
      else if (url.pathname === '/refill' && request.method === 'POST') response = await refillRoute(request, env);
      else if (url.pathname === '/archive/leaderboard' && request.method === 'GET') response = await archiveLeaderboardRoute(env);
      else if (url.pathname === '/archive/status' && request.method === 'GET') response = await archiveStatusRoute(request, env);
      else if (url.pathname === '/archive/vote' && request.method === 'POST') response = await archiveVoteRoute(request, env);
      else response = json({ error: 'Pick ’Em window closed.' }, 404);
      const headers = new Headers(response.headers);
      Object.entries(cors(origin)).forEach(([key, value]) => headers.set(key, value));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      console.error(JSON.stringify({ event: 'request_error', path: url.pathname, message: error?.message }));
      const response = json({ error: error?.message || 'The tote board is temporarily unavailable.' }, error?.status || 500);
      Object.entries(cors(origin)).forEach(([key, value]) => response.headers.set(key, value));
      return response;
    }
  }
};

function cors(origin) {
  const allowed = ALLOWED.has(origin) || /^https:\/\/[a-z0-9-]+\.myshopify\.com$/i.test(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://hattrick.nyc',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

async function getSchedule(date, env, ctx, gamePks = '') {
  const key = gamePks ? `games:${gamePks}` : `date:${date}`;
  const cached = await caches.default.match(new Request(`https://cache.hattrick.nyc/${key}`));
  if (cached) return { ...(await cached.json()), stale: false };
  const upstream = new URL(MLB);
  upstream.searchParams.set('sportId', '1');
  upstream.searchParams.set('hydrate', 'team,linescore');
  if (gamePks) upstream.searchParams.set('gamePks', gamePks); else upstream.searchParams.set('date', date);
  try {
    const response = await fetch(upstream, { headers: { Accept: 'application/json', 'User-Agent': 'Hat-Trick-Off-Track/1.0' } });
    if (!response.ok) throw new Error(`score source ${response.status}`);
    const payload = normalizeSchedule(await response.json());
    const ttl = payload.games.some((game) => game.state === 'live') ? 15 : 300;
    const body = { ...payload, stale: false, updatedAt: new Date().toISOString() };
    ctx?.waitUntil(caches.default.put(new Request(`https://cache.hattrick.nyc/${key}`), Response.json(body, { headers: { 'Cache-Control': `public,max-age=${ttl}` } })));
    ctx?.waitUntil(env.DB.prepare('INSERT INTO score_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at').bind(key, JSON.stringify(body), body.updatedAt).run());
    return body;
  } catch (error) {
    const row = await env.DB.prepare('SELECT payload,fetched_at FROM score_cache WHERE cache_key=?').bind(key).first();
    if (!row) throw error;
    return { ...JSON.parse(row.payload), stale: true, updatedAt: row.fetched_at };
  }
}

function normalizeSchedule(data) {
  const games = (data.dates || []).flatMap((day) => day.games || []).map((game) => {
    const abstract = game.status?.abstractGameState || '';
    const detailed = game.status?.detailedState || '';
    let state = abstract === 'Final' ? 'final' : abstract === 'Live' ? 'live' : 'scheduled';
    if (/postponed|cancelled|suspended/i.test(detailed)) state = detailed.toLowerCase();
    const away = team(game.teams?.away);
    const home = team(game.teams?.home);
    const hp = clamp((home.pct + (1 - away.pct)) / 2, .35, .65);
    return {
      id: Number(game.gamePk), date: game.officialDate, start: game.gameDate, state, status: detailed,
      inning: game.linescore?.currentInningOrdinal || '', inningState: game.linescore?.inningState || '',
      away, home,
      lines: { home: decimal(.95 / hp), away: decimal(.95 / (1 - hp)), total: 8.5, totalPayout: 1.9 },
      wageringOpen: abstract === 'Preview' && !/postponed|cancelled|suspended/i.test(detailed)
    };
  });
  return { games };
}

function team(side = {}) {
  const record = side.leagueRecord || {};
  const name = side.team?.name || 'TBD';
  return { id: side.team?.id || 0, name, displayName: cityLabel(name), abbreviation: abbreviation(name), score: Number.isFinite(side.score) ? side.score : null, record: record.wins == null ? '' : `${record.wins}-${record.losses}`, pct: Number(record.pct) || .5 };
}

function cityLabel(name) {
  const cities = {
    'Arizona Diamondbacks':'Arizona','Atlanta Braves':'Atlanta','Baltimore Orioles':'Baltimore','Boston Red Sox':'Boston',
    'Chicago Cubs':'Chicago (NL)','Chicago White Sox':'Chicago (AL)','Cincinnati Reds':'Cincinnati','Cleveland Guardians':'Cleveland',
    'Colorado Rockies':'Colorado','Detroit Tigers':'Detroit','Houston Astros':'Houston','Kansas City Royals':'Kansas City',
    'Los Angeles Angels':'Los Angeles (AL)','Los Angeles Dodgers':'Los Angeles (NL)','Miami Marlins':'Miami','Milwaukee Brewers':'Milwaukee',
    'Minnesota Twins':'Minnesota','New York Mets':'New York (NL)','New York Yankees':'New York (AL)','Athletics':'Sacramento',
    'Oakland Athletics':'Oakland','Sacramento Athletics':'Sacramento','Philadelphia Phillies':'Philadelphia','Pittsburgh Pirates':'Pittsburgh',
    'San Diego Padres':'San Diego','San Francisco Giants':'San Francisco','Seattle Mariners':'Seattle','St. Louis Cardinals':'St. Louis',
    'Tampa Bay Rays':'Tampa Bay','Texas Rangers':'Texas','Toronto Blue Jays':'Toronto','Washington Nationals':'Washington'
  };
  return cities[name] || name.replace(/\s+(Diamondbacks|Braves|Orioles|Red Sox|Cubs|White Sox|Reds|Guardians|Rockies|Tigers|Astros|Royals|Angels|Dodgers|Marlins|Brewers|Twins|Mets|Yankees|Athletics|Phillies|Pirates|Padres|Giants|Mariners|Cardinals|Rays|Rangers|Blue Jays|Nationals)$/i, '');
}

function abbreviation(name) {
  const known = { 'New York Yankees':'NYY','New York Mets':'NYM','Los Angeles Dodgers':'LAD','Los Angeles Angels':'LAA','Boston Red Sox':'BOS','Chicago Cubs':'CHC','Chicago White Sox':'CWS','San Francisco Giants':'SF','San Diego Padres':'SD','Kansas City Royals':'KC','Tampa Bay Rays':'TB' };
  return known[name] || name.split(/\s+/).map((part) => part[0]).join('').slice(0, 3).toUpperCase();
}

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function decimal(n) { return Math.round(clamp(n, 1.35, 2.75) * 100) / 100; }

async function gamesRoute(url, env, ctx) {
  const schedule = await getSchedule(isoDate(url.searchParams.get('date')), env, ctx);
  return json({ ...schedule, wageringEnabled: !schedule.stale });
}

async function playerId(request, token, env) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token || '')) throw new HttpError(400, 'A valid anonymous browser token is required.');
  const material = `${token}|${request.headers.get('CF-Connecting-IP') || ''}|${request.headers.get('User-Agent') || ''}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.HASH_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ensurePlayer(id, env) {
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT OR IGNORE INTO players(id,balance,created_at,updated_at) VALUES(?,1000,?,?)').bind(id, now, now).run();
  return env.DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first();
}

async function stateRoute(request, env, ctx) {
  const { player: sessionPlayer } = await requireSession(request, env);
  const id = sessionPlayer.id;
  await settlePending(id, env, ctx);
  return stateResponse(id, env);
}

async function stateResponse(id, env, extra = {}) {
  const player = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first();
  const { results = [] } = await env.DB.prepare('SELECT id,game_pk AS gameId,official_date AS officialDate,market,selection,line,stake,quoted_payout AS quotedPayout,status,result,created_at AS createdAt,settled_at AS settledAt FROM wagers WHERE player_id=? ORDER BY created_at DESC LIMIT 500').bind(id).all();
  const inPlay = results.filter((ticket) => ticket.status === 'pending').reduce((sum, ticket) => sum + Number(ticket.stake || 0), 0);
  const standingBalance = Number(player.balance || 0) + inPlay;
  const rank = player.nickname ? await exactRank(id, env) : null;
  const today = chicagoDate();
  return json({ authenticated: true, balance: player.balance, inPlay, standingBalance, nickname: player.nickname, nicknameRequired: !player.nickname, eligibilityRequired: player.eligibility_rules_version !== RULES_VERSION, refillEligible: player.balance < 25 && player.last_daily_refill_date !== today, settledPicks: player.settled_picks || 0, winningPicks: player.winning_picks || 0, rank, tickets: results, contest: contestInfo(), ...extra });
}

async function eligibilityRoute(request, env) {
  const { player } = await requireSession(request, env);
  await rateLimit(`eligibility:${player.id}`, 6, 3600, env);
  const body = await request.json();
  if (body.confirmed !== true || body.rulesVersion !== RULES_VERSION) {
    throw new HttpError(400, 'Confirm that you are 21 or older, an eligible US resident, and agree to the current Official Rules and Privacy Policy.');
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE players SET eligibility_accepted_at=?,eligibility_rules_version=?,updated_at=? WHERE id=?')
      .bind(now, RULES_VERSION, now, player.id),
    env.DB.prepare('INSERT INTO contest_audit(id,player_id,event_type,event_data,created_at) VALUES(?,?,?,?,?)')
      .bind(crypto.randomUUID(), player.id, 'eligibility_accepted', JSON.stringify({ rulesVersion: RULES_VERSION }), now)
  ]);
  return stateResponse(player.id, env, { eligibilityAccepted: true });
}

async function refillRoute(request, env) {
  const { player } = await requireSession(request, env);
  await rateLimit(`refill:${player.id}`, 6, 3600, env);
  const today = chicagoDate();
  const now = new Date().toISOString();
  const result = await env.DB.prepare('UPDATE players SET balance=25,last_daily_refill_date=?,updated_at=? WHERE id=? AND balance<25 AND (last_daily_refill_date IS NULL OR last_daily_refill_date<>?)')
    .bind(today, now, player.id, today).run();
  if (!result.meta?.changes) throw new HttpError(409, player.balance >= 25 ? 'Clubhouse refills activate only below 25 Hat Bucks.' : 'Today’s clubhouse refill has already been claimed.');
  await env.DB.prepare('INSERT INTO contest_audit(id,player_id,event_type,event_data,created_at) VALUES(?,?,?,?,?)')
    .bind(crypto.randomUUID(), player.id, 'daily_refill', JSON.stringify({ balance: 25, chicagoDate: today }), now).run();
  return stateResponse(player.id, env, { refilled: true });
}

async function wagerRoute(request, env, ctx) {
  const body = await request.json();
  const { player } = await requireSession(request, env);
  const id = player.id;
  if (player.eligibility_rules_version !== RULES_VERSION) throw new HttpError(409, 'Confirm eligibility and the Official Rules before making a pick.');
  if (!player.nickname) throw new HttpError(409, 'Choose a public race name before placing your first pick.');
  if (Date.now() > Date.parse(CONTEST_END)) throw new HttpError(409, 'The Race to October pick window is closed.');
  const gameId = Number(body.gameId);
  const market = body.market;
  const selection = String(body.selection || '');
  const allIn = body.stake === 'ALL_IN';
  const stake = allIn ? player.balance : Number(body.stake);
  if (!Number.isInteger(gameId) || market !== 'winner') throw new HttpError(400, 'Pick one club to win. That is the entire questionable market.');
  if (!allIn && (!Number.isInteger(stake) || stake < 25 || stake % 25 !== 0)) throw new HttpError(400, 'Choose a risk amount in 25 Hat Buck increments, or go ALL IN.');
  if (stake <= 0 || stake > player.balance) throw new HttpError(409, 'Not enough Hat Bucks for that risk amount.');
  const schedule = await getSchedule('', env, ctx, String(gameId));
  if (schedule.stale) throw new HttpError(503, 'Scores are stale. New picks are paused.');
  const game = schedule.games.find((item) => item.id === gameId);
  if (!game || !game.wageringOpen) throw new HttpError(409, 'Picks are closed for this game.');
  if (!['home','away'].includes(selection)) throw new HttpError(400, 'Pick the home or away club.');
  const multiplier = game.lines[selection];
  const now = new Date().toISOString();
  const wagerId = crypto.randomUUID();
  const payout = Math.round(stake * multiplier);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO wagers(id,player_id,game_pk,official_date,market,selection,line,stake,quoted_payout,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,\'pending\',?)').bind(wagerId,id,game.id,game.date,market,selection,market === 'total' ? 8.5 : multiplier,stake,payout,now),
      env.DB.prepare('UPDATE players SET balance=balance-?,updated_at=? WHERE id=?').bind(stake,now,id)
    ]);
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) throw new HttpError(409, 'One winner pick per game. Pick ’Em rules.');
    if (/CHECK/i.test(error.message)) throw new HttpError(409, 'Not enough Hat Bucks for that risk amount.');
    throw error;
  }
  return stateResponse(id, env, { accepted: true, acceptedTicket: wagerId });
}

async function settlePending(id, env, ctx) {
  const { results = [] } = await env.DB.prepare("SELECT * FROM wagers WHERE player_id=? AND status='pending'").bind(id).all();
  if (!results.length) return;
  const schedule = await getSchedule('', env, ctx, [...new Set(results.map((w) => w.game_pk))].join(','));
  if (schedule.stale) return;
  for (const wager of results) {
    const game = schedule.games.find((item) => item.id === wager.game_pk);
    if (!game || game.state !== 'final' || game.home.score == null || game.away.score == null) continue;
    const total = game.home.score + game.away.score;
    let won;
    if (wager.market === 'winner') won = wager.selection === (game.home.score > game.away.score ? 'home' : 'away');
    else won = wager.selection === (total > wager.line ? 'over' : 'under');
    const status = won ? 'won' : 'lost';
    const payout = won ? wager.quoted_payout : 0;
    const result = `${game.away.abbreviation} ${game.away.score} — ${game.home.abbreviation} ${game.home.score}`;
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO settlements(wager_id,created_at) VALUES(?,?)').bind(wager.id,now),
      env.DB.prepare("UPDATE wagers SET status=?,result=?,settled_at=? WHERE id=? AND status='pending'").bind(status,result,now,wager.id),
      env.DB.prepare('UPDATE players SET balance=balance+?,settled_picks=settled_picks+1,winning_picks=winning_picks+?,updated_at=? WHERE id=?').bind(payout,won ? 1 : 0,now,id)
    ]);
  }
}

async function authStart(request, url, env) {
  requireOAuthConfig(env);
  await rateLimit(`auth:${request.headers.get('CF-Connecting-IP') || 'unknown'}`, 12, 600, env);
  const discovery = await discover(STOREFRONT);
  const state = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const now = new Date();
  const returnUrl = safeReturn(url.searchParams.get('return'));
  await env.DB.prepare('INSERT INTO oauth_flows(state_hash,code_verifier,nonce,return_url,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .bind(await secretHash(state, env), verifier, nonce, returnUrl, now.toISOString(), new Date(now.getTime() + 10 * 60e3).toISOString()).run();
  const target = new URL(discovery.authorization_endpoint);
  target.searchParams.set('scope', 'openid email customer-account-api:full');
  target.searchParams.set('client_id', env.CUSTOMER_ACCOUNT_CLIENT_ID);
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('redirect_uri', CALLBACK);
  target.searchParams.set('state', state);
  target.searchParams.set('nonce', nonce);
  target.searchParams.set('code_challenge', challenge);
  target.searchParams.set('code_challenge_method', 'S256');
  return Response.redirect(target.toString(), 302);
}

async function authCallback(url, env) {
  requireOAuthConfig(env);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (!state || !code) throw new HttpError(400, 'Shop login returned without the required authorization details.');
  const stateHash = await secretHash(state, env);
  const flow = await env.DB.prepare('SELECT * FROM oauth_flows WHERE state_hash=?').bind(stateHash).first();
  if (!flow || flow.used_at || Date.parse(flow.expires_at) < Date.now()) throw new HttpError(400, 'This Shop login link expired or was already used.');
  const discovery = await discover(STOREFRONT);
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Hat-Trick-Off-Track/2.0' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: env.CUSTOMER_ACCOUNT_CLIENT_ID, redirect_uri: CALLBACK, code, code_verifier: flow.code_verifier })
  });
  if (!tokenResponse.ok) throw new HttpError(401, 'Shop could not verify this login. Please try again.');
  const oauth = await tokenResponse.json();
  const subject = await fetchCustomerSubject(oauth.access_token);
  const subjectHash = await secretHash(`shopify:${subject}`, env);
  const now = new Date().toISOString();
  let player = await env.DB.prepare('SELECT * FROM players WHERE shopify_subject_hash=?').bind(subjectHash).first();
  if (!player) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO players(id,balance,shopify_subject_hash,claimed_at,created_at,updated_at) VALUES(?,1000,?,?,?,?)')
      .bind(id, subjectHash, now, now, now).run();
    player = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first();
  }
  const exchangeCode = randomToken();
  await env.DB.batch([
    env.DB.prepare('UPDATE oauth_flows SET used_at=? WHERE state_hash=? AND used_at IS NULL').bind(now,stateHash),
    env.DB.prepare('INSERT INTO auth_exchange_codes(code_hash,player_id,created_at,expires_at) VALUES(?,?,?,?)').bind(await secretHash(exchangeCode,env),player.id,now,new Date(Date.now()+5*60e3).toISOString())
  ]);
  const destination = new URL(flow.return_url);
  destination.hash = `auth=${encodeURIComponent(exchangeCode)}`;
  return Response.redirect(destination.toString(), 302);
}

async function authExchange(request, env) {
  const { code } = await request.json();
  const codeHash = await secretHash(String(code || ''), env);
  const row = await env.DB.prepare('SELECT * FROM auth_exchange_codes WHERE code_hash=?').bind(codeHash).first();
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) throw new HttpError(401, 'This one-time Shop login code expired or was already used.');
  const token = randomToken();
  const now = new Date().toISOString();
  const expires = new Date(Date.now()+SESSION_DAYS*864e5).toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE auth_exchange_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL').bind(now,codeHash),
    env.DB.prepare('INSERT INTO sportsbook_sessions(token_hash,player_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)').bind(await secretHash(token,env),row.player_id,now,expires,now)
  ]);
  return json({ token, expiresAt: expires });
}

async function authLogout(request, env) {
  const token = bearer(request);
  if (token) await env.DB.prepare('UPDATE sportsbook_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').bind(new Date().toISOString(),await secretHash(token,env)).run();
  return json({ signedOut: true });
}

async function guestProof(request, env) {
  const { token } = await request.json();
  const guestId = await playerId(request, token, env);
  const guest = await env.DB.prepare('SELECT id FROM players WHERE id=? AND shopify_subject_hash IS NULL').bind(guestId).first();
  if (!guest) throw new HttpError(404, 'No browser Hat Bucks are available to import.');
  const proof = randomToken(); const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO guest_claim_proofs(proof_hash,guest_player_id,created_at,expires_at) VALUES(?,?,?,?)')
    .bind(await secretHash(proof,env),guestId,now,new Date(Date.now()+10*60e3).toISOString()).run();
  return json({ proof, expiresIn: 600 });
}

async function accountClaim(request, env) {
  const { player } = await requireSession(request, env);
  const { proof } = await request.json();
  if (player.guest_imported_at) throw new HttpError(409, 'This Shop account has already imported browser Hat Bucks.');
  const row = await env.DB.prepare('SELECT * FROM guest_claim_proofs WHERE proof_hash=?').bind(await secretHash(String(proof||''),env)).first();
  if (!row || row.used_at || Date.parse(row.expires_at)<Date.now()) throw new HttpError(401, 'The browser import proof expired or was already used.');
  const existing = await env.DB.prepare('SELECT COUNT(*) AS count FROM wagers WHERE player_id=?').bind(player.id).first();
  if (Number(existing.count)) throw new HttpError(409, 'Import must happen before the verified account places its first ticket.');
  const guest = await env.DB.prepare('SELECT * FROM players WHERE id=? AND shopify_subject_hash IS NULL').bind(row.guest_player_id).first();
  if (!guest) throw new HttpError(404, 'The browser Hat Bucks are no longer available.');
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE guest_claim_proofs SET used_at=? WHERE proof_hash=? AND used_at IS NULL').bind(now,row.proof_hash),
    env.DB.prepare('UPDATE wagers SET player_id=? WHERE player_id=?').bind(player.id,guest.id),
    env.DB.prepare('UPDATE players SET balance=?,reward_unlocked_at=?,bailout_date=?,settled_picks=?,winning_picks=?,guest_imported_at=?,updated_at=? WHERE id=? AND guest_imported_at IS NULL').bind(guest.balance,guest.reward_unlocked_at,guest.bailout_date,guest.settled_picks||0,guest.winning_picks||0,now,now,player.id),
    env.DB.prepare('DELETE FROM players WHERE id=?').bind(guest.id)
  ]);
  return stateResponse(player.id,env,{ imported:true });
}

async function profileRoute(request, env) {
  const { player } = await requireSession(request, env);
  const body = await request.json();
  const nickname = String(body.nickname || '').replace(/\s+/g,' ').trim();
  if (!/^[A-Za-z0-9 _-]{3,18}$/.test(nickname)) throw new HttpError(400,'Race names must be 3–18 characters using letters, numbers, spaces, hyphens, or underscores.');
  const normalized = nickname.toLocaleLowerCase('en-US');
  if (BLOCKED_NICKNAMES.some(term => normalized.includes(term))) throw new HttpError(400,'That race name is unavailable. Try another questionable identity.');
  if (player.nickname_updated_at && Date.now()-Date.parse(player.nickname_updated_at)<30*864e5) throw new HttpError(409,'Race names can be changed once every 30 days.');
  const now = new Date().toISOString();
  try { await env.DB.prepare('UPDATE players SET nickname=?,nickname_normalized=?,nickname_updated_at=?,leaderboard_opt_in=1,updated_at=? WHERE id=?').bind(nickname,normalized,now,now,player.id).run(); }
  catch(error){ if(/UNIQUE/i.test(error.message)) throw new HttpError(409,'That race name is already on the board.'); throw error; }
  return stateResponse(player.id,env,{ profileUpdated:true });
}

async function leaderboardRoute(request, env, ctx) {
  await settleLeaderboard(env,ctx);
  const sql = `WITH ranked AS (
    SELECT p.id,p.nickname,p.balance,
      p.balance + COALESCE((SELECT SUM(w.stake) FROM wagers w WHERE w.player_id=p.id AND w.status='pending'),0) AS standingBalance,
      p.winning_picks AS correctPicks,p.settled_picks AS settledPicks,p.claimed_at
    FROM players p
    WHERE p.shopify_subject_hash IS NOT NULL AND p.nickname IS NOT NULL AND p.leaderboard_opt_in=1
  )
  SELECT nickname,balance,standingBalance,correctPicks,settledPicks,
    ROW_NUMBER() OVER (ORDER BY standingBalance DESC,correctPicks DESC,claimed_at ASC) AS rank
  FROM ranked ORDER BY standingBalance DESC,correctPicks DESC,claimed_at ASC LIMIT 10`;
  const { results=[] } = await env.DB.prepare(sql).all();
  let me=null;
  try { const auth=await requireSession(request,env); me=await exactRank(auth.player.id,env); } catch(error) { if(error.status!==401) throw error; }
  return json({ leaders:results, me, scoreBasis:'standing_balance', contest:contestInfo(), prize:{ type:'one_personal_custom_hat', approximateRetailValue:39.99, currency:'USD', status:'official_rules_ready' } });
}

async function archiveLeaderboard(env) {
  const { results = [] } = await env.DB.prepare(`
    SELECT candidate AS handle, COUNT(*) AS votes
    FROM archive_ballots
    WHERE round=?
    GROUP BY candidate
    ORDER BY votes DESC, candidate ASC
  `).bind(ARCHIVE_ROUND).all();
  return results.map((row, index) => ({
    rank: index + 1,
    handle: row.handle,
    votes: Number(row.votes || 0)
  }));
}

async function archiveLeaderboardRoute(env) {
  return json({ ok: true, round: ARCHIVE_ROUND, leaderboard: await archiveLeaderboard(env) });
}

async function archiveStatusRoute(request, env) {
  const { player } = await requireSession(request, env);
  const ballot = await env.DB.prepare('SELECT candidate,created_at AS createdAt FROM archive_ballots WHERE round=? AND player_id=?')
    .bind(ARCHIVE_ROUND, player.id).first();
  return json({ ok: true, authenticated: true, round: ARCHIVE_ROUND, voted: Boolean(ballot), candidate: ballot?.candidate || null, createdAt: ballot?.createdAt || null });
}

async function archiveVoteRoute(request, env) {
  const { player } = await requireSession(request, env);
  await rateLimit(`archive-vote:${player.id}`, 8, 3600, env);
  const body = await request.json();
  const candidate = String(body.candidate || '');
  if (!ARCHIVE_CANDIDATES.has(candidate)) throw new HttpError(400, 'That retired hat is not on this ballot.');
  const existing = await env.DB.prepare('SELECT candidate FROM archive_ballots WHERE round=? AND player_id=?')
    .bind(ARCHIVE_ROUND, player.id).first();
  if (existing) {
    const response = json({ ok: false, voted: true, candidate: existing.candidate, error: 'This Shop account already cast its comeback ballot.' }, 409);
    return response;
  }
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO archive_ballots(round,player_id,candidate,created_at) VALUES(?,?,?,?)')
        .bind(ARCHIVE_ROUND, player.id, candidate, now),
      env.DB.prepare('INSERT INTO contest_audit(id,player_id,event_type,event_data,created_at) VALUES(?,?,?,?,?)')
        .bind(crypto.randomUUID(), player.id, 'archive_ballot_cast', JSON.stringify({ round: ARCHIVE_ROUND, candidate }), now)
    ]);
  } catch (error) {
    if (/UNIQUE|PRIMARY/i.test(error.message)) {
      const ballot = await env.DB.prepare('SELECT candidate FROM archive_ballots WHERE round=? AND player_id=?')
        .bind(ARCHIVE_ROUND, player.id).first();
      return json({ ok: false, voted: true, candidate: ballot?.candidate || null, error: 'This Shop account already cast its comeback ballot.' }, 409);
    }
    throw error;
  }
  return json({ ok: true, candidate, round: ARCHIVE_ROUND, leaderboard: await archiveLeaderboard(env) });
}

async function exactRank(id, env) {
  return env.DB.prepare(`SELECT rank,nickname,balance,standingBalance,correctPicks,settledPicks FROM (
    SELECT p.id,p.nickname,p.balance,
      p.balance + COALESCE((SELECT SUM(w.stake) FROM wagers w WHERE w.player_id=p.id AND w.status='pending'),0) AS standingBalance,
      p.winning_picks AS correctPicks,p.settled_picks AS settledPicks,
      ROW_NUMBER() OVER (ORDER BY p.balance + COALESCE((SELECT SUM(w2.stake) FROM wagers w2 WHERE w2.player_id=p.id AND w2.status='pending'),0) DESC,p.winning_picks DESC,p.claimed_at ASC) AS rank
    FROM players p WHERE p.shopify_subject_hash IS NOT NULL AND p.nickname IS NOT NULL AND p.leaderboard_opt_in=1
  ) WHERE id=?`).bind(id).first();
}

async function settleLeaderboard(env,ctx){
  const {results=[]}=await env.DB.prepare("SELECT DISTINCT player_id FROM wagers WHERE status='pending'").all();
  for(const row of results.slice(0,100)) await settlePending(row.player_id,env,ctx);
}

async function requireSession(request, env) {
  const token=bearer(request); if(!token) throw new HttpError(401,'Continue with Shop to continue.');
  const now=new Date().toISOString();
  const row=await env.DB.prepare(`SELECT s.*,p.* FROM sportsbook_sessions s JOIN players p ON p.id=s.player_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`).bind(await secretHash(token,env),now).first();
  if(!row) throw new HttpError(401,'Your Shop session expired. Continue with Shop again; your Hat Bucks are safe.');
  const renewed=new Date(Date.now()+SESSION_DAYS*864e5).toISOString();
  await env.DB.prepare('UPDATE sportsbook_sessions SET last_seen_at=?,expires_at=? WHERE token_hash=?').bind(now,renewed,row.token_hash).run();
  return {player:row};
}

function bearer(request){ const value=request.headers.get('Authorization')||''; return value.startsWith('Bearer ')?value.slice(7):''; }
function contestInfo(){ return { name:'Hat Trick Race to October Pick ’Em', endsAt:CONTEST_END, prize:'One collaborative original-design experience resulting in exactly one personal custom hat (ARV $39.99)', status:Date.now()<=Date.parse(CONTEST_END)?'open':'closed', officialRulesPending:false, rulesVersion:RULES_VERSION }; }
function requireOAuthConfig(env){ if(!env.CUSTOMER_ACCOUNT_CLIENT_ID) throw new HttpError(503,'Shop login is awaiting its Shopify Customer Account client ID.'); }
function safeReturn(value){ try{const url=new URL(value||`${STOREFRONT}/pages/race-to-october-pick-em`); if(!['hattrick.nyc','www.hattrick.nyc'].includes(url.hostname)) throw 0; return url.toString();}catch{return `${STOREFRONT}/pages/race-to-october-pick-em`;} }
function randomToken(){ const bytes=crypto.getRandomValues(new Uint8Array(32)); return base64url(bytes); }
function base64url(value){ const bytes=value instanceof ArrayBuffer?new Uint8Array(value):value; return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
async function secretHash(value,env){ const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.AUTH_SECRET||env.HASH_PEPPER),{name:'HMAC',hash:'SHA-256'},false,['sign']); return base64url(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(value))); }
async function discover(domain){ const response=await fetch(`${domain}/.well-known/openid-configuration`,{headers:{Accept:'application/json','User-Agent':'Hat-Trick-Off-Track/2.0'}}); if(!response.ok) throw new HttpError(502,'Shop login discovery is unavailable.'); return response.json(); }
async function fetchCustomerSubject(accessToken){
  const cfgResponse=await fetch(`${STOREFRONT}/.well-known/customer-account-api`,{headers:{Accept:'application/json','User-Agent':'Hat-Trick-Off-Track/2.0'}});
  if(!cfgResponse.ok) throw new HttpError(502,'Customer Account API discovery is unavailable.');
  const cfg=await cfgResponse.json(); const endpoint=cfg.graphql_api||cfg.graphql_api_endpoint||cfg.graphql_endpoint;
  if(!endpoint) throw new HttpError(502,'Customer Account API endpoint was not discovered.');
  const response=await fetch(endpoint,{method:'POST',headers:{Authorization:accessToken,Origin:STOREFRONT,'Content-Type':'application/json','User-Agent':'Hat-Trick-Off-Track/2.0'},body:JSON.stringify({query:'query SportsbookIdentity { customer { id } }'})});
  const data=await response.json(); const id=data?.data?.customer?.id; if(!response.ok||!id) throw new HttpError(401,'Shop verified the login but did not return a customer identity.'); return id;
}
async function rateLimit(bucket,limit,seconds,env){ const now=Math.floor(Date.now()/1000),start=now-(now%seconds); const row=await env.DB.prepare('SELECT * FROM rate_limits WHERE bucket=?').bind(bucket).first(); if(row&&row.window_start===start&&row.requests>=limit) throw new HttpError(429,'Too many attempts. The window clerk requests a short intermission.'); await env.DB.prepare('INSERT INTO rate_limits(bucket,window_start,requests) VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET window_start=CASE WHEN window_start=? THEN window_start ELSE ? END,requests=CASE WHEN window_start=? THEN requests+1 ELSE 1 END').bind(bucket,start,start,start,start).run(); }

function chicagoDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()); }
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
