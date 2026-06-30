// Fetches World Cup match results from football-data.org and upserts them into
// the Supabase `results` table. Runs server-side (GitHub Action), so the API
// token and Supabase service_role key stay in GitHub Secrets — never in the site.
//
// Required env vars (set as GitHub Secrets):
//   FOOTBALL_DATA_TOKEN     - free token from https://www.football-data.org/
//   SUPABASE_URL            - your project URL
//   SUPABASE_SERVICE_KEY    - Supabase service_role key (Settings -> API)
//
// Matching strategy: the free API does not expose FIFA's 73..103 match numbers,
// so we resolve our bracket's teams (using results already known) and match an
// API fixture to one of our matches by its two team names. Anything we can't
// confidently map is logged and skipped — fix those by hand in the Admin tab.

import fs from "node:fs";

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!TOKEN || !SB_URL || !SB_KEY) {
  console.error("Missing env vars. Need FOOTBALL_DATA_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY.");
  process.exit(1);
}

const bracket = JSON.parse(fs.readFileSync(new URL("../data/bracket.json", import.meta.url)));

// Normalize team names so "USA" / "United States", "South Korea" / "Korea Republic" match.
const ALIASES = {
  "united states": "usa",
  "us": "usa",
  "korea republic": "south korea",
  "ir iran": "iran",
  "côte d'ivoire": "ivory coast",
  "cote d'ivoire": "ivory coast",
  "dr congo": "congo dr",
  "czechia": "czech republic",
  "bosnia and herzegovina": "bosnia-herzegovina",
  "cape verde": "cape verde islands"
};
const norm = (s) =>
  s ? (ALIASES[s.trim().toLowerCase()] || s.trim().toLowerCase()) : "";

// ---- Supabase REST helpers (no SDK needed) ----
async function sbGet(table) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?select=*`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
  });
  if (!r.ok) throw new Error(`Supabase GET ${table} failed: ${r.status}`);
  return r.json();
}
async function sbUpsert(table, rows) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error(`Supabase upsert ${table} failed: ${r.status} ${await r.text()}`);
}

// Resolve a bracket slot to a team name given the results we already have.
function resolveSlot(slot, resultsById) {
  if (!slot) return null;
  if (slot.team) return slot.team;
  if (slot.from != null) {
    const res = resultsById[slot.from];
    return res && res.winner ? res.winner : null;
  }
  return null;
}

async function main() {
  const existing = await sbGet("results");
  const resultsById = {};
  existing.forEach((r) => (resultsById[r.match_id] = r));

  // Pull World Cup fixtures. Competition code "WC".
  const api = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
    headers: { "X-Auth-Token": TOKEN }
  });
  if (!api.ok) {
    console.error(`football-data API error: ${api.status}. (Free tier may not cover this competition.)`);
    process.exit(1);
  }
  const { matches = [] } = await api.json();

  // Store the full match history (all stages) for the hover-over-team feature.
  const gameRows = matches.map((m) => ({
    id: String(m.id),
    utc_date: m.utcDate || null,
    stage: m.stage || null,
    home: m.homeTeam?.name || null,
    away: m.awayTeam?.name || null,
    home_score: m.score?.fullTime?.home ?? null,
    away_score: m.score?.fullTime?.away ?? null,
    status: m.status || null
  })).filter((g) => g.home && g.away);
  if (gameRows.length) {
    await sbUpsert("games", gameRows);
    console.log(`Upserted ${gameRows.length} game(s) into history.`);
  }

  // Build a lookup of finished API fixtures keyed by the unordered team pair.
  const finished = {};
  for (const m of matches) {
    if (m.status !== "FINISHED") continue;
    const home = norm(m.homeTeam?.name);
    const away = norm(m.awayTeam?.name);
    if (!home || !away) continue;
    const key = [home, away].sort().join("|");
    finished[key] = {
      home, away,
      homeScore: m.score?.fullTime?.home ?? null,
      awayScore: m.score?.fullTime?.away ?? null,
      winner: m.score?.winner // HOME_TEAM | AWAY_TEAM | DRAW
    };
  }

  const toUpsert = [];
  const unmatched = [];

  // Resolve bracket rounds in order so winners feed later rounds within one run.
  for (const id of Object.keys(bracket.matches).sort((a, b) => a - b)) {
    if (resultsById[id] && resultsById[id].winner) continue; // already have it
    const m = bracket.matches[id];
    const a = resolveSlot(m.a, resultsById);
    const b = resolveSlot(m.b, resultsById);
    if (!a || !b) continue; // teams not known yet

    const key = [norm(a), norm(b)].sort().join("|");
    const f = finished[key];
    if (!f) continue; // not played yet, or names didn't match

    // Map API home/away back to our slot A / slot B.
    const aIsHome = norm(a) === f.home;
    const scoreA = aIsHome ? f.homeScore : f.awayScore;
    const scoreB = aIsHome ? f.awayScore : f.homeScore;
    let winner = null;
    if (f.winner === "HOME_TEAM") winner = f.home === norm(a) ? a : b;
    else if (f.winner === "AWAY_TEAM") winner = f.away === norm(a) ? a : b;
    // Knockout games can't truly draw; if API says DRAW it was decided on
    // penalties — we can't read the shootout here, so leave winner null and
    // flag it for manual entry.
    if (!winner) { unmatched.push(`#${id} ${a} vs ${b} (decided on penalties? set winner in Admin)`); }

    const row = { match_id: Number(id), winner, score_a: scoreA, score_b: scoreB };
    toUpsert.push(row);
    if (winner) resultsById[id] = row; // let it feed the next round this run
  }

  if (toUpsert.length) {
    await sbUpsert("results", toUpsert);
    console.log(`Upserted ${toUpsert.length} result(s).`);
  } else {
    console.log("No new results to write.");
  }
  if (unmatched.length) {
    console.log("Needs manual attention:\n  " + unmatched.join("\n  "));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
