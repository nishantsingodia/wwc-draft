import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, teamSelections } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getPlayerByKey, getByTeamCode, getPlayerPhoto } from "@/lib/players";
import { getMatchByKey, LOCK_BUFFER } from "@/lib/matches";
import {
  getMatchPointsForMatch,
  getMatchStatusFor,
  getMatchPlayerRecon,
  lookupPlayerPoints,
  lookupPlayerRecon,
  isMatchCompleted,
  getSettledPointsForMatch,
} from "@/lib/points";
import {
  auditMatch,
  auditContest,
  type PlayerAudit,
  type ContestAudit,
} from "@/lib/settlement-audit";
import { calcSelectionPoints } from "@/lib/contest-scoring";
import { getLiveMatchPoints, type LiveStatus } from "@/lib/espn";
import { getMatchDelay } from "@/lib/match-delay";
import { getOfficialLineup } from "@/lib/official-lineup";
import { tourRulesFor } from "@/lib/tour-rules";
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

  const nowSec = Math.floor(Date.now() / 1000);
  // Manual rain/delay override extends the effective deadline (team-lock, "started",
  // BACKUP_INTELLIGENCE eligibility) so a delayed toss doesn't prematurely lock/score.
  const matchDelay = match ? await getMatchDelay(contest.matchKey) : 0;
  const effDeadline = contest.matchDeadline + matchDelay;
  const started = nowSec >= effDeadline;
  // LIVE provisional scoring: while a match has started but the COMPLETED pipeline hasn't
  // finalized it, score the H2H from a fresh ESPN scorecard (zero cricapi, no bot run).
  // Once COMPLETED, we read the bot's reconciled sheet exactly as before — that path is
  // untouched. `?fresh=1` (the Refresh tap) busts the 20s ESPN cache for an instant pull.
  const completed = match ? await isMatchCompleted(match) : true;
  const wantFresh = new URL(request.url).searchParams.get("fresh") === "1";
  const liveScore =
    match && started && !completed ? await getLiveMatchPoints(match, { fresh: wantFresh }) : null;
  // Use the live ESPN map only once play has actually begun (anyStats). Before the first ball
  // ESPN posts the XI but no figures, so the live map would show every starter at +4 (as if
  // scoring started) — stay on the sheet until real bat/bowl numbers appear.
  const useLive = !!liveScore && liveScore.anyStats;
  const scoringMap = useLive ? liveScore!.points : pointsMap;
  const pointsSource: "live-espn" | "sheet" = useLive ? "live-espn" : "sheet";
  // Player headshots from the same live ESPN fetch — available once the XI is posted (even
  // pre-first-ball, so independent of useLive). Keyed like the points map; silhouettes were
  // already filtered out in lib/espn.ts, so a miss cleanly falls back to the flag in the UI.
  const photoMap: Map<string, string> = liveScore?.photos ?? new Map();

  // BACKUP_INTELLIGENCE eligibility: auto-substitute only once the team is locked
  // (post-deadline, live mode) AND both teams' official XIs are announced. Before
  // that we pass the team through unchanged and never freeze a decision — the user
  // can still hand-fix their team while lineups trickle in.
  const t1 = match?.team1 ?? "";
  const t2 = match?.team2 ?? "";
  const announced = !!(
    t1 && t2 &&
    getByTeamCode(lineupMeta, t1)?.announced &&
    getByTeamCode(lineupMeta, t2)?.announced
  );
  const eligible =
    contest.mode === "live" && nowSec >= effDeadline + LOCK_BUFFER && announced;
  // Impact Player tours (LPL) disable auto-substitution: a non-XI pick may still
  // be named the impact sub, so we keep the drafted XI as-is. See lib/tour-rules.ts.
  const backupIntelligence = match ? tourRulesFor(match).backupIntelligence : true;

  const teams = await Promise.all(
    selections.map(async (sel) => {
      const playerKeys: string[] = JSON.parse(sel.selectedPlayers ?? "[]");
      // Float legacy C/VC to the ranking head so the engine reads ranks #1/#2
      // correctly for both old and new rows (no-op for new saves).
      const ranking = rankingFromSelection(playerKeys, sel.captainKey, sel.viceCaptainKey);

      // Effective XI = top picksPerUser PLAYING by rank, with C/VC cascaded. Serve
      // the frozen decision once computed; otherwise compute (and freeze if eligible).
      const frozenChanges: Change[] = sel.effectiveChanges
        ? (JSON.parse(sel.effectiveChanges) as Change[])
        : [];
      // A lineup set by an APPROVED AMENDMENT is authoritative on its own — it was
      // decided by people and signed off by everyone with a stake, so it doesn't need
      // the `eligible` gate (which is false for every manual-mode contest, and flips
      // false again if a lineup un-announces). Serving it unconditionally is what makes
      // "we score exactly what was approved" true rather than usually true.
      const byAmendment = frozenChanges.some((c) => c.type === "amendment");
      let eff: EffectiveLineup;
      if ((eligible || byAmendment) && sel.effectiveComputedAt && sel.effectiveLineup) {
        const fz = JSON.parse(sel.effectiveLineup) as {
          xi: string[];
          captainKey: string | null;
          viceCaptainKey: string | null;
        };
        eff = { ...fz, changes: frozenChanges };
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
          // Impact Player tours never sub (keep the drafted XI as-is).
          backupIntelligence,
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
        const rawPts = lookupPlayerPoints(p?.pid, displayName, p?.name, scoringMap, useLive);
        // Harvested static photo (by stable pid — works for live AND completed matches)
        // first; the live ESPN roster photo is a supplement for anyone not in the static map.
        const photo =
          getPlayerPhoto(p?.pid) ??
          (p?.pid ? photoMap.get(p.pid) : undefined) ??
          photoMap.get(displayName) ??
          (p?.name ? photoMap.get(p.name) : undefined) ??
          null;
        const isCap = key === eff.captainKey && !isBackup;
        const isVC = key === eff.viceCaptainKey && !isBackup;
        const multiplier = isCap ? 2 : isVC ? 1.5 : 1;
        // LIVE per-player status (batting/bowling facet + one-line summary) — only meaningful
        // while the match is live (liveScore is non-null only then), same fallback chain as
        // the live points/photos. Null once completed → the results page shows no live chips.
        const live: LiveStatus | null =
          liveScore?.status.get(p?.pid ?? "") ??
          liveScore?.status.get(displayName) ??
          (p?.name ? liveScore?.status.get(p.name) : undefined) ??
          null;
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
          photo,
          live,
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

  // ── Settlement audit (completed matches only) ────────────────────────────────────────
  // The sheet is rewritten in place every bot run, so a settled result can move silently —
  // cricsheet landing on LPL/the Hundred zeroed players whose official-card spelling didn't
  // resolve, on matches already badged COMPLETED. Compare the bot's WRITE-ONCE settled baseline
  // against what this route just scored, using the SAME per-selection scorer for both sides so
  // "then" and "now" can never drift apart the way the lobby and results totals once did.
  // Skipped while live: nothing is settled yet, so there is nothing to audit.
  let audit: {
    changed: boolean;
    noBaseline: boolean;
    /** L2 recon NOT finished — your action outstanding; the shown number is still the settled one. */
    pending: PlayerAudit[];
    /** L2 recon finished and the number moved — the re-settle list. */
    changedRows: PlayerAudit[];
    pendingAbsDelta: number;
    players: PlayerAudit[];
    orphans: { name: string; points: number }[];
    totals: ContestAudit["totals"];
    winnerChanged: boolean;
    settledWinners: string[];
    currentWinners: string[];
  } | null = null;
  if (match && completed) {
    const [matchAudit, settledPts] = await Promise.all([
      auditMatch(match),
      getSettledPointsForMatch(match),
    ]);
    const score = (user: string, pts: Map<string, number>) => {
      const sel = selections.find((s) => s.user === user);
      return sel ? calcSelectionPoints(sel, contest.picksPerUser, pts) : null;
    };
    const ca = auditContest(selections.map((s) => s.user), score, settledPts, pointsMap);
    audit = {
      changed: matchAudit.changed,
      noBaseline: matchAudit.noBaseline,
      pending: matchAudit.pending,
      changedRows: matchAudit.changedRows,
      pendingAbsDelta: matchAudit.pendingAbsDelta,
      // Only rows worth reading: an unchanged player is noise on this tab.
      players: matchAudit.players.filter((p) => p.reason !== "UNCHANGED"),
      orphans: matchAudit.orphans,
      ...ca,
    };
  }

  // `started` + `completed` (computed above off nowSec) let the client pick the refresh
  // mode: while live it re-fetches this route (?fresh=1) for an instant ESPN pull; once
  // completed the sheet drives it. `pointsSource` flags when the H2H is provisional/ESPN.
  return NextResponse.json({
    audit,
    contest: { ...contest, matchDeadline: effDeadline },
    teams,
    username,
    announced,
    matchStatus,
    started,
    completed,
    pointsSource,
    liveProvisional: pointsSource === "live-espn",
    // "Points updated till 14.3 overs (138/4)" — how far play had progressed when these
    // provisional points were read (from the same ESPN summary). Null once completed.
    liveFreshness: liveScore?.freshness ?? null,
    // Full innings breakdown for the live Scorecard tab. Only meaningful while live; null once
    // completed (liveScore is null → the results page hides the Scorecard tab).
    scorecard: liveScore?.scorecard ?? null,
  });
}
