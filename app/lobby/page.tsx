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
import { getCompletedMatchKeys, getMatchPointsForMatch, lookupPlayerPoints } from "@/lib/points";
import { getFlag, getPlayerByKey } from "@/lib/players";
import { rankingFromSelection } from "@/lib/effective-lineup";

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

// Must agree byte-for-byte with the in-draft total (results/route.ts). Prefer the
// FROZEN effective lineup BACKUP_INTELLIGENCE persisted (auto-subbed XI + cascaded
// C/VC) — that's what the results page shows for a locked/announced match. Only when
// nothing is frozen do we fall back to top-N by rank with C/VC floated to the head,
// which mirrors the route's pass-through path. The old code sliced the raw saved
// order with the originally-set armband and so diverged once auto-subs kicked in.
function calcSelectionPoints(sel: TeamSelection, ppu: number, matchPts: Map<string, number>): number | null {
  const playerKeys: string[] = JSON.parse(sel.selectedPlayers ?? "[]");

  let xi: string[];
  let captainKey: string | null;
  let viceCaptainKey: string | null;

  if (sel.effectiveComputedAt && sel.effectiveLineup) {
    const fz = JSON.parse(sel.effectiveLineup) as {
      xi: string[];
      captainKey: string | null;
      viceCaptainKey: string | null;
    };
    xi = fz.xi;
    captainKey = fz.captainKey;
    viceCaptainKey = fz.viceCaptainKey;
  } else {
    const ranking = rankingFromSelection(playerKeys, sel.captainKey, sel.viceCaptainKey);
    xi = ranking.slice(0, ppu);
    captainKey = ranking[0] ?? null;
    viceCaptainKey = ranking[1] ?? null;
  }

  let total = 0;
  let hasAny = false;
  for (const key of xi) {
    const p = getPlayerByKey(key);
    if (!p) continue;
    const raw = lookupPlayerPoints(p.pid, p.displayName, p.name, matchPts);
    if (raw !== null) {
      hasAny = true;
      const mult = key === captainKey ? 2 : key === viceCaptainKey ? 1.5 : 1;
      total += raw * mult;
    }
  }
  return hasAny ? total : null;
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
      if (participants.length < 2)
        return { label: "Waiting for opponent to join", color: "text-yellow-400" };
      if (contest.mode === "live")
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
  const upcomingMatches = allMatches.filter((m) => m.deadlineTs + LOCK_BUFFER > now);
  const startedMatches = allMatches.filter(
    (m) => m.deadlineTs + LOCK_BUFFER <= now && m.deadlineTs >= recentTs
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

  // Fetch match points for live drafts and completed matches (in parallel)
  const matchPointsCache = new Map<string, Map<string, number>>();
  const matchesToFetch = [
    ...liveMatches.filter((m) => liveDraftMatchKeys.has(m.key)),
    ...allMatches.filter((m) => myCompletedMatchKeys.includes(m.key)),
  ];
  await Promise.all(
    matchesToFetch.map(async (m) => {
      matchPointsCache.set(m.key, await getMatchPointsForMatch(m));
    })
  );

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
                    {/* Match header */}
                    <div className="flex items-center gap-2 px-1">
                      <span className="text-lg">{getFlag(m.team1)}{getFlag(m.team2)}</span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold truncate">{m.label}</span>
                          <span className="text-xs text-live font-bold shrink-0 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-live animate-pulse" />In progress</span>
                        </div>
                        <p className="text-[11px] text-mist font-mono">{formatMatchDate(m.date)}</p>
                      </div>
                    </div>

                    {/* Match-level live-points refresh + cricapi quota gauge (one bot run
                        scores every contest on this match). */}
                    <MatchRefresh matchStarted />

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
                      <div className="text-xl">{getFlag(m.team1)}{getFlag(m.team2)}</div>
                      <div>
                        <p className="font-bold text-sm">{m.label}</p>
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

  // ── COMPLETED panel ──
  const completedContent = (
    <div className="space-y-3">
      {myCompletedMatchKeys.map((matchKey) => {
              const match = allMatches.find((m) => m.key === matchKey);
              const matchPts = matchPointsCache.get(matchKey) ?? new Map();
              const contests = userContestsByMatch.get(matchKey) ?? [];

              return (
                <div key={matchKey} className="card-stadium rounded-2xl overflow-hidden">
                  {/* Match header */}
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-hair">
                    <span className="text-lg">{getFlag(match?.team1 ?? "")}{getFlag(match?.team2 ?? "")}</span>
                    <div className="min-w-0">
                      <span className="text-sm font-semibold block truncate">{match?.label ?? matchKey}</span>
                      {match && (
                        <p className="text-[11px] text-mist font-mono">{formatMatchDate(match.date)}</p>
                      )}
                    </div>
                  </div>

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
