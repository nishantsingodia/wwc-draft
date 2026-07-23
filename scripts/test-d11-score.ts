#!/usr/bin/env npx tsx
/**
 * Unit tests for lib/d11-score.ts — the in-app LIVE provisional scorer. Focus: The Hundred
 * (HUN) ruleset must match the bot's _score_hundred / the auction ETL's
 * compute_fantasy_points_hundred (NO strike-rate, NO economy, NO maiden; hauls tier from a
 * 2-for), so the live H2H tracks the eventual final.
 *
 *   npx tsx scripts/test-d11-score.ts
 */
import { scoreD11, type Perf, type Role } from "../lib/d11-score";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
}

function perf(over: Partial<Perf>): Perf {
  return {
    played: true,
    batRuns: 0, batBalls: 0, bat4s: 0, bat6s: 0, batDismissed: false,
    bowlBalls: 0, bowlRuns: 0, bowlWickets: 0, bowlDots: 0, bowlMaidens: 0, bowlLbwBowled: 0,
    catches: 0, stumpings: 0, runOuts: 0,
    ...over,
  };
}

console.log("The Hundred (HUN) scorer:");

// 60 off 20 balls (SR 300): T20 would add +6 SR; The Hundred adds none. bat 60 + 50-milestone 8 + XI 4.
check("no strike-rate bonus", scoreD11(perf({ batRuns: 60, batBalls: 20 }), "BAT", "HUN") === 72);
// Same line under T20 DOES get +6 SR (guards that HUN actually diverges).
check("T20 same line gets +6 SR (divergence)", scoreD11(perf({ batRuns: 60, batBalls: 20 }), "BAT", "T20") === 78);

// Miserly bowler: 20 balls / 5 runs (econ 1.5) / 1 maiden / 15 dots / 1 wkt.
// HUN: 30 (wkt) + 15 (dots) + XI 4 = 49 ; NO econ, NO maiden.
check("no economy / no maiden", scoreD11(perf({ bowlWickets: 1, bowlBalls: 20, bowlRuns: 5, bowlMaidens: 1, bowlDots: 15 }), "BOWL", "HUN") === 49);

// Wicket-haul tiers (dots=0 isolates the haul): 2w+4 / 3w+8 / 4w+12 / 5w+16 (6w caps at 16).
const haul = (w: number) => scoreD11(perf({ bowlWickets: w, bowlBalls: 20, bowlRuns: 40 }), "BOWL", "HUN") - 4; // minus XI
check("haul 1w = +0", haul(1) === 1 * 30 + 0);
check("haul 2w = +4", haul(2) === 2 * 30 + 4);
check("haul 3w = +8", haul(3) === 3 * 30 + 8);
check("haul 4w = +12", haul(4) === 4 * 30 + 12);
check("haul 5w = +16", haul(5) === 5 * 30 + 16);
check("haul 6w caps at +16", haul(6) === 6 * 30 + 16);

// Bowling gate needs balls>0 (why the bot's ESPN balls-backfill is required): 4-fer, balls=0 -> 0 bowling.
check("no balls -> bowling scores 0 (only XI)", scoreD11(perf({ bowlWickets: 4, bowlDots: 9, bowlRuns: 25, bowlBalls: 0 }), "BOWL", "HUN") === 4);

// Gleeson (Hundred Men M1): 4 wkts / 9 dots / 25 in ~20 balls -> 120 + 9 + 12 (4-wkt haul) + XI 4 = 145.
check("Gleeson real case = 145", scoreD11(perf({ bowlWickets: 4, bowlDots: 9, bowlRuns: 25, bowlBalls: 20 }), "BOWL", "HUN") === 145);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
