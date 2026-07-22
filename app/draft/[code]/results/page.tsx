"use client";

import { useEffect, useState, use, useCallback } from "react";
import Link from "next/link";
import { getUserLabel, USER_COLORS } from "@/lib/users";
import { getFlag } from "@/lib/players";
import { LOCK_BUFFER } from "@/lib/lock-buffer";
import type { Change } from "@/lib/effective-lineup";
import ChangesBanner from "@/components/changes-banner";
import LineupRefresh from "@/components/lineup-refresh";

type PlayerResult = {
  key: string;
  name: string;
  role: string;
  team: string;
  isCaptain: boolean;
  isViceCaptain: boolean;
  isBackup: boolean;
  fantasyPoints: number | null;
  rawPoints: number | null;
  efppm: number;
  recon?: string | null; // per-player: "⏳ unreconciled" / "⚠ official revision", null when settled
};

type TeamResult = {
  user: string;
  players: PlayerResult[];
  captainKey: string | null;
  viceCaptainKey: string | null;
  isLocked: boolean;
  totalPoints: number | null;
  changes?: Change[]; // BACKUP_INTELLIGENCE: what auto-substitution did (empty if nothing moved)
};

type ResultsData = {
  contest: {
    code: string;
    matchKey: string;
    matchLabel: string;
    matchDeadline: number;
    status: string;
  };
  teams: TeamResult[];
  username: string;
  announced: boolean; // both teams' official XIs are out
  // Recon status from the bot's "Match Status" column (null on legacy sheets).
  matchStatus: { status: "LIVE" | "COMPLETED" | "COMPLETED_FLAGGED"; flag: string } | null;
  started: boolean; // match has begun (server-computed; gates the live-refresh button)
  completed: boolean; // the COMPLETED pipeline has finalized this match (sheet drives it)
  pointsSource: "live-espn" | "sheet";
  liveProvisional: boolean; // H2H is computed live from ESPN (provisional, in-app, no bot)
};

const ROLE_COLORS: Record<string, string> = {
  WK: "text-yellow-400",
  BAT: "text-blue-400",
  AR: "text-purple-400",
  BOWL: "text-red-400",
};

// Only XI counts toward total (backups excluded)
function calcXITotal(team: TeamResult): number {
  return team.players
    .filter((p) => !p.isBackup)
    .reduce((sum, p) => sum + (p.fantasyPoints ?? 0), 0);
}

// Surfaces the bot's recon status so a provisional/revised result never looks plain-final.
function ReconBanner({
  ms,
  hasPoints,
}: {
  ms: { status: "LIVE" | "COMPLETED" | "COMPLETED_FLAGGED"; flag: string } | null;
  hasPoints: boolean;
}) {
  if (!ms) return null;
  if (ms.status === "COMPLETED_FLAGGED" && ms.flag.includes("revision")) {
    return (
      <div className="rounded-lg border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        ⚠ Official revision pending — these points may change once the official scorecard is approved.
      </div>
    );
  }
  if (ms.status === "LIVE" && hasPoints) {
    return (
      <div className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-sm text-amber-300">
        ⏳ Provisional — awaiting reconciliation. Points shown are live and may be revised before final.
      </div>
    );
  }
  if (ms.status === "COMPLETED_FLAGGED") {
    return (
      <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/90">
        ⚠ Unverified — scored from a single source (no cross-check available).
      </div>
    );
  }
  return null;
}

