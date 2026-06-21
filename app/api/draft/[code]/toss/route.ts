import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, contestParticipants } from "@/lib/db";
import { eq } from "drizzle-orm";

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
  const body = await request.json();
  const { call, winner: directWinner } = body; // call = "H"|"T" (digital toss), OR winner = username (real toss already happened)

  const db = getDb();

  const [contest] = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.code, code.toUpperCase()));

  if (!contest) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (contest.status !== "WAITING") {
    return NextResponse.json({ error: "Toss already done" }, { status: 409 });
  }
  if (contest.createdBy !== username) {
    return NextResponse.json({ error: "Only the creator calls the toss" }, { status: 403 });
  }

  const participants = await db
    .select()
    .from(contestParticipants)
    .where(eq(contestParticipants.contestId, contest.id));

  const users = participants.map((p) => p.user);
  if (users.length < 2) {
    return NextResponse.json({ error: "Need 2 players for toss" }, { status: 400 });
  }

  let draftOrder: string[];

  if (directWinner) {
    // Real toss already happened — creator directly names who picks first
    if (!users.includes(directWinner)) {
      return NextResponse.json({ error: "Invalid winner" }, { status: 400 });
    }
    draftOrder = [directWinner, ...users.filter((u) => u !== directWinner)];
    await db
      .update(draftContests)
      .set({ status: "DRAFTING", draftOrder: JSON.stringify(draftOrder) })
      .where(eq(draftContests.id, contest.id));
    return NextResponse.json({ result: null, call: null, callerWins: true, winner: directWinner, draftOrder });
  }

  // Digital coin toss
  if (call !== "H" && call !== "T") {
    return NextResponse.json({ error: "Invalid call" }, { status: 400 });
  }

  const result: "H" | "T" = Math.random() < 0.5 ? "H" : "T";
  const callerWins = call === result;

  const others = users.filter((u) => u !== username);
  draftOrder = callerWins ? [username, ...others] : [...others, username];

  await db
    .update(draftContests)
    .set({ status: "DRAFTING", draftOrder: JSON.stringify(draftOrder) })
    .where(eq(draftContests.id, contest.id));

  return NextResponse.json({
    result,
    call,
    callerWins,
    winner: draftOrder[0],
    draftOrder,
  });
}
