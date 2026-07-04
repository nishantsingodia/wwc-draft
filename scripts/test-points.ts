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
  getTourPoints,
  getLastPlayedXI,
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

  // ── getTourPoints: scoped to ONE tour by the match's two teams ──
  // The merged sheet holds every tour's tab. A player who features in TWO tours must
  // NOT have their points summed across tours — only rows for the current match's
  // teams count. Team column may be a code (women's, MLC) or a full name (men's tab).
  const TOURS: string[][] = [
    H_FULL,
    // Women's WC — England player, two matches (both Team ENG) => summed within tour
    ["Match 1 — ENG v SL", "2026-06-12", "ENG", "engnat", "Nat Sciver", "Y", "50", "COMPLETED", "", ""],
    ["Match 8 — ENG v IRE", "2026-06-16", "ENG", "engnat", "Nat Sciver", "Y", "30", "COMPLETED", "", ""],
    // Cross-tour player: 60 in the bilateral (full-name Team "Australia") + 40 in MLC (code Team "WAF")
    ["Match 1 — Bangladesh v Australia", "2026-06-17", "Australia", "dualman", "Marcus Stoinis", "Y", "60", "COMPLETED", "", ""],
    ["Match 3 — SEO v WAF", "2026-06-20", "WAF", "dualman", "Marcus Stoinis", "Y", "40", "COMPLETED", "", ""],
    // MLC-only player
    ["Match 3 — SEO v WAF", "2026-06-20", "WAF", "mlconly", "Aaron Jones", "Y", "25", "COMPLETED", "", ""],
  ];
  __setPointsCacheForTest(TOURS);
  const wcPts = await getTourPoints("ENG", "SL");
  check("tour points: within-tour summed by pid (50+30)", wcPts.get("engnat") === 80);
  check("tour points: within-tour summed by name", wcPts.get("nat sciver") === 80);
  check("tour points: other-tour player absent from WC scope", wcPts.get("dualman") === undefined);

  const biPts = await getTourPoints("MAUS", "MBAN");
  check("tour points: cross-tour scoped to bilateral only (60, not 100)", biPts.get("dualman") === 60);
  check("tour points: full-name Team column matches code (Australia->MAUS)", biPts.has("dualman"));
  check("tour points: MLC-only player absent from bilateral scope", biPts.get("mlconly") === undefined);

  const mlcPts = await getTourPoints("WAF", "SFU");
  check("tour points: cross-tour scoped to MLC only (40)", mlcPts.get("dualman") === 40);
  check("tour points: MLC-only player present in MLC scope", mlcPts.get("mlconly") === 25);

  // ── Reused team code across two BILATERAL tours (the IND-v-IRE → IND-v-ENG bug) ──
  // team-code scoping breaks when the SAME code appears in two tours: India is "MIND"
  // in both series, so summing by code would add its Ireland points onto the England
  // board. mergeCsvs stamps a __tab (tour) column; getTourPoints/getLastPlayedXI scope
  // to the match's own tab. (Test injects the __tab column mergeCsvs would produce.)
  const H_TAB = [...H_FULL, "__tab"];
  const REUSED: string[][] = [
    H_TAB,
    // tab 0 = IND v IRE: Abhishek plays twice; an Ireland-only player also features
    ["Match 1 — MIND v MIRE", "2026-06-26", "MIND", "abh", "Abhishek Sharma", "Y", "100", "COMPLETED", "", "", "0"],
    ["Match 2 — MIND v MIRE", "2026-06-28", "MIND", "abh", "Abhishek Sharma", "Y", "10", "COMPLETED", "", "", "0"],
    ["Match 2 — MIND v MIRE", "2026-06-28", "MIRE", "ireonly", "Ire Only", "Y", "20", "COMPLETED", "", "", "0"],
    // tab 1 = IND v ENG: SAME India code MIND (Abhishek) + an England player
    ["Match 1 — MENG v MIND", "2026-07-01", "MIND", "abh", "Abhishek Sharma", "Y", "125", "COMPLETED", "", "", "1"],
    ["Match 1 — MENG v MIND", "2026-07-01", "MENG", "brook", "Harry Brook", "Y", "10", "COMPLETED", "", "", "1"],
  ];
  const ENG_M2 = { team1: "MIND", team2: "MENG", date: "2026-07-04T23:00:00+05:30" };
  const IRE_M2 = { team1: "MIND", team2: "MIRE", date: "2026-06-28T18:00:00+05:30" };
  __setPointsCacheForTest(REUSED);

  const engT = await getTourPoints("MIND", "MENG", ENG_M2);
  check("reused-code: India total scoped to ENG tab only (125, not 235)", engT.get("abh") === 125);
  check("reused-code: England player present in ENG scope", engT.get("brook") === 10);
  check("reused-code: Ireland-only player absent from ENG scope", engT.get("ireonly") === undefined);

  const ireT = await getTourPoints("MIND", "MIRE", IRE_M2);
  check("reused-code: India total scoped to IRE tab only (100+10)", ireT.get("abh") === 110);
  check("reused-code: England player absent from IRE scope", ireT.get("brook") === undefined);

  const engXI = await getLastPlayedXI(ENG_M2);
  check("reused-code XI: ENG-scoped last XI has England player", engXI.get("MENG")?.has("brook") === true);
  check("reused-code XI: ENG-scoped last XI has India player", engXI.get("MIND")?.has("abh") === true);
  check("reused-code XI: Ireland-tab team absent from ENG-scoped XI", engXI.get("MIRE") === undefined);

  // Guard: WITHOUT a match (legacy / no tab resolution) it still falls back to
  // team-code scoping — which is exactly the leak (235) the match-scoped path fixes.
  const engNoMatch = await getTourPoints("MIND", "MENG");
  check("reused-code: no-match fallback is team-code scoping (235 across tabs)", engNoMatch.get("abh") === 235);

  __setPointsCacheForTest(null);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
