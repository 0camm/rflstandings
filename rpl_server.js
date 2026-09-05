"use strict";

const http  = require("http");
const https = require("https");

const PORT         = process.env.PORT                              || 3000;
// RPL_SECRET is legacy (used only by the old auto-report endpoint, which is
// now disabled — see handleAutoReportDisabled below). It is NOT required to start.
const SECRET       = (process.env.RPL_SECRET   || "").trim();
const RESULTS_MAX  = 500;
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();
// Upstash Redis is now the ONLY persistence layer (Supabase support removed —
// this league is manual-entry only via the admin panel, no live game bot).
const UPSTASH_URL   = (process.env.UPSTASH_REDIS_REST_URL   || process.env.UPSTASH_URL   || "").trim();
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_TOKEN || "").trim();
const STATE_KEY     = "rfl-standings-state";
const ARCHIVE_KEY   = "rfl-standings-archive";
const ROBUX_PER_REF_GAME = 40;

if (!ADMIN_SECRET) {
  console.error("[RFL] FATAL: ADMIN_SECRET must be set as an environment variable. Refusing to start with no/default credentials.");
  process.exit(1);
}
if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn("[RFL] WARNING: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — standings will NOT persist across restarts.");
}

/* ── NFL team roster (Season 1 default seed) ──
   Used to pre-populate state.teams ONE TIME on first boot only, so the admin
   panel has every team ready to edit immediately instead of starting empty.
   This is a static, hard-coded starting point — nothing here is ever
   re-fetched or re-synced after boot. Every field (name, conference, logo,
   roles) is 100% editable — and, going forward, ONLY editable — through the
   Admin Panel's Teams tab. There is no Roblox group/API integration of any
   kind: team metadata never updates itself, it only changes when an admin
   types a change in and clicks Save. */
const NFL_TEAM_INFO = {
  ARI:{name:"Arizona Cardinals",conference:"NFC"}, ATL:{name:"Atlanta Falcons",conference:"NFC"},
  BAL:{name:"Baltimore Ravens",conference:"AFC"},  BUF:{name:"Buffalo Bills",conference:"AFC"},
  CAR:{name:"Carolina Panthers",conference:"NFC"}, CHI:{name:"Chicago Bears",conference:"NFC"},
  CIN:{name:"Cincinnati Bengals",conference:"AFC"},CLE:{name:"Cleveland Browns",conference:"AFC"},
  DAL:{name:"Dallas Cowboys",conference:"NFC"},    DEN:{name:"Denver Broncos",conference:"AFC"},
  DET:{name:"Detroit Lions",conference:"NFC"},     GB:{name:"Green Bay Packers",conference:"NFC"},
  HOU:{name:"Houston Texans",conference:"AFC"},    IND:{name:"Indianapolis Colts",conference:"AFC"},
  JAX:{name:"Jacksonville Jaguars",conference:"AFC"}, KC:{name:"Kansas City Chiefs",conference:"AFC"},
  LV:{name:"Las Vegas Raiders",conference:"AFC"},  LAC:{name:"Los Angeles Chargers",conference:"AFC"},
  LAR:{name:"Los Angeles Rams",conference:"NFC"},  MIA:{name:"Miami Dolphins",conference:"AFC"},
  MIN:{name:"Minnesota Vikings",conference:"NFC"}, NE:{name:"New England Patriots",conference:"AFC"},
  NO:{name:"New Orleans Saints",conference:"NFC"}, NYG:{name:"New York Giants",conference:"NFC"},
  NYJ:{name:"New York Jets",conference:"AFC"},     PHI:{name:"Philadelphia Eagles",conference:"NFC"},
  PIT:{name:"Pittsburgh Steelers",conference:"AFC"},SF:{name:"San Francisco 49ers",conference:"NFC"},
  SEA:{name:"Seattle Seahawks",conference:"NFC"},  TB:{name:"Tampa Bay Buccaneers",conference:"NFC"},
  TEN:{name:"Tennessee Titans",conference:"AFC"},  WSH:{name:"Washington Commanders",conference:"NFC"},
};
const NFL_TEAMS = Object.keys(NFL_TEAM_INFO);
function nflLogo(abb) { return `https://a.espncdn.com/i/teamlogos/nfl/500/${abb.toLowerCase()}.png`; }
function blankRoles() { return { owner: "", gm: "", headCoach: "" }; }
function seedRoster() {
  for (const abb of NFL_TEAMS) {
    const info = NFL_TEAM_INFO[abb];
    state.teams[abb] = {
      wins: 0, losses: 0, pct: "0.000", streak: "—",
      logo: nflLogo(abb),
      name: info.name,
      conference: info.conference,
      roles: blankRoles(),
    };
  }
  console.log(`[RFL] Seeded roster with ${NFL_TEAMS.length} NFL teams for Season 1 (one-time default — fully editable from here on).`);
}

