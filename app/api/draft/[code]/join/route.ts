import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, contestParticipants } from "@/lib/db";
import { eq } from "drizzle-orm";

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
  const db = getDb();

  const [contest] = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.code, code.toUpperCase()));

  if (!contest) {
    return NextResponse.json({ error: "Contest not found" }, { status: 404 });
  }

  if (contest.status !== "WAITING") {
    // For manual drafts in TEAM_SELECT, still let the second user join as a participant
    if (contest.mode === "manual" && contest.status === "TEAM_SELECT") {
      try {
        await db.insert(contestParticipants).values({
          contestId: contest.id,
          user: username,
          joinedAt: Math.floor(Date.now() / 1000),
        });
      } catch {
        // Unique constraint — already joined, fine
      }
    }
    return NextResponse.json({ status: contest.status, already: true });
  }

  const maxPlayers = contest.maxPlayers ?? 2;
  const now = Math.floor(Date.now() / 1000);

  // Capacity (live only): never seat more than maxPlayers. Re-joining a seat you
  // already hold is always fine — this only blocks a brand-new joiner once full.
  const existing = await db
    .select()
    .from(contestParticipants)
    .where(eq(contestParticipants.contestId, contest.id));
  const alreadyIn = existing.some((p) => p.user === username);
  if (contest.mode === "live" && !alreadyIn && existing.length >= maxPlayers) {
    return NextResponse.json({ error: "This draft is full" }, { status: 403 });
  }

  // Upsert participant
  try {
    await db.insert(contestParticipants).values({
      contestId: contest.id,
      user: username,
      joinedAt: now,
    });
  } catch {
    // Unique constraint — already joined, that's fine
  }

  const participants = await db
    .select()
    .from(contestParticipants)
    .where(eq(contestParticipants.contestId, contest.id));

  const users = participants.map((p) => p.user);

  // Live draft: start only once ALL seats are filled. Manual: creator alone can start.
  const canStart =
    contest.mode === "live" ? users.length >= maxPlayers : users.length >= 1;

  if (canStart) {
    if (contest.mode === "manual") {
      const order = shuffleArray(users);
      await db
        .update(draftContests)
        .set({ status: "TEAM_SELECT", draftOrder: JSON.stringify(order) })
        .where(eq(draftContests.id, contest.id));
      return NextResponse.json({ status: "TEAM_SELECT" });
    }

    if (maxPlayers === 2) {
      // 2-player live: stay WAITING — client shows the interactive coin toss.
      return NextResponse.json({ status: "WAITING", users, awaitingToss: true });
    }

    // 3+ players live: auto-shuffle and start (a visible order reveal comes later).
    const order = shuffleArray(users);
    await db
      .update(draftContests)
      .set({ status: "DRAFTING", draftOrder: JSON.stringify(order) })
      .where(eq(draftContests.id, contest.id));
    return NextResponse.json({ status: "DRAFTING", draftOrder: order });
  }

  return NextResponse.json({ status: "WAITING", users });
}
