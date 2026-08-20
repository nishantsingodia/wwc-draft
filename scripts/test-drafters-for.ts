/**
 * draftersFor — who a contest's team-entry surfaces offer a slot for.
 *
 * Guards a regression that nearly shipped. Manual drafts had no join step, so entering a
 * friend's team never seated them in contest_participants and the lobby (participant-scoped)
 * couldn't see it. Seating them on write fixes that — but the drafter list used to read
 * `participants.length >= 2 ? participants : roster.slice(0, maxPlayers)`, so seating would
 * have SHRUNK the list as teams got entered: fill 2 of 6 and friends 3-6 become unreachable.
 * The two behaviours are only safe together, hence the test.
 */
import { draftersFor, ALL_USERS, MAX_ROSTER } from "@/lib/users";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
};
const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

console.log("\ndraftersFor — manual mode offers every friend, live mode follows participants");

const [u1, u2, u3] = ALL_USERS;

// ── manual: the roster drives the list, NOT how many are seated ──
check(
  "fresh 2-seat manual draft offers both friends",
  eq(draftersFor("manual", [u1], 2), [u1, u2])
);
check(
  "seating the 2nd friend does not shrink a 2-seat draft",
  eq(draftersFor("manual", [u1, u2], 2), [u1, u2])
);
check(
  "fresh 6-seat manual draft offers all six",
  draftersFor("manual", [u1], MAX_ROSTER).length === MAX_ROSTER
);
check(
  "THE REGRESSION: 2 of 6 seated still offers all six",
  draftersFor("manual", [u1, u2], MAX_ROSTER).length === MAX_ROSTER
);
check(
  "5 of 6 seated still offers the sixth",
  draftersFor("manual", ALL_USERS.slice(0, 5), MAX_ROSTER).length === MAX_ROSTER
);

// ── manual: a seated drafter is never dropped ──
check(
  "a seated friend outside the maxPlayers slice is kept, not truncated away",
  draftersFor("manual", [u1, ALL_USERS[MAX_ROSTER - 1]], 2).includes(ALL_USERS[MAX_ROSTER - 1])
);
check(
  "over-seated contest grows to fit rather than cutting a participant",
  draftersFor("manual", [u1, u2, u3], 2).length === 3
);
const overlap = draftersFor("manual", [u2, u1], MAX_ROSTER);
check(
  "no duplicates when participants overlap the roster",
  new Set(overlap).size === overlap.length
);

// ── a manual draft created by the friend PICKER: everyone is seated up front, so the
//    chosen set must come back EXACTLY — no roster padding, no roster-order substitution.
//    This is the contract POST /api/draft relies on when it seats seatedUsers. ──
const picked = [u1, ALL_USERS[1], ALL_USERS[4], ALL_USERS[5]]; // you, Pushap, Sharan, Mihir
check(
  "a picked 4-some comes back exactly, in the order chosen",
  eq(draftersFor("manual", picked, picked.length), picked)
);
check(
  "picking non-adjacent roster members does NOT pull in the ones between them",
  !draftersFor("manual", picked, picked.length).includes(ALL_USERS[2])
);
const pickedPair = [u1, ALL_USERS[5]]; // you + Mihir only
check(
  "a 2-person pick skipping five roster slots is expressible",
  eq(draftersFor("manual", pickedPair, 2), pickedPair)
);

// ── live: participants are authoritative once the seats fill ──
check(
  "live draft with 2 joined uses participants",
  eq(draftersFor("live", [u2, u3], 2), [u2, u3])
);
check(
  "live draft awaiting a join falls back to the roster slice",
  eq(draftersFor("live", [u1], 2), [u1, u2])
);
check(
  "live 6-player draft uses all six participants",
  draftersFor("live", ALL_USERS.slice(0, 6), 6).length === 6
);

// ── the null/undefined maxPlayers legacy rows ──
check("null maxPlayers defaults to 2 seats", eq(draftersFor("manual", [u1], null), [u1, u2]));
check(
  "undefined maxPlayers defaults to 2 seats",
  eq(draftersFor("manual", [u1], undefined), [u1, u2])
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