export default function ResultsPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const [data, setData] = useState<ResultsData | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"h2h" | "detail">("h2h");
  const [refreshing, setRefreshing] = useState(false);

  const fetchResults = useCallback(
    async (fresh = false) => {
      // `fresh` (the manual tap) busts the 20s ESPN cache for an instant live pull.
      const res = await fetch(`/api/draft/${code}/results${fresh ? "?fresh=1" : ""}`);
      if (!res.ok) {
        setError("Failed to load results.");
        return;
      }
      setData(await res.json());
    },
    [code]
  );

  // Live-only instant refresh: re-pull the ESPN scorecard right now (no bot, no cricapi).
  const refreshLive = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchResults(true);
    } finally {
      setRefreshing(false);
    }
  }, [fetchResults]);

  useEffect(() => {
    async function init() {
      await fetchResults();
    }
    init();
    const id = setInterval(fetchResults, 30000);
    return () => clearInterval(id);
  }, [fetchResults]);

  if (error) {
    return (
      <main className="min-h-screen bg-ink text-white flex items-center justify-center">
        <p className="text-red-400">{error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="min-h-screen bg-ink text-white flex items-center justify-center">
        <p className="text-mist">Loading results…</p>
      </main>
    );
  }

  const { contest, teams, username } = data;
  const myTeam = teams.find((t) => t.user === username);
  const otherTeams = teams.filter((t) => t.user !== username);

  const hasPoints = teams.some((t) => t.players.some((p) => p.fantasyPoints !== null));
  const orderedTeams = [myTeam, ...otherTeams].filter(Boolean) as TeamResult[];
  const totals = orderedTeams.map((t) => calcXITotal(t));
  const maxTotal = hasPoints && totals.length ? Math.max(...totals) : null;

  // Head-to-head hero framing (built for the common 2-player draft; for 3+ the hero
  // shows you vs the current leader, plus your rank).
  const myTotal = myTeam ? calcXITotal(myTeam) : 0;
  const rankedOpps = otherTeams
    .map((t) => ({ team: t, total: calcXITotal(t) }))
    .sort((a, b) => b.total - a.total);
  const topOpp = rankedOpps[0] ?? null;
  const myRank = 1 + rankedOpps.filter((o) => o.total > myTotal).length;
  const leadMargin = topOpp ? myTotal - topOpp.total : null;
  const denom = topOpp ? myTotal + topOpp.total : myTotal;
  const myShare = denom > 0 ? (myTotal / denom) * 100 : 50;
  const isFinal =
    data.matchStatus?.status === "COMPLETED" || data.matchStatus?.status === "COMPLETED_FLAGGED";
  // Live = started but the COMPLETED pipeline hasn't finalized it. The H2H is then scored
  // in-app from ESPN (instant, no cricapi/bot); tapping "Refresh" re-pulls that immediately.
  const live = data.started && !data.completed;

  return (
    <main className="min-h-screen bg-ink text-white pb-8">
      <div className="max-w-lg mx-auto px-3 pt-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link href={`/match/${contest.matchKey}`} className="text-mist hover:text-white text-lg">←</Link>
          <div className="flex-1">
            <h1 className="font-bold">{contest.matchLabel}</h1>
            <p className="text-xs text-mist">
              {live && data.liveProvisional
                ? "Live · provisional (via ESPN) — auto-refreshes every 30s"
                : live
                ? "Live — waiting for scores"
                : hasPoints
                ? "Refreshes every 30s"
                : "Waiting for match to start"}
            </p>
          </div>
          {live && (
            <button
              onClick={refreshLive}
              disabled={refreshing}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition ${
                refreshing
                  ? "bg-navy border-hair2 text-mist cursor-not-allowed"
                  : "bg-navy border-gold/50 text-gold hover:brightness-110"
              }`}
            >
              {refreshing && (
                <span className="h-3 w-3 rounded-full border-2 border-mist/30 border-t-cloud animate-spin" />
              )}
              {refreshing ? "…" : "🔄 Refresh"}
            </button>
          )}
          <Link href="/lobby" className="text-xs text-mist2 hover:text-cloud">Home</Link>
        </div>

        {/* Recon-status banner: a provisional/awaiting-recon or revised-but-pending result is
            never presented as plain "final" — the numbers may still change. */}
        <ReconBanner ms={data.matchStatus} hasPoints={hasPoints} />

        {/* Refresh the lineup — manual + auto-check at roundlock. On the results
            page this re-pulls the official XI so backup-intelligence subs + the
            effective lineup update the moment lineups post. */}
        <LineupRefresh
          announced={data.announced}
          roundlockTs={(contest.matchDeadline ?? 0) + LOCK_BUFFER}
          onRefresh={fetchResults}
        />

        {/* ── Head-to-head hero — answers "am I winning?" before anything else ── */}
        {orderedTeams.length > 0 && (
          <div className={`rounded-2xl p-4 border ${hasPoints && leadMargin !== null && leadMargin > 0 ? "border-yellow-400/40 bg-gradient-to-b from-yellow-400/10 to-ink2" : "border-hair2 bg-ink2"}`}>
            {topOpp ? (
              <>
                <div className="flex items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-mist font-medium truncate">
                      <span className="text-gold">{getUserLabel(username)}</span> (you)
                    </p>
                    <p className={`text-3xl font-bold tabular-nums ${myTotal >= topOpp.total ? "text-amber-300" : "text-cloud"}`}>
                      {myTotal.toFixed(1)}
                    </p>
                  </div>
                  <span className="text-mist2 text-xs font-bold pb-2">vs</span>
                  <div className="min-w-0 text-right">
                    <p className="text-xs text-mist font-medium truncate">{getUserLabel(topOpp.team.user)}</p>
                    <p className={`text-3xl font-bold tabular-nums ${topOpp.total > myTotal ? "text-amber-300" : "text-cloud"}`}>
                      {topOpp.total.toFixed(1)}
                    </p>
                  </div>
                </div>
                {/* Share bar */}
                <div className="mt-3 h-2 rounded-full bg-navy2 overflow-hidden flex">
                  <span className="h-full bg-gradient-to-r from-gold to-amber-300" style={{ width: `${myShare}%` }} />
                  <span className="h-full bg-[#33456b]" style={{ width: `${100 - myShare}%` }} />
                </div>
                {/* Verdict */}
                <p className={`mt-2.5 text-sm font-semibold ${
                  !hasPoints ? "text-mist2" : leadMargin! > 0 ? "text-emerald-400" : leadMargin! < 0 ? "text-red-400" : "text-mist"
                }`}>
                  {!hasPoints
                    ? "Waiting for points"
                    : leadMargin! > 0
                    ? `${isFinal ? "🏆 " : "▲ "}${
                        otherTeams.length > 1
                          ? `${myRank === 1 ? (isFinal ? "Won" : "Leading") : ordinal(myRank) + " of " + orderedTeams.length}`
                          : isFinal
                          ? "Won"
                          : "Ahead"
                      } by ${leadMargin!.toFixed(1)} pts`
                    : leadMargin! < 0
                    ? `${isFinal ? "Lost" : "▼ Behind"} by ${(-leadMargin!).toFixed(1)} pts`
                    : isFinal ? "● Tied" : "● Level"}
                </p>
              </>
            ) : (
              // Solo (no opponent submitted): just your total.
              <div>
                <p className="text-xs text-mist font-medium">
                  <span className="text-gold">{getUserLabel(username)}</span> (you)
                </p>
                <p className={`text-3xl font-bold tabular-nums ${hasPoints ? "text-amber-300" : "text-mist2"}`}>
                  {myTotal.toFixed(1)}<span className="text-sm text-mist2 font-normal"> pts</span>
                </p>
              </div>
            )}
          </div>
        )}

        {/* Tab switcher — H2H comparison vs the rich single-team breakdown */}
        {orderedTeams.length > 0 && (
          <div className="flex bg-ink2 rounded-xl p-1 gap-1">
            <button
              onClick={() => setTab("h2h")}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${tab === "h2h" ? "bg-ink text-gold" : "text-mist hover:text-cloud"}`}
            >
              Head-to-head
            </button>
            <button
              onClick={() => setTab("detail")}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${tab === "detail" ? "bg-ink text-gold" : "text-mist hover:text-cloud"}`}
            >
              My XI detail
            </button>
          </div>
        )}

        {/* ── HEAD-TO-HEAD: both XIs side by side, full names, sorted by points ── */}
        {tab === "h2h" && orderedTeams.length > 0 && (
          <div className={orderedTeams.length === 2 ? "grid grid-cols-2 gap-2" : "flex gap-2 overflow-x-auto pb-1"}>
            {orderedTeams.map((team) => {
              const total = calcXITotal(team);
              const isWinner = maxTotal !== null && total === maxTotal && total > 0 && orderedTeams.length > 1;
              const color = USER_COLORS[team.user] ?? "bg-gray-500";
              const xi = team.players
                .filter((p) => !p.isBackup)
                .sort((a, b) => (b.fantasyPoints ?? 0) - (a.fantasyPoints ?? 0));

              return (
                <div
                  key={team.user}
                  className={`rounded-xl border overflow-hidden ${orderedTeams.length === 2 ? "" : "min-w-[47%] shrink-0"} ${isWinner ? "border-yellow-400/50 ring-1 ring-yellow-400/20" : "border-hair2"} bg-ink2`}
                >
                  {/* Column head */}
                  <div className={`px-3 py-2.5 border-b border-hair2 ${isWinner ? "bg-yellow-400/[0.06]" : ""}`}>
                    <div className="flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
                      <span className="text-xs font-semibold text-cloud truncate">
                        {getUserLabel(team.user)}{team.user === username ? " (you)" : ""}
                      </span>
                      {isWinner && <span className="ml-auto shrink-0">👑</span>}
                    </div>
                    <p className={`text-xl font-bold tabular-nums mt-1 ${isWinner ? "text-amber-300" : "text-cloud"}`}>
                      {total.toFixed(1)}
                    </p>
                  </div>
                  {/* Rows — two lines each so full names always read */}
                  <div className="flex flex-col">
                    {xi.map((p) => (
                      <div key={p.key} className="flex flex-col gap-0.5 px-2.5 py-2 border-t border-hair2/50 first:border-t-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs shrink-0">{getFlag(p.team)}</span>
                          <span className="text-xs font-medium text-cloud truncate">{p.name}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[9px] font-bold ${ROLE_COLORS[p.role] ?? "text-mist"}`}>{p.role}</span>
                          {p.isCaptain && <span className="text-[8px] bg-yellow-500 text-black px-1 rounded font-bold">C</span>}
                          {p.isViceCaptain && <span className="text-[8px] bg-blue-500 text-white px-1 rounded font-bold">VC</span>}
                          <span className={`ml-auto text-xs font-bold tabular-nums ${p.fantasyPoints !== null ? "text-amber-300" : "text-mist2"}`}>
                            {p.fantasyPoints !== null ? p.fantasyPoints.toFixed(1) : "–"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── MY XI DETAIL: the rich single-column breakdown (C/VC math, bench, recon) ── */}
        {tab === "detail" &&
          orderedTeams.map((team) => {
            const color = USER_COLORS[team.user] ?? "bg-gray-500";
            const xi = team.players.filter((p) => !p.isBackup);
            const bench = team.players.filter((p) => p.isBackup);

            return (
              <div key={team.user} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${color}`} />
                  <h2 className="text-sm font-semibold text-cloud">
                    {getUserLabel(team.user)}{team.user === username ? "'s team (you)" : "'s team"}
                  </h2>
                </div>

                {/* What backup intelligence changed for this team */}
                <ChangesBanner changes={team.changes ?? []} />

                {/* XI */}
                <div className="space-y-1">
                  {xi.map((p) => (
                    <PlayerRow key={p.key} player={p} />
                  ))}
                </div>

                {/* Bench */}
                {bench.length > 0 && (
                  <div className="space-y-1 opacity-60">
                    <p className="text-xs text-mist2 uppercase tracking-wider px-1 pt-1">Bench — not counted</p>
                    {bench.map((p) => (
                      <PlayerRow key={p.key} player={p} isBench />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

        {teams.length === 0 && (
          <div className="text-center py-12">
            <p className="text-mist2">No teams submitted yet. Go finalize your team!</p>
            <Link href={`/draft/${code}/team`} className="mt-4 inline-block text-gold underline">
              Set my team →
            </Link>
          </div>
        )}

        <p className="text-xs text-mist2 text-center">
          Points refresh every 30s · ~ means projected EFPPM (no live data yet)
        </p>
      </div>
    </main>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function PlayerRow({ player, isBench = false }: { player: PlayerResult; isBench?: boolean }) {
  const mult = player.isCaptain ? 2 : player.isViceCaptain ? 1.5 : 1;
  // rawPoints is the base score; fantasyPoints already has mult applied (do NOT re-multiply)
  const raw = player.rawPoints;
  const displayPts = raw !== null ? raw * mult : null;

  return (
    <div className={`flex items-center gap-2 bg-ink2 rounded-lg px-3 py-2 ${isBench ? "opacity-70" : ""}`}>
      <span className="text-base">{getFlag(player.team)}</span>
      <span className={`text-xs font-bold ${ROLE_COLORS[player.role] ?? "text-mist"}`}>
        {player.role}
      </span>
      <span className="flex-1 text-sm font-medium min-w-0 truncate">
        {player.name}
        {player.isCaptain && (
          <span className="ml-1 text-xs bg-yellow-500 text-black px-1 rounded font-bold">C</span>
        )}
        {player.isViceCaptain && (
          <span className="ml-1 text-xs bg-blue-500 text-white px-1 rounded font-bold">VC</span>
        )}
        {player.recon && (
          <span
            title={
              player.recon === "⚠ official revision"
                ? "Official scorecard differs from the approved value — pending review."
                : "cricapi & ESPN disagree on this player — points not yet reconciled."
            }
            className={`ml-1.5 align-middle text-[10px] px-1.5 py-0.5 rounded font-semibold border ${
              player.recon === "⚠ official revision"
                ? "bg-red-500/15 text-red-300 border-red-500/40"
                : "bg-amber-400/15 text-amber-300 border-amber-400/40"
            }`}
          >
            {player.recon === "⚠ official revision" ? "⚠ revision" : "⏳ provisional"}
          </span>
        )}
      </span>
      {/* For C/VC, show base ×mult = total so the multiplier is visibly ALREADY
          applied (102 ×2 = 204) — never the multiplied value beside a bare "×2",
          which misreads as if it'll be doubled again. */}
      <span className="text-sm text-mist shrink-0 whitespace-nowrap">
        {mult > 1 && displayPts !== null && raw !== null && (
          <span className="text-mist2 text-xs mr-1">{raw.toFixed(1)} ×{mult} =</span>
        )}
        <span className={displayPts !== null ? "text-amber-300 font-semibold" : "text-mist2"}>
          {(displayPts ?? 0).toFixed(1)}
        </span>
      </span>
    </div>
  );
}
