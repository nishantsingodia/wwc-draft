/**
 * computePayout — the winnings multipliers on a finished contest.
 *
 * These are money rules, so the edges matter more than the happy path: they are strictly
 * greater (a dead-exact 2.000× pays nothing), they do NOT compound (an underdog above 2× takes
 * 2×, never 3×), and they must stay silent in manual mode, where `draft_order` is a shuffle of
 * whoever was seated rather than a toss result — every manual row in prod reads `["nishant"]`,
 * so reading it as "picked first" would invent a coin toss that never happened.
 */
import { computePayout, firstPickOf, formatRatio, payoutCopy } from "@/lib/payout";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
};

// nishant picked FIRST in every `live` fixture below unless stated otherwise.
const order = JSON.stringify(["nishant", "pushap"]);
const live = (a: number | null, b: number | null) =>
  computePayout({
    mode: "live" as const,
    draftOrder: order,
    totals: [
      { user: "nishant", pts: a },
      { user: "pushap", pts: b },
    ],
  });

console.log("\ncomputePayout — thresholds");
check("2.22× pays double", live(186.5, 84).multiplier === 2);
check("1.72× from FIRST pick pays nothing", live(158, 92).multiplier === 1);
check("1.72× from SECOND pick pays 1.5×", live(92, 158).multiplier === 1.5);
check("a plain win pays nothing", live(120, 100).multiplier === 1);

console.log("\ncomputePayout — strictly greater, both lines");
check("exactly 2.000× does NOT double", live(200, 100).multiplier === 1);
check("a hair over 2× doubles", live(200.1, 100).multiplier === 2);
check("exactly 1.600× from 2nd pick pays nothing", live(100, 160).multiplier === 1);
check("a hair over 1.6× from 2nd pick pays 1.5×", live(100, 160.1).multiplier === 1.5);

console.log("\ncomputePayout — the rules do not compound");
const stacked = live(84, 210); // pushap picked 2nd AND scored 2.5×
check("underdog at 2.5× is over BOTH lines", stacked.ratio! > 2 && stacked.fromSecondPick);
check("...and still takes 2×, not 3×", stacked.multiplier === 2);

console.log("\ncomputePayout — degenerate scores");
check("a tie pays nothing", live(100, 100).multiplier === 1);
check("a tie names no winner", live(100, 100).winner === null);
check("opponent on 0 doubles", live(120, 0).multiplier === 2);
check("opponent on 0 gives an infinite ratio", live(120, 0).ratio === Infinity);
check("an unscored side can't compete", live(120, null).multiplier === 1);
check("both unscored pays nothing", live(null, null).multiplier === 1);
check("negative opponent doubles rather than flipping sign", live(50, -10).multiplier === 2);

console.log("\nfirstPickOf — a shuffle is not a toss");
check("live 2-name order names the first picker", firstPickOf({ mode: "live", draftOrder: order }) === "nishant");
check("live order given as an array works too", firstPickOf({ mode: "live", draftOrder: ["pushap", "nishant"] }) === "pushap");
check("MANUAL mode never names one", firstPickOf({ mode: "manual", draftOrder: order }) === null);
check(
  "the real manual shape — one shuffled name — names none",
  firstPickOf({ mode: "manual", draftOrder: '["nishant"]' }) === null
);
check("a solo live order names none", firstPickOf({ mode: "live", draftOrder: '["nishant"]' }) === null);
check("null order names none", firstPickOf({ mode: "live", draftOrder: null }) === null);
check("unparsable order names none", firstPickOf({ mode: "live", draftOrder: "{oops" }) === null);

console.log("\nmanual contests: 2× still applies, 1.5× cannot");
const manual = (a: number, b: number) =>
  computePayout({
    mode: "manual" as const,
    draftOrder: '["nishant"]',
    totals: [
      { user: "nishant", pts: a },
      { user: "pushap", pts: b },
    ],
  });
check("manual 2.2× still doubles", manual(186.5, 84).multiplier === 2);
check("manual 1.72× pays nothing (no toss to lose)", manual(92, 158).multiplier === 1);
check("manual never claims a first pick", manual(186.5, 84).firstPick === null);

console.log("\nthree drafters: the opponent is the runner-up");
const trio = computePayout({
  mode: "live",
  draftOrder: JSON.stringify(["pushap", "nishant", "arif"]),
  totals: [
    { user: "nishant", pts: 210 },
    { user: "pushap", pts: 100 },
    { user: "arif", pts: 40 },
  ],
});
check("winner is the top score", trio.winner === "nishant");
check("runner-up is 2nd, not last", trio.runnerUp === "pushap");
check("ratio is against the runner-up (2.1×), so it doubles", trio.multiplier === 2);

console.log("\nformatRatio — never show a bare threshold it didn't clear");
check("ordinary ratio shows 2dp", formatRatio(2.2234) === "2.22×");
check("2.001 would round ONTO the line, so it shows 3dp", formatRatio(2.001) === "2.001×");
check("1.599 would round onto the underdog line, so it shows 3dp", formatRatio(1.599) === "1.599×");
check("a dead-exact 2 shows 2dp (nothing to disambiguate)", formatRatio(2) === "2.00×");
check("infinite ratio has no number to show", formatRatio(Infinity) === "∞");

console.log("\npayoutCopy — states the fact from the viewer's side");
const won = payoutCopy(live(186.5, 84), "nishant");
check("your own double reads as yours", won?.title === "Double winnings");
check("...and quotes the ratio", won?.detail === "You scored 2.22× Pushap");
const lost = payoutCopy(live(84, 186.5), "nishant");
check("the opponent's double NAMES them", lost?.title === "Double winnings — Pushap");
check("...and still notes they came from 2nd pick", lost?.detail === "Pushap picked 2nd and scored 2.22× you");
const under = payoutCopy(live(92, 158), "nishant");
check("the opponent's underdog bonus names them too", under?.title === "Underdog bonus — Pushap");
check("...with the 1.6-band ratio", under?.detail === "Pushap picked 2nd and scored 1.72× you");
check("a zeroed opponent gets a sentence, not a ratio", payoutCopy(live(120, 0), "nishant")?.detail === "You won it with Pushap on 0");
check("1× has nothing to say", payoutCopy(live(120, 100), "nishant") === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
