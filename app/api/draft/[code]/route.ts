import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, draftPicks, contestParticipants, teamSelections, UNDO_TTL_SECONDS } from "@/lib/db";
import { eq, asc } from "drizzle-orm";
import { getPlayersByTeams } from "@/lib/players";
import { getMatchByKey } from "@/lib/matches";
import { currentPicker } from "@/lib/snake-draft";
import { getSheetRoster, getTourPoints, lookupTourPoints } from "@/lib/points";
import { getOfficialLineup } from "@/lib/official-lineup";

export async function GET(
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
  const db = getDb();

  const [contest] = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.code, code.toUpperCase()));

  if (!contest) {
    return NextResponse.json({ error: "Contest not found" }, { status: 404 });
  }

  const picks = await db
    .select()
    .from(draftPicks)
    .where(eq(draftPicks.contestId, contest.id))
    .orderBy(asc(draftPicks.pickNumber));

  const participants = await db
    .select()
    .from(contestParticipants)
    .where(eq(contestParticipants.contestId, contest.id));

  const mySelection = await db
    .select()
    .from(teamSelections)
    .where(eq(teamSelections.contestId, contest.id));

  const match = getMatchByKey(contest.matchKey);
  // The two teams in this match — also the tour scope for tour-points (a player's
  // total is summed only over these teams' rows, never other tours in the sheet).
  const t1 = match?.team1 ?? "NZ";
  const t2 = match?.team2 ?? "SL";
  // Official XI + announced status: direct ESPN fetch (live), sheet fallback.
  // Pass `match` to getTourPoints so it scopes to THIS tour's tab — team codes repeat
  // across bilateral tours (India is "MIND" in both the Ireland and England series).
  const [{ lastXI, lineupMeta }, sheetRoster, tourPoints] = await Promise.all([
    getOfficialLineup(match),
    getSheetRoster(),
    getTourPoints(t1, t2, match),
  ]);

  const pool = match
    ? getPlayersByTeams(match.team1, match.team2, lastXI, sheetRoster)
    : getPlayersByTeams("NZ", "SL", lastXI, sheetRoster);

  // Lineup status (Dream11-style "lineups out" + toss), per the two teams.
  const m1 = lineupMeta.get(t1) ?? { announced: false, toss: null };
  const m2 = lineupMeta.get(t2) ?? { announced: false, toss: null };
  const lineups = {
    announced: m1.announced && m2.announced, // both teams' XIs are official
    toss: m1.toss || m2.toss || null,
    perTeam: { [t1]: m1.announced, [t2]: m2.announced } as Record<string, boolean>,
  };

  const playerPool = pool.map((p) => ({
    key: p.key,
    displayName: p.displayName,
    role: p.role,
    teamCode: p.teamCode,
    efppm: p.efppm,
    tourPoints: lookupTourPoints(p.pid, p.displayName, p.name, tourPoints),
    isLikelyXI: p.isLikelyXI,
    takenBy: picks.find((pk) => pk.playerKey === p.key)?.pickedBy ?? null,
  }));

  const order = contest.draftOrder ? JSON.parse(contest.draftOrder) : null;
  const picker =
    contest.status === "DRAFTING" && order
      ? currentPicker(order, contest.pickCount)
      : null;

  const totalPicks = order
    ? order.length * (contest.picksPerUser + contest.backupsPerUser)
    : 0;

  // Pending-undo handshake state (null unless a live, non-expired request exists).
  const nowSec = Math.floor(Date.now() / 1000);
  const undoLive =
    !!contest.pendingUndoBy &&
    !!contest.pendingUndoAt &&
    nowSec - contest.pendingUndoAt < UNDO_TTL_SECONDS;
  const pendingUndo =
    undoLive && contest.pendingUndoTarget != null
      ? {
          by: contest.pendingUndoBy!,
          target: contest.pendingUndoTarget,
          requestedAt: contest.pendingUndoAt!,
          // Picks that will return to the pool, in draft order.
          discarded: picks
            .filter((p) => p.pickNumber >= contest.pendingUndoTarget!)
            .map((p) => ({
              playerKey: p.playerKey,
              playerName: p.playerName,
              playerTeam: p.playerTeam,
              playerRole: p.playerRole,
              pickedBy: p.pickedBy,
              pickNumber: p.pickNumber,
            })),
          // Whose turn it becomes after the rollback (computed, not assumed).
          resumePicker: order ? currentPicker(order, contest.pendingUndoTarget - 1) : null,
        }
      : null;

  return NextResponse.json({
    contest: {
      ...contest,
      draftOrder: order,
    },
    participants: participants.map((p) => p.user),
    picks,
    playerPool,
    currentPicker: picker,
    isMyTurn: picker === username,
    totalPicks,
    pendingUndo,
    lineups,
    mySelection: mySelection.find((s) => s.user === username) ?? null,
    allSelections: mySelection,
    username,
    takenCount: picks.length,
  });
}

export async function DELETE(
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
  const db = getDb();

  const [contest] = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.code, code.toUpperCase()));

  if (!contest) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (contest.createdBy !== username) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (contest.status === "COMPLETED") return NextResponse.json({ error: "Cannot delete a completed draft" }, { status: 400 });

  await db.delete(draftPicks).where(eq(draftPicks.contestId, contest.id));
  await db.delete(teamSelections).where(eq(teamSelections.contestId, contest.id));
  await db.delete(contestParticipants).where(eq(contestParticipants.contestId, contest.id));
  await db.delete(draftContests).where(eq(draftContests.id, contest.id));

  return NextResponse.json({ ok: true });
}
