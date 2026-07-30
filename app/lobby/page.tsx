import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDb, draftContests, contestParticipants, teamSelections, type DraftContest, type TeamSelection } from "@/lib/db";
import { eq, desc, inArray } from "drizzle-orm";
import Link from "next/link";
import { getUserLabel } from "@/lib/users";
import LogoutButton from "@/components/logout-button";
import DeleteDraftButton from "@/components/delete-draft-button";
import MatchRefresh from "@/components/match-refresh";
import LobbyTabs from "@/components/lobby-tabs";
import TransitionLink from "@/components/transition-link";
import { getAllMatches, formatMatchDate, LOCK_BUFFER } from "@/lib/matches";
import { getAllMatchDelays } from "@/lib/match-delay";
import { getCompletedMatchKeys } from "@/lib/points";
import { getMatchPointsMap } from "@/lib/live-points";
import { getPlayerByKey, prettifyMatchLabel } from "@/lib/players";
import TeamLogo from "@/components/team-logo";
import { calcSelectionPoints } from "@/lib/contest-scoring";
import { getSettledPointsForMatch } from "@/lib/points";
import { auditMatch } from "@/lib/settlement-audit";
import { SettlementBadge } from "@/components/settlement-badge";

async function getUserContests(username: string) {
  const db = getDb();
  const participated = await db
    .select({ contestId: contestParticipants.contestId })
    .from(contestParticipants)
    .where(eq(contestParticipants.user, username));

  const ids = new Set(participated.map((p) => p.contestId));
  if (ids.size === 0) return [];

  const all = await db
    .select()
    .from(draftContests)
    .orderBy(desc(draftContests.createdAt))
    .limit(50);

  return all.filter((c) => ids.has(c.id) || c.createdBy === username);
}

async function getSelectionsForContests(ids: number[]): Promise<Map<number, TeamSelection[]>> {
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db.select().from(teamSelections).where(inArray(teamSelections.contestId, ids));
  const map = new Map<number, TeamSelection[]>();
  for (const r of rows) {
    const arr = map.get(r.contestId) ?? [];
    arr.push(r);
    map.set(r.contestId, arr);
  }
  return map;
}

async function getParticipantsForContests(ids: number[]): Promise<Map<number, string[]>> {
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db.select().from(contestParticipants).where(inArray(contestParticipants.contestId, ids));
  const map = new Map<number, string[]>();
  for (const r of rows) {
    const arr = map.get(r.contestId) ?? [];
    arr.push(r.user);
    map.set(r.contestId, arr);
  }
  return map;
}

function getPickCounts(draftOrder: string[] | null, pickCount: number): Map<string, number> {
  if (!draftOrder || draftOrder.length === 0) return new Map();
  const counts = new Map(draftOrder.map((u) => [u, 0]));
  for (let i = 0; i < pickCount; i++) {
    counts.set(draftOrder[i % draftOrder.length], (counts.get(draftOrder[i % draftOrder.length]) ?? 0) + 1);
  }
  return counts;
}

function getDraftStatusLine(
  contest: DraftContest,
  participants: string[],
  selections: TeamSelection[],
  username: string
): { label: string; sub?: string; color: string } {
  const order: string[] = JSON.parse(contest.draftOrder ?? "[]");

  switch (contest.status) {
    case "WAITING": {
      const seats = contest.maxPlayers ?? 2;
      if (participants.length < seats)
        return { label: `Waiting for players (${participants.length}/${seats})`, color: "text-yellow-400" };
      if (contest.mode === "live" && seats === 2)
        return { label: "Coin toss pending", color: "text-yellow-400" };
      return { label: "Waiting…", color: "text-yellow-400" };
    }
    case "DRAFTING": {
      const counts = getPickCounts(order, contest.pickCount);
      const currentTurn = order.length ? order[contest.pickCount % order.length] : null;
      const isMyTurn = currentTurn === username;
      const turnLabel = !currentTurn
        ? "Draft in progress"
        : isMyTurn
        ? "Your turn!"
        : `${getUserLabel(currentTurn)}'s turn`;
      const sub = participants.map((u) => `${getUserLabel(u)}: ${counts.get(u) ?? 0} picks`).join(" · ");
      return { label: turnLabel, sub, color: isMyTurn ? "text-emerald-400" : "text-blue-400" };
    }
    case "TEAM_SELECT": {
      if (contest.mode === "manual") {
        const parts = participants.map((u) => {
          const sel = selections.find((s) => s.user === u);
          const done = sel && JSON.parse(sel.selectedPlayers ?? "[]").length > 0;
          return `${getUserLabel(u)}: ${done ? "✓" : "pending"}`;
        });
        return { label: "Enter your team", sub: parts.join(" · "), color: "text-emerald-400" };
      }
      return { label: "Draft done · select your XI", color: "text-emerald-400" };
    }
    case "LOCKED":
      return { label: "Team locked", color: "text-mist" };
    case "COMPLETED":
      return { label: "Completed", color: "text-mist2" };
    default:
      return { label: contest.status, color: "text-mist" };
  }
}

