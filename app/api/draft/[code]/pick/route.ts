import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, draftPicks, UNDO_TTL_SECONDS } from "@/lib/db";
import { eq } from "drizzle-orm";
import { currentPicker, isDraftComplete } from "@/lib/snake-draft";
import { getPlayerByKey } from "@/lib/players";

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
  const { playerKey } = await request.json();

  const db = getDb();

  const [contest] = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.code, code.toUpperCase()));

  if (!contest) {
    return NextResponse.json({ error: "Contest not found" }, { status: 404 });
  }

  if (contest.status !== "DRAFTING") {
    return NextResponse.json({ error: "Draft not active" }, { status: 400 });
  }

  // Freeze picking while an undo is awaiting approval, so the set of picks the
  // approver is reviewing can't shift under them.
  const now = Math.floor(Date.now() / 1000);
  if (
    contest.pendingUndoBy &&
    contest.pendingUndoAt &&
    now - contest.pendingUndoAt < UNDO_TTL_SECONDS
  ) {
    return NextResponse.json(
      { error: "An undo is pending — resolve it before picking" },
      { status: 409 }
    );
  }

  const order = JSON.parse(contest.draftOrder ?? "[]") as string[];
  const picker = currentPicker(order, contest.pickCount);

  if (picker !== username) {
    return NextResponse.json({ error: "Not your turn" }, { status: 403 });
  }

  const player = getPlayerByKey(playerKey);
  if (!player) {
    return NextResponse.json({ error: "Player not found" }, { status: 400 });
  }

  try {
    await db.insert(draftPicks).values({
      contestId: contest.id,
      pickedBy: username,
      playerKey: player.key,
      playerName: player.displayName,
      playerRole: player.role,
      playerTeam: player.teamCode,
      pickNumber: contest.pickCount + 1,
      pickedAt: now,
    });
  } catch {
    return NextResponse.json(
      { error: "Player already picked" },
      { status: 409 }
    );
  }

  const newPickCount = contest.pickCount + 1;
  const done = isDraftComplete(
    order,
    newPickCount,
    contest.picksPerUser,
    contest.backupsPerUser
  );

  await db
    .update(draftContests)
    .set({
      pickCount: newPickCount,
      status: done ? "TEAM_SELECT" : "DRAFTING",
    })
    .where(eq(draftContests.id, contest.id));

  return NextResponse.json({
    ok: true,
    pickNumber: newPickCount,
    draftComplete: done,
    nextPicker: done ? null : currentPicker(order, newPickCount),
  });
}
