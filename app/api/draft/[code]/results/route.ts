import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, teamSelections } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getPlayerByKey } from "@/lib/players";
import { getMatchPoints, toCsvMatchLabel } from "@/lib/points";

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

  // contest.matchLabel is "Match N: TEAM1 v TEAM2"; CSV uses "Match N — TEAM1 v TEAM2"
  const csvLabel = toCsvMatchLabel(contest.matchLabel);
  const pointsMap = await getMatchPoints(csvLabel);

  const teams = selections.map((sel) => {
    const playerKeys: string[] = JSON.parse(sel.selectedPlayers ?? "[]");
    const starters = playerKeys.slice(0, contest.picksPerUser);
    const backups = playerKeys.slice(contest.picksPerUser);

    const mapPlayer = (key: string, isBackup: boolean) => {
      const p = getPlayerByKey(key);
      const displayName = p?.displayName ?? key;
      const rawPts = pointsMap.get(displayName) ?? null;
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
