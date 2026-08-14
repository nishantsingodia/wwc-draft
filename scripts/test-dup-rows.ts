#!/usr/bin/env npx tsx
/**
 * ONE row per (match, player) — the duplicate-slot regressions (14 Aug 2026).
 *
 * The bot writes one row per (match, SQUAD SLOT) and auto-add appended a slot that already
 * existed, so 18 (match, pid) keys on the live sheet carry TWO rows for ONE performance. Five app
 * paths reduced that pair five different ways — last-wins (contest totals), SUM (draft board),
 * max-wins (audit), first-wins (bat order), and the summed `Points Delta` — so the results page
 * printed −1 for Jane Maguire while the Audit tab BESIDE IT printed 2, and her single 46-point WWC
 * match read 92 on the draft board.
 *
 * These fixtures are the two real shapes, with the real numbers:
 *   • two scored rows — ci:1229018, "Match 1 — OIRE v OWI": identical stats scored BOWL=2 and
 *     AR=−1 (the AR row takes the ODI duck penalty the BOWL role is exempt from).
 *   • a scored row + a bare Played=N slot row — ci:858809 (181 / blank) and the negative case
 *     ci:300 (−3 / blank) that the audit's `(prev.points ?? -1)` used to lose.
 *
 *   npx tsx scripts/test-dup-rows.ts
 */
import {
  __setPointsCacheForTest,
  __setSettlementCacheForTest,
  getMatchPointsForMatch,
  getTourPoints,
  getMatchXI,
  getMatchStatusFor,
  lookupPlayerPoints,
} from "../lib/points";
import { auditMatch } from "../lib/settlement-audit";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
}

const MAG = "ci:1229018";   // Jane Maguire — two SCORED rows (2 / −1)
const GAR = "ci:858809";    // Ash Gardner  — 181 + a bare Played=N slot row
const NEG = "ci:300";       // the absence-as-value case: −3 + a bare Played=N slot row
const SOLO = "ci:100";      // control: exactly one row, must be untouched by any of this
const NONE = "ci:200";      // control: only a blank row — an ABSENCE, never a 0

const H = ["Match", "Date", "Team", "Player ID", "Full Name", "Played", "Fantasy Points",
  "Bat Order", "Match Status", "Recon Flag", "Player Recon", "L2 Recon", "Recon State",
  "Points Delta"];

// One row: [pid, name, played, pts, bat, delta]
type R = [string, string, string, string, string, string];
const M1 = "Match 1 — OIRE v OWI";
const row = (team: string, r: R, label = M1, date = "2020-07-10"): string[] =>
  [label, date, team, r[0], r[1], r[2], r[3], r[4], "COMPLETED", "", "", "", "✅ L2 recon done", r[5]];

const MAG_BOWL: R = [MAG, "Jane Maguire", "Y", "2", "8", ""];
const MAG_AR: R = [MAG, "Jane Maguire", "Y", "-1", "8", ""];
const GAR_SCORED: R = [GAR, "Ash Gardner", "Y", "181", "4", "+9"];
const GAR_SLOT: R = [GAR, "Ash Gardner", "N", "", "", "-181"];   // the phantom: no stats at all
const NEG_SCORED: R = [NEG, "Neg Player", "Y", "-3", "9", ""];
const NEG_SLOT: R = [NEG, "Neg Player", "N", "", "", ""];

// `dupFirst=false` writes each duplicate pair the other way round. Every assertion below must hold
// identically both ways: the bot rewrites the sheet in place on every run, so a number that
// depends on which row landed last is a number that can move with no data change.
function sheet(dupFirst: boolean): string[][] {
  const pair = (a: R, b: R): R[] => (dupFirst ? [a, b] : [b, a]);
  return [
    H,
    ...pair(MAG_BOWL, MAG_AR).map((r) => row("OIRE", r)),
    row("OIRE", [SOLO, "Solo Player", "Y", "55", "3", ""]),
    row("OWI", [NONE, "Blank Only", "N", "", "", ""]),
    ...pair(GAR_SCORED, GAR_SLOT).map((r) => row("OWI", r)),
    ...pair(NEG_SCORED, NEG_SLOT).map((r) => row("OWI", r)),
    // A SECOND match for the same tour — the tour total must still add ACROSS matches (46 + 2),
    // it just must not add the two rows of one match together (which read 92 on the board).
    row("OIRE", [MAG, "Jane Maguire", "Y", "46", "9", ""], "Match 2 — OIRE v OWI", "2020-07-12"),
  ];
}

const M = { team1: "OIRE", team2: "OWI", date: "2020-07-10T15:15:00+05:30", key: "M1", label: M1 };

const SETTLE_H = ["Match Key", "Tour", "Match", "Date", "Team", "Player ID", "Full Name",
  "Settled Points", "Settled Status", "Settled Source", "Frozen At", "Provenance"];
