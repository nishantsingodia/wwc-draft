import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, teamSelections } from "@/lib/db";
import { LOCK_BUFFER } from "@/lib/matches";
import { isKnownUser } from "@/lib/users";
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
  const { selectedPlayers, targetUser } = await request.json();

  // The ranking IS the team and the single source of truth: index 0 = highest
  // priority = Captain, index 1 = Vice-Captain. Derive C/VC here so they can
  // never drift from the saved order (and old clients sending stale C/VC can't
  // desync it).
  const ranking: string[] = Array.isArray(selectedPlayers) ? selectedPlayers : [];
  const captainKey = ranking[0] ?? null;
  const viceCaptainKey = ranking[1] ?? null;

  const db = getDb();

  const [contest] = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.code, code.toUpperCase()));

  if (!contest) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (contest.status === "LOCKED" || contest.status === "COMPLETED") {
    return NextResponse.json({ error: "Teams are locked" }, { status: 403 });
  }

  // Whose team to write. In MANUAL mode one person enters both friends' teams from
  // the WhatsApp draft, so any participant may write either known user's selection.
  // In live mode you may only write your own team.
  let writeUser = username;
  if (contest.mode === "manual" && typeof targetUser === "string" && targetUser && targetUser !== username) {
    if (!isKnownUser(targetUser)) {
      return NextResponse.json({ error: "Unknown user" }, { status: 400 });
    }
    writeUser = targetUser;
  }

  // Auto-lock LOCK_BUFFER after match start (see lib/matches.ts) — BOTH live and manual
  // drafts, so no team (either mode) can be edited once the match is underway.
  const now = Math.floor(Date.now() / 1000);
  const isLocked = now >= contest.matchDeadline + LOCK_BUFFER;
  if (isLocked) {
    return NextResponse.json(
      { error: "Teams are locked — the match has started." },
      { status: 403 }
    );
  }

  const now2 = now;

  // Upsert team selection (for writeUser — self, or the other friend in manual mode)
  const existing = await db
    .select()
    .from(teamSelections)
    .where(
      and(
        eq(teamSelections.contestId, contest.id),
        eq(teamSelections.user, writeUser)
      )
    );

  if (existing.length > 0) {
    if (existing[0].isLocked) {
      return NextResponse.json({ error: "That team is locked" }, { status: 403 });
    }
    await db
      .update(teamSelections)
      .set({
        selectedPlayers: JSON.stringify(ranking),
        captainKey,
        viceCaptainKey,
        submittedAt: now2,
        isLocked,
      })
      .where(
        and(
          eq(teamSelections.contestId, contest.id),
          eq(teamSelections.user, writeUser)
        )
      );
  } else {
    await db.insert(teamSelections).values({
      contestId: contest.id,
      user: writeUser,
      selectedPlayers: JSON.stringify(ranking),
      captainKey,
      viceCaptainKey,
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
