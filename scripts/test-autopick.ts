#!/usr/bin/env npx tsx
/**
 * Verifies the server-side autopick cascade end-to-end against a scratch DB:
 *   rm -f db/test-autopick.db \
 *     && TURSO_DATABASE_URL=file:db/test-autopick.db npx tsx scripts/migrate.ts \
 *     && TURSO_DATABASE_URL=file:db/test-autopick.db npx tsx scripts/test-autopick.ts
 *
 * Simulates a real draft where Bob's browser is CLOSED (no client) — his queued
 * picks must still fire, driven only by the server when Alice picks.
 */
import { getDb, draftContests, draftPicks, draftQueues, contestParticipants } from "../lib/db";
import { eq, asc } from "drizzle-orm";
import { resolveAutopicks } from "../lib/autopick";
import { getAllPlayers } from "../lib/players";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${label}`);
  if (!cond) failures++;
}

async function main() {
  const db = getDb();
  const players = getAllPlayers();
  const [pA, pB, pC] = players; // three distinct real players for Bob's queue
  const now = Math.floor(Date.now() / 1000);

  // Fresh contest: 2 players, tiny sizes so the draft is short & readable.
  await db.delete(draftContests).where(eq(draftContests.code, "TEST01"));
  const [contest] = await db
    .insert(draftContests)
    .values({
      code: "TEST01",
      matchKey: "TEST",
      matchLabel: "Test",
      matchDeadline: now + 100000,
      picksPerUser: 2,
      backupsPerUser: 0,
      status: "DRAFTING",
      draftOrder: JSON.stringify(["alice", "bob"]),
      pickCount: 0,
      createdBy: "alice",
      createdAt: now,
    })
    .returning();
  const cid = contest.id;
  await db.delete(draftPicks).where(eq(draftPicks.contestId, cid));
  await db.delete(draftQueues).where(eq(draftQueues.contestId, cid));
  await db.insert(contestParticipants).values([
    { contestId: cid, user: "alice", joinedAt: now },
    { contestId: cid, user: "bob", joinedAt: now },
  ]);

  // Bob (browser closed) queues three players, in order.
  await db.insert(draftQueues).values({
    contestId: cid,
    user: "bob",
    playerKeys: JSON.stringify([pA.key, pB.key, pC.key]),
    updatedAt: now,
  });

  // ---- Alice makes pick #1 manually, then the server cascade runs. --------
  await db.insert(draftPicks).values({
    contestId: cid, pickedBy: "alice", playerKey: "alice-pick-1",
    playerName: "AlicePlayer1", playerRole: "BAT", playerTeam: "XXX",
    pickNumber: 1, pickedAt: now,
  });
  await db.update(draftContests).set({ pickCount: 1 }).where(eq(draftContests.id, cid));

  let r = await resolveAutopicks(cid);

  // Order alternates: after alice #1 → bob's turn. Bob has a queue → auto-pick #2
  // (pA). Then alice's turn (pickCount 2). Alice has no queue → cascade stops.
  let picks = await db.select().from(draftPicks).where(eq(draftPicks.contestId, cid)).orderBy(asc(draftPicks.pickNumber));
  check("cascade fired Bob's queued pick with no client", picks.length === 2);
  check("Bob's pick #2 is his first queued player", picks[1]?.playerKey === pA.key && picks[1]?.pickedBy === "bob");
  check("pickCount advanced to 2, stops on Alice (no queue)", r.pickCount === 2 && r.status === "DRAFTING");

  let [bq] = await db.select().from(draftQueues).where(eq(draftQueues.contestId, cid));
  check("Bob's queue shrank to [pB, pC] after consuming pA", JSON.parse(bq.playerKeys).length === 2 && JSON.parse(bq.playerKeys)[0] === pB.key);

  // ---- Alice makes pick #3; cascade should fire Bob's LAST pick (#4) & finish.
  await db.insert(draftPicks).values({
    contestId: cid, pickedBy: "alice", playerKey: "alice-pick-2",
    playerName: "AlicePlayer2", playerRole: "BAT", playerTeam: "XXX",
    pickNumber: 3, pickedAt: now,
  });
  await db.update(draftContests).set({ pickCount: 3 }).where(eq(draftContests.id, cid));

  r = await resolveAutopicks(cid);
  picks = await db.select().from(draftPicks).where(eq(draftPicks.contestId, cid)).orderBy(asc(draftPicks.pickNumber));
  check("Bob's 2nd queued pick fired (pB), draft now complete", picks.length === 4 && picks[3]?.playerKey === pB.key);
  check("status flips to TEAM_SELECT when all picks made", r.status === "TEAM_SELECT" && r.pickCount === 4);

  // ---- Taken-skip: if Bob's front-of-queue player is already gone, skip it. --
  await db.delete(draftContests).where(eq(draftContests.code, "TEST02"));
  const [c2] = await db.insert(draftContests).values({
    code: "TEST02", matchKey: "TEST", matchLabel: "Test", matchDeadline: now + 100000,
    picksPerUser: 1, backupsPerUser: 0, status: "DRAFTING",
    draftOrder: JSON.stringify(["alice", "bob"]), pickCount: 1,
    createdBy: "alice", createdAt: now,
  }).returning();
  // Alice already took pA; Bob's queue leads with pA (gone) then pB.
  await db.insert(draftPicks).values({
    contestId: c2.id, pickedBy: "alice", playerKey: pA.key,
    playerName: pA.displayName, playerRole: pA.role, playerTeam: pA.teamCode,
    pickNumber: 1, pickedAt: now,
  });
  await db.insert(draftQueues).values({
    contestId: c2.id, user: "bob", playerKeys: JSON.stringify([pA.key, pB.key]), updatedAt: now,
  });
  await resolveAutopicks(c2.id);
  const p2 = await db.select().from(draftPicks).where(eq(draftPicks.contestId, c2.id)).orderBy(asc(draftPicks.pickNumber));
  check("cascade skips already-taken front-of-queue player, picks next available", p2.length === 2 && p2[1]?.playerKey === pB.key && p2[1]?.pickedBy === "bob");

  // ---- Undo-pending guard: cascade must NOT fire while an undo is pending. ---
  await db.update(draftContests).set({ pendingUndoBy: "alice", pendingUndoTarget: 1, pendingUndoAt: now, pickCount: 1, status: "DRAFTING" }).where(eq(draftContests.id, c2.id));
  await db.delete(draftPicks).where(eq(draftPicks.contestId, c2.id));
  await db.insert(draftPicks).values({ contestId: c2.id, pickedBy: "alice", playerKey: pC.key, playerName: pC.displayName, playerRole: pC.role, playerTeam: pC.teamCode, pickNumber: 1, pickedAt: now });
  const before = (await db.select().from(draftPicks).where(eq(draftPicks.contestId, c2.id))).length;
  await resolveAutopicks(c2.id);
  const after = (await db.select().from(draftPicks).where(eq(draftPicks.contestId, c2.id))).length;
  check("cascade is a no-op while an undo is pending", before === after);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
