"use client";

import { useEffect, useState, use, useCallback } from "react";
import Link from "next/link";
import { getUserLabel, USER_COLORS } from "@/lib/users";
import { getFlag } from "@/lib/players";

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
};

type TeamResult = {
  user: string;
  players: PlayerResult[];
  captainKey: string | null;
  viceCaptainKey: string | null;
  isLocked: boolean;
  totalPoints: number | null;
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

export default function ResultsPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const [data, setData] = useState<ResultsData | null>(null);
  const [error, setError] = useState("");

  const fetchResults = useCallback(async () => {
    const res = await fetch(`/api/draft/${code}/results`);
    if (!res.ok) {
      setError("Failed to load results.");
      return;
    }
    setData(await res.json());
  }, [code]);

  useEffect(() => {
    fetchResults();
    const id = setInterval(fetchResults, 30000);
    return () => clearInterval(id);
  }, [fetchResults]);

  if (error) {
    return (
      <main className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <p className="text-red-400">{error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <p className="text-zinc-400">Loading results…</p>
      </main>
    );
  }

  const { contest, teams, username } = data;
  const myTeam = teams.find((t) => t.user === username);
  const otherTeams = teams.filter((t) => t.user !== username);

  const totals = teams.map((t) => calcXITotal(t));
  const hasPoints = teams.some((t) => t.players.some((p) => p.fantasyPoints !== null));
  const maxTotal = hasPoints ? Math.max(...totals) : null;

  const orderedTeams = [myTeam, ...otherTeams].filter(Boolean) as TeamResult[];

  return (
    <main className="min-h-screen bg-zinc-950 text-white pb-8">
      <div className="max-w-lg mx-auto px-3 pt-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link href={`/match/${contest.matchKey}`} className="text-zinc-400 hover:text-white text-lg">←</Link>
          <div className="flex-1">
            <h1 className="font-bold">{contest.matchLabel}</h1>
            <p className="text-xs text-zinc-400">
              {hasPoints ? "Live points — refreshes every 30s" : "Waiting for match to start"}
            </p>
          </div>
          <Link href="/lobby" className="text-xs text-zinc-500 hover:text-zinc-300">Home</Link>
        </div>

        {/* Scoreboard */}
        {teams.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {orderedTeams.map((team) => {
              const total = calcXITotal(team);
              const isWinner = total !== null && total === maxTotal && total > 0;
              const color = USER_COLORS[team.user] ?? "bg-gray-500";

              return (
                <div
                  key={team.user}
                  className={`bg-zinc-900 rounded-xl p-3 ${isWinner ? "ring-2 ring-yellow-400" : ""}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-3 h-3 rounded-full ${color}`} />
                    <span className="font-semibold text-sm truncate">
                      {getUserLabel(team.user)}
                      {team.user === username && <span className="text-zinc-500"> (you)</span>}
                    </span>
                    {isWinner && <span className="ml-auto text-yellow-400 shrink-0">🏆</span>}
                  </div>
                  <p className={`text-2xl font-bold ${hasPoints ? "text-emerald-400" : "text-zinc-600"}`}>
                    {total.toFixed(1)}
                    <span className="text-sm text-zinc-500 font-normal"> pts</span>
                  </p>
                </div>
              );
            })}
          </div>
        )}

        {/* Team breakdowns — both users' teams always visible */}
        {orderedTeams.map((team) => {
          const color = USER_COLORS[team.user] ?? "bg-gray-500";
          const xi = team.players.filter((p) => !p.isBackup);
          const bench = team.players.filter((p) => p.isBackup);

          return (
            <div key={team.user} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${color}`} />
                <h2 className="text-sm font-semibold text-zinc-300">
                  {getUserLabel(team.user)}{team.user === username ? "'s team (you)" : "'s team"}
                </h2>
              </div>

              {/* XI */}
              <div className="space-y-1">
                {xi.map((p) => (
                  <PlayerRow key={p.key} player={p} />
                ))}
              </div>

              {/* Bench */}
              {bench.length > 0 && (
                <div className="space-y-1 opacity-60">
                  <p className="text-xs text-zinc-500 uppercase tracking-wider px-1 pt-1">Bench — not counted</p>
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
            <p className="text-zinc-500">No teams submitted yet. Go finalize your team!</p>
            <Link href={`/draft/${code}/team`} className="mt-4 inline-block text-emerald-400 underline">
              Set my team →
            </Link>
          </div>
        )}

        <p className="text-xs text-zinc-700 text-center">
          Points refresh every 30s · ~ means projected EFPPM (no live data yet)
        </p>
      </div>
    </main>
  );
}

function PlayerRow({ player, isBench = false }: { player: PlayerResult; isBench?: boolean }) {
  const mult = player.isCaptain ? 2 : player.isViceCaptain ? 1.5 : 1;
  // rawPoints is the base score; fantasyPoints already has mult applied (do NOT re-multiply)
  const raw = player.rawPoints;
  const displayPts = raw !== null ? raw * mult : null;

  return (
    <div className={`flex items-center gap-2 bg-zinc-900 rounded-lg px-3 py-2 ${isBench ? "opacity-70" : ""}`}>
      <span className="text-base">{getFlag(player.team)}</span>
      <span className={`text-xs font-bold ${ROLE_COLORS[player.role] ?? "text-zinc-400"}`}>
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
      </span>
      <span className="text-sm text-zinc-400 shrink-0">
        <span className={displayPts !== null ? "text-emerald-400 font-semibold" : "text-zinc-600"}>
          {(displayPts ?? 0).toFixed(1)}
        </span>
        {mult > 1 && displayPts !== null && (
          <span className="text-zinc-600 text-xs ml-1">×{mult}</span>
        )}
      </span>
    </div>
  );
}
