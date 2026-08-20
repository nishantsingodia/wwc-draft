// Self-contained Dream11 fantasy-points scorer for the LIVE in-app path ONLY.
//
// Why this exists (and why it's separate): the COMPLETED pipeline is untouched — its
// numbers come from the bot's reconciled sheet. This scorer powers the *provisional*
// live H2H a friend sees while a match is in play, computed from an ESPN scorecard we
// fetch on demand. It mirrors the canonical auction scorer
// (cricket-auction-helper/src/lib/fantasy-points/{calculator,rules}.ts) so live numbers
// track the eventual final — but they can legitimately differ (dot/maiden detail lags in
// the live feed), which is expected and labelled "provisional" in the UI.
//
// ⚠ 14 Aug 2026 — THE LIVE H2H WAS SHORT BY 41.3 FP/MATCH AND THE COMMENT ABOVE SAID SO
// APPROVINGLY. Measured over 38 cached ESPN events (Hundred M 10 / Hundred W 8 / LPL 10 /
// CPL 5 / NZ-WI ODI 5), bot minus app: +1571 FP total = +41.3/match ≈ +20 per SIDE, and
// DOUBLE that on a captain. Of it, 1096 FP (70%) was the +8 lbw/bowled bowling bonus, 492 FP
// (31%) was run-out fielding, and −17 was everything else. None of it was a feed limitation:
// both sit structured and id-anchored in the SAME `summary` payload lib/espn.ts already
// downloads, under `…statistics.batting.outDetails`. They were simply never read. Two of this
// codebase's standing bug classes at once:
//   • WRITTEN BUT NEVER READ — `directRunOut: 12` was declared in all three rule tables below
//     and referenced by NOTHING (3 declarations, 0 reads), so every direct hit paid the
//     assisted rate of 6. Worth 96 FP / 15 rows on the same corpus.
//   • AN ABSENCE PRESENTING AS A VALUE — `bowlLbwBowled` and `runOuts` were hard-coded 0 in
//     lib/espn.ts, which is indistinguishable from "this bowler bowled nobody".
// `directRunOuts` is now a REQUIRED field on Perf on purpose: a caller that forgets it is a
// compile error, not a silent zero.
//
// RE-VERIFIED 16 Aug 2026 on a fresh, larger corpus — 183 ESPN summaries fetched today, 170
// scored, 85 of them diffable against the settled sheet (1874 player rows, joined on athlete id).
// The two omissions above were worth **33.5 FP/match** here (lbw/bowled 22.0 = 66%, run-outs at
// the assisted 6 9.2 = 27%, the unread direct-hit uplift 2.3 = 7%; the /match figure is corpus-
// dependent, the shares are not). Everything the two omissions do NOT explain totals
// **−0.47 FP/match** — the app now reads slightly HIGH, not short. Per bucket (sheet minus app,
// over the 85): XI 0.00, bat −0.11, SR −0.02, bowl −0.04, econ −0.02, field −0.28. 1839/1874 rows
// and 65/85 matches land EXACTLY. So there is no third omission hiding in this file, and the
// remaining live under-report was never arithmetic — it was the CONSUMER dropping a player it
// could not join by pid (lib/live-map.ts, BUGS.md §11).
//
// Format-aware (per Nishant): ODI uses ODI bands; T20 uses T20 bands; The Hundred (HUN) has
// its OWN ruleset — same core scale as T20 but NO strike-rate, NO economy and NO maiden points,
// and wicket hauls tier from a 2-for (2w+4 / 3w+8 / 4w+12 / 5w+16). Mirrors the bot's
// _score_hundred + the auction ETL's compute_fantasy_points_hundred, so the live provisional
// H2H tracks the eventual final.

export type Role = "BAT" | "BOWL" | "AR" | "WK";
export type ScoreFormat = "ODI" | "T20" | "HUN" | "TEST";

