import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  getDb,
  draftContests,
  draftPicks,
  teamSelections,
  draftQueues,
  UNDO_TTL_SECONDS,
} from "@/lib/db";
import { and, eq, gte, desc } from "drizzle-orm";
import { currentPicker } from "@/lib/snake-draft";

/**
 * Undo a pick via an N-player approval handshake.
 *
 * Flow (body `{ action }`):
 *  - "request":  caller asks to roll the draft back to THEIR own last pick.
 *                Everything from that pick onward is discarded — the requester's
 *                own later picks AND any picks OTHER players made after it. Every
 *                player who'd lose a pick (the "affected" set, excluding the
 *                requester) must approve. If NO one else is affected, it executes
 *                instantly with no handshake.
 *  - "approve":  an affected player confirms. Once every affected player has
 *                approved, the rollback fires atomically: delete picks >= target,
 *                clear now-stale team selections + autopick queues, reset
 *                pickCount/status, clear the pending request.
 *  - "reject":   any affected player declines → clears the pending request.
 *  - "cancel":   the requester withdraws their own pending request.
 *
 * Picks are blocked while a request is pending (see pick/route.ts), so the set
 * of discarded picks — and thus the affected approvers — can't shift under them.
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
      .set({
        pendingUndoBy: null,
        pendingUndoTarget: null,
        pendingUndoAt: null,
        pendingUndoApprovals: null,
      })
      .where(eq(draftContests.id, contest.id));
  }

  // Players (other than `requester`) who'd lose a pick if we roll back to `target`
  // — i.e. distinct owners of any pick with pick_number >= target. These are the
  // ones whose approval is required. Picks are frozen while an undo is pending, so
  // this set is stable between request and approve.
  async function affectedApprovers(target: number, requester: string): Promise<string[]> {
    const rows = await db
      .select({ pickedBy: draftPicks.pickedBy })
      .from(draftPicks)
      .where(and(eq(draftPicks.contestId, contest.id), gte(draftPicks.pickNumber, target)));
    return [...new Set(rows.map((r) => r.pickedBy))].filter((u) => u !== requester);
  }

  // The atomic rollback — shared by the instant path (request with no one else
  // affected) and the approve path once consensus is reached.
  async function doRollback(target: number) {
    await db.batch([
      db
        .delete(draftPicks)
        .where(and(eq(draftPicks.contestId, contest.id), gte(draftPicks.pickNumber, target))),
      // Team selections become stale the moment the draft reopens.
      db.delete(teamSelections).where(eq(teamSelections.contestId, contest.id)),
      // Wipe autopick queues so a rolled-back player isn't instantly re-grabbed.
      db.delete(draftQueues).where(eq(draftQueues.contestId, contest.id)),
      db
        .update(draftContests)
        .set({
          pickCount: target - 1,
          status: "DRAFTING",
          pendingUndoBy: null,
          pendingUndoTarget: null,
          pendingUndoAt: null,
          pendingUndoApprovals: null,
        })
        .where(eq(draftContests.id, contest.id)),
    ]);
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

    const target = mine.pickNumber;
    const affected = await affectedApprovers(target, username);

    // No one else loses a pick → nothing to get consensus on. Roll back at once.
    if (affected.length === 0) {
      await doRollback(target);
      return NextResponse.json({
        ok: true,
        instant: true,
        resumedAt: target,
        currentPicker: order.length ? currentPicker(order, target - 1) : null,
      });
    }

    await db
      .update(draftContests)
      .set({
        pendingUndoBy: username,
        pendingUndoTarget: target,
        pendingUndoAt: now,
        pendingUndoApprovals: JSON.stringify([]),
      })
      .where(eq(draftContests.id, contest.id));

    return NextResponse.json({ ok: true, target, needsApproval: affected });
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

  // --- approve (by an affected player) -------------------------------------
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

    const target = contest.pendingUndoTarget!;
    const affected = await affectedApprovers(target, contest.pendingUndoBy!);

    // Only a player who'd actually lose a pick gets a vote.
    if (!affected.includes(username)) {
      return NextResponse.json(
        { error: "You have no picks affected by this undo" },
        { status: 403 }
      );
    }

    // Record this approval (dedupe).
    let approvals: string[] = [];
    try {
      const parsed = JSON.parse(contest.pendingUndoApprovals ?? "[]");
      if (Array.isArray(parsed)) approvals = parsed;
    } catch {
      /* corrupt → treat as empty */
    }
    if (!approvals.includes(username)) approvals.push(username);

    // Everyone affected has approved → execute the rollback atomically.
    const allApproved = affected.every((u) => approvals.includes(u));
    if (allApproved) {
      await doRollback(target);
      return NextResponse.json({
        ok: true,
        resumedAt: target,
        currentPicker: order.length ? currentPicker(order, target - 1) : null,
      });
    }

    // Otherwise just record the approval and keep waiting for the rest.
    await db
      .update(draftContests)
      .set({ pendingUndoApprovals: JSON.stringify(approvals) })
      .where(eq(draftContests.id, contest.id));
    return NextResponse.json({
      ok: true,
      waitingOn: affected.filter((u) => !approvals.includes(u)),
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
