import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  getDb,
  draftContests,
  draftQueues,
  contestParticipants,
} from "@/lib/db";
import { eq } from "drizzle-orm";
import { getPlayerByKey } from "@/lib/players";
import { currentPicker } from "@/lib/snake-draft";
import { resolveAutopicks } from "@/lib/autopick";

/**
 * Save (upsert) the caller's server-side autopick queue for a contest.
 *
 * Body: { playerKeys: string[] } — an ordered list of pool player_keys. An empty
 * array clears the queue. The queue is durable, so it auto-fires on the user's
 * turn even with no browser open (see lib/autopick.ts). If it becomes the
 * caller's turn to have already arrived, the cascade fires the queued pick(s)
 * immediately server-side.
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
  const body = await request.json().catch(() => ({}));
  const raw = Array.isArray(body?.playerKeys) ? body.playerKeys : null;
  if (!raw) {
    return NextResponse.json({ error: "playerKeys must be an array" }, { status: 400 });
  }

  const db = getDb();

  const [contest] = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.code, code.toUpperCase()));

  if (!contest) {
    return NextResponse.json({ error: "Contest not found" }, { status: 404 });
  }

  // Only a participant can set a queue for this contest.
  const participants = await db
    .select()
    .from(contestParticipants)
    .where(eq(contestParticipants.contestId, contest.id));
  if (!participants.some((p) => p.user === username)) {
    return NextResponse.json({ error: "Not a participant" }, { status: 403 });
  }

  // Sanitise: strings only, real pool players, de-duped, order preserved, capped
  // at the most a user could ever pick.
  const maxLen = contest.picksPerUser + contest.backupsPerUser;
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const k of raw) {
    if (typeof k !== "string" || seen.has(k) || !getPlayerByKey(k)) continue;
    seen.add(k);
    clean.push(k);
    if (clean.length >= maxLen) break;
  }

  const now = Math.floor(Date.now() / 1000);
  await db
    .insert(draftQueues)
    .values({
      contestId: contest.id,
      user: username,
      playerKeys: JSON.stringify(clean),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [draftQueues.contestId, draftQueues.user],
      set: { playerKeys: JSON.stringify(clean), updatedAt: now },
    });

  // If it's already this user's turn, fire the queued pick(s) now — server-side.
  const order = JSON.parse(contest.draftOrder ?? "[]") as string[];
  let result = { pickCount: contest.pickCount, status: contest.status as string };
  if (
    contest.status === "DRAFTING" &&
    order.length > 0 &&
    currentPicker(order, contest.pickCount) === username
  ) {
    result = await resolveAutopicks(contest.id);
  }

  return NextResponse.json({
    ok: true,
    playerKeys: clean,
    pickCount: result.pickCount,
    status: result.status,
  });
}
