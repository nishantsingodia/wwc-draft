import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, contestParticipants } from "@/lib/db";
import { generateCode } from "@/lib/generate-code";
import { getMatchByKey } from "@/lib/matches";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  let username: string;
  try {
    username = await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { matchKey, picksPerUser, backupsPerUser, mode } = await request.json();

  const match = getMatchByKey(matchKey);
  if (!match) {
    return NextResponse.json({ error: "Invalid match" }, { status: 400 });
  }

  // Coerce carefully. `Number(x) || default` turns a legit 0 into the default
  // (`0 || 4 === 4`), which silently gave every "0 backups" draft 4 backups —
  // the live draft then kept asking for backup picks. A finite + range check
  // honours 0 backups.
  const ppuNum = Number(picksPerUser);
  const bpuNum = Number(backupsPerUser);
  const resolvedPicks = Number.isFinite(ppuNum) && ppuNum >= 1 ? Math.floor(ppuNum) : 11;
  const resolvedBackups = Number.isFinite(bpuNum) && bpuNum >= 0 ? Math.floor(bpuNum) : 4;

  const code = generateCode();
  const now = Math.floor(Date.now() / 1000);

  try {
    const db = getDb();
    await db.insert(draftContests).values({
      code,
      matchKey: match.key,
      matchLabel: match.label,
      matchDeadline: match.deadlineTs,
      picksPerUser: resolvedPicks,
      backupsPerUser: resolvedBackups,
      mode: mode === "manual" ? "manual" : "live",
      status: "WAITING",
      draftOrder: null,
      pickCount: 0,
      createdBy: username,
      createdAt: now,
    });

    // Add creator to participants immediately so the draft appears in their lobby
    const [contest] = await db
      .select()
      .from(draftContests)
      .where(eq(draftContests.code, code));
    if (contest) {
      await db.insert(contestParticipants).values({
        contestId: contest.id,
        user: username,
        joinedAt: now,
      });
    }

    return NextResponse.json({ code, matchLabel: match.label });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }
}