// One player's match line. Everything here IS readable live from the ESPN summary; what still
// lags is the exactness of `bowlDots`/`bowlMaidens` (ESPN's own per-bowler counters, which the
// bot recomputes from the ball-by-ball) — see lib/espn.ts LIVE_PROVISIONAL_GAP.
export type Perf = {
  played: boolean;
  batRuns: number;
  batBalls: number;
  bat4s: number;
  bat6s: number;
  batDismissed: boolean;
  bowlBalls: number;
  bowlRuns: number;
  bowlWickets: number;
  bowlDots: number;
  bowlMaidens: number;
  bowlLbwBowled: number; // wickets via lbw/bowled (+8 each) — outDetails.dismissalCard + bowler.id
  catches: number;
  stumpings: number;
  runOuts: number; // TOTAL run-out credits (direct + assisted) — outDetails.fielders[]
  directRunOuts: number; // …of which unassisted (fielders[].length === 1). Paid 12; the rest 6.
  // RED BALL ONLY. One entry per innings this player appeared in, because Dream11's Test milestone
  // and wicket-haul tiers are evaluated INSIDE an innings — see scoreTest. Absent/undefined for
  // every white-ball format, where a player bats once and the match line IS the innings line.
  innings?: Perf[];
};

const T20 = {
  bat: { perRun: 1, four: 4, six: 6, b25: 4, b50: 8, b75: 12, b100: 16, duck: -2 },
  bowl: { perWkt: 30, lbwBowled: 8, dot: 1, maiden: 12, h3: 4, h4: 8, h5: 12 },
  field: { catch: 8, catch3: 4, stumping: 12, directRunOut: 12, runOut: 6 },
  sr: { minBalls: 10, a170: 6, a150: 4, a130: 2, b60_70: -2, b50_60: -4, below50: -6 },
  econ: { minBalls: 12, b5: 6, b5_6: 4, b6_7: 2, b10_11: -2, b11_12: -4, a12: -6 },
  xi: 4,
} as const;

const ODI = {
  bat: { perRun: 1, four: 4, six: 6, b25: 4, b50: 8, b75: 12, b100: 16, duck: -3 },
  bowl: { perWkt: 30, lbwBowled: 8, dotGroup: 3, dotPts: 1, maiden: 4, h4: 4, h5: 8, h6: 12 },
  field: { catch: 8, catch3: 4, stumping: 12, directRunOut: 12, runOut: 6 },
  sr: { minBalls: 20, a140: 6, a120: 4, a100: 2, b40_50: -2, b30_40: -4, below30: -6 },
  econ: { minBalls: 30, b2_5: 6, b2_5_3_5: 4, b3_5_4_5: 2, b7_8: -2, b8_9: -4, a9: -6 },
  xi: 4,
} as const;

// TEST (red ball). Mirror of the bot's R_TEST and the auction ETL's compute_fantasy_points_test,
// confirmed against the live Dream11 Test page: NO strike-rate, NO economy, NO maiden, NO dot-ball
// and NO 3-catch award, so it is a pure per-event scorer. Wicket is +20 — LOWER than T20's 25 and
// ODI's 30, because a Test yields ~20 wickets — while batting milestones run two tiers deeper.
// Duck is -4 and the page names the roles explicitly: Batter, Wicket-Keeper, All-Rounder.
const TEST = {
  bat: { perRun: 1, four: 4, six: 6, b25: 4, b50: 8, b75: 12, b100: 16, b125: 20, b150: 24, duck: -4 },
  bowl: { perWkt: 20, lbwBowled: 8, h4: 4, h5: 8, h6: 12 },
  // No catch3: Test awards no 3-catch bonus, which is what lets fielding be read off the match line.
  field: { catch: 8, catch3: 0, stumping: 12, directRunOut: 12, runOut: 6 },
  xi: 4,
} as const;

