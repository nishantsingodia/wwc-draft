import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  getDb,
  draftContests,
  draftPicks,
  teamSelections,
  contestParticipants,
  UNDO_TTL_SECONDS,
} from "@/lib/db";
import { and, eq, gte, desc } from "drizzle-orm";
import { currentPicker } from "@/lib/snake-draft";

/**
 * Undo a pick via an approval handshake.
 *
 * Flow (body `{ action }`):
 *  - "request":  caller asks to roll the draft back to THEIR own last pick.
 *                Everything from that pick onward (their pick + any picks the
 *                opponent made after it) will be discarded. Stores a pending
 *                request; the other player must approve.
 *  - "approve":  the OTHER player confirms. Atomically deletes picks >= target,
 *                clears now-stale team selections, resets pickCount/status, and
 *                clears the pending request. Turn is whatever currentPicker()
 *                resolves to from the rolled-back pickCount.
 *  - "reject":   the other player declines → clears the pending request.
 *  - "cancel":   the requester withdraws their own pending request.
 *
 * Picks are blocked while a request is pending (see pick/route.ts), so the set
 * of discarded picks the approver sees can't shift under them.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  let username: string;
  try {
    username = await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { code } = await params;
  const { action } = await request.json();
  const db = getDb();

  const [contest] = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.code, code.toUpperCase()));

  if (!contest) {
    return NextResponse.json({ error: "Contest not found" }, { status: 404 });
  }

  const order = JSON.parse(contest.draftOrder ?? "[]") as string[];
  const now = Math.floor(Date.now() / 1000);
  const pendingLive =
    !!contest.pendingUndoBy &&
    !!contest.pendingUndoAt &&
    now - contest.pendingUndoAt < UNDO_TTL_SECONDS;

  async function clearPending() {
    await db
      .update(draftContests)
      .set({ pendingUndoBy: null, pendingUndoTarget: null, pendingUndoAt: null })
      .where(eq(draftContests.id, contest.id));
  }

  // --- request --------------------------------------------------------------
  if (action === "request") {
    if (contest.status !== "DRAFTING" && contest.status !== "TEAM_SELECT") {
      return NextResponse.json({ error: "Draft is not in progress" }, { status: 400 });
    }
    if (pendingLive) {
      return NextResponse.json(
        { error: "An undo is already awaiting approval" },
        { status: 409 }
      );
    }

    // The caller's own most recent pick is the rollback anchor.
    const [mine] = await db
      .select()
      .from(draftPicks)
      .where(and(eq(draftPicks.contestId, contest.id), eq(draftPicks.pickedBy, username)))
      .orderBy(desc(draftPicks.pickNumber))
      .limit(1);

    if (!mine) {
      return NextResponse.json({ error: "You have no picks to undo" }, { status: 400 });
    }

    await db
      .update(draftContests)
      .set({ pendingUndoBy: username, pendingUndoTarget: mine.pickNumber, pendingUndoAt: now })
      .where(eq(draftContests.id, contest.id));

    return NextResponse.json({ ok: true, target: mine.pickNumber });
  }

  // --- cancel (by the requester) -------------------------------------------
  if (action === "cancel") {
    if (contest.pendingUndoBy !== username) {
      return NextResponse.json({ error: "No undo request of yours to cancel" }, { status: 403 });
    }
    await clearPending();
    return NextResponse.json({ ok: true });
  }

  // --- reject (by the other player) ----------------------------------------
  if (action === "reject") {
    if (!contest.pendingUndoBy) {
      return NextResponse.json({ error: "Nothing to reject" }, { status: 400 });
    }
    if (contest.pendingUndoBy === username) {
      return NextResponse.json({ error: "Use cancel for your own request" }, { status: 400 });
    }
    await clearPending();
    return NextResponse.json({ ok: true });
  }

  // --- approve (by the other player) ---------------------------------------
  if (action === "approve") {
    if (!pendingLive) {
      return NextResponse.json(
        { error: "No pending undo (it may have expired)" },
        { status: 409 }
      );
    }
    if (contest.pendingUndoBy === username) {
      return NextResponse.json({ error: "You can't approve your own undo" }, { status: 403 });
    }
    // Only a participant of this contest may approve.
    const participants = await db
      .select()
      .from(contestParticipants)
      .where(eq(contestParticipants.contestId, contest.id));
    if (!participants.some((p) => p.user === username)) {
      return NextResponse.json({ error: "Not a participant" }, { status: 403 });
    }

    const target = contest.pendingUndoTarget!;

    // Atomic rollback in a single libsql batch — pickCount and the pick rows
    // must never drift apart. batch() runs all three statements in one
    // transaction (reliable on Turso HTTP, unlike interactive transactions).
    await db.batch([
      db
        .delete(draftPicks)
        .where(and(eq(draftPicks.contestId, contest.id), gte(draftPicks.pickNumber, target))),
      // Team selections become stale the moment the draft reopens.
      db.delete(teamSelections).where(eq(teamSelections.contestId, contest.id)),
      db
        .update(draftContests)
        .set({
          pickCount: target - 1,
          status: "DRAFTING",
          pendingUndoBy: null,
          pendingUndoTarget: null,
          pendingUndoAt: null,
        })
        .where(eq(draftContests.id, contest.id)),
    ]);

    return NextResponse.json({
      ok: true,
      resumedAt: target,
      currentPicker: order.length ? currentPicker(order, target - 1) : null,
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
