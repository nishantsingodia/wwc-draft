import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, teamSelections } from "@/lib/db";
import { eq, and } from "drizzle-orm";

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

  if (!contest) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [selection] = await db
    .select()
    .from(teamSelections)
    .where(
      and(
        eq(teamSelections.contestId, contest.id),
        eq(teamSelections.user, username)
      )
    );

  return NextResponse.json({ selection: selection ?? null, contest });
}

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
  const { selectedPlayers, captainKey, viceCaptainKey } = await request.json();

  const db = getDb();

  const [contest] = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.code, code.toUpperCase()));

  if (!contest) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (contest.status === "LOCKED" || contest.status === "COMPLETED") {
    return NextResponse.json({ error: "Teams are locked" }, { status: 403 });
  }

  // Auto-lock only for live drafts past deadline; manual drafts never auto-lock
  const now = Math.floor(Date.now() / 1000);
  const isLocked = contest.mode === "live" && now >= contest.matchDeadline;

  const now2 = now;

  // Upsert team selection
  const existing = await db
    .select()
    .from(teamSelections)
    .where(
      and(
        eq(teamSelections.contestId, contest.id),
        eq(teamSelections.user, username)
      )
    );

  if (existing.length > 0) {
    if (existing[0].isLocked) {
      return NextResponse.json({ error: "Your team is locked" }, { status: 403 });
    }
    await db
      .update(teamSelections)
      .set({
        selectedPlayers: JSON.stringify(selectedPlayers),
        captainKey: captainKey ?? null,
        viceCaptainKey: viceCaptainKey ?? null,
        submittedAt: now2,
        isLocked,
      })
      .where(
        and(
          eq(teamSelections.contestId, contest.id),
          eq(teamSelections.user, username)
        )
      );
  } else {
    await db.insert(teamSelections).values({
      contestId: contest.id,
      user: username,
      selectedPlayers: JSON.stringify(selectedPlayers),
      captainKey: captainKey ?? null,
      viceCaptainKey: viceCaptainKey ?? null,
      submittedAt: now2,
      isLocked,
    });
  }

  // Lock contest if deadline passed
  const statuses = ["WAITING", "DRAFTING", "TEAM_SELECT", "LOCKED", "COMPLETED"] as const;
  if (isLocked && (contest.status as string) !== "LOCKED") {
    await db
      .update(draftContests)
      .set({ status: "LOCKED" as typeof statuses[number] })
      .where(eq(draftContests.id, contest.id));
  }

  return NextResponse.json({ ok: true, isLocked });
}