const SETTLED = [
  SETTLE_H,
  ["mk", "IRE v WI W ODI", M1, "2020-07-10", "OIRE", MAG, "Jane Maguire", "2", "COMPLETED", "cricsheet", "2020-07-11", "live"],
  ["mk", "IRE v WI W ODI", M1, "2020-07-10", "OWI", GAR, "Ash Gardner", "181", "COMPLETED", "cricsheet", "2020-07-11", "live"],
  ["mk", "IRE v WI W ODI", M1, "2020-07-10", "OWI", NEG, "Neg Player", "-3", "COMPLETED", "cricsheet", "2020-07-11", "live"],
  ["mk", "IRE v WI W ODI", M1, "2020-07-10", "OIRE", SOLO, "Solo Player", "55", "COMPLETED", "cricsheet", "2020-07-11", "live"],
];

async function main() {
  for (const dupFirst of [true, false]) {
    const order = dupFirst ? "scored row first" : "rows REVERSED";
    console.log(`\n── every path agrees on a duplicate (${order}) ──`);
    __setPointsCacheForTest(sheet(dupFirst));
    __setSettlementCacheForTest(SETTLED);

    const pts = await getMatchPointsForMatch(M);
    const tour = await getTourPoints("OIRE", "OWI");
    const xi = await getMatchXI(M);
    const audit = await auditMatch(M);
    const auditNow = (pid: string) => audit.players.find((p) => p.pid === pid)?.now ?? null;

    // 1. Two SCORED rows: the higher one wins, and it is the SAME number on all four surfaces.
    check("contest total keeps 2, not the last row's −1", pts.get(MAG) === 2);
    check("audit 'now' agrees with the contest total", auditNow(MAG) === pts.get(MAG));
    check("tour total = 2 + 46 across matches, not 2 + (−1) + 46 within one",
      tour.get(MAG) === 48);
    check("bat order comes from the row that won the points", xi.get("OIRE")?.get(MAG) === 8);

    // 2. An ABSENCE never outranks a value — in EITHER direction.
    check("blank slot row cannot erase 181", pts.get(GAR) === 181 && auditNow(GAR) === 181);
    check("blank slot row cannot erase a NEGATIVE −3 (the `?? -1` bug)",
      pts.get(NEG) === -3 && auditNow(NEG) === -3);
    check("no phantom delta / SCORER_FIX off the negative row",
      audit.players.find((p) => p.pid === NEG)?.delta === 0 &&
      audit.players.find((p) => p.pid === NEG)?.reason === "UNCHANGED");
    check("a player with only a blank row has NO points (null, never 0)",
      !pts.has(NONE) && lookupPlayerPoints(NONE, "Blank Only", undefined, pts) === null);

    // 3. A NON-duplicate is untouched by any of it.
    check("single-row player unchanged everywhere",
      pts.get(SOLO) === 55 && auditNow(SOLO) === 55 && tour.get(SOLO) === 55 &&
      xi.get("OIRE")?.get(SOLO) === 3);
    check("single-row player reports no duplicate",
      !audit.duplicates.some((d) => d.pid === SOLO));

    // 4. The duplicate is SURFACED, not silently absorbed.
    const dm = audit.duplicates.find((d) => d.pid === MAG);
    check("duplicate is reported with both candidate values",
      !!dm && dm.kept === 2 && dm.values.length === 2 &&
      dm.values.includes(2) && dm.values.includes(-1));
    check("blank-partner duplicates are reported too (3 keys)", audit.duplicates.length === 3);

    // 5. The match's net Points Delta: the phantom slot row carries the negation of its twin's
    //    score (−181) and used to be summed, reporting a revision on a match nothing happened to.
    const st = await getMatchStatusFor(M);
    check("match delta = +9, not +9 − 181", st?.delta === 9);
  }

  // 6. Order-independence, stated as one equality: the same sheet written either way round must
  //    produce byte-identical maps. This is the property that keeps a settled number from moving
  //    on a bot re-run that only reorders rows.
  console.log("\n── the reduction is order-independent ──");
  __setPointsCacheForTest(sheet(true));
  const a = JSON.stringify([...(await getMatchPointsForMatch(M))].sort());
  const aTour = JSON.stringify([...(await getTourPoints("OIRE", "OWI"))].sort());
  __setPointsCacheForTest(sheet(false));
  const b = JSON.stringify([...(await getMatchPointsForMatch(M))].sort());
  const bTour = JSON.stringify([...(await getTourPoints("OIRE", "OWI"))].sort());
  check("match points identical under either row order", a === b);
  check("tour points identical under either row order", aTour === bTour);

  __setPointsCacheForTest(null);
  __setSettlementCacheForTest(null);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
