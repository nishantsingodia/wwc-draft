#!/usr/bin/env npx tsx
/**
 * Unit tests for lib/points.ts: the points lookups + the NEW "LIVE until L1 recon" gate.
 * Offline — injects parsed CSV rows via __setPointsCacheForTest (no network/file).
 *
 *   npx tsx scripts/test-points.ts
 */
import {
  __setPointsCacheForTest,
  lookupPlayerPoints,
  fuzzyLookupPoints,
  getMatchPointsForMatch,
  getCompletedMatchKeys,
  isMatchCompleted,
  getMatchStatusFor,
  getMatchPlayerRecon,
  lookupPlayerRecon,
} from "../lib/points";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
}

const M30 = { team1: "AUS", team2: "IND", date: "2026-06-28T00:00:00+05:30", key: "AUS_IND_Jun28" };

// Charani pid 583ce32c, Perry pid be150fc8 (the real Match 30 ids).
const H_FULL = ["Match", "Date", "Team", "Player ID", "Full Name", "Played",
  "Fantasy Points", "Match Status", "Recon Flag", "Player Recon"];
const H_LEGACY = ["Match", "Date", "Team", "Player ID", "Full Name", "Played", "Fantasy Points"];

function m30(status: string, flag: string, charani: number, perry: number, recon = ""): string[][] {
  return [
    H_FULL,
    ["Match 30 — AUS v IND", "2026-06-28", "IND", "583ce32c", "Shree Charani", "Y", String(charani), status, flag, recon],
    ["Match 30 — AUS v IND", "2026-06-28", "AUS", "be150fc8", "Ellyse Perry", "Y", String(perry), status, flag, recon],
  ];
}
const LIVE = m30("LIVE", "⏳ pending recon approval (4 players)", 43, 79, "⏳ unreconciled");
const COMPLETED = m30("COMPLETED", "", 73, 118);
const REVISION = m30("COMPLETED_FLAGGED", "⚠ official revision pending", 73, 118, "⚠ official revision");
const SINGLE = m30("COMPLETED_FLAGGED", "⚠ unverified — single feed", 73, 118);
const LEGACY: string[][] = [
  H_LEGACY,
  ["Match 30 — AUS v IND", "2026-06-28", "IND", "583ce32c", "Shree Charani", "Y", "43"],
  ["Match 30 — AUS v IND", "2026-06-28", "AUS", "be150fc8", "Ellyse Perry", "Y", "79"],
];

async function main() {
  // ── lookupPlayerPoints: pid is authoritative; no fuzzy fall-back for a pid'd player ──
  const map = new Map<string, number>([
    ["583ce32c", 43],
    ["Shree Charani", 43],
    ["espn:999", 12],
  ]);
  check("pid present + in map -> exact value", lookupPlayerPoints("583ce32c", "Shree Charani", undefined, map) === 43);
  check("pid present + NOT in map -> null (no fuzzy fallback)",
    lookupPlayerPoints("missing_pid", "Shree Charani", undefined, map) === null);
  check("no pid -> fuzzy on name", lookupPlayerPoints(undefined, "Shree Charani", undefined, map) === 43);
  check("fuzzy excludes pid keys", fuzzyLookupPoints("Some Espn Name", new Map([["espn:999", 12]])) === null);

  // ── getMatchPointsForMatch: resolves by teams+date, keys by pid AND name ──
  __setPointsCacheForTest(LIVE);
  const pm = await getMatchPointsForMatch(M30);
  check("match points: Charani by pid", pm.get("583ce32c") === 43);
  check("match points: Perry by name", pm.get("Ellyse Perry") === 79);

  // ── THE GATE: scored + LIVE => NOT completed ──
  __setPointsCacheForTest(LIVE);
  check("LIVE: getCompletedMatchKeys excludes it", !(await getCompletedMatchKeys([M30])).has(M30.key));
  check("LIVE: isMatchCompleted false", (await isMatchCompleted(M30)) === false);
  check("LIVE: getMatchStatusFor flag", (await getMatchStatusFor(M30))?.status === "LIVE");

  // scored + COMPLETED => completed
  __setPointsCacheForTest(COMPLETED);
  check("COMPLETED: in completed set", (await getCompletedMatchKeys([M30])).has(M30.key));
  check("COMPLETED: isMatchCompleted true", (await isMatchCompleted(M30)) === true);

  // COMPLETED_FLAGGED (revision) => still shows results, with the flag
  __setPointsCacheForTest(REVISION);
  check("FLAGGED(revision): in completed set", (await getCompletedMatchKeys([M30])).has(M30.key));
  check("FLAGGED(revision): status flag carries 'revision'",
    ((await getMatchStatusFor(M30))?.flag ?? "").includes("revision"));

  // COMPLETED_FLAGGED (single feed) => completed + unverified flag
  __setPointsCacheForTest(SINGLE);
  check("FLAGGED(single): in completed set", (await getCompletedMatchKeys([M30])).has(M30.key));
  check("FLAGGED(single): unverified flag", ((await getMatchStatusFor(M30))?.flag ?? "").includes("single feed"));

  // ── BACKWARD-COMPAT: a sheet with NO "Match Status" column => legacy (scored => completed) ──
  __setPointsCacheForTest(LEGACY);
  check("LEGACY: scored => completed (column absent)", (await getCompletedMatchKeys([M30])).has(M30.key));
  check("LEGACY: isMatchCompleted true", (await isMatchCompleted(M30)) === true);
  check("LEGACY: getMatchStatusFor null", (await getMatchStatusFor(M30)) === null);

  // ── PER-PLAYER recon: which players aren't reconciled ──
  __setPointsCacheForTest(LIVE);
  const recon = await getMatchPlayerRecon(M30);
  check("player recon: Charani flagged by pid", recon.get("583ce32c") === "⏳ unreconciled");
  check("player recon: lookup pid-first",
    lookupPlayerRecon("583ce32c", "Shree Charani", undefined, recon) === "⏳ unreconciled");
  __setPointsCacheForTest(COMPLETED);
  check("player recon: empty once completed", (await getMatchPlayerRecon(M30)).size === 0);
  __setPointsCacheForTest(LEGACY);
  check("player recon: empty on legacy (no column)", (await getMatchPlayerRecon(M30)).size === 0);

  __setPointsCacheForTest(null);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
