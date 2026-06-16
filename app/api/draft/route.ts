import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests } from "@/lib/db";
import { generateCode } from "@/lib/generate-code";
import { getMatchByKey } from "@/lib/matches";

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

  const code = generateCode();
  const now = Math.floor(Date.now() / 1000);

  try {
    const db = getDb();
    await db.insert(draftContests).values({
      code,
      matchKey: match.key,
      matchLabel: match.label,
      matchDeadline: match.deadlineTs,
      picksPerUser: Number(picksPerUser) || 11,
      backupsPerUser: Number(backupsPerUser) || 4,
      mode: mode === "manual" ? "manual" : "live",
      status: "WAITING",
      draftOrder: null,
      pickCount: 0,
      createdBy: username,
      createdAt: now,
    });

    return NextResponse.json({ code, matchLabel: match.label });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }
}
