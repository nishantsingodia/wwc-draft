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
import { getMatchPointsMap, getMatchScoreline, type InningsLine } from "@/lib/live-points";
import LobbyMatch, { type DraftRow } from "@/components/lobby-match";
import RainDelay from "@/components/rain-delay";
import { getPendingAmendments } from "@/lib/pending-amendments";
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

  // ── Pending lineup amendments, so an approval waiting on you shows up next to the score
  // it would change rather than three taps away. One query for every contest on screen.
  const pendingByContest = await getPendingAmendments(
    userContests.map((c) => ({ id: c.id, code: c.code, picksPerUser: c.picksPerUser })),
    participantsMap,
    selectionsMap,
    username,
    now
  ).catch(() => new Map<number, Awaited<ReturnType<typeof getPendingAmendments>> extends Map<number, infer V> ? V : never>());

  const contestsNeedingMe = new Set(
    [...pendingByContest.entries()]
      .filter(([, ps]) => ps.some((p) => p.canApprove))
      .map(([id]) => id)
  );
  const matchesNeedingMe = new Set(
    userContests.filter((c) => contestsNeedingMe.has(c.id)).map((c) => c.matchKey)
  );

  // ── Which cards open by default.
  // One live match ⇒ it opens; several ⇒ the one closest to finishing (started earliest).
  // A match with an amendment awaiting YOUR approval always opens — that is the whole point
  // of surfacing it here. Everything else is a one-line row you can tap.
  const liveOnLobby = liveMatches
    .filter((m) => liveDraftMatchKeys.has(m.key))
    .sort((a, b) => b.deadlineTs - a.deadlineTs);
  const mostAdvancedLive = liveOnLobby.length
    ? liveOnLobby.reduce((a, b) => (a.deadlineTs <= b.deadlineTs ? a : b)).key
    : null;
  const expandedKeys = new Set<string>([
    ...(mostAdvancedLive ? [mostAdvancedLive] : []),
    ...matchesNeedingMe,
  ]);

  // Scorelines cost one ESPN summary each, so fetch them ONLY for cards that render open.
  const scorelines = new Map<string, InningsLine[]>();
  await Promise.all(
    allMatches
      .filter((m) => expandedKeys.has(m.key))
      .map(async (m) => {
        scorelines.set(m.key, await getMatchScoreline(m).catch(() => []));
      })
  );

  // Build the per-draft rows a match card renders — the SAME per-user summary the old
  // lobby cards showed, just assembled once for both tabs.
  const draftRowsFor = (
    contests: typeof userContests,
    matchPts: Map<string, number>
  ): DraftRow[] =>
    contests.map((c) => {
      const sels = selectionsMap.get(c.id) ?? [];
      const parts = participantsMap.get(c.id) ?? [];
      return {
        id: c.id,
        code: c.code,
        mode: c.mode,
        deletable: c.createdBy === username && c.status !== "LOCKED",
        users: parts.map((u) => {
          const sel = sels.find((s) => s.user === u);
          return {
            user: u,
            capName: sel?.captainKey ? getPlayerByKey(sel.captainKey)?.displayName ?? "—" : null,
            vcName: sel?.viceCaptainKey ? getPlayerByKey(sel.viceCaptainKey)?.displayName ?? "—" : null,
            pts: sel ? calcSelectionPoints(sel, c.picksPerUser, matchPts) : null,
          };
        }),
        pending: pendingByContest.get(c.id) ?? [],
      };
    });

  // Default tab: prefer Live, then Upcoming, then Completed
  const defaultTab =
    liveDraftMatchKeys.size > 0
      ? "live"
      : upcomingMatches.length > 0
      ? "upcoming"
      : "completed";

  // ── LIVE NOW panel ──
  // One card per match: scoreline, head-to-head, the drafts on it, and the match-level
  // controls that used to justify a separate /match/[key] page. Nothing here computes a
  // score — every total is handed in from calcSelectionPoints above.
  const liveContent = (
    <div className="space-y-3">
      {liveOnLobby.map((m) => {
        const matchPts = matchPointsCache.get(m.key) ?? new Map();
        const myDrafts = (userContestsByMatch.get(m.key) ?? []).filter(
          (c) => c.status !== "COMPLETED"
        );
        const delay = matchDelays.get(m.key) ?? 0;
        return (
          <LobbyMatch
            key={m.key}
            match={{
              key: m.key,
              label: m.label,
              team1: m.team1,
              team2: m.team2,
              dateLabel: formatMatchDate(m.date),
            }}
            state="live"
            freshness={matchFreshness.get(m.key) ?? null}
            innings={scorelines.get(m.key) ?? []}
            drafts={draftRowsFor(myDrafts, matchPts)}
            username={username}
            defaultOpen={expandedKeys.has(m.key)}
            actions={
              <>
                <MatchRefresh matchStarted freshness={matchFreshness.get(m.key) ?? null} />
                <RainDelay
                  matchKey={m.key}
                  initialExtraMinutes={Math.round(delay / 60)}
                  scheduledStart={formatMatchDate(m.date)}
                />
                <div className="flex flex-wrap gap-2">
                  {myDrafts.map((c) => (
                    <Link
                      key={c.id}
                      href={`/draft/${c.code}/amend`}
                      className="text-[11px] rounded-lg border border-hair px-2.5 py-1.5 text-mist hover:text-cloud"
                    >
                      ⚖️ Amend {c.code}
                    </Link>
                  ))}
                  <Link
                    href={`/draft/create?matchKey=${m.key}`}
                    className="text-[11px] rounded-lg border border-gold/50 px-2.5 py-1.5 text-gold"
                  >
                    + Draft for this match
                  </Link>
                </div>
              </>
            }
          />
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
                  <div
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
                  </div>

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
  // Same card as LIVE — the final scoreline, the head-to-head, the drafts — plus the recon
  // state, which matters MORE here than live: a completed result can still move under you
  // when the bot reconciles, and that is exactly what the settlement badge reports.
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
        const match = matchByKey.get(matchKey);
        if (!match) return null;
        const contests = userContestsByMatch.get(matchKey) ?? [];
        const matchPts = matchPointsCache.get(matchKey) ?? new Map();
        const settledPts = settledPointsCache.get(matchKey);

        // Movement against the WRITE-ONCE settled baseline, for the viewer's own XI only.
        const mySwing = contests.reduce((acc, c) => {
          if (!settledPts || settledPts.size === 0) return acc;
          const mySel = (selectionsMap.get(c.id) ?? []).find((sl) => sl.user === username);
          if (!mySel) return acc;
          const then = calcSelectionPoints(mySel, c.picksPerUser, settledPts);
          const nowP = calcSelectionPoints(mySel, c.picksPerUser, matchPts);
          return acc + ((nowP ?? 0) - (then ?? 0));
        }, 0);
        const noSettledBaseline = !settledPts || settledPts.size === 0;
        const pendingHere = pendingCountCache.get(matchKey) ?? 0;
        const hasReconNews = mySwing !== 0 || noSettledBaseline || pendingHere > 0;

        return (
          <LobbyMatch
            key={matchKey}
            match={{
              key: matchKey,
              label: match.label,
              team1: match.team1,
              team2: match.team2,
              dateLabel: formatMatchDate(match.date),
            }}
            state="completed"
            freshness={null}
            innings={scorelines.get(matchKey) ?? []}
            drafts={draftRowsFor(contests, matchPts)}
            username={username}
            defaultOpen={expandedKeys.has(matchKey)}
            statusChip={
              hasReconNews ? (
                <SettlementBadge
                  delta={mySwing}
                  noBaseline={noSettledBaseline}
                  pendingCount={pendingHere}
                  compact
                />
              ) : (
                <span className="text-[10px] text-mist2">✓ settled</span>
              )
            }
            actions={
              <div className="flex flex-wrap gap-2">
                {contests.map((c) => (
                  <Link
                    key={c.id}
                    href={`/draft/${c.code}/amend`}
                    className="text-[11px] rounded-lg border border-hair px-2.5 py-1.5 text-mist hover:text-cloud"
                  >
                    ⚖️ Amend {c.code}
                  </Link>
                ))}
                <Link
                  href="/audit"
                  className="text-[11px] rounded-lg border border-gold/50 px-2.5 py-1.5 text-gold"
                >
                  Settlement audit →
                </Link>
              </div>
            }
          />
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
