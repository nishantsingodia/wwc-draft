#!/usr/bin/env npx tsx
/**
 * Integration check for the post-lock amendment APPLY path: real player data through
 * applyAmendment against the real schema, including the two things that would silently
 * break scoring if they regressed —
 *   1. the approved lineup must be FROZEN exactly as approved (the substitution engine
 *      must not get a second vote over a decision people already signed off), and
 *   2. the draft_picks row for the stand-in must be rewritten to the real player.
 * Writes throwaway rows to a LOCAL file DB and deletes them.
 *
 *   TURSO_DATABASE_URL=file:db/test.db npx tsx scripts/test-amend-integration.ts
 *
 * Refuses to run against anything that isn't a file: DB (never prod Turso).
 */
if (!/^file:/.test(process.env.TURSO_DATABASE_URL ?? "")) {
  console.error("Refusing to run: set TURSO_DATABASE_URL=file:db/test.db (local only).");
  process.exit(1);
}

import { and, eq } from "drizzle-orm";
import {
  getDb,
  draftContests,
  draftPicks,
  teamSelections,
  lineupAmendments,
  type DraftContest,
} from "../lib/db";
import { getAllPlayers, getPlayerByKey, makeExternalKey } from "../lib/players";
import {
  applyAmendment,
  approvedLineup,
  currentRanking,
  validateAmendment,
} from "../lib/amendments";
import type { Change } from "../lib/effective-lineup";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};

const CODE = "__AMEND_TEST__";
const USER = "nishant";