let state = {
  teams:       {},
  results:     [],
  lastUpdated: null,
  auditLog:    [],
  refLog:      [],
};

const sseClients = new Set();

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

function upstashRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return resolve({ status: 0, body: {} });
    const parsed = new URL(`${UPSTASH_URL}${path}`);
    const bodyStr = body !== undefined ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "Authorization": `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type":  "application/json",
      },
    };
    if (bodyStr) options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = https.request(options, res => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", e => { console.error("[RFL] Upstash request error:", e.message); reject(e); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Tracks whether this boot's load from Upstash actually succeeded. saveState()
// refuses to write unless this is true, so a network hiccup or bad response
// during startup can never result in a blank/seeded state getting persisted
// over real data — the old code seeded AND saved on any failure, which is
// what wiped a real roster down to 0-0 in the first place.
let stateLoadedOk = false;

async function loadState() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) { seedRoster(); stateLoadedOk = true; return; }
  try {
    const { status, body } = await upstashRequest("GET", `/get/${STATE_KEY}`);
    if (status !== 200) {
      console.error(`[RFL] FATAL: Upstash GET /get/${STATE_KEY} returned HTTP ${status}. Refusing to start — starting anyway risks seeding a blank roster and then saving over your real data. Check UPSTASH_REDIS_REST_URL/TOKEN and Upstash status, then redeploy.`);
      process.exit(1);
    }
    const parsed = body && body.result ? JSON.parse(body.result) : null;
    if (parsed) {
      state.teams       = parsed.teams       || {};
      state.results     = parsed.results     || [];
      state.lastUpdated = parsed.lastUpdated || null;
      state.auditLog    = parsed.auditLog    || [];
      state.refLog       = parsed.refLog     || [];
      console.log("[RFL] Loaded from Upstash:", Object.keys(state.teams).length, "teams");
    }
    stateLoadedOk = true;
  } catch (e) {
    console.error("[RFL] FATAL: loadState failed —", e.message, "— refusing to start. Starting anyway risks seeding a blank roster and then saving over your real data. Redeploy once Upstash is reachable.");
    process.exit(1);
  }
  if (Object.keys(state.teams).length === 0) {
    console.warn("[RFL] Upstash's stored state has 0 teams. Seeding the default roster now. IMPORTANT: if you did not intend to clear the roster, stop and restore from a backup BEFORE any admin action triggers a save — the next save will overwrite Upstash with this fresh 0-0 seed.");
    seedRoster();
  }
}

async function saveState() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  if (!stateLoadedOk) {
    console.error("[RFL] saveState refused: this process never successfully completed loadState(). Not risking a write.");
    return;
  }
  try {
    // Snapshot whatever is currently in Upstash to a backup key BEFORE
    // overwriting it. This is a one-generation-back safety net: if a Reset,
    // Archive-Advance, or bad seed gets saved, /rpl/standings/restore-backup
    // can undo it. Best-effort — a backup failure must never block the
    // actual save.
    try {
      const prev = await upstashRequest("GET", `/get/${STATE_KEY}`);
      if (prev.status === 200 && prev.body && prev.body.result) {
        await upstashRequest("POST", `/set/${STATE_KEY}-backup`, { value: prev.body.result });
      }
    } catch (e) { console.error("[RFL] pre-save backup failed (continuing with save):", e.message); }

    const payload = {
      teams:       state.teams,
      results:     state.results,
      lastUpdated: state.lastUpdated,
      auditLog:    state.auditLog,
      refLog:      state.refLog,
    };
    await upstashRequest("POST", `/set/${STATE_KEY}`, { value: JSON.stringify(payload) });
  } catch (e) { console.error("[RFL] saveState error:", e.message); }
}

async function handleRestoreBackup(req, res) {
  // Restores state.teams/results/etc from the backup key written by the
  // last successful saveState() call — i.e. "undo the most recent save".
  // Admin-only. Chain two of these (if needed) to go back further only if
  // you called it after each bad save; there is only ever ONE backup
  // generation kept, so restoring twice in a row without a save in between
  // will just restore the same snapshot again.
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  try {
    const { status, body } = await upstashRequest("GET", `/get/${STATE_KEY}-backup`);
    if (status !== 200 || !body || !body.result) {
      return sendJSON(res, 404, { error: "No backup found." });
    }
    const parsed = JSON.parse(body.result);
    state.teams       = parsed.teams       || {};
    state.results     = parsed.results     || [];
    state.lastUpdated = parsed.lastUpdated || null;
    state.auditLog     = parsed.auditLog    || [];
    state.refLog       = parsed.refLog     || [];
    stateLoadedOk = true;

    await upstashRequest("POST", `/set/${STATE_KEY}`, { value: body.result });
    broadcast("standings", buildPublicPayload());

    console.log(`[RFL] Restored from backup key: ${Object.keys(state.teams).length} teams, ${state.results.length} results.`);
    return sendJSON(res, 200, { ok: true, teams: Object.keys(state.teams).length, results: state.results.length });
  } catch (e) {
    console.error("[RFL] handleRestoreBackup error:", e.message);
    return sendJSON(res, 500, { error: e.message || "Restore failed" });
  }
}

function isAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === SECRET;
  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("secret") === SECRET;
}

function isAdminAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === ADMIN_SECRET;
  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("secret") === ADMIN_SECRET;
}

function rebuildStandings() {
  for (const abb of Object.keys(state.teams)) {
    state.teams[abb].wins = 0;
    state.teams[abb].losses = 0;
    state.teams[abb].pct = "0.000";
    state.teams[abb].streak = "—";
  }
  const ordered = [...state.results].reverse();
  for (const r of ordered) {
    if (r.voided) continue;
    if (!isTerminalStatus(r.status)) continue;
    let winnerABB = r.winnerABB;
    if (!winnerABB && r.status === "final") {
      if (r.homeScore > r.awayScore) winnerABB = r.homeABB;
      else if (r.awayScore > r.homeScore) winnerABB = r.awayABB;
    }
    if (!winnerABB) continue;
    const loserABB = winnerABB === r.homeABB ? r.awayABB : r.homeABB;
    ensureTeam(winnerABB, winnerABB === r.homeABB ? r.homeLogo : r.awayLogo);
    ensureTeam(loserABB,  loserABB  === r.homeABB ? r.homeLogo : r.awayLogo);
    state.teams[winnerABB].wins += 1;
    state.teams[loserABB].losses += 1;
    state.teams[winnerABB].streak = updateStreak(state.teams[winnerABB].streak, true);
    state.teams[loserABB].streak  = updateStreak(state.teams[loserABB].streak, false);
  }
  for (const abb of Object.keys(state.teams)) {
    const t = state.teams[abb];
    const total = t.wins + t.losses;
    t.pct = total > 0 ? (t.wins / total).toFixed(3) : "0.000";
  }
}

function ensureTeam(abb, logo) {
  if (!abb) return;
  if (!state.teams[abb]) {
    // Minimal placeholder only — name/conference/roles are intentionally left
    // blank rather than guessed, so the admin notices it needs to be filled
    // in on the Teams tab instead of silently inheriting made-up data.
    state.teams[abb] = {
      wins: 0, losses: 0, pct: "0.000", streak: "—",
      logo: logo || "", name: "", conference: "", roles: blankRoles(),
    };
  } else if (logo) {
    state.teams[abb].logo = logo;
  }
}

const VALID_CONFERENCES = new Set(["AFC", "NFC"]);
function sanitizeStr(v, maxLen) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, maxLen || 60);
}
function sanitizeRoles(r) {
  const src = (r && typeof r === "object") ? r : {};
  return {
    owner:     sanitizeStr(src.owner, 60),
    gm:        sanitizeStr(src.gm, 60),
    headCoach: sanitizeStr(src.headCoach, 60),
  };
}

function updateRecord(winnerABB, loserABB) {
  if (!winnerABB || !loserABB) return;
  ensureTeam(winnerABB);
  ensureTeam(loserABB);
  state.teams[winnerABB].wins  += 1;
  state.teams[loserABB].losses += 1;
  state.teams[winnerABB].streak = updateStreak(state.teams[winnerABB].streak, true);
  state.teams[loserABB].streak  = updateStreak(state.teams[loserABB].streak, false);
  for (const abb of [winnerABB, loserABB]) {
    const t = state.teams[abb];
    const total = t.wins + t.losses;
    t.pct = total > 0 ? (t.wins / total).toFixed(3) : "0.000";
  }
}

function updateStreak(current, won) {
  const letter = won ? "W" : "L";
  if (!current || current === "—") return `${letter}1`;
  const curLetter = current[0];
  const curNum    = parseInt(current.slice(1), 10) || 0;
  if (curLetter === letter) return `${letter}${curNum + 1}`;
  return `${letter}1`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 8e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

/* Simple in-memory rate limiter for auth/write endpoints.
   Not distributed (resets on restart, per-instance only) but stops
   naive brute-force / scripted abuse against a single process. */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_HITS  = 20;
const rateBuckets = new Map();

function getClientIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(req) {
  const ip  = getClientIP(req);
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) { if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k); }
  }
  return bucket.count > RATE_LIMIT_MAX_HITS;
}

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function sendJSON(res, status, data) {
  setCORS(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const GAME_SESSION_WINDOW = 5 * 60 * 1000;
const recentTerminalGames = new Map();

function makeMatchupKey(homeABB, awayABB) { return [homeABB, awayABB].sort().join("|"); }
function isTerminalStatus(status) { return status === "final" || status === "forfeit"; }

function isDuplicateTerminal(homeABB, awayABB, status) {
  if (!isTerminalStatus(status)) return false;
  const key = makeMatchupKey(homeABB, awayABB);
  const last = recentTerminalGames.get(key);
  if (!last) return false;
  return (Date.now() - last) < GAME_SESSION_WINDOW;
}

function markTerminal(homeABB, awayABB, status) {
  if (!isTerminalStatus(status)) return;
  const key = makeMatchupKey(homeABB, awayABB);
  recentTerminalGames.set(key, Date.now());
  setTimeout(() => recentTerminalGames.delete(key), GAME_SESSION_WINDOW);
}

function parseRefs(refString) {
  if (!refString || refString === "None" || refString === "") return [];
  return refString.split(/[,;\/]/).map(r => r.trim()).filter(r => {
    if (!r) return false;
    if (r.includes(":"))   return false; // Discord emoji format e.g. :notepad_spiral: Note
    if (r.length > 40)     return false; // suspiciously long
    return true;
  });
}

function logRefActivity(refString, gameId, homeABB, awayABB, timestamp) {
  const names = parseRefs(refString);
  const ts = timestamp || new Date().toISOString();
  for (const name of names) {
    state.refLog.unshift({ name, gameId, homeABB, awayABB, timestamp: ts });
  }
  if (state.refLog.length > 5000) state.refLog.length = 5000;
}

function buildRefStats() {
  const map = {};
  // Derive from results (source of truth — covers all historical games)
  for (const result of [...state.results].reverse()) {
    const names = parseRefs(result.referees);
    for (const name of names) {
      if (!map[name]) map[name] = { name, games: 0, lastActive: null, recentGames: [] };
      const r = map[name];
      r.games += 1;
      if (!r.lastActive || result.timestamp > r.lastActive) r.lastActive = result.timestamp;
      if (r.recentGames.length < 5) r.recentGames.push({ gameId: result.id, homeABB: result.homeABB, awayABB: result.awayABB, timestamp: result.timestamp });
    }
  }
  const list = Object.values(map).map(r => ({ ...r, robux: r.games * ROBUX_PER_REF_GAME }));
  return list.sort((a, b) => b.games - a.games || b.lastActive.localeCompare(a.lastActive));
}

function handleGetRefs(req, res) {
  const refs = buildRefStats();
  const totalRobux = refs.reduce((sum, r) => sum + r.robux, 0);
  return sendJSON(res, 200, { refs, robuxPerGame: ROBUX_PER_REF_GAME, totalRobux, lastUpdated: state.lastUpdated });
}

function handleAuth(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  return sendJSON(res, 200, { ok: true });
}

// Automatic score reporting (from an in-game bot) is disabled for RFL Season 1.
// All results now go through the admin panel's "Add Game" / "Team Override"
// tools instead (see handleAddGame / handleTeamOverride below). This handler
// is kept only so the old endpoint fails loudly and clearly, instead of 404ing.
function handleAutoReportDisabled(req, res) {
  return sendJSON(res, 410, {
    error: "Automatic score reporting has been disabled for RFL Season 1. Use the admin panel to add games manually.",
  });
}

async function handleVoidResult(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { id, voided } = body;
  if (id === undefined) return sendJSON(res, 422, { error: "Missing result id" });

  const result = state.results.find(r => r.id === id);
  if (!result) return sendJSON(res, 404, { error: "Result not found" });

  result.voided = !!voided;
  state.lastUpdated = new Date().toISOString();

  const action = voided ? "voided" : "unvoided";
  state.auditLog.unshift({
    action,
    gameId:    result.id,
    matchup:   `${result.awayABB} @ ${result.homeABB}`,
    score:     `${result.awayScore}–${result.homeScore}`,
    status:    result.status,
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  rebuildStandings();
  await saveState();
  broadcast("standings", buildPublicPayload());

  console.log(`[RFL] Result ${action}: ${result.awayABB} @ ${result.homeABB} | id=${id}`);
  return sendJSON(res, 200, { ok: true, action, result });
}

async function handleRemoveResult(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { id } = body;
  if (id === undefined) return sendJSON(res, 422, { error: "Missing result id" });

  const idx = state.results.findIndex(r => r.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: "Result not found" });

  const removed = state.results.splice(idx, 1)[0];
  state.lastUpdated = new Date().toISOString();

  state.auditLog.unshift({
    action:    "removed",
    gameId:    removed.id,
    matchup:   `${removed.awayABB} @ ${removed.homeABB}`,
    score:     `${removed.awayScore}–${removed.homeScore}`,
    status:    removed.status,
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  rebuildStandings();
  await saveState();
  broadcast("standings", buildPublicPayload());

  console.log(`[RFL] Result removed: ${removed.awayABB} @ ${removed.homeABB} | id=${id}`);
  return sendJSON(res, 200, { ok: true, removed });
}

async function handleZeroRecords(req, res) {
  // Zeroes every team's wins/losses/streak back to 0-0 and clears match
  // history, but — unlike handleReset — KEEPS the team objects (and their
  // logos) in state.teams so the roster doesn't need to be re-seeded.
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });

  const teamCount = Object.keys(state.teams).length;
  for (const abb of Object.keys(state.teams)) {
    state.teams[abb].wins   = 0;
    state.teams[abb].losses = 0;
    state.teams[abb].pct    = "0.000";
    state.teams[abb].streak = "—";
  }
  state.results     = [];
  state.lastUpdated = new Date().toISOString();

  state.auditLog.unshift({
    action:    "zeroed",
    gameId:    null,
    matchup:   "ALL",
    score:     "—",
    status:    "zeroed (roster kept)",
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  await saveState();
  broadcast("standings", buildPublicPayload());

  console.log(`[RFL] All ${teamCount} team records zeroed to 0-0 (roster/logos kept, match history cleared).`);
  return sendJSON(res, 200, { ok: true, teamsZeroed: teamCount });
}

async function resetState(auditAction) {
  state.teams       = {};
  state.results     = [];
  state.lastUpdated = new Date().toISOString();
  state.auditLog.unshift({
    action:    auditAction || "reset",
    gameId:    null,
    matchup:   "ALL",
    score:     "—",
    status:    "reset",
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  await saveState();
  broadcast("standings", buildPublicPayload());
}

async function handleReset(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });

  await resetState("reset");

  console.log("[RFL] Full standings reset.");
  return sendJSON(res, 200, { ok: true });
}

async function handleArchiveAndAdvance(req, res) {
  // Saves the season snapshot (the full archive list, same shape the client
  // already builds for /rpl/archive) and then wipes the live standings/results
  // back to a clean slate, all in one admin-authorized, atomic-from-the-
  // client's-perspective call.
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { archive, label } = body;
  if (archive === undefined) return sendJSON(res, 422, { error: "Missing archive payload" });

  try {
    await upstashRequest("POST", `/set/${ARCHIVE_KEY}`, { value: JSON.stringify(archive) });
  } catch (e) {
    console.error("[RFL] Archive save to Upstash failed — aborting reset:", e.message);
    return sendJSON(res, 500, { error: "Archive save failed — standings were NOT reset." });
  }

  state.auditLog.unshift({
    action:    "archived",
    gameId:    null,
    matchup:   "ALL",
    score:     "—",
    status:    label ? `archived: ${label}` : "archived",
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  await resetState("season-advance");

  console.log(`[RFL] Season archived${label ? ` ("${label}")` : ""} and standings reset for new season.`);
  return sendJSON(res, 200, { ok: true });
}

function handleGetStandings(req, res) {
  setCORS(res);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(buildPublicPayload()));
}

function handleSSE(req, res) {
  setCORS(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: standings\ndata: ${JSON.stringify(buildPublicPayload())}\n\n`);
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); }
    catch (_) { clearInterval(heartbeat); sseClients.delete(res); }
  }, 25000);

  req.on("close", () => { clearInterval(heartbeat); sseClients.delete(res); });
}

