import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, teamSelections } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getPlayerByKey } from "@/lib/players";
import { getMatchByKey, LOCK_BUFFER } from "@/lib/matches";
import {
  getMatchPointsForMatch,
  getMatchStatusFor,
  getMatchPlayerRecon,
  lookupPlayerPoints,
  lookupPlayerRecon,
} from "@/lib/points";
import { getOfficialLineup } from "@/lib/official-lineup";
import {
  computeEffectiveLineup,
  rankingFromSelection,
  type EffectiveLineup,
  type Change,
} from "@/lib/effective-lineup";

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
  // Official XI + announced status: direct ESPN fetch (live), sheet fallback.
  const [pointsMap, { lastXI, lineupMeta }, matchStatus, reconMap] = await Promise.all([
    match ? getMatchPointsForMatch(match) : Promise.resolve(new Map<string, number>()),
    getOfficialLineup(match),
    match ? getMatchStatusFor(match) : Promise.resolve(null),
    match ? getMatchPlayerRecon(match) : Promise.resolve(new Map<string, string>()),
  ]);

  // BACKUP_INTELLIGENCE eligibility: auto-substitute only once the team is locked
  // (post-deadline, live mode) AND both teams' official XIs are announced. Before
  // that we pass the team through unchanged and never freeze a decision — the user
  // can still hand-fix their team while lineups trickle in.
  const t1 = match?.team1 ?? "";
  const t2 = match?.team2 ?? "";
  const announced = !!(t1 && t2 && lineupMeta.get(t1)?.announced && lineupMeta.get(t2)?.announced);
  const nowSec = Math.floor(Date.now() / 1000);
  const eligible =
    contest.mode === "live" && nowSec >= contest.matchDeadline + LOCK_BUFFER && announced;

  const teams = await Promise.all(
    selections.map(async (sel) => {
      const playerKeys: string[] = JSON.parse(sel.selectedPlayers ?? "[]");
      // Float legacy C/VC to the ranking head so the engine reads ranks #1/#2
      // correctly for both old and new rows (no-op for new saves).
      const ranking = rankingFromSelection(playerKeys, sel.captainKey, sel.viceCaptainKey);

      // Effective XI = top picksPerUser PLAYING by rank, with C/VC cascaded. Serve
      // the frozen decision once computed; otherwise compute (and freeze if eligible).
      let eff: EffectiveLineup;
      if (eligible && sel.effectiveComputedAt && sel.effectiveLineup) {
        const fz = JSON.parse(sel.effectiveLineup) as {
          xi: string[];
          captainKey: string | null;
          viceCaptainKey: string | null;
        };
        const changes = sel.effectiveChanges
          ? (JSON.parse(sel.effectiveChanges) as Change[])
          : [];
        eff = { ...fz, changes };
      } else {
        eff = computeEffectiveLineup({
          ranking,
          picksPerUser: contest.picksPerUser,
          teamXIByTeam: lastXI,
          resolve: getPlayerByKey,
          inMatchTeams: [t1, t2],
          // Substitute only when fully eligible (locked + announced); otherwise
          // the engine passes through and we don't persist anything.
          announced: eligible,
        });
        if (eligible) {
          await db
            .update(teamSelections)
            .set({
              effectiveLineup: JSON.stringify({
                xi: eff.xi,
                captainKey: eff.captainKey,
                viceCaptainKey: eff.viceCaptainKey,
              }),
              effectiveChanges: JSON.stringify(eff.changes),
              effectiveComputedAt: nowSec,
            })
            .where(eq(teamSelections.id, sel.id));
        }
      }

      const effSet = new Set(eff.xi);
      // Bench = everyone in the squad not in the effective XI (dropped dead
      // starters fall here; promoted backups move up into the XI).
      const benchKeys = ranking.filter((k) => !effSet.has(k));

      const mapPlayer = (key: string, isBackup: boolean) => {
        const p = getPlayerByKey(key);
        const displayName = p?.displayName ?? key;
        // Identity-first: exact match on the stable Player ID, then fuzzy name fallback.
        const rawPts = lookupPlayerPoints(p?.pid, displayName, p?.name, pointsMap);
        const isCap = key === eff.captainKey && !isBackup;
        const isVC = key === eff.viceCaptainKey && !isBackup;
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
          // Per-player recon marker ("⏳ unreconciled" / "⚠ official revision"), null when settled.
          recon: lookupPlayerRecon(p?.pid, displayName, p?.name, reconMap),
        };
      };

      const players = [
        ...eff.xi.map((k) => mapPlayer(k, false)),
        ...benchKeys.map((k) => mapPlayer(k, true)),
      ];

      const totalPoints = players
        .filter((p) => !p.isBackup && p.fantasyPoints !== null)
        .reduce((sum, p) => sum + (p.fantasyPoints ?? 0), 0);

      return {
        user: sel.user,
        players,
        captainKey: eff.captainKey,
        viceCaptainKey: eff.viceCaptainKey,
        isLocked: sel.isLocked,
        totalPoints: players.some((p) => p.fantasyPoints !== null) ? totalPoints : null,
        // What BACKUP_INTELLIGENCE changed (empty when nothing moved / not eligible).
        changes: eff.changes,
      };
    })
  );

  return NextResponse.json({ contest, teams, username, announced, matchStatus });
}
