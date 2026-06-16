import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, teamSelections } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getPlayerByKey } from "@/lib/players";

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

  const selections = await db
    .select()
    .from(teamSelections)
    .where(eq(teamSelections.contestId, contest.id));

  // TODO: fetch actual match fantasy points from Google Sheet or auction DB
  // For now return placeholder structure so frontend can render
  const teams = selections.map((sel) => {
    const playerKeys: string[] = JSON.parse(sel.selectedPlayers ?? "[]");
    const players = playerKeys.map((key) => {
      const p = getPlayerByKey(key);
      return {
        key,
        name: p?.displayName ?? key,
        role: p?.role ?? "BAT",
        team: p?.teamCode ?? "",
        isCaptain: key === sel.captainKey,
        isViceCaptain: key === sel.viceCaptainKey,
        fantasyPoints: null as number | null, // populated from live data
        efppm: p?.efppm ?? 0,
      };
    });

    return {
      user: sel.user,
      players,
      captainKey: sel.captainKey,
      viceCaptainKey: sel.viceCaptainKey,
      isLocked: sel.isLocked,
      totalPoints: null as number | null,
    };
  });

  return NextResponse.json({ contest, teams, username });
}
