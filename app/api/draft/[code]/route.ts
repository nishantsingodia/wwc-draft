import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, draftPicks, contestParticipants, teamSelections } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getPlayersByTeams } from "@/lib/players";
import { getMatchByKey } from "@/lib/matches";
import { currentPicker } from "@/lib/snake-draft";
import { getLastPlayedXI } from "@/lib/points";

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
    .where(eq(draftPicks.contestId, contest.id));

  const participants = await db
    .select()
    .from(contestParticipants)
    .where(eq(contestParticipants.contestId, contest.id));

  const mySelection = await db
    .select()
    .from(teamSelections)
    .where(eq(teamSelections.contestId, contest.id));

  const match = getMatchByKey(contest.matchKey);
  const lastXI = await getLastPlayedXI();

  const pool = match
    ? getPlayersByTeams(match.team1, match.team2, lastXI)
    : getPlayersByTeams("NZ", "SL", lastXI);

  const playerPool = pool.map((p) => ({
    key: p.key,
    displayName: p.displayName,
    role: p.role,
    teamCode: p.teamCode,
    efppm: p.efppm,
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
    mySelection: mySelection.find((s) => s.user === username) ?? null,
    allSelections: mySelection,
    username,
    takenCount: picks.length,
  });
}
