/**
 * Settlement-audit regressions — the 29 Jul 2026 LPL/Hundred post-mortem, app side.
 *
 * The headline case: LPL Match 6 (DS v KR, 21 Jul). Every field cricsheet compared agreed, so the
 * bot published COMPLETED with an EMPTY flag — while Hasaranga (Captain, 114 pts) read 0 because
 * the official card spells him "PWH de Silva" and that row resolved to no player id. The audit
 * must (a) show the delta, (b) name the reason as an identity break, not a benching, and
 * (c) surface the orphan row whose points no contest can see.
 */
import {
  __setPointsCacheForTest,
  __setSettlementCacheForTest,
} from "../lib/points";
import { auditMatch, auditContest, REASON_LABEL } from "../lib/settlement-audit";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
}

const M6 = {
  team1: "LPLDS", team2: "LPLKR", date: "2026-07-21T19:30:00+05:30",
  key: "M_LPL_DSvKR_0721", label: "Match 6: DS v KR",
};

const LIVE_H = ["Match", "Date", "Team", "Player ID", "Full Name", "Played",
  "Fantasy Points", "L2 Recon", "Match Status", "Recon Flag", "Player Recon"];

// The live sheet exactly as it stands: Hasaranga's squad row zeroed and marked "not in official
// XI", his 114 points sitting on a blank-pid orphan row, and the match badged COMPLETED.
const LIVE = [
  LIVE_H,
  ["Match 6 — DS v KR", "2026-07-21", "KR", "ci:784379", "Wanindu Hasaranga", "N",
    "", "⚠ revised: not in official XI", "COMPLETED", "", ""],
  ["Match 6 — DS v KR", "2026-07-21", "KR", "", "PWH de Silva", "Y",
    "114", "✓ complete", "COMPLETED", "", ""],
  ["Match 6 — DS v KR", "2026-07-21", "KR", "ci:704693", "Lahiru Udara", "Y",
    "105", "✓ complete", "COMPLETED", "", ""],
  // a genuine cricsheet revision (approval pending) — different reason, same match
  ["Match 6 — DS v KR", "2026-07-21", "DS", "ci:552152", "Dushmantha Chameera", "Y",
    "51", "⚠ revised: wkts 2→1", "COMPLETED", "", "⚠ official revision"],
  // moved with reconciliation reading clean => came from OUR side, not the official card
  ["Match 6 — DS v KR", "2026-07-21", "DS", "ci:1138316", "Maheesh Theekshana", "Y",
    "50", "✓ complete", "COMPLETED", "", ""],
];

const SETTLE_H = ["Match Key", "Tour", "Match", "Date", "Team", "Player ID", "Full Name",
  "Settled Points", "Settled Status", "Settled Source", "Frozen At", "Provenance"];
const MK = "2026-07-21::dambulla sixers|kandy roar";
const SETTLED = [
  SETTLE_H,
  [MK, "LPL 2026", "Match 6 — DS v KR", "2026-07-21", "KR", "ci:784379", "Wanindu Hasaranga",
    "114", "COMPLETED", "cricapi + ESPN dots/XI", "2026-07-22", "seed"],
  [MK, "LPL 2026", "Match 6 — DS v KR", "2026-07-21", "KR", "ci:704693", "Lahiru Udara",
    "105", "COMPLETED", "cricapi + ESPN dots/XI", "2026-07-22", "seed"],
  [MK, "LPL 2026", "Match 6 — DS v KR", "2026-07-21", "DS", "ci:552152", "Dushmantha Chameera",
    "60", "COMPLETED", "cricapi + ESPN dots/XI", "2026-07-22", "seed"],
  [MK, "LPL 2026", "Match 6 — DS v KR", "2026-07-21", "DS", "ci:1138316", "Maheesh Theekshana",
    "58", "COMPLETED", "cricapi + ESPN dots/XI", "2026-07-22", "seed"],
];

