import { and, eq } from "drizzle-orm";
import {
  getDb,
  draftContests,
  draftPicks,
  draftQueues,
  UNDO_TTL_SECONDS,
} from "./db";
import { currentPicker, isDraftComplete } from "./snake-draft";
import { getPlayerByKey } from "./players";

/**
 * Server-authoritative autopick cascade.
 *
 * Call this right after the turn advances (a human pick, or a queue save made on
 * the caller's own turn). While the *current* picker has a saved queue with an
 * available player, it inserts that pick and advances — looping through any run
 * of consecutive queued pickers. Because it runs entirely server-side, queued
 * picks fire even when no browser tab is open: the queue is durable and the
 * server, not the client, is what fires it.
 *
 * Safety:
 *  - Skips if the draft isn't DRAFTING or an undo is pending (the pick path is
 *    frozen during an undo handshake).
 *  - Each step is one atomic libsql batch (insert pick + bump pickCount + shrink
 *    that user's queue), so pickCount and the pick rows never drift apart.
 *  - Only ever picks a player not already taken and still in the pool. Stops on
 *    any insert error (e.g. a concurrent grab racing the UNIQUE(contest,player)
 *    constraint) rather than risking a double-advance.
 *  - Bounded by the total pick count, so it can never loop forever.
 *
 * Returns the final { pickCount, status } after the cascade settles.
 */
export async function resolveAutopicks(
  contestId: number
): Promise<{ pickCount: number; status: string }> {
  const db = getDb();

  const [contest] = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.id, contestId));

  if (!contest) return { pickCount: 0, status: "WAITING" };

  let pickCount = contest.pickCount;
  let status = contest.status as string;

  const now = Math.floor(Date.now() / 1000);
  const undoLive =
    !!contest.pendingUndoBy &&
    !!contest.pendingUndoAt &&
    now - contest.pendingUndoAt < UNDO_TTL_SECONDS;

  const order = JSON.parse(contest.draftOrder ?? "[]") as string[];
  if (status !== "DRAFTING" || undoLive || order.length === 0) {
    return { pickCount, status };
  }

  // Load every saved queue for this contest into memory (user -> ordered keys).
  const queueRows = await db
    .select()
    .from(draftQueues)
    .where(eq(draftQueues.contestId, contestId));
  const queues = new Map<string, string[]>();
  for (const q of queueRows) {
    try {
      const keys = JSON.parse(q.playerKeys) as string[];
      if (Array.isArray(keys)) queues.set(q.user, keys);
    } catch {
      /* ignore a corrupt queue row */
    }
  }

  // Players already off the board.
  const takenRows = await db
    .select({ playerKey: draftPicks.playerKey })
    .from(draftPicks)
    .where(eq(draftPicks.contestId, contestId));
  const taken = new Set(takenRows.map((r) => r.playerKey));

  const maxPicks = order.length * (contest.picksPerUser + contest.backupsPerUser);

  // `maxPicks` iterations is the hard ceiling — every step consumes one pick.
  for (let guard = 0; guard <= maxPicks; guard++) {
    if (isDraftComplete(order, pickCount, contest.picksPerUser, contest.backupsPerUser)) {
      status = "TEAM_SELECT";
      break;
    }
    const picker = currentPicker(order, pickCount);
    const queue = queues.get(picker) ?? [];

    // First queued player who is still available and a real pool player.
    const nextKey = queue.find((k) => !taken.has(k) && !!getPlayerByKey(k));
    if (!nextKey) break; // current picker has nothing to auto-fire → hand back to humans

    const player = getPlayerByKey(nextKey)!;
    const newPickCount = pickCount + 1;
    const done = isDraftComplete(
      order,
      newPickCount,
      contest.picksPerUser,
      contest.backupsPerUser
    );
    const remaining = queue.filter((k) => k !== nextKey);

    try {
      await db.batch([
        db.insert(draftPicks).values({
          contestId,
          pickedBy: picker,
          playerKey: player.key,
          playerName: player.displayName,
          playerRole: player.role,
          playerTeam: player.teamCode,
          pickNumber: newPickCount,
          pickedAt: Math.floor(Date.now() / 1000),
        }),
        db
          .update(draftContests)
          .set({ pickCount: newPickCount, status: done ? "TEAM_SELECT" : "DRAFTING" })
          .where(eq(draftContests.id, contestId)),
        db
          .update(draftQueues)
          .set({ playerKeys: JSON.stringify(remaining), updatedAt: now })
          .where(and(eq(draftQueues.contestId, contestId), eq(draftQueues.user, picker))),
      ]);
    } catch {
      // Concurrent grab or write failure — stop cascading and let state settle
      // rather than risk advancing pickCount past a pick that didn't land.
      break;
    }

    taken.add(nextKey);
    queues.set(picker, remaining);
    pickCount = newPickCount;
    status = done ? "TEAM_SELECT" : "DRAFTING";
    if (done) break;
  }

  return { pickCount, status };
}
