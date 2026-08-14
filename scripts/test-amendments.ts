#!/usr/bin/env npx tsx
/**
 * Unit tests for the post-lock lineup-amendment rules (lib/amendments.ts) and the
 * identity-carrying player key they depend on (lib/players.ts `x|pid|…`).
 * No test framework in this repo — run directly:  npx tsx scripts/test-amendments.ts
 * Exits non-zero on any failure.
 */
import {
  validateAmendment,
  diffAmendment,
  isNoOp,
  approversFor,
  approvedLineup,
} from "../lib/amendments";
import { getPlayerByKey, makeExternalKey, makeSyntheticKey, isOffSeedKey } from "../lib/players";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────────
// A 6-player squad k1..k6 on team AAA, plus outsiders. `resolve` is injected so these
// tests never depend on players-raw.json.
const TEAMS = ["AAA", "BBB"] as const;
const ROSTER: Record<string, { teamCode: string; displayName: string }> = {};
for (let i = 1; i <= 8; i++) ROSTER[`k${i}`] = { teamCode: "AAA", displayName: `Player ${i}` };
ROSTER["new1"] = { teamCode: "BBB", displayName: "Late Addition" };
ROSTER["offtour"] = { teamCode: "ZZZ", displayName: "Wrong Match" };
const resolve = (k: string) => ROSTER[k];

const CURRENT = ["k1", "k2", "k3", "k4", "k5", "k6"];
const base = {
  current: CURRENT,
  matchTeams: TEAMS,
  taken: new Set<string>(),
  resolve,
};

console.log("validateAmendment");

check(
  "a pure re-order is accepted",
  validateAmendment({ ...base, proposed: ["k2", "k1", "k3", "k4", "k5", "k6"], replacements: [] }).ok
);

check(
  "a straight replacement is accepted",
  validateAmendment({
    ...base,
    proposed: ["k1", "k2", "k3", "k4", "k5", "new1"],
    replacements: [{ outKey: "k6", inKey: "new1" }],
  }).ok
);

check(
  "dropping a player without a replacement is rejected",
  !validateAmendment({ ...base, proposed: ["k1", "k2", "k3", "k4", "k5"], replacements: [] }).ok
);

check(
  "adding a player without a replacement is rejected",
  !validateAmendment({
    ...base,
    proposed: [...CURRENT, "new1"],
    replacements: [],
  }).ok
);

check(
  "a duplicate in the ranking is rejected",
  !validateAmendment({
    ...base,
    proposed: ["k1", "k1", "k3", "k4", "k5", "k6"],
    replacements: [],
  }).ok
);

check(
  "replacing someone who isn't in the squad is rejected",
  !validateAmendment({
    ...base,
    proposed: ["k1", "k2", "k3", "k4", "k5", "new1"],
    replacements: [{ outKey: "k7", inKey: "new1" }],
  }).ok
);

check(
  "pulling in a player another squad already owns is rejected",
  !validateAmendment({
    ...base,
    taken: new Set(["new1"]),
    proposed: ["k1", "k2", "k3", "k4", "k5", "new1"],
    replacements: [{ outKey: "k6", inKey: "new1" }],
  }).ok
);

check(
  "pulling in a player who isn't in this match is rejected",
  !validateAmendment({
    ...base,
    proposed: ["k1", "k2", "k3", "k4", "k5", "offtour"],
    replacements: [{ outKey: "k6", inKey: "offtour" }],
  }).ok
);

check(
  "a ranking that silently swaps in a stranger is rejected",
  !validateAmendment({
    ...base,
    proposed: ["k1", "k2", "k3", "k4", "k5", "new1"],
    replacements: [],
  }).ok
);

check(
  "replacing the same player twice is rejected",
  !validateAmendment({
    ...base,
    proposed: ["k1", "k2", "k3", "k4", "k5", "new1"],
    replacements: [
      { outKey: "k6", inKey: "new1" },
      { outKey: "k6", inKey: "k7" },
    ],
  }).ok
);

console.log("diffAmendment");

{
  // A replacement in place is a replacement only — never also a phantom "moved 6→6".
  const d = diffAmendment(
    CURRENT,
    ["k1", "k2", "k3", "k4", "k5", "new1"],
    [{ outKey: "k6", inKey: "new1" }],
    4,
    resolve as never
  );
  check("replacement in place produces no move rows", d.moves.length === 0, JSON.stringify(d.moves));
  check("replacement is reported", d.replacements.length === 1);
  check("armband untouched", !d.captain && !d.vice);
}

