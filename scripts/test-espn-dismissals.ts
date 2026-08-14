#!/usr/bin/env npx tsx
/**
 * Unit tests for the LIVE scorer's dismissal credits — lib/espn.ts collectDismissalCredits +
 * liveScoreFromSummary.
 *
 * WHY THIS FILE EXISTS. Until 14 Aug 2026 lib/espn.ts hard-coded `bowlLbwBowled: 0` and
 * `runOuts: 0`, and lib/d11-score.ts declared `directRunOut: 12` in all three rule tables while
 * reading it nowhere. The live H2H a friend watches was therefore short by ~35 FP/match —
 * measured bot-minus-app over 99 cached ESPN events / 2236 rows: +3472 FP, of which lbw/bowled
 * +2424 (69.8%), run-outs at the assisted rate +876 (25.2%) and the unread direct-hit uplift
 * +228 (6.6%). ~20 FP per side, doubled on a captain.
 *
 * It was invisible for weeks because NOTHING could exercise the scorer without the network.
 * That is what these fixtures fix: the payload shapes below are trimmed verbatim from real
 * cached `summary` responses (CPL ev1534179, ev1534184; Hundred W ev1521201).
 *
 *   npx tsx scripts/test-espn-dismissals.ts
 */
import { collectDismissalCredits, liveScoreFromSummary } from "../lib/espn";
import type { Match } from "../lib/matches";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${extra}`}`);
}

