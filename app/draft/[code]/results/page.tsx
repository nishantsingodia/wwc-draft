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
  fantasyPoints: number | null;
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

function calcTotal(team: TeamResult): number | null {
  if (team.players.every((p) => p.fantasyPoints === null)) return null;
  return team.players.reduce((sum, p) => {
    if (p.fantasyPoints === null) return sum;
    const mult = p.isCaptain ? 2 : p.isViceCaptain ? 1.5 : 1;
    return sum + p.fantasyPoints * mult;
  }, 0);
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

  const totals = teams.map((t) => calcTotal(t));
  const hasPoints = totals.some((t) => t !== null);
  const maxTotal = hasPoints ? Math.max(...(totals.filter((t) => t !== null) as number[])) : null;

  return (
    <main className="min-h-screen bg-zinc-950 text-white pb-8">
      <div className="max-w-lg mx-auto px-3 pt-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link
            href={`/draft/${code}/team`}
            className="text-zinc-400 hover:text-white text-lg"
          >
            ←
          </Link>
          <div className="flex-1">
            <h1 className="font-bold">{contest.matchLabel}</h1>
            <p className="text-xs text-zinc-400">
              {hasPoints ? "Live points" : "Waiting for match to start"}
            </p>
          </div>
        </div>

        {/* Scoreboard */}
        {teams.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {[myTeam, ...otherTeams].filter(Boolean).map((team) => {
              if (!team) return null;
              const total = calcTotal(team);
              const isWinner = total !== null && total === maxTotal && total > 0;
              const color = USER_COLORS[team.user] ?? "bg-gray-500";

              return (
                <div
                  key={team.user}
                  className={`bg-zinc-900 rounded-xl p-3 ${
                    isWinner ? "ring-2 ring-yellow-400" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-3 h-3 rounded-full ${color}`} />
                    <span className="font-semibold text-sm">
                      {getUserLabel(team.user)}
                      {team.user === username && (
                        <span className="text-zinc-500"> (you)</span>
                      )}
                    </span>
                    {isWinner && (
                      <span className="ml-auto text-yellow-400">🏆</span>
                    )}
                  </div>
                  {total !== null ? (
                    <p className="text-2xl font-bold text-emerald-400">
                      {total.toFixed(1)}
                      <span className="text-sm text-zinc-500 font-normal">
                        {" "}
                        pts
                      </span>
                    </p>
                  ) : (
                    <p className="text-sm text-zinc-500">Points pending</p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Team details */}
        {[myTeam, ...otherTeams].filter(Boolean).map((team) => {
          if (!team) return null;
          const color = USER_COLORS[team.user] ?? "bg-gray-500";

          return (
            <div key={team.user} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${color}`} />
                <h2 className="text-sm font-semibold text-zinc-300">
                  {getUserLabel(team.user)}
                  {team.user === username && "'s team"}
                </h2>
              </div>

              <div className="space-y-1">
                {team.players.map((p) => {
                  const mult = p.isCaptain ? 2 : p.isViceCaptain ? 1.5 : 1;
                  const pts =
                    p.fantasyPoints !== null
                      ? p.fantasyPoints * mult
                      : null;

                  return (
                    <div
                      key={p.key}
                      className="flex items-center gap-2 bg-zinc-900 rounded-lg px-3 py-2"
                    >
                      <span className="text-base">{getFlag(p.team)}</span>
                      <span
                        className={`text-xs font-bold ${
                          ROLE_COLORS[p.role] ?? "text-zinc-400"
                        }`}
                      >
                        {p.role}
                      </span>
                      <span className="flex-1 text-sm font-medium">
                        {p.name}
                        {p.isCaptain && (
                          <span className="ml-1 text-xs bg-yellow-500 text-black px-1 rounded font-bold">
                            C
                          </span>
                        )}
                        {p.isViceCaptain && (
                          <span className="ml-1 text-xs bg-blue-500 text-white px-1 rounded font-bold">
                            VC
                          </span>
                        )}
                      </span>
                      <span className="text-sm text-zinc-400">
                        {pts !== null ? (
                          <>
                            <span className="text-emerald-400 font-semibold">
                              {pts.toFixed(1)}
                            </span>
                            {mult > 1 && (
                              <span className="text-zinc-600 text-xs ml-1">
                                ×{mult}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-zinc-600">
                            ~{p.efppm.toFixed(0)}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {teams.length === 0 && (
          <div className="text-center py-12">
            <p className="text-zinc-500">
              No teams submitted yet. Go finalize your team!
            </p>
            <Link
              href={`/draft/${code}/team`}
              className="mt-4 inline-block text-emerald-400 underline"
            >
              Set my team →
            </Link>
          </div>
        )}

        <p className="text-xs text-zinc-700 text-center">
          Points refresh every 30s · ~{" "}
          means projected EFPPM (no live data yet)
        </p>
      </div>
    </main>
  );
}