async function handleTeamOverride(req, res) {
  // Manual standings edits are admin-only. The regular SECRET ("console" /
  // bot-poster credential) is intentionally NOT accepted here — only ADMIN_SECRET.
  // This endpoint edits an EXISTING team's record and/or metadata. It never
  // reaches out to Roblox or any external source — every value it writes
  // comes straight from the request body the admin panel sent.
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { abb: rawAbb, wins, losses, streak, logo, name, conference, roles } = body;
  const abb = sanitizeStr(rawAbb, 8).toUpperCase();
  if (!abb) return sendJSON(res, 422, { error: "Missing abb" });
  if (conference !== undefined && conference !== "" && !VALID_CONFERENCES.has(conference)) {
    return sendJSON(res, 422, { error: "conference must be AFC or NFC" });
  }

  ensureTeam(abb, logo);
  const t = state.teams[abb];
  if (wins       !== undefined) t.wins       = Math.max(0, parseInt(wins, 10) || 0);
  if (losses     !== undefined) t.losses     = Math.max(0, parseInt(losses, 10) || 0);
  if (streak     !== undefined) t.streak     = sanitizeStr(streak, 10) || "—";
  if (logo       !== undefined) t.logo       = sanitizeStr(logo, 500);
  if (name       !== undefined) t.name       = sanitizeStr(name, 80);
  if (conference !== undefined) t.conference = conference;
  if (roles      !== undefined) t.roles      = sanitizeRoles(roles);
  if (!t.roles) t.roles = blankRoles();

  const total = t.wins + t.losses;
  t.pct = total > 0 ? (t.wins / total).toFixed(3) : "0.000";
  state.lastUpdated = new Date().toISOString();

  await saveState();
  broadcast("standings", buildPublicPayload());

  state.auditLog.unshift({
    action: "team_edited", gameId: null, matchup: abb,
    score: `${t.wins}W-${t.losses}L`, status: t.conference || "",
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  console.log(`[RFL] Team edited: ${abb} → ${t.wins}W-${t.losses}L name="${t.name || ""}" conf=${t.conference || "—"} logo=${t.logo ? "✓" : "—"}`);
  return sendJSON(res, 200, { ok: true, team: { abb, ...t } });
}

async function handleAddTeam(req, res) {
  // Creates a brand-new team from scratch. Admin-only, fully manual — the
  // admin types in every field themselves. There is no lookup against
  // Roblox groups, no bot import, nothing auto-filled beyond what's sent here.
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const abb  = sanitizeStr(body.abb, 8).toUpperCase();
  const name = sanitizeStr(body.name, 80);
  const conference = body.conference;

  if (!abb)  return sendJSON(res, 422, { error: "Team abbreviation is required." });
  if (!name) return sendJSON(res, 422, { error: "Team name is required." });
  if (!VALID_CONFERENCES.has(conference)) return sendJSON(res, 422, { error: "Conference must be AFC or NFC." });
  if (state.teams[abb]) return sendJSON(res, 409, { error: `Team "${abb}" already exists — edit it instead of adding it again.` });

  state.teams[abb] = {
    wins: 0, losses: 0, pct: "0.000", streak: "—",
    logo: sanitizeStr(body.logo, 500),
    name, conference,
    roles: sanitizeRoles(body.roles),
  };
  state.lastUpdated = new Date().toISOString();

  await saveState();
  broadcast("standings", buildPublicPayload());

  state.auditLog.unshift({
    action: "team_added", gameId: null, matchup: `${abb} — ${name}`,
    score: "0W-0L", status: conference, timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  console.log(`[RFL] Team added manually: ${abb} (${name}, ${conference})`);
  return sendJSON(res, 200, { ok: true, team: { abb, ...state.teams[abb] } });
}

async function handleRemoveTeam(req, res) {
  // Permanently deletes a team. Admin-only. Past game results that reference
  // this abbreviation are left untouched in history, but the next standings
  // rebuild will show it as an unnamed placeholder rather than silently
  // resurrecting it — nothing is re-created from an external source.
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const abb = sanitizeStr(body.abb, 8).toUpperCase();
  if (!abb) return sendJSON(res, 422, { error: "Missing abb" });
  if (!state.teams[abb]) return sendJSON(res, 404, { error: `Team "${abb}" doesn't exist.` });

  const removedName = state.teams[abb].name || abb;
  delete state.teams[abb];
  state.lastUpdated = new Date().toISOString();

  await saveState();
  broadcast("standings", buildPublicPayload());

  state.auditLog.unshift({
    action: "team_removed", gameId: null, matchup: `${abb} — ${removedName}`,
    score: "—", status: "", timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  console.log(`[RFL] Team removed manually: ${abb} (${removedName})`);
  return sendJSON(res, 200, { ok: true, abb });
}

function buildPublicPayload() {
  const sorted = Object.entries(state.teams)
    .map(([abb, data]) => ({ abb, ...data }))
    .sort((a, b) => {
      const pctA = parseFloat(a.pct) || 0;
      const pctB = parseFloat(b.pct) || 0;
      if (pctB !== pctA) return pctB - pctA;
      const gpA = a.wins + a.losses;
      const gpB = b.wins + b.losses;
      if (gpB !== gpA) return gpB - gpA;
      return b.wins - a.wins;
    });
  return { standings: sorted, results: state.results, lastUpdated: state.lastUpdated };
}

async function handleAddGame(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { homeABB, awayABB, homeScore, awayScore, status, quarter, note, season, timestamp } = body;
  if (!homeABB || !awayABB || !status)
    return sendJSON(res, 422, { error: "Missing required fields: homeABB, awayABB, status" });

  const safeStatus = ["final", "forfeit", "incomplete"].includes(status) ? status : "final";
  const hs  = parseInt(homeScore, 10) || 0;
  const as_ = parseInt(awayScore, 10) || 0;

  ensureTeam(homeABB);
  ensureTeam(awayABB);

  let winnerABB = null;
  if (isTerminalStatus(safeStatus)) {
    if (hs > as_)       winnerABB = homeABB;
    else if (as_ > hs)  winnerABB = awayABB;
    if (winnerABB) {
      const loserABB = winnerABB === homeABB ? awayABB : homeABB;
      updateRecord(winnerABB, loserABB);
    }
  }

  const result = {
    id:           Date.now(),
    timestamp:    timestamp || new Date().toISOString(),
    season:       season || "Season 1",
    status:       safeStatus,
    quarter:      quarter || "---",
    note:         note || "",
    homeABB,      awayABB,
    homeLogo:     "",
    awayLogo:     "",
    homeScore:    hs,
    awayScore:    as_,
    winnerABB,
    playerOfGame: null,
    referees:     "None",
    homeStats:    [],
    awayStats:    [],
    manualEntry:  true,
  };

  state.results.unshift(result);
  if (state.results.length > RESULTS_MAX) state.results.length = RESULTS_MAX;
  state.lastUpdated = new Date().toISOString();

  state.auditLog.unshift({
    action:    "added",
    gameId:    result.id,
    matchup:   `${awayABB} @ ${homeABB}`,
    score:     `${as_}–${hs}`,
    status:    safeStatus,
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  logRefActivity(result.referees, result.id, homeABB, awayABB, result.timestamp);

  await saveState();
  broadcast("standings", buildPublicPayload());
  broadcast("result", result);

  console.log(`[RFL] Manual game added: ${awayABB} @ ${homeABB} | ${safeStatus} | ${as_}–${hs}`);
  return sendJSON(res, 200, { ok: true, result });
}

function handleGetAuditLog(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  return sendJSON(res, 200, { auditLog: state.auditLog || [] });
}

async function handleGetArchive(req, res) {
  try {
    const { body } = await upstashRequest("GET", `/get/${ARCHIVE_KEY}`);
    const data = body && body.result ? JSON.parse(body.result) : null;
    return sendJSON(res, 200, { data });
  } catch (e) {
    return sendJSON(res, 500, { error: "Archive fetch failed" });
  }
}

async function handleSetArchive(req, res) {
  // Archive management (rename/delete/reorder seasons) is admin-only.
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  try {
    const payload = await readBody(req);
    await upstashRequest("POST", `/set/${ARCHIVE_KEY}`, { value: JSON.stringify(payload) });
    return sendJSON(res, 200, { ok: true });
  } catch (e) {
    console.error("[RFL] handleSetArchive error:", e.message);
    return sendJSON(res, 400, { error: e.message || "Invalid request" });
  }
}

const server = http.createServer(async (req, res) => {
  const url    = req.url.split("?")[0];
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") { setCORS(res); res.writeHead(204); return res.end(); }
  if (url === "/" || url === "/health")
    return sendJSON(res, 200, { status: "ok", clients: sseClients.size, teams: Object.keys(state.teams).length });

  if (method === "POST" && isRateLimited(req)) {
    return sendJSON(res, 429, { error: "Too many requests — please slow down." });
  }

  if (url === "/rpl/standings") {
    if (method === "POST") return handleAutoReportDisabled(req, res);
    if (method === "GET")  return handleGetStandings(req, res);
  }
  if (url === "/rpl/standings/events"   && method === "GET")  return handleSSE(req, res);
  if (url === "/rpl/standings/auth"     && method === "POST") return handleAuth(req, res);
  if (url === "/rpl/standings/void"     && method === "POST") return handleVoidResult(req, res);
  if (url === "/rpl/standings/remove"   && method === "POST") return handleRemoveResult(req, res);
  if (url === "/rpl/standings/reset"    && method === "POST") return handleReset(req, res);
  if (url === "/rpl/standings/add"      && method === "POST") return handleAddGame(req, res);
  if (url === "/rpl/standings/auditlog" && method === "GET")  return handleGetAuditLog(req, res);
  if (url === "/rpl/standings/team"     && method === "POST") return handleTeamOverride(req, res);
  if (url === "/rpl/standings/team/add"    && method === "POST") return handleAddTeam(req, res);
  if (url === "/rpl/standings/team/remove" && method === "POST") return handleRemoveTeam(req, res);
  if (url === "/rpl/refs"               && method === "GET")  return handleGetRefs(req, res);
  if (url === "/rpl/archive"            && method === "GET")  return handleGetArchive(req, res);
  if (url === "/rpl/archive"            && method === "POST") return handleSetArchive(req, res);
  if (url === "/rpl/standings/archive-advance" && method === "POST") return handleArchiveAndAdvance(req, res);
  if (url === "/rpl/standings/zero-records"    && method === "POST") return handleZeroRecords(req, res);
  if (url === "/rpl/standings/restore-backup"  && method === "POST") return handleRestoreBackup(req, res);

  sendJSON(res, 404, { error: "Not found" });
});

loadState().then(() => {
  server.listen(PORT, () => {
    console.log(`[RFL] Server running on port ${PORT}`);
    console.log(`[RFL] Upstash: ${UPSTASH_URL ? "connected" : "NOT configured"}`);
  });
});

server.on("error", err => { console.error("[RFL] Server error:", err.message); process.exit(1); });