// The Hundred: same core scale as T20 but NO strike-rate, NO economy, NO maiden; wicket hauls
// tier from a 2-for. (Mirror of the bot's R_HUN.)
const HUN = {
  bat: { perRun: 1, four: 4, six: 6, b25: 4, b50: 8, b75: 12, b100: 16, duck: -2 },
  bowl: { perWkt: 30, lbwBowled: 8, dot: 1, h2: 4, h3: 8, h4: 12, h5: 16 },
  field: { catch: 8, catch3: 4, stumping: 12, directRunOut: 12, runOut: 6 },
  xi: 4,
} as const;

// Structural, not `typeof T20.field`: that pins catch3 to the literal 4, and Test awards NO 3-catch
// bonus (catch3: 0). Widening the parameter is the honest fix — the alternative is giving Test a
// fake 4 and gating it at the call site, i.e. hiding a rule difference inside a type.
type FieldRules = {
  readonly catch: number;
  readonly catch3: number;
  readonly stumping: number;
  readonly directRunOut: number;
  readonly runOut: number;
};

function fielding(p: Perf, f: FieldRules): number {
  let x = p.catches * f.catch;
  if (p.catches >= 3) x += f.catch3;
  x += p.stumpings * f.stumping;
  // Direct hits pay 12, assisted 6 — the exact mirror of the bot's settling line
  //   field += p["dro"]*R["dro"] + (p["runouts"] - p["dro"])*R["ro"]
  // (wc_fps_to_csv.py:1592, and :1625/:1669 for the other two rulesets — re-verified 16 Aug 2026;
  // the old ":1551" anchor had drifted. Check the anchor, don't trust it.)
  // ESPN lists every fielder involved, so `directRunOuts` is "fielders[].length === 1" and can
  // never exceed `runOuts` — they are counted in the SAME pass (lib/espn.ts
  // collectDismissalCredits). Deliberately no clamp: if that invariant ever broke, a negative
  // assisted term is a visible wrong number, and this file's history is of silent zeros.
  x += p.directRunOuts * f.directRunOut + (p.runOuts - p.directRunOuts) * f.runOut;
  return x;
}

function scoreT20(p: Perf, role: Role): number {
  const r = T20;
  let pts = p.played ? r.xi : 0;

  if (p.batBalls > 0 || p.batRuns > 0) {
    pts += p.batRuns * r.bat.perRun + p.bat4s * r.bat.four + p.bat6s * r.bat.six;
    if (p.batRuns >= 100) pts += r.bat.b100;
    else if (p.batRuns >= 75) pts += r.bat.b75;
    else if (p.batRuns >= 50) pts += r.bat.b50;
    else if (p.batRuns >= 25) pts += r.bat.b25;
    if (p.batBalls >= r.sr.minBalls && role !== "BOWL") {
      const sr = (p.batRuns / p.batBalls) * 100;
      if (sr > 170) pts += r.sr.a170;
      else if (sr > 150) pts += r.sr.a150;
      else if (sr >= 130) pts += r.sr.a130;
      else if (sr >= 60 && sr <= 70) pts += r.sr.b60_70;
      else if (sr >= 50 && sr < 60) pts += r.sr.b50_60;
      else if (sr < 50) pts += r.sr.below50;
    }
  }
  if (p.batDismissed && p.batRuns === 0 && role !== "BOWL") pts += r.bat.duck;

  if (p.bowlBalls > 0) {
    pts += p.bowlWickets * r.bowl.perWkt + p.bowlLbwBowled * r.bowl.lbwBowled;
    pts += p.bowlDots * r.bowl.dot + p.bowlMaidens * r.bowl.maiden;
    if (p.bowlWickets >= 5) pts += r.bowl.h5;
    else if (p.bowlWickets >= 4) pts += r.bowl.h4;
    else if (p.bowlWickets >= 3) pts += r.bowl.h3;
    if (p.bowlBalls >= r.econ.minBalls) {
      const econ = p.bowlRuns / (p.bowlBalls / 6);
      if (econ < 5) pts += r.econ.b5;
      else if (econ < 6) pts += r.econ.b5_6;
      else if (econ <= 7) pts += r.econ.b6_7;
      else if (econ >= 10 && econ <= 11) pts += r.econ.b10_11;
      else if (econ > 11 && econ <= 12) pts += r.econ.b11_12;
      else if (econ > 12) pts += r.econ.a12;
    }
  }

  return pts + fielding(p, r.field);
}