async function main() {
  console.log("\nsettlement audit — LPL Match 6 (the Hasaranga case)");
  __setPointsCacheForTest(LIVE);
  __setSettlementCacheForTest(SETTLED);

  const a = await auditMatch(M6);
  check("match flagged as changed", a.changed === true);
  check("does NOT claim missing baseline (we have seed evidence)", a.noBaseline === false);

  const has = (pid: string) => a.players.find((p) => p.pid === pid)!;
  const hasa = has("ci:784379");
  check("Hasaranga delta is -114", hasa.delta === -114);
  check("Hasaranga reason = IDENTITY_BREAK (not a benching)", hasa.reason === "IDENTITY_BREAK");
  check("Hasaranga paired to the orphan 'PWH de Silva'", hasa.orphanCandidate === "PWH de Silva");
  check("orphan row surfaced with its 114 unreachable points",
    a.orphans.length === 1 && a.orphans[0].name === "PWH de Silva" && a.orphans[0].points === 114);

  check("Udara unchanged", has("ci:704693").reason === "UNCHANGED");
  check("Chameera = FIELD_REVISION (cricsheet revised it)",
    has("ci:552152").reason === "FIELD_REVISION" && has("ci:552152").delta === -9);
  check("Theekshana = SCORER_FIX (recon clean, yet points moved)",
    has("ci:1138316").reason === "SCORER_FIX" && has("ci:1138316").delta === -8);

  check("biggest mover sorted first", a.players[0].pid === "ci:784379");
  // NB: totalAbsDelta counts APPLIED movement only — see the pending/changed split below.
  check("points at stake overall = 114+9+8", a.pendingAbsDelta + a.totalAbsDelta === 131);
  check("every reason has a human label",
    a.players.every((p) => typeof REASON_LABEL[p.reason] === "string"));

  // ── PENDING (manual action outstanding) vs CHANGED (recon done, result moved) ──
  // The distinction is mechanical: while an L2 revision is unapproved the bot HOLDS the settled
  // value, so nothing has actually moved yet. Mixing the two would either cry wolf on a to-do
  // item or hide a real re-settle.
  console.log("\n  — split: L2 pending vs L2 done-and-changed —");
  check("Chameera is PENDING (marker '⚠ official revision', value still held)",
    has("ci:552152").group === "PENDING" && has("ci:552152").marker !== "");
  check("Hasaranga is PENDING (identity needs a registry fix)",
    hasa.group === "PENDING");
  check("Theekshana is CHANGED (recon clean, number already moved)",
    has("ci:1138316").group === "CHANGED" && has("ci:1138316").marker === "");
  check("Udara is CLEAN", has("ci:704693").group === "CLEAN");
  check("pending list = Hasaranga + Chameera",
    a.pending.length === 2 && a.pending.every((p) => ["ci:784379", "ci:552152"].includes(p.pid)));
  check("changed list = Theekshana only",
    a.changedRows.length === 1 && a.changedRows[0].pid === "ci:1138316");
  check("pendingAbsDelta counts only pending (114+9)", a.pendingAbsDelta === 123);
  check("totalAbsDelta counts only APPLIED change (8)", a.totalAbsDelta === 8);
  check("match.changed reflects APPLIED change only", a.changed === true);

  // ── provenance 'unknown' must never read as "unchanged" ──
  console.log("\nunverified baseline is never reported as clean");
  __setSettlementCacheForTest([
    SETTLE_H,
    [MK, "LPL 2026", "Match 6 — DS v KR", "2026-07-21", "KR", "ci:704693", "Lahiru Udara",
      "105", "COMPLETED", "cricsheet · official", "2026-07-29", "unknown"],
  ]);
  const b = await auditMatch(M6);
  const udara = b.players.find((p) => p.pid === "ci:704693")!;
  check("identical points + unknown provenance => NO_BASELINE, not UNCHANGED",
    udara.reason === "NO_BASELINE" && udara.delta === 0);
  check("match reports noBaseline", b.noBaseline === true);

  // ── contest level: did the winner actually change? ──
  console.log("\ncontest audit — the question that decides money");
  const settledPts = new Map([["ci:784379", 114], ["ci:704693", 105]]);
  const nowPts = new Map([["ci:704693", 105]]);   // Hasaranga gone
  // nishant had Hasaranga as CAPTAIN (x2); pushap did not.
  const score = (user: string, pts: Map<string, number>): number | null => {
    if (user === "nishant") return (pts.get("ci:784379") ?? 0) * 2 + 400;
    return (pts.get("ci:704693") ?? 0) + 500;
  };
  const c = auditContest(["nishant", "pushap"], score, settledPts, nowPts);
  const n = c.totals.find((t) => t.user === "nishant")!;
  check("captain's loss is doubled (-228)", n.delta === -228);
  check("settled winner was nishant (628 v 605)", c.settledWinners.join() === "nishant");
  check("current winner is pushap (400 v 605)", c.currentWinners.join() === "pushap");
  check("winnerChanged = true — the settled result flipped", c.winnerChanged === true);

  const stable = auditContest(["a", "b"], (u, p) => (u === "a" ? 10 : 5) + (p.size ? 0 : 0),
    new Map([["x", 1]]), new Map([["x", 1]]));
  check("no change => winnerChanged false", stable.winnerChanged === false);

  __setPointsCacheForTest(null);
  __setSettlementCacheForTest(null);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
