"use client";

import { useEffect, useState, use, useCallback } from "react";
import Link from "next/link";
import { getUserLabel, USER_COLORS } from "@/lib/users";
import { getFlag } from "@/lib/players";
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

  const totals = teams.map((t) => calcXITotal(t));
  const hasPoints = teams.some((t) => t.players.some((p) => p.fantasyPoints !== null));
  const maxTotal = hasPoints ? Math.max(...totals) : null;

  const orderedTeams = [myTeam, ...otherTeams].filter(Boolean) as TeamResult[];

  return (
    <main className="min-h-screen bg-ink text-white pb-8">
      <div className="max-w-lg mx-auto px-3 pt-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link href={`/match/${contest.matchKey}`} className="text-mist hover:text-white text-lg">←</Link>
          <div className="flex-1">
            <h1 className="font-bold">{contest.matchLabel}</h1>
            <p className="text-xs text-mist">
              {hasPoints ? "Live points — refreshes every 30s" : "Waiting for match to start"}
            </p>
          </div>
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
          roundlockTs={(contest.matchDeadline ?? 0) + 30 * 60}
          onRefresh={fetchResults}
        />

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
                  className={`bg-ink2 rounded-xl p-3 ${isWinner ? "ring-2 ring-yellow-400" : ""}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-3 h-3 rounded-full ${color}`} />
                    <span className="font-semibold text-sm truncate">
                      {getUserLabel(team.user)}
                      {team.user === username && <span className="text-mist2"> (you)</span>}
                    </span>
                    {isWinner && <span className="ml-auto text-yellow-400 shrink-0">🏆</span>}
                  </div>
                  <p className={`text-2xl font-bold ${hasPoints ? "text-amber-300" : "text-mist2"}`}>
                    {total.toFixed(1)}
                    <span className="text-sm text-mist2 font-normal"> pts</span>
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