// ── payload builders in ESPN's real shape ────────────────────────────────────────────────
// A batter's own scorecard line lives at
//   rosters[].roster[].linescores[].statistics.batting.outDetails
// and the per-player counters at
//   rosters[].roster[].linescores[].linescores[].statistics.categories[].stats[]
type Out = { card: string; bowlerId?: string; fielderIds?: string[] };
function player(
  id: string,
  name: string,
  opts: { stats?: Record<string, number>; out?: Out; period?: number; starter?: boolean } = {}
) {
  const period = opts.period ?? 2;
  const batting: Record<string, unknown> = { order: 1 };
  if (opts.out) {
    batting.outDetails = {
      dismissalCard: opts.out.card,
      ...(opts.out.bowlerId ? { bowler: { id: opts.out.bowlerId } } : {}),
      fielders: (opts.out.fielderIds ?? []).map((f) => ({ athlete: { id: f } })),
    };
  }
  return {
    starter: opts.starter ?? true,
    athlete: { id, displayName: name, fullName: name },
    position: { abbreviation: "BAT" },
    linescores: [
      {
        period,
        statistics: opts.out ? { batting } : {},
        linescores: [
          {
            statistics: {
              categories: [
                {
                  name: "general",
                  stats: Object.entries(opts.stats ?? {}).map(([k, v]) => ({ name: k, value: v })),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
const summaryOf = (players: unknown[]) => ({
  rosters: [{ team: { displayName: "Jamaica Kingsmen" }, roster: players }],
});

const MATCH = {
  key: "T", matchNum: 1, gender: "M", team1: "MTJAM", team2: "MTGUY",
  label: "t", date: "2026-08-14T19:00:00+05:30", deadlineTs: 0, format: "T20",
} as Match;

// ── 1. the +8 lbw/bowled bonus is a fact about the BOWLER, read off the batter's line ─────
console.log("lbw / bowled → the bowler's +8:");
{
  // CPL ev1534184, verbatim: Keacy Carty " b Joseph" and Vitel Lawes " b Joseph" — two for
  // Shamar Joseph, whose live total read 78.0 and settles at 94.0 (+16).
  const c = collectDismissalCredits(
    summaryOf([
      player("1", "Keacy Carty", { out: { card: "bowled", bowlerId: "99" } }),
      player("2", "Vitel Lawes", { out: { card: "bowled", bowlerId: "99" } }),
      player("3", "Hunain Shah", { out: { card: "bowled", bowlerId: "77" } }),
      player("4", "Rovman Powell", { out: { card: "lbw", bowlerId: "99" } }),
    ])
  );
  check("two bowleds + one lbw all land on the same bowler", c.get("99")?.lbwBowled === 3);
  check("a different bowler keeps his own single credit", c.get("77")?.lbwBowled === 1);
  check("no run-out credit leaks from a bowling dismissal", (c.get("99")?.runOuts ?? 0) === 0);
}
{
  // ESPN's SCORECARD vocabulary is "c"/"st", not playbyplay's "caught"/"stumped". Measured over
  // 139 cached summaries: c 836 / not out 350 / bowled 240 / run out 99 / lbw 84 / st 39 /
  // retired out 4 / retired not out 4. A caught dismissal must never pay the lbw/bowled bonus —
  // that would be +8 on 836 of 1656 dismissals.
  const c = collectDismissalCredits(
    summaryOf([
      player("1", "Reeza Hendricks", { out: { card: "c", bowlerId: "99", fielderIds: ["55"] } }),
      player("2", "Kirk McKenzie", { out: { card: "st", bowlerId: "99", fielderIds: ["55"] } }),
      player("3", "Jediah Blades", { out: { card: "not out" } }),
      player("4", "A Retiree", { out: { card: "retired out" } }),
    ])
  );
  check("caught pays the bowler NO lbw/bowled bonus", (c.get("99")?.lbwBowled ?? 0) === 0);
  check("caught/stumped add no run-out credit (counters do that)", c.size === 0);
}
{
  // An ABSENCE must not present as a VALUE: a dismissal with no bowler id must credit nobody —
  // least of all a phantom player keyed on the empty string.
  const c = collectDismissalCredits(summaryOf([player("1", "X", { out: { card: "bowled" } })]));
  check("no bowler id → no credit at all, and no '' key", c.size === 0 && !c.has(""));
}
{
  // "leg before wicket" is the playbyplay spelling; accepted defensively so a vocabulary change
  // would not silently drop 8 points a wicket.
  const c = collectDismissalCredits(
    summaryOf([player("1", "X", { out: { card: "Leg Before Wicket", bowlerId: "99" } })])
  );
  check("'leg before wicket' also counts (case-insensitive)", c.get("99")?.lbwBowled === 1);
}

// ── 2. run-outs: every listed fielder is credited; a lone fielder gets the direct-hit rate ───
console.log("\nrun-outs → direct 12 / assisted 6:");
{
  // CPL ev1534179 verbatim: "run out (Joseph)" — one fielder, athlete id 670031.
  const c = collectDismissalCredits(
    summaryOf([player("1", "X", { out: { card: "run out", fielderIds: ["670031"] } })])
  );
  check("lone fielder → 1 run-out AND 1 direct", c.get("670031")?.runOuts === 1 && c.get("670031")?.directRunOuts === 1);
}
{
  const c = collectDismissalCredits(
    summaryOf([player("1", "X", { out: { card: "run out", fielderIds: ["10", "20"] } })])
  );
  check("two fielders → both credited, NEITHER direct", c.get("10")?.runOuts === 1 && c.get("20")?.runOuts === 1 && c.get("10")?.directRunOuts === 0 && c.get("20")?.directRunOuts === 0);
}
{
  // Hundred W ev1521201: Lizelle Lee finished with two direct hits and nothing with bat or ball.
  const c = collectDismissalCredits(
    summaryOf([
      player("1", "A", { out: { card: "run out", fielderIds: ["500"] } }),
      player("2", "B", { out: { card: "run out", fielderIds: ["500"] } }),
    ])
  );
  check("two direct hits by one fielder accumulate", c.get("500")?.runOuts === 2 && c.get("500")?.directRunOuts === 2);
}
{
  const c = collectDismissalCredits(
    summaryOf([player("1", "X", { out: { card: "run out", fielderIds: [] } })])
  );
  check("run out with no named fielder credits nobody", c.size === 0);
}
{
  // A super over is period 3+ and Dream11 awards no points for it.
  const c = collectDismissalCredits(
    summaryOf([player("1", "X", { period: 3, out: { card: "bowled", bowlerId: "99" } })])
  );
  check("super-over (period 3) dismissal is not credited", c.size === 0);
}

// ── 3. end-to-end through the real scorer ────────────────────────────────────────────────
console.log("\nend-to-end (liveScoreFromSummary, T20):");
{
  // Shamar Joseph's shape from CPL ev1534184: 24 balls, 30 conceded, 3 wickets, 6 dots, two of
  // the three bowled. Before the fix this line scored 78.0; it settles at 94.0.
  const bowler = player("99", "Shamar Joseph", {
    stats: { balls: 24, conceded: 30, wickets: 3, dots: 6, ballsFaced: 0, runs: 0 },
  });
  const withOuts = summaryOf([
    bowler,
    player("1", "Keacy Carty", { out: { card: "bowled", bowlerId: "99" } }),
    player("2", "Vitel Lawes", { out: { card: "bowled", bowlerId: "99" } }),
  ]);
  const noOuts = summaryOf([
    bowler,
    player("1", "Keacy Carty", { out: { card: "c", bowlerId: "99", fielderIds: ["7"] } }),
    player("2", "Vitel Lawes", { out: { card: "c", bowlerId: "99", fielderIds: ["7"] } }),
  ]);
  const a = liveScoreFromSummary(withOuts, MATCH)?.points.get("espn:99");
  const b = liveScoreFromSummary(noOuts, MATCH)?.points.get("espn:99");
  check("two bowleds are worth exactly +16 to the bowler", a !== undefined && b !== undefined && a - b === 16, `${b} → ${a}`);
}
{
  // A fielder who does nothing but effect one direct-hit run-out: XI 4 + 12 = 16, not 4 + 6.
  const s = summaryOf([
    player("500", "Rivaldo Clarke", { stats: { ballsFaced: 0, runs: 0 } }),
    player("1", "X", { out: { card: "run out", fielderIds: ["500"] } }),
  ]);
  check("direct hit alone = 4 (XI) + 12", liveScoreFromSummary(s, MATCH)?.points.get("espn:500") === 16);
}
{
  const s = summaryOf([
    player("500", "A", { stats: { ballsFaced: 0, runs: 0 } }),
    player("501", "B", { stats: { ballsFaced: 0, runs: 0 } }),
    player("1", "X", { out: { card: "run out", fielderIds: ["500", "501"] } }),
  ]);
  const live = liveScoreFromSummary(s, MATCH);
  check("assisted run-out pays 6 to each of the two", live?.points.get("espn:500") === 10 && live?.points.get("espn:501") === 10);
}
{
  // anyStats gates whether the route uses the live map at all. A match whose only event so far
  // is a run-out has certainly begun.
  const s = summaryOf([
    player("500", "A", { stats: { ballsFaced: 0, runs: 0 } }),
    player("1", "X", { out: { card: "run out", fielderIds: ["500"] } }),
  ]);
  check("a run-out alone counts as play having begun", liveScoreFromSummary(s, MATCH)?.anyStats === true);
}
{
  // The credit belongs to the fielder, NOT to the dismissed batter — the trap in the
  // ball-by-ball, where a run-out is attached to whoever was on strike.
  const s = summaryOf([
    player("500", "Fielder", { stats: { ballsFaced: 0, runs: 0 } }),
    player("1", "Victim", { stats: { ballsFaced: 10, runs: 12, outs: 1 }, out: { card: "run out", fielderIds: ["500"] } }),
  ]);
  const live = liveScoreFromSummary(s, MATCH);
  check("the victim gets no run-out points", live?.points.get("espn:1") === 12 + 4);
  check("the fielder does", live?.points.get("espn:500") === 16);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
