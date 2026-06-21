import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, teamSelections } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getPlayerByKey } from "@/lib/players";
import { getMatchByKey } from "@/lib/matches";
import { getMatchPointsForMatch, lookupPlayerPoints } from "@/lib/points";

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

  // Match points by teams+date (not the "Match N" label — bot numbering differs).
  const match = getMatchByKey(contest.matchKey);
  const pointsMap = match ? await getMatchPointsForMatch(match) : new Map<string, number>();

  const teams = selections.map((sel) => {
    const playerKeys: string[] = JSON.parse(sel.selectedPlayers ?? "[]");
    const starters = playerKeys.slice(0, contest.picksPerUser);
    const backups = playerKeys.slice(contest.picksPerUser);

    const mapPlayer = (key: string, isBackup: boolean) => {
      const p = getPlayerByKey(key);
      const displayName = p?.displayName ?? key;
      // Identity-first: exact match on the stable Player ID, then fuzzy name fallback.
      const rawPts = lookupPlayerPoints(p?.pid, displayName, p?.name, pointsMap);
      const isCap = key === sel.captainKey && !isBackup;
      const isVC = key === sel.viceCaptainKey && !isBackup;
      const multiplier = isCap ? 2 : isVC ? 1.5 : 1;
      return {
        key,
        name: displayName,
        role: p?.role ?? "BAT",
        team: p?.teamCode ?? "",
        isCaptain: isCap,
        isViceCaptain: isVC,
        isBackup,
        fantasyPoints: rawPts !== null ? rawPts * multiplier : null,
        rawPoints: rawPts,
        efppm: p?.efppm ?? 0,
      };
    };

    const players = [
      ...starters.map((k) => mapPlayer(k, false)),
      ...backups.map((k) => mapPlayer(k, true)),
    ];

    const totalPoints = players
      .filter((p) => !p.isBackup && p.fantasyPoints !== null)
      .reduce((sum, p) => sum + (p.fantasyPoints ?? 0), 0);

    return {
      user: sel.user,
      players,
      captainKey: sel.captainKey,
      viceCaptainKey: sel.viceCaptainKey,
      isLocked: sel.isLocked,
      totalPoints: players.some((p) => p.fantasyPoints !== null) ? totalPoints : null,
    };
  });

  return NextResponse.json({ contest, teams, username });
}