export default async function LobbyPage() {
  const username = await getSession();
  if (!username) redirect("/");

  const now = Math.floor(Date.now() / 1000);
  const allMatches = getAllMatches();
  // Manual rain/delay overrides push a match's effective start back, so a delayed game
  // stays in Upcoming (not Live) until its real, extended start time.
  const matchDelays = await getAllMatchDelays();
  const effDeadline = (m: { key: string; deadlineTs: number }) =>
    m.deadlineTs + (matchDelays.get(m.key) ?? 0);

  let completedMatchKeys = new Set<string>();
  let userContests: Awaited<ReturnType<typeof getUserContests>> = [];
  let selectionsMap = new Map<number, TeamSelection[]>();
  let participantsMap = new Map<number, string[]>();

  try {
    [completedMatchKeys, userContests] = await Promise.all([
      getCompletedMatchKeys(allMatches),
      getUserContests(username),
    ]);

    const contestIds = userContests.map((c) => c.id);
    [selectionsMap, participantsMap] = await Promise.all([
      getSelectionsForContests(contestIds),
      getParticipantsForContests(contestIds),
    ]);
  } catch {
    // DB or sheet not available
  }

  // Only surface recently-started matches in Live/Completed (last ~18 days)
  const RECENT_WINDOW = 18 * 24 * 60 * 60;
  const recentTs = now - RECENT_WINDOW;

  // Classify matches — "started" means past lock window (match start + 15 min)
  const upcomingMatches = allMatches.filter((m) => effDeadline(m) + LOCK_BUFFER > now);
  const startedMatches = allMatches.filter(
    (m) => effDeadline(m) + LOCK_BUFFER <= now && m.deadlineTs >= recentTs
  );
  const liveMatches = startedMatches.filter((m) => !completedMatchKeys.has(m.key));

  const upcomingMatchKeys = new Set(upcomingMatches.map((m) => m.key));
  const liveMatchKeys = new Set(liveMatches.map((m) => m.key));

  // Group user contests by match key
  const userContestsByMatch = new Map<string, typeof userContests>();
  for (const c of userContests) {
    const arr = userContestsByMatch.get(c.matchKey) ?? [];
    arr.push(c);
    userContestsByMatch.set(c.matchKey, arr);
  }

  // Live: started matches where user has at least one non-COMPLETED draft
  const liveDraftMatchKeys = new Set(
    liveMatches
      .filter((m) => {
        const drafts = userContestsByMatch.get(m.key) ?? [];
        return drafts.some((c) => c.status !== "COMPLETED");
      })
      .map((m) => m.key)
  );

  // Upcoming: user's active drafts for upcoming matches
  const upcomingDraftsByMatch = new Map<string, typeof userContests>();
  for (const c of userContests) {
    if (!upcomingMatchKeys.has(c.matchKey)) continue;
    const arr = upcomingDraftsByMatch.get(c.matchKey) ?? [];
    arr.push(c);
    upcomingDraftsByMatch.set(c.matchKey, arr);
  }

  // Completed: matches with user drafts, within the recent window, newest first
  const matchByKey = new Map(allMatches.map((m) => [m.key, m]));
  const myCompletedMatchKeys = [...completedMatchKeys]
    .filter((key) => userContestsByMatch.has(key))
    .map((key) => matchByKey.get(key))
    .filter((m): m is NonNullable<typeof m> => !!m && m.deadlineTs >= recentTs)
    .sort((a, b) => b.deadlineTs - a.deadlineTs)
    .map((m) => m.key);

  // Fetch match points for live drafts and completed matches (in parallel). LIVE matches
  // are scored IN-APP from ESPN (getMatchPointsMap → getLiveMatchPoints) — zero cricapi, no
  // bot run, the same provisional numbers the results page shows; completed matches read the
  // bot's reconciled sheet. `fresh: true` so the manual "Refresh now" always re-pulls a
  // current ESPN scorecard rather than a ≤20s-cached one.
  const matchPointsCache = new Map<string, Map<string, number>>();
  const settledPointsCache = new Map<string, Map<string, number>>();
  // How many players on a completed match still need a recon decision. Kept separate from the
  // points delta: a pending revision has NOT moved anything (the bot holds the settled value), so
  // it must read as "recon open", never as "this result was wrong".
  const pendingCountCache = new Map<string, number>();
  const matchFreshness = new Map<string, string>(); // live "Points updated till …" per match
  const liveToFetch = liveMatches.filter((m) => liveDraftMatchKeys.has(m.key));
  const completedToFetch = allMatches.filter((m) => myCompletedMatchKeys.includes(m.key));
  await Promise.all([
    ...liveToFetch.map(async (m) => {
      const r = await getMatchPointsMap(m, { live: true, fresh: true });
      matchPointsCache.set(m.key, r.points);
      if (r.freshness) matchFreshness.set(m.key, r.freshness);
    }),
    ...completedToFetch.map(async (m) => {
      const r = await getMatchPointsMap(m, { live: false });
      matchPointsCache.set(m.key, r.points);
    }),
    // Settled baseline per completed match, so the Completed tab can flag "this result moved
    // since we settled" WITHOUT the user opening each contest. One extra cached CSV read.
    ...completedToFetch.map(async (m) => {
      settledPointsCache.set(m.key, await getSettledPointsForMatch(m));
    }),
    ...completedToFetch.map(async (m) => {
      pendingCountCache.set(m.key, (await auditMatch(m)).pending.length);
    }),
  ]);

  // Default tab: prefer Live, then Upcoming, then Completed
  const defaultTab =
    liveDraftMatchKeys.size > 0
      ? "live"
      : upcomingMatches.length > 0
      ? "upcoming"
      : "completed";

  // ── LIVE NOW panel ──
  const liveContent = (
    <div className="space-y-3">
      {liveMatches
        .filter((m) => liveDraftMatchKeys.has(m.key))
        .sort((a, b) => b.deadlineTs - a.deadlineTs)
        .map((m) => {
                const matchPts = matchPointsCache.get(m.key) ?? new Map();
                const myDrafts = (userContestsByMatch.get(m.key) ?? []).filter(
                  (c) => c.status !== "COMPLETED"
                );

                return (
                  <div key={m.key} className="space-y-2">
                    {/* Match header — tappable through to the match hub */}
                    <Link href={`/match/${m.key}`} className="flex items-center gap-2 px-1 py-1 -mx-1 rounded-lg hover:bg-navy2/40 transition-colors">
                      <span className="flex items-center gap-1 shrink-0">
                        <TeamLogo code={m.team1} size={22} />
                        <TeamLogo code={m.team2} size={22} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold truncate">{prettifyMatchLabel(m.label)}</span>
                          <span className="text-xs text-live font-bold shrink-0 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-live animate-pulse" />In progress</span>
                        </div>
                        <p className="text-[11px] text-mist font-mono">{formatMatchDate(m.date)}</p>
                      </div>
                      <span className="text-mist2 text-sm shrink-0">›</span>
                    </Link>

                    {/* Match-level live-points refresh — in-app ESPN scoring, no cricapi/bot.
                        Freshness ("Points updated till 14.3 overs (138/4)") sits under it. */}
                    <MatchRefresh matchStarted freshness={matchFreshness.get(m.key) ?? null} />

                    {/* Draft cards */}
                    {myDrafts.map((c) => {
                      const sels = selectionsMap.get(c.id) ?? [];
                      const parts = participantsMap.get(c.id) ?? [];
                      const isDeletable = c.createdBy === username && c.status !== "LOCKED";

                      // Build per-user summary row
                      const userRows = parts.map((u) => {
                        const sel = sels.find((s) => s.user === u);
                        const capName = sel?.captainKey ? (getPlayerByKey(sel.captainKey)?.displayName ?? "—") : null;
                        const vcName = sel?.viceCaptainKey ? (getPlayerByKey(sel.viceCaptainKey)?.displayName ?? "—") : null;
                        const pts = sel ? calcSelectionPoints(sel, c.picksPerUser, matchPts) : null;
                        return { u, capName, vcName, pts };
                      });

                      return (
                        <div
                          key={c.id}
                          className="card-stadium rounded-2xl overflow-hidden"
                        >
                          {/* Card header */}
                          <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${c.mode === "live" ? "bg-live/15 text-live border border-live/40" : "bg-navy2 text-mist"}`}>
                              {c.mode === "live" ? "Live" : "Manual"}
                            </span>
                            <span className="text-mist2 font-mono text-xs">{c.code}</span>
                            <span className="flex-1" />
                            {isDeletable && <DeleteDraftButton code={c.code} />}
                          </div>

                          {/* Per-user rows */}
                          <Link href={`/draft/${c.code}/results`} className="block px-3 pb-3 space-y-1.5">
                            {userRows.map(({ u, capName, vcName, pts }) => (
                              <div key={u} className="flex items-center gap-2 text-xs">
                                <span className="text-mist w-14 shrink-0 font-medium truncate">
                                  {getUserLabel(u)}{u === username ? " (you)" : ""}
                                </span>
                                <div className="flex-1 flex items-center gap-1.5 min-w-0 overflow-hidden">
                                  {capName ? (
                                    <>
                                      <span className="bg-yellow-500 text-black text-[9px] font-bold px-1 rounded shrink-0">C</span>
                                      <span className="text-cloud truncate">{capName}</span>
                                      {vcName && (
                                        <>
                                          <span className="bg-blue-500 text-white text-[9px] font-bold px-1 rounded shrink-0">VC</span>
                                          <span className="text-cloud truncate">{vcName}</span>
                                        </>
                                      )}
                                    </>
                                  ) : (
                                    <span className="text-mist2">Team not set</span>
                                  )}
                                </div>
                                <span className={`font-bold shrink-0 ${pts !== null ? "text-emerald-400" : "text-mist2"}`}>
                                  {(pts ?? 0).toFixed(0)}pt
                                </span>
                              </div>
                            ))}
                            <p className="text-[10px] text-mist2 font-mono pt-0.5">Tap to compare teams →</p>
                          </Link>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
    </div>
  );

  // ── UPCOMING panel ──
  const upcomingContent = (
    <div className="space-y-3">
      {upcomingMatches.length > 8 && (
        <div className="flex justify-end">
          <Link href="/schedule" className="text-xs text-mist2 hover:text-cloud">
            All {upcomingMatches.length} →
          </Link>
        </div>
      )}

      {upcomingMatches.slice(0, 8).map((m) => {
              const myDrafts = upcomingDraftsByMatch.get(m.key) ?? [];

              return (
                <div key={m.key} className="space-y-1.5">
                  {/* Match header */}
                  <Link
                    href={`/match/${m.key}`}
                    className="flex items-center justify-between card-stadium rounded-2xl px-4 py-3 hover:brightness-110 transition"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1">
                        <TeamLogo code={m.team1} size={24} />
                        <TeamLogo code={m.team2} size={24} />
                      </div>
                      <div>
                        <p className="font-bold text-sm">{prettifyMatchLabel(m.label)}</p>
                        <p className="text-xs text-mist font-mono mt-0.5">{formatMatchDate(m.date)}</p>
                      </div>
                    </div>
                    <span className="text-gold text-xs font-mono shrink-0 border border-gold/30 rounded-lg px-2.5 py-1.5">Draft →</span>
                  </Link>

                  {/* User's drafts for this match */}
                  {myDrafts.map((c) => {
                    const sels = selectionsMap.get(c.id) ?? [];
                    const parts = participantsMap.get(c.id) ?? [];
                    const isDeletable = c.createdBy === username && !["COMPLETED", "LOCKED"].includes(c.status);
                    const statusInfo = getDraftStatusLine(c, parts, sels, username);

                    return (
                      <div
                        key={c.id}
                        className="ml-4 flex items-center gap-2 rounded-xl border border-gold/30 bg-gradient-to-br from-gold/10 to-navy2 px-3 py-2.5"
                      >
                        <TransitionLink href={`/draft/${c.code}`} className="flex-1 min-w-0 group">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${c.mode === "live" ? "bg-live/15 text-live border border-live/40" : "bg-navy2 text-mist"}`}>
                              {c.mode === "live" ? "Live" : "Manual"}
                            </span>
                            <span className="text-mist2 font-mono text-xs">{c.code}</span>
                          </div>
                          <p className={`text-sm font-bold ${statusInfo.color}`}>{statusInfo.label}</p>
                          {statusInfo.sub && (
                            <p className="text-[11px] text-mist2 font-mono mt-0.5">{statusInfo.sub}</p>
                          )}
                        </TransitionLink>
                        <span className="shrink-0 grid place-items-center w-8 h-8 rounded-full bg-gold text-ink font-bold shadow-[0_8px_18px_-8px_rgba(212,175,55,0.8)]">→</span>
                        {isDeletable && <DeleteDraftButton code={c.code} />}
                      </div>
                    );
                  })}
                </div>
              );
            })}
    </div>
  );

  // How many of the viewer's completed matches have moved since settlement — drives the count on
  // the "Settlement audit" link so the entry point itself says whether it's worth opening.
  const pendingMatchCount = myCompletedMatchKeys.filter(
    (mk) => (pendingCountCache.get(mk) ?? 0) > 0
  ).length;
  const movedCount = myCompletedMatchKeys.filter((mk) => {
    const settled = settledPointsCache.get(mk);
    if (!settled || settled.size === 0) return false;
    const pts = matchPointsCache.get(mk) ?? new Map();
    return (userContestsByMatch.get(mk) ?? []).some((c) => {
      const sel = (selectionsMap.get(c.id) ?? []).find((sl) => sl.user === username);
      if (!sel) return false;
      return calcSelectionPoints(sel, c.picksPerUser, settled) !==
        calcSelectionPoints(sel, c.picksPerUser, pts);
    });
  }).length;

  // ── COMPLETED panel ──
  const completedContent = (
    <div className="space-y-3">
      <Link
        href="/audit"
        className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 transition-colors ${
          movedCount > 0
            ? "border-destructive/50 bg-destructive/10 hover:bg-destructive/15"
            : pendingMatchCount > 0
              ? "border-gold/50 bg-gold/10 hover:bg-gold/15"
              : "border-hair bg-navy2/40 hover:bg-navy2"
        }`}
      >
        <span className="text-sm">{movedCount > 0 ? "⚠" : pendingMatchCount > 0 ? "⏳" : "🧾"}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Settlement audit</p>
          <p className="text-[11px] text-mist">
            {movedCount > 0 ? (
              <>
                <span className="text-destructive font-semibold">
                  {movedCount} changed
                </span>{" "}
                after settling up
                {pendingMatchCount > 0 && (
                  <> · <span className="text-gold">{pendingMatchCount} recon open</span></>
                )}
              </>
            ) : pendingMatchCount > 0 ? (
              <>
                <span className="text-gold font-semibold">
                  {pendingMatchCount} match{pendingMatchCount === 1 ? "" : "es"} awaiting recon
                </span>{" "}
                — nothing has moved yet
              </>
            ) : (
              "Compare what each result was settled on vs the sheet now"
            )}
          </p>
        </div>
        <span className="text-mist2 text-sm shrink-0">›</span>
      </Link>
      {myCompletedMatchKeys.map((matchKey) => {
              const match = allMatches.find((m) => m.key === matchKey);
              const matchPts = matchPointsCache.get(matchKey) ?? new Map();
              const contests = userContestsByMatch.get(matchKey) ?? [];
              // "Has this settled result moved?" — scored with the SAME calcSelectionPoints on
              // both point maps, so then/now can't drift. A settled baseline may be absent for
              // matches that completed before the baseline existed; say so rather than implying
              // "verified unchanged".
              const settledPts = settledPointsCache.get(matchKey);
              const mySwing = (contests ?? []).reduce((acc, c) => {
                if (!settledPts || settledPts.size === 0) return acc;
                const mySel = (selectionsMap.get(c.id) ?? []).find((sl) => sl.user === username);
                if (!mySel) return acc;
                const then = calcSelectionPoints(mySel, c.picksPerUser, settledPts);
                const nowP = calcSelectionPoints(mySel, c.picksPerUser, matchPts);
                return acc + ((nowP ?? 0) - (then ?? 0));
              }, 0);
              const noSettledBaseline = !settledPts || settledPts.size === 0;
              const pendingHere = pendingCountCache.get(matchKey) ?? 0;

              return (
                <div key={matchKey} className="card-stadium rounded-2xl overflow-hidden">
                  {/* Match header — tappable through to the match hub */}
                  <Link href={`/match/${matchKey}`} className="flex items-center gap-2 px-4 py-3 border-b border-hair hover:bg-navy2/40 transition-colors">
                    <span className="flex items-center gap-1 shrink-0">
                      <TeamLogo code={match?.team1 ?? ""} size={20} />
                      <TeamLogo code={match?.team2 ?? ""} size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-semibold block truncate">{match ? prettifyMatchLabel(match.label) : matchKey}</span>
                      {match && (
                        <p className="text-[11px] text-mist font-mono">{formatMatchDate(match.date)}</p>
                      )}
                    </div>
                    {(mySwing !== 0 || noSettledBaseline || pendingHere > 0) && (
                      <span className="shrink-0">
                        <SettlementBadge
                          delta={mySwing}
                          noBaseline={noSettledBaseline}
                          pendingCount={pendingHere}
                          compact
                        />
                      </span>
                    )}
                    <span className="text-mist2 text-sm shrink-0">›</span>
                  </Link>

                  {/* Contest rows */}
                  <div className="divide-y divide-hair">
                    {contests.map((c) => {
                      const sels = selectionsMap.get(c.id) ?? [];
                      const parts = participantsMap.get(c.id) ?? [];

                      // Calculate points per user
                      const userSummaries = parts.map((u) => {
                        const sel = sels.find((s) => s.user === u);
                        const capName = sel?.captainKey ? (getPlayerByKey(sel.captainKey)?.displayName ?? "—") : null;
                        const vcName = sel?.viceCaptainKey ? (getPlayerByKey(sel.viceCaptainKey)?.displayName ?? "—") : null;
                        const pts = sel ? calcSelectionPoints(sel, c.picksPerUser, matchPts) : null;
                        return { u, capName, vcName, pts };
                      });

                      const allPts = userSummaries.map((s) => s.pts).filter((p): p is number => p !== null);
                      const maxPts = allPts.length > 0 ? Math.max(...allPts) : null;

                      return (
                        <Link key={c.id} href={`/draft/${c.code}/results`} className="block px-4 py-3 hover:bg-navy2/40 transition-colors">
                          <div className="flex items-center gap-2 mb-2">
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${c.mode === "live" ? "bg-live/15 text-live border border-live/40" : "bg-navy2 text-mist"}`}>
                              {c.mode === "live" ? "Live" : "Manual"}
                            </span>
                            <span className="text-mist2 font-mono text-xs">{c.code}</span>
                            <span className="flex-1" />
                            <span className="text-xs text-mist2">Results →</span>
                          </div>

                          <div className="space-y-1.5">
                            {userSummaries.map(({ u, capName, vcName, pts }) => {
                              const isWinner = pts !== null && maxPts !== null && pts === maxPts && allPts.length > 1;
                              return (
                                <div key={u} className="flex items-center gap-2 text-xs">
                                  <span className={`w-14 shrink-0 font-medium truncate ${isWinner ? "text-yellow-400" : "text-mist"}`}>
                                    {getUserLabel(u)}{isWinner ? " 🏆" : ""}
                                  </span>
                                  <div className="flex-1 flex items-center gap-1.5 min-w-0 overflow-hidden">
                                    {capName ? (
                                      <>
                                        <span className="bg-yellow-500 text-black text-[9px] font-bold px-1 rounded shrink-0">C</span>
                                        <span className="text-cloud truncate">{capName}</span>
                                        {vcName && (
                                          <>
                                            <span className="bg-blue-500 text-white text-[9px] font-bold px-1 rounded shrink-0">VC</span>
                                            <span className="text-cloud truncate">{vcName}</span>
                                          </>
                                        )}
                                      </>
                                    ) : (
                                      <span className="text-mist2">No team</span>
                                    )}
                                  </div>
                                  <span className={`font-bold shrink-0 ${isWinner ? "text-yellow-400" : pts !== null ? "text-emerald-400" : "text-mist2"}`}>
                                    {(pts ?? 0).toFixed(0)}pt
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
    </div>
  );

  const hasAnyMatches = allMatches.length > 0;

  return (
    <main className="relative min-h-screen bg-ink floodlight text-cloud">
      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl drop-shadow-[0_0_14px_rgba(212,175,55,0.4)]">🏏</span>
            <div>
              <h1 className="text-lg font-bold uppercase tracking-tight leading-none">WWC Draft</h1>
              <p className="text-mist text-xs font-mono mt-0.5">Welcome, {getUserLabel(username)}</p>
            </div>
          </div>
          <LogoutButton />
        </div>

        {hasAnyMatches ? (
          <LobbyTabs
            defaultTab={defaultTab}
            upcomingCount={upcomingMatches.length}
            liveCount={liveDraftMatchKeys.size}
            completedCount={myCompletedMatchKeys.length}
            upcoming={upcomingContent}
            live={liveContent}
            completed={completedContent}
          />
        ) : (
          <div className="text-center py-12">
            <p className="text-mist2">No matches scheduled.</p>
          </div>
        )}
      </div>
    </main>
  );
}
