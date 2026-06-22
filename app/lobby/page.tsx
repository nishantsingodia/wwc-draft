import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDb, draftContests, contestParticipants, teamSelections, type DraftContest, type TeamSelection } from "@/lib/db";
import { eq, desc, inArray } from "drizzle-orm";
import Link from "next/link";
import { getUserLabel } from "@/lib/users";
import LogoutButton from "@/components/logout-button";
import DeleteDraftButton from "@/components/delete-draft-button";
import LobbyTabs from "@/components/lobby-tabs";
import { getAllMatches, formatMatchDate, LOCK_BUFFER } from "@/lib/matches";
import { getCompletedMatchKeys, getMatchPointsForMatch, lookupPlayerPoints } from "@/lib/points";
import { getFlag, getPlayerByKey } from "@/lib/players";

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

function calcSelectionPoints(sel: TeamSelection, ppu: number, matchPts: Map<string, number>): number | null {
  const keys: string[] = JSON.parse(sel.selectedPlayers ?? "[]");
  const starters = keys.slice(0, ppu);
  let total = 0;
  let hasAny = false;
  for (const key of starters) {
    const p = getPlayerByKey(key);
    if (!p) continue;
    const raw = lookupPlayerPoints(p.pid, p.displayName, p.name, matchPts);
    if (raw !== null) {
      hasAny = true;
      const mult = key === sel.captainKey ? 2 : key === sel.viceCaptainKey ? 1.5 : 1;
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
      return { label: "Team locked", color: "text-zinc-400" };
    case "COMPLETED":
      return { label: "Completed", color: "text-zinc-500" };
    default:
      return { label: contest.status, color: "text-zinc-400" };
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
                          <span className="text-sm font-semibold truncate">{m.label}</span>
                          <span className="text-xs text-red-400 font-medium shrink-0">In progress</span>
                        </div>
                        <p className="text-[11px] text-zinc-400">{formatMatchDate(m.date)}</p>
                      </div>
                    </div>

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
                          className="bg-zinc-900/80 border border-zinc-700/40 rounded-xl overflow-hidden"
                        >
                          {/* Card header */}
                          <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${c.mode === "live" ? "bg-red-900/60 text-red-400" : "bg-zinc-700 text-zinc-400"}`}>
                              {c.mode === "live" ? "Live" : "Manual"}
                            </span>
                            <span className="text-zinc-500 font-mono text-xs">{c.code}</span>
                            <span className="flex-1" />
                            {isDeletable && <DeleteDraftButton code={c.code} />}
                          </div>

                          {/* Per-user rows */}
                          <Link href={`/draft/${c.code}/results`} className="block px-3 pb-3 space-y-1.5">
                            {userRows.map(({ u, capName, vcName, pts }) => (
                              <div key={u} className="flex items-center gap-2 text-xs">
                                <span className="text-zinc-400 w-14 shrink-0 font-medium truncate">
                                  {getUserLabel(u)}{u === username ? " (you)" : ""}
                                </span>
                                <div className="flex-1 flex items-center gap-1.5 min-w-0 overflow-hidden">
                                  {capName ? (
                                    <>
                                      <span className="bg-yellow-500 text-black text-[9px] font-bold px-1 rounded shrink-0">C</span>
                                      <span className="text-zinc-200 truncate">{capName}</span>
                                      {vcName && (
                                        <>
                                          <span className="bg-blue-500 text-white text-[9px] font-bold px-1 rounded shrink-0">VC</span>
                                          <span className="text-zinc-200 truncate">{vcName}</span>
                                        </>
                                      )}
                                    </>
                                  ) : (
                                    <span className="text-zinc-600">Team not set</span>
                                  )}
                                </div>
                                <span className={`font-bold shrink-0 ${pts !== null ? "text-emerald-400" : "text-zinc-600"}`}>
                                  {(pts ?? 0).toFixed(0)}pt
                                </span>
                              </div>
                            ))}
                            <p className="text-[10px] text-zinc-600 pt-0.5">Tap to compare teams →</p>
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
          <Link href="/schedule" className="text-xs text-zinc-500 hover:text-zinc-300">
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
                    className="flex items-center justify-between bg-zinc-900 rounded-xl px-4 py-3 hover:bg-zinc-800 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="text-xl">{getFlag(m.team1)}{getFlag(m.team2)}</div>
                      <div>
                        <p className="font-semibold text-sm">{m.label}</p>
                        <p className="text-xs text-zinc-400">{formatMatchDate(m.date)}</p>
                      </div>
                    </div>
                    <span className="text-zinc-500 text-sm shrink-0">Draft →</span>
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
                        className="ml-4 flex items-start gap-2 bg-zinc-900/70 border border-zinc-700/30 rounded-xl px-3 py-2.5"
                      >
                        <Link href={`/draft/${c.code}`} className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${c.mode === "live" ? "bg-red-900/60 text-red-400" : "bg-zinc-700 text-zinc-400"}`}>
                              {c.mode === "live" ? "Live" : "Manual"}
                            </span>
                            <span className="text-zinc-500 font-mono text-xs">{c.code}</span>
                          </div>
                          <p className={`text-xs font-semibold ${statusInfo.color}`}>{statusInfo.label}</p>
                          {statusInfo.sub && (
                            <p className="text-[11px] text-zinc-500 mt-0.5">{statusInfo.sub}</p>
                          )}
                        </Link>
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
                <div key={matchKey} className="bg-zinc-900 rounded-xl overflow-hidden">
                  {/* Match header */}
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
                    <span className="text-lg">{getFlag(match?.team1 ?? "")}{getFlag(match?.team2 ?? "")}</span>
                    <div className="min-w-0">
                      <span className="text-sm font-semibold block truncate">{match?.label ?? matchKey}</span>
                      {match && (
                        <p className="text-[11px] text-zinc-400">{formatMatchDate(match.date)}</p>
                      )}
                    </div>
                  </div>

                  {/* Contest rows */}
                  <div className="divide-y divide-zinc-800">
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
                        <Link key={c.id} href={`/draft/${c.code}/results`} className="block px-4 py-3 hover:bg-zinc-800/50 transition-colors">
                          <div className="flex items-center gap-2 mb-2">
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${c.mode === "live" ? "bg-red-900/60 text-red-400" : "bg-zinc-700 text-zinc-400"}`}>
                              {c.mode === "live" ? "Live" : "Manual"}
                            </span>
                            <span className="text-zinc-500 font-mono text-xs">{c.code}</span>
                            <span className="flex-1" />
                            <span className="text-xs text-zinc-500">Results →</span>
                          </div>

                          <div className="space-y-1.5">
                            {userSummaries.map(({ u, capName, vcName, pts }) => {
                              const isWinner = pts !== null && maxPts !== null && pts === maxPts && allPts.length > 1;
                              return (
                                <div key={u} className="flex items-center gap-2 text-xs">
                                  <span className={`w-14 shrink-0 font-medium truncate ${isWinner ? "text-yellow-400" : "text-zinc-400"}`}>
                                    {getUserLabel(u)}{isWinner ? " 🏆" : ""}
                                  </span>
                                  <div className="flex-1 flex items-center gap-1.5 min-w-0 overflow-hidden">
                                    {capName ? (
                                      <>
                                        <span className="bg-yellow-500 text-black text-[9px] font-bold px-1 rounded shrink-0">C</span>
                                        <span className="text-zinc-300 truncate">{capName}</span>
                                        {vcName && (
                                          <>
                                            <span className="bg-blue-500 text-white text-[9px] font-bold px-1 rounded shrink-0">VC</span>
                                            <span className="text-zinc-300 truncate">{vcName}</span>
                                          </>
                                        )}
                                      </>
                                    ) : (
                                      <span className="text-zinc-600">No team</span>
                                    )}
                                  </div>
                                  <span className={`font-bold shrink-0 ${isWinner ? "text-yellow-400" : pts !== null ? "text-emerald-400" : "text-zinc-600"}`}>
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
    <main className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">🏏 WWC Draft</h1>
            <p className="text-zinc-400 text-sm">Welcome, {getUserLabel(username)}</p>
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
            <p className="text-zinc-500">No matches scheduled.</p>
          </div>
        )}
      </div>
    </main>
  );
}
