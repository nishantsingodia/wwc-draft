// Self-contained Dream11 fantasy-points scorer for the LIVE in-app path ONLY.
//
// Why this exists (and why it's separate): the COMPLETED pipeline is untouched — its
// numbers come from the bot's reconciled sheet. This scorer powers the *provisional*
// live H2H a friend sees while a match is in play, computed from an ESPN scorecard we
// fetch on demand. It mirrors the canonical auction scorer
// (cricket-auction-helper/src/lib/fantasy-points/{calculator,rules}.ts) so live numbers
// track the eventual final — but they can legitimately differ (fielding/dot/lbw detail
// lags in the live feed), which is expected and labelled "provisional" in the UI.
//
// Format-aware (per Nishant): ODI uses ODI bands; T20 AND The Hundred use the T20
// ruleset — the SAME mapping the bot/auction use (scoringFormatOf maps everything
// non-ODI → T20), so live and final stay methodologically consistent.

export type Role = "BAT" | "BOWL" | "AR" | "WK";
export type ScoreFormat = "ODI" | "T20";

// One player's match line. Fields we can't read live (lbw/bowled split, run-outs) are
// simply 0 → their bonus is omitted live and trues up when the bot finalizes.
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
  bowlLbwBowled: number; // wickets via lbw/bowled — 0 from the live feed (not exposed per-bowler)
  catches: number;
  stumpings: number;
  runOuts: number; // total run-outs credited (live feed rarely attributes these → usually 0)
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

function fielding(p: Perf, f: typeof T20.field): number {
  let x = p.catches * f.catch;
  if (p.catches >= 3) x += f.catch3;
  x += p.stumpings * f.stumping;
  // Live feed doesn't split direct vs assisted run-outs → credit the assisted rate (safe).
  x += p.runOuts * f.runOut;
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

// D11 fantasy points for one player line. Rounds to 1dp (the sheet stores whole/1dp).
export function scoreD11(perf: Perf, role: Role, format: ScoreFormat): number {
  const raw = format === "ODI" ? scoreOdi(perf, role) : scoreT20(perf, role);
  return Math.round(raw * 10) / 10;
}