function scoreOdi(p: Perf, role: Role): number {
  const r = ODI;
  let pts = p.played ? r.xi : 0;

  if (p.batBalls > 0 || p.batRuns > 0) {
    pts += p.batRuns * r.bat.perRun + p.bat4s * r.bat.four + p.bat6s * r.bat.six;
    if (p.batRuns >= 100) pts += r.bat.b100;
    else if (p.batRuns >= 75) pts += r.bat.b75;
    else if (p.batRuns >= 50) pts += r.bat.b50;
    else if (p.batRuns >= 25) pts += r.bat.b25;
    if (p.batBalls >= r.sr.minBalls && role !== "BOWL") {
      const sr = (p.batRuns / p.batBalls) * 100;
      if (sr > 140) pts += r.sr.a140;
      else if (sr > 120) pts += r.sr.a120;
      else if (sr >= 100) pts += r.sr.a100;
      else if (sr >= 40 && sr <= 50) pts += r.sr.b40_50;
      else if (sr >= 30 && sr < 40) pts += r.sr.b30_40;
      else if (sr < 30) pts += r.sr.below30;
    }
  }
  if (p.batDismissed && p.batRuns === 0 && role !== "BOWL") pts += r.bat.duck;

  if (p.bowlBalls > 0) {
    pts += p.bowlWickets * r.bowl.perWkt + p.bowlLbwBowled * r.bowl.lbwBowled;
    pts += Math.floor(p.bowlDots / r.bowl.dotGroup) * r.bowl.dotPts + p.bowlMaidens * r.bowl.maiden;
    if (p.bowlWickets >= 6) pts += r.bowl.h6;
    else if (p.bowlWickets >= 5) pts += r.bowl.h5;
    else if (p.bowlWickets >= 4) pts += r.bowl.h4;
    if (p.bowlBalls >= r.econ.minBalls) {
      const econ = p.bowlRuns / (p.bowlBalls / 6);
      if (econ < 2.5) pts += r.econ.b2_5;
      else if (econ < 3.5) pts += r.econ.b2_5_3_5;
      else if (econ <= 4.5) pts += r.econ.b3_5_4_5;
      else if (econ >= 7 && econ <= 8) pts += r.econ.b7_8;
      else if (econ > 8 && econ <= 9) pts += r.econ.b8_9;
      else if (econ > 9) pts += r.econ.a9;
    }
  }

  return pts + fielding(p, r.field);
}

function scoreHundred(p: Perf, role: Role): number {
  const r = HUN;
  let pts = p.played ? r.xi : 0;

  if (p.batBalls > 0 || p.batRuns > 0) {
    pts += p.batRuns * r.bat.perRun + p.bat4s * r.bat.four + p.bat6s * r.bat.six;
    if (p.batRuns >= 100) pts += r.bat.b100;
    else if (p.batRuns >= 75) pts += r.bat.b75;
    else if (p.batRuns >= 50) pts += r.bat.b50;
    else if (p.batRuns >= 25) pts += r.bat.b25;
    // No strike-rate points in The Hundred.
  }
  if (p.batDismissed && p.batRuns === 0 && role !== "BOWL") pts += r.bat.duck;

  if (p.bowlBalls > 0) {
    pts += p.bowlWickets * r.bowl.perWkt + p.bowlLbwBowled * r.bowl.lbwBowled;
    pts += p.bowlDots * r.bowl.dot;
    if (p.bowlWickets >= 5) pts += r.bowl.h5;
    else if (p.bowlWickets >= 4) pts += r.bowl.h4;
    else if (p.bowlWickets >= 3) pts += r.bowl.h3;
    else if (p.bowlWickets >= 2) pts += r.bowl.h2;
    // No maiden, no economy points in The Hundred.
  }

  return pts + fielding(p, r.field);
}

