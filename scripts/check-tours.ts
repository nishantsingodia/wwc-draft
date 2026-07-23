/**
 * check:tours — preflight that fails LOUD (non-zero exit) if a tour in the draft can't work,
 * BEFORE it ships to prod as a silent "0 points". Run in CI ("Validate draft") and locally
 * (`npm run check:tours`) after adding/editing a tour — auto-ingested OR hand-added.
 *
 * It uses the draft's OWN resolution code (one source of truth), so it can't drift from what
 * the app actually does. Hard failures are the unambiguous breakers behind the LPL/Hundred saga:
 *   1. a match team code the roster/TEAM_NAMES doesn't know   (→ match never attaches)
 *   2. a gender in play with an EMPTY ESPN series list         (→ live XI + live points can't resolve)
 * Identity resolution is REPORTED (not gated): the real live join resolves by ESPN id first, which
 * this roster-only view can't see, so a low name-only number is the fallback tail, not a break.
 */
import matches from "../data/matches.json";
import roster from "../data/players-raw.json";
import espnSeries from "../data/espn-series.json";
import { TEAM_NAMES } from "../lib/players";
import { resolveEspnPid } from "../lib/registry";

type M = { team1: string; team2: string; gender: string; key: string };
const ms = matches as M[];
const players = roster as Array<{ name: string; pid?: string; team_code: string }>;
const series = espnSeries as Record<string, string[]>;

const rosterCodes = new Set(players.map((p) => p.team_code));
const fail: string[] = [];

// 1. every match team code (≠ TBD knockouts) must be known to TEAM_NAMES AND have a roster.
const codes = new Set<string>();
for (const m of ms) for (const c of [m.team1, m.team2]) if (c && c !== "TBD") codes.add(c);
for (const c of codes) {
  if (!TEAM_NAMES[c]) fail.push(`team code "${c}" is in matches.json but missing from team-codes.json (TEAM_NAMES)`);
  if (!rosterCodes.has(c)) fail.push(`team code "${c}" has no players in players-raw.json`);
}

// 2. every gender that appears in matches must have at least one ESPN series registered.
const gendersUsed = new Set(ms.map((m) => m.gender));
for (const g of gendersUsed) {
  if (!(series[g]?.length)) fail.push(`gender "${g}" is used by matches but data/espn-series.json["${g}"] is empty — live XI + live points can't resolve`);
}

// 3. REPORT identity resolution per team (name-only path; informational).
const byTeam: Record<string, { t: number; r: number; miss: string[] }> = {};
for (const p of players) {
  if (!p.pid) continue;
  const g = (byTeam[p.team_code] ??= { t: 0, r: 0, miss: [] });
  g.t++;
  if (resolveEspnPid(undefined, p.name) === p.pid) g.r++;
  else g.miss.push(p.name);
}
const low = Object.entries(byTeam)
  .map(([c, g]) => ({ c, cov: g.t ? g.r / g.t : 1, miss: g.miss }))
  .filter((r) => r.cov < 0.85)
  .sort((a, b) => a.cov - b.cov);
if (low.length) {
  console.log("ℹ️  identity: teams with low name-only resolution (real join also uses ESPN id, so this is the fallback tail):");
  for (const r of low) console.log(`   ${r.c}: ${(r.cov * 100).toFixed(0)}%  e.g. ${r.miss.slice(0, 3).join(", ")}`);
}

if (fail.length) {
  console.error(`\n❌ check:tours FAILED — ${fail.length} blocker(s):`);
  for (const f of fail) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ check:tours passed — ${codes.size} team codes, genders [${[...gendersUsed].join(", ")}] all have ESPN series.`);