{
  // Promoting the late addition to Captain: one move, one captain change, one vice change
  // (the old captain slides to rank 2), and the demoted rank-2 leaves the armband.
  const d = diffAmendment(
    CURRENT,
    ["new1", "k1", "k2", "k3", "k4", "k5"],
    [{ outKey: "k6", inKey: "new1" }],
    4,
    resolve as never
  );
  check("captain change reported", d.captain?.to?.key === "new1" && d.captain?.from?.key === "k1");
  check("vice change reported", d.vice?.to?.key === "k1" && d.vice?.from?.key === "k2");
  check("XI entry reported", d.intoXI.some((r) => r.key === "new1"), JSON.stringify(d.intoXI));
  check("XI exit reported", d.outOfXI.some((r) => r.key === "k4"), JSON.stringify(d.outOfXI));
}

{
  const d = diffAmendment(CURRENT, CURRENT, [], 4, resolve as never);
  check("an unchanged ranking is a no-op", isNoOp(d));
}

{
  // Swapping C and VC is the ONLY change — it must not read as an XI reshuffle.
  const d = diffAmendment(
    CURRENT,
    ["k2", "k1", "k3", "k4", "k5", "k6"],
    [],
    4,
    resolve as never
  );
  check("C/VC swap reports both armbands", !!d.captain && !!d.vice);
  check("C/VC swap moves nobody in or out of the XI", d.intoXI.length === 0 && d.outOfXI.length === 0);
  check("C/VC swap is not a no-op", !isNoOp(d));
}

console.log("approversFor");

check(
  "every other stakeholder must approve",
  approversFor(["nishant", "pushap"], ["nishant", "pushap"], "nishant").join() === "pushap"
);
check(
  "a selection owner who never joined still gets a vote",
  approversFor(["nishant"], ["nishant", "pushap"], "nishant").join() === "pushap"
);
check(
  "no one else in the contest ⇒ no approval needed",
  approversFor(["nishant"], ["nishant"], "nishant").length === 0
);

// The property that makes "anyone may amend anyone's team" safe: when you file for
// SOMEONE ELSE, that someone else is an approver. A change to a person's team can never
// apply without that person agreeing to it, whoever proposed it.
{
  const owner = "pushap";
  const filer = "nishant";
  const approvers = approversFor([filer, owner], [filer, owner], filer);
  check("filing for another player puts THEM in the approver set", approvers.includes(owner));
  check("the filer never approves their own request", !approvers.includes(filer));
}
{
  // Six-player contest: filing for one friend still needs everybody else, including them.
  const roster = ["nishant", "pushap", "pradeep", "arif", "sharan", "mihir"];
  const approvers = approversFor(roster, roster, "nishant");
  check("N-player: every other stakeholder approves", approvers.length === 5);
  check("N-player: the target owner is among them", approvers.includes("mihir"));
}

console.log("approvedLineup — score exactly what was approved");

{
  // No substitution engine, no re-derivation: top ppu of the agreed order, rank 1 = C,
  // rank 2 = VC. A player the engine would have benched (not in the official XI) MUST
  // stay in, because that is what the friends signed off on.
  const l = approvedLineup(CURRENT, 4);
  check("XI is the top ppu of the approved order", l.xi.join() === "k1,k2,k3,k4");
  check("captain is rank 1", l.captainKey === "k1");
  check("vice is rank 2", l.viceCaptainKey === "k2");
}
{
  const l = approvedLineup(["new1", "k1", "k2", "k3", "k4", "k5"], 4);
  check("a promoted late addition captains", l.captainKey === "new1");
  check("the late addition is in the scoring XI", l.xi.includes("new1"));
}
{
  const l = approvedLineup(["k1"], 4);
  check("a squad shorter than ppu doesn't pad", l.xi.length === 1);
  check("no vice when there is only one player", l.viceCaptainKey === null);
}

console.log("player keys");

{
  const key = makeExternalKey("ci:1234567", "LPLJK", "AR", "Kamindu Mendis");
  const p = getPlayerByKey(key);
  check("x| key resolves", !!p);
  check("x| key carries the registry pid", p?.pid === "ci:1234567", p?.pid);
  check("x| key carries name/team/role", p?.displayName === "Kamindu Mendis" && p?.teamCode === "LPLJK" && p?.role === "AR");
  check("x| key is flagged off-seed", isOffSeedKey(key));
}
{
  // A name with a pipe must still round-trip (the name is the rest of the key).
  const key = makeExternalKey("ci:9", "AAA", "BAT", "Odd|Name");
  check("x| key round-trips a piped name", getPlayerByKey(key)?.displayName === "Odd|Name");
}
{
  const key = makeSyntheticKey("AAA", "BOWL", "No Registry Entry");
  const p = getPlayerByKey(key);
  check("s| key still resolves with NO pid (fuzzy-name join)", !!p && p.pid === undefined);
  check("s| key is flagged off-seed", isOffSeedKey(key));
}
check("a seeded numeric key is not off-seed", !isOffSeedKey("852"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