async function main() {
  const db = getDb();

  // ── seed a realistic locked contest ────────────────────────────────────────
  const byTeam = new Map<string, string[]>();
  for (const p of getAllPlayers()) {
    if (!byTeam.has(p.teamCode)) byTeam.set(p.teamCode, []);
    byTeam.get(p.teamCode)!.push(p.key);
  }
  const [t1, t2] = [...byTeam.entries()].filter(([, k]) => k.length >= 8).map(([t]) => t);
  if (!t1 || !t2) throw new Error("need two teams with >= 8 seeded players");
  const ranking = [...byTeam.get(t1)!.slice(0, 8), ...byTeam.get(t2)!.slice(0, 7)];

  await cleanup();
  const [contest] = (await db
    .insert(draftContests)
    .values({
      code: CODE,
      matchKey: "__amend_test__",
      matchLabel: `Test: ${t1} v ${t2}`,
      matchDeadline: 1,
      picksPerUser: 11,
      backupsPerUser: 4,
      mode: "live",
      status: "LOCKED",
      draftOrder: JSON.stringify([USER]),
      pickCount: ranking.length,
      createdBy: USER,
      createdAt: 1,
    })
    .returning()) as DraftContest[];

  await db.insert(teamSelections).values({
    contestId: contest.id,
    user: USER,
    selectedPlayers: JSON.stringify(ranking),
    captainKey: ranking[0],
    viceCaptainKey: ranking[1],
    submittedAt: 1,
    isLocked: true,
    // Pretend BACKUP_INTELLIGENCE already froze a decision — the amendment MUST overwrite it.
    effectiveLineup: JSON.stringify({
      xi: ranking.slice(0, 11),
      captainKey: ranking[0],
      viceCaptainKey: ranking[1],
    }),
    effectiveChanges: JSON.stringify([]),
    effectiveComputedAt: 1,
  });

  await db.insert(draftPicks).values(
    ranking.map((key, i) => {
      const p = getPlayerByKey(key)!;
      return {
        contestId: contest.id,
        pickedBy: USER,
        playerKey: key,
        playerName: p.displayName,
        playerRole: p.role,
        playerTeam: p.teamCode,
        pickNumber: i + 1,
        pickedAt: 1,
      };
    })
  );

  // ── the scenario: the LAST pick was a dummy stand-in for a late addition ────
  const dummyKey = ranking[ranking.length - 1];
  const realKey = makeExternalKey("ci:9999999", t1, "AR", "Late Addition");
  // …and while we're in there, promote them to Captain.
  const proposed = [realKey, ...ranking.slice(0, ranking.length - 1)];

  const valid = validateAmendment({
    current: ranking,
    proposed,
    replacements: [{ outKey: dummyKey, inKey: realKey }],
    matchTeams: [t1, t2],
    taken: new Set<string>(),
  });
  ok("validates against real player data", valid.ok, valid.ok ? "" : valid.error);

  const [amendment] = await db
    .insert(lineupAmendments)
    .values({
      contestId: contest.id,
      user: USER,
      requestedBy: USER,
      ranking: JSON.stringify(proposed),
      replacements: JSON.stringify([{ outKey: dummyKey, inKey: realKey }]),
      reason: "Late addition — drafted a stand-in for him",
      pointsDelta: 0,
      status: "PENDING",
      approvals: JSON.stringify([]),
      createdAt: 1,
    })
    .returning();

  await applyAmendment(contest, amendment, 2);

  // ── assertions ─────────────────────────────────────────────────────────────
  const [sel] = await db
    .select()
    .from(teamSelections)
    .where(and(eq(teamSelections.contestId, contest.id), eq(teamSelections.user, USER)));

  ok("ranking replaced", currentRanking(sel)[0] === realKey);
  ok("stand-in gone from the squad", !currentRanking(sel).includes(dummyKey));
  ok("squad size unchanged", currentRanking(sel).length === ranking.length);
  ok("captain follows rank 1", sel.captainKey === realKey);
  ok("vice follows rank 2", sel.viceCaptainKey === ranking[0]);
  // The whole point: what gets scored is what was approved, not what the engine would
  // have chosen. Frozen top-11 of the approved order, rank 1 captains, rank 2 vices.
  const frozen = JSON.parse(sel.effectiveLineup ?? "null") as ReturnType<typeof approvedLineup> | null;
  const expected = approvedLineup(proposed, 11);
  ok("approved lineup is FROZEN, not cleared", !!frozen && sel.effectiveComputedAt === 2);
  ok(
    "frozen XI is exactly the approved top 11",
    JSON.stringify(frozen?.xi) === JSON.stringify(expected.xi),
    JSON.stringify(frozen?.xi)
  );
  ok("frozen captain is the approved rank 1", frozen?.captainKey === realKey);
  ok("frozen vice is the approved rank 2", frozen?.viceCaptainKey === ranking[0]);
  ok("the late addition is IN the scoring XI", !!frozen?.xi.includes(realKey));

  const changes = JSON.parse(sel.effectiveChanges ?? "[]") as Change[];
  const marker = changes.find((c) => c.type === "amendment");
  ok("disclosure marks it as a human amendment, not backup intelligence", !!marker);
  ok(
    "disclosure names the requester and the reason",
    marker?.type === "amendment" &&
      marker.by === USER &&
      marker.reason.includes("Late addition")
  );
  ok(
    "disclosure lists the replacement as a sub",
    changes.some((c) => c.type === "sub" && c.in.key === realKey && c.out.key === dummyKey)
  );
  ok(
    "disclosure lists the captaincy move",
    changes.some((c) => c.type === "captain" && c.in.key === realKey)
  );

  const picks = await db.select().from(draftPicks).where(eq(draftPicks.contestId, contest.id));
  const rewritten = picks.find((p) => p.playerKey === realKey);
  ok("draft pick rewritten to the real player", !!rewritten);
  ok("draft pick carries the real name", rewritten?.playerName === "Late Addition");
  ok("stand-in pick row is gone", !picks.some((p) => p.playerKey === dummyKey));
  ok("pick count unchanged", picks.length === ranking.length);

  const [after] = await db
    .select()
    .from(lineupAmendments)
    .where(eq(lineupAmendments.id, amendment.id));
  ok("amendment marked APPROVED", after.status === "APPROVED" && after.resolvedAt === 2);

  // The real player must now resolve with their registry pid — that is the whole point:
  // points join on identity, exactly like a seeded player.
  const p = getPlayerByKey(currentRanking(sel)[0]);
  ok("replacement resolves with a stable pid", p?.pid === "ci:9999999", p?.pid);

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

async function cleanup() {
  const db = getDb();
  const [c] = await db.select().from(draftContests).where(eq(draftContests.code, CODE));
  if (!c) return;
  await db.delete(draftPicks).where(eq(draftPicks.contestId, c.id));
  await db.delete(teamSelections).where(eq(teamSelections.contestId, c.id));
  await db.delete(lineupAmendments).where(eq(lineupAmendments.contestId, c.id));
  await db.delete(draftContests).where(eq(draftContests.id, c.id));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
