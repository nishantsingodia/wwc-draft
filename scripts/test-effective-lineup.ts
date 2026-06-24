#!/usr/bin/env npx tsx
/**
 * Unit tests for the BACKUP_INTELLIGENCE engine (lib/effective-lineup.ts).
 * No test framework in this repo — run directly:  npx tsx scripts/test-effective-lineup.ts
 * Exits non-zero on any failure.
 */
import { computeEffectiveLineup, type Change } from "../lib/effective-lineup";
import type { Player } from "../lib/players";

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

// ── Fixtures: 15 players k1..k15, alternating teams AAA/BBB, valid 8-hex pids ──
function mkPlayer(n: number, team: string): Player {
  return {
    id: n,
    key: `k${n}`,
    pid: n.toString(16).padStart(8, "0"),
    name: `Player ${n}`,
    displayName: `Player ${n}`,
    country: "",
    role: "BAT",
    teamCode: team,
    squadNumber: n,
    efppm: 20,
  };
}
const PLAYERS: Player[] = Array.from({ length: 15 }, (_, i) =>
  mkPlayer(i + 1, (i + 1) % 2 === 1 ? "AAA" : "BBB")
);
const BY_KEY = new Map(PLAYERS.map((p) => [p.key, p]));
const RESOLVE = (k: string) => BY_KEY.get(k);
const RANKING = PLAYERS.map((p) => p.key); // k1..k15, k1 = Captain, k2 = Vice
const TEAMS: readonly [string, string] = ["AAA", "BBB"];

// Official XI map (teamCode -> pid -> batOrder) for the given set of playing keys.
function xiFor(playingKeys: string[]): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const key of playingKeys) {
    const p = BY_KEY.get(key)!;
    if (!m.has(p.teamCode)) m.set(p.teamCode, new Map());
    m.get(p.teamCode)!.set(p.pid!, p.squadNumber);
  }
  return m;
}
const run = (over: Partial<Parameters<typeof computeEffectiveLineup>[0]>) =>
  computeEffectiveLineup({
    ranking: RANKING,
    picksPerUser: 11,
    teamXIByTeam: xiFor(RANKING),
    resolve: RESOLVE,
    inMatchTeams: TEAMS,
    announced: true,
    ...over,
  });
const caps = (cs: Change[]) => cs.filter((c) => c.type === "captain");
const vices = (cs: Change[]) => cs.filter((c) => c.type === "vice");
const subs = (cs: Change[]) => cs.filter((c) => c.type === "sub");
const warns = (cs: Change[]) => cs.filter((c) => c.type === "warning");

console.log("BACKUP_INTELLIGENCE engine tests\n");

// 1. All playing → top 11 by rank, C/VC unchanged, no changes.
{
  const e = run({});
  check("all playing: XI = top 11 by rank", JSON.stringify(e.xi) === JSON.stringify(RANKING.slice(0, 11)));
  check("all playing: C=k1, VC=k2", e.captainKey === "k1" && e.viceCaptainKey === "k2");
  check("all playing: no changes", e.changes.length === 0);
}

// 2. Not announced → pass-through (even with an empty official XI).
{
  const e = run({ announced: false, teamXIByTeam: new Map() });
  check("not announced: XI = top 11 by rank", JSON.stringify(e.xi) === JSON.stringify(RANKING.slice(0, 11)));
  check("not announced: C/VC = ranks 1/2", e.captainKey === "k1" && e.viceCaptainKey === "k2");
  check("not announced: no changes", e.changes.length === 0);
}

// 3. One starter (k3) out, first backup (k12) playing → k12 slides in; C/VC unchanged.
{
  const playing = RANKING.filter((k) => k !== "k3");
  const e = run({ teamXIByTeam: xiFor(playing) });
  check("one out: k3 dropped from XI", !e.xi.includes("k3"));
  check("one out: k12 slid into XI", e.xi.includes("k12"));
  check("one out: XI still 11", e.xi.length === 11);
  check("one out: one sub recorded", subs(e.changes).length === 1);
  check("one out: sub is k3→k12", subs(e.changes)[0]?.type === "sub" && (subs(e.changes)[0] as Extract<Change, { type: "sub" }>).out.key === "k3" && (subs(e.changes)[0] as Extract<Change, { type: "sub" }>).in.key === "k12");
  check("one out (C/VC fine): no armband change", caps(e.changes).length === 0 && vices(e.changes).length === 0);
  check("one out: C=k1, VC=k2 unchanged", e.captainKey === "k1" && e.viceCaptainKey === "k2");
}

// 4. Captain (k1) out → VC steps up to C, next pick becomes VC (the cascade).
{
  const playing = RANKING.filter((k) => k !== "k1");
  const e = run({ teamXIByTeam: xiFor(playing) });
  check("captain out: C → k2", e.captainKey === "k2");
  check("captain out: VC → k3", e.viceCaptainKey === "k3");
  check("captain out: a captain change recorded", caps(e.changes).length === 1);
  check("captain out: a vice change recorded", vices(e.changes).length === 1);
  check("captain out: backup k12 fills the freed XI slot", e.xi.includes("k12") && e.xi.length === 11);
}

// 5. Captain AND Vice out → both cascade down by rank.
{
  const playing = RANKING.filter((k) => k !== "k1" && k !== "k2");
  const e = run({ teamXIByTeam: xiFor(playing) });
  check("C+VC out: C → k3", e.captainKey === "k3");
  check("C+VC out: VC → k4", e.viceCaptainKey === "k4");
  check("C+VC out: two subs (k12,k13 slid in)", e.xi.includes("k12") && e.xi.includes("k13") && e.xi.length === 11);
}

// 6. Only backups k12..k15 playing (top 11 all out) → a BACKUP becomes Captain.
{
  const e = run({ teamXIByTeam: xiFor(["k12", "k13", "k14", "k15"]) });
  check("backup-as-captain: C = k12 (a backup)", e.captainKey === "k12");
  check("backup-as-captain: VC = k13", e.viceCaptainKey === "k13");
  check("backup-as-captain: XI = the 4 playing", e.xi.length === 4);
  check("backup-as-captain: warnings for unfillable slots", warns(e.changes).length > 0);
}

// 7. Fewer than 11 playing (only k1..k9) → field 9, warn on the 2 empty slots.
{
  const e = run({ teamXIByTeam: xiFor(["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9"]) });
  check("short XI: only 9 fielded", e.xi.length === 9);
  check("short XI: C/VC still k1/k2 (playing)", e.captainKey === "k1" && e.viceCaptainKey === "k2");
  check("short XI: ≥2 warnings for empty slots", warns(e.changes).length >= 2);
}

// 8. A starter (k5) is on a team NOT in this match → treated as not playing, dropped.
{
  const ghost = { ...BY_KEY.get("k5")!, teamCode: "ZZZ" };
  const resolve = (k: string) => (k === "k5" ? ghost : BY_KEY.get(k));
  // k5 is on ZZZ; everyone else on AAA/BBB is playing.
  const playing = RANKING.filter((k) => k !== "k5");
  const e = computeEffectiveLineup({
    ranking: RANKING,
    picksPerUser: 11,
    teamXIByTeam: xiFor(playing),
    resolve,
    inMatchTeams: TEAMS,
    announced: true,
  });
  check("off-match team: k5 dropped", !e.xi.includes("k5"));
  check("off-match team: k12 slid in, XI = 11", e.xi.includes("k12") && e.xi.length === 11);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