// One INNINGS of a Test. Excludes the +4 announced-XI award, which is per match, and excludes
// fielding — see scoreTest for why both are added once at match level.
function scoreTestInnings(p: Perf, role: Role): number {
  const r = TEST;
  let pts = 0;
  if (p.batBalls > 0 || p.batRuns > 0) {
    pts += p.batRuns * r.bat.perRun + p.bat4s * r.bat.four + p.bat6s * r.bat.six;
    // HIGHEST TIER ONLY: "Any player scoring 150 Runs will only get points for that."
    if (p.batRuns >= 150) pts += r.bat.b150;
    else if (p.batRuns >= 125) pts += r.bat.b125;
    else if (p.batRuns >= 100) pts += r.bat.b100;
    else if (p.batRuns >= 75) pts += r.bat.b75;
    else if (p.batRuns >= 50) pts += r.bat.b50;
    else if (p.batRuns >= 25) pts += r.bat.b25;
  }
  // Outside the runs/balls gate so a 0-off-0 run-out still takes the duck.
  if (p.batDismissed && p.batRuns === 0 && (role === "BAT" || role === "WK" || role === "AR")) {
    pts += r.bat.duck;
  }
  if (p.bowlBalls > 0 || p.bowlWickets > 0) {
    // lbwBowled is deliberately NOT here: it is a flat +8 per wicket with no tier, so it is added
    // ONCE at match level in scoreTest — exactly like fielding. ESPN reports the credit per
    // dismissal rather than per innings, so there is no per-innings figure to read, and counting
    // the match total inside each innings would multiply it by the number of innings.
    pts += p.bowlWickets * r.bowl.perWkt;
    if (p.bowlWickets >= 6) pts += r.bowl.h6;
    else if (p.bowlWickets >= 5) pts += r.bowl.h5;
    else if (p.bowlWickets >= 4) pts += r.bowl.h4;
    // No dot, no maiden, no economy in Test.
  }
  return pts;
}

/**
 * TEST: sum the PER-INNINGS scores, then add the untiered parts once.
 *
 * Scoring off the match aggregate is a different, wrong number, because the milestone and haul tiers
 * live inside an innings: 40 and 40 is two 25-bonuses (+8), not a 75-bonus (+12); 3-for + 3-for earns
 * no haul where an aggregate 6-for earns +12; and a first-innings duck survives instead of being
 * forgiven by a second-innings score.
 *
 * Fielding and the XI bonus are added ONCE from the match line: Test has no 3-catch bonus, so
 * fielding is untiered and identical read either way, and ESPN reports catches/run-outs per
 * dismissal rather than per innings.
 *
 * FALLBACK: with no `innings` array this scores the match line as a single innings — exact for a
 * one-innings appearance, and wrong only in tier distribution. lib/espn.ts marks such a match
 * provisional rather than letting it pass as reconciled.
 */
function scoreTest(p: Perf, role: Role): number {
  const inns = p.innings && p.innings.length ? p.innings : [p];
  let pts = inns.reduce((s, ip) => s + scoreTestInnings(ip, role), 0);
  // Untiered, so read once off the match line: the +4 XI award, the lbw/bowled bonus, and fielding.
  if (p.played) pts += TEST.xi;
  pts += p.bowlLbwBowled * TEST.bowl.lbwBowled;
  return pts + fielding(p, TEST.field);
}

// D11 fantasy points for one player line. Rounds to 1dp (the sheet stores whole/1dp).
export function scoreD11(perf: Perf, role: Role, format: ScoreFormat): number {
  const raw =
    format === "ODI"
      ? scoreOdi(perf, role)
      : format === "HUN"
        ? scoreHundred(perf, role)
        : format === "TEST"
          ? scoreTest(perf, role)
          : scoreT20(perf, role);
  return Math.round(raw * 10) / 10;
}
