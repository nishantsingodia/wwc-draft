"use client";

import { useEffect, useState, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PlayerCard from "@/components/player-card";
import { getUserLabel, USER_COLORS } from "@/lib/users";
import { TEAM_NAMES } from "@/lib/players";

type PlayerInPool = {
  key: string;
  displayName: string;
  role: string;
  teamCode: string;
  efppm: number;
  takenBy: string | null;
};

type Pick = {
  playerKey: string;
  playerName: string;
  playerRole: string;
  playerTeam: string;
  pickedBy: string;
  pickNumber: number;
};

type ContestState = {
  contest: {
    code: string;
    matchLabel: string;
    matchDeadline: number;
    picksPerUser: number;
    backupsPerUser: number;
    mode: "live" | "manual";
    status: string;
    draftOrder: string[] | null;
    pickCount: number;
  };
  participants: string[];
  picks: Pick[];
  playerPool: PlayerInPool[];
  currentPicker: string | null;
  isMyTurn: boolean;
  totalPicks: number;
  username: string;
  takenCount: number;
};

export default function DraftBoardPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const router = useRouter();
  const [state, setState] = useState<ContestState | null>(null);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [coinFlipActive, setCoinFlipActive] = useState(false);
  const [filter, setFilter] = useState<"ALL" | "WK" | "BAT" | "AR" | "BOWL">(
    "ALL"
  );
  const [teamFilter, setTeamFilter] = useState<"ALL" | string>("ALL");
  const [picking, setPicking] = useState(false);

  const fetchState = useCallback(async () => {
    const res = await fetch(`/api/draft/${code}`);
    if (res.status === 401) {
      router.push("/");
      return;
    }
    if (res.status === 404) {
      setError("Draft not found.");
      return;
    }
    if (res.ok) {
      const data: ContestState = await res.json();
      setState((prev) => {
        // Detect transition from WAITING → DRAFTING for coin flip animation
        if (
          prev?.contest.status === "WAITING" &&
          data.contest.status === "DRAFTING"
        ) {
          setCoinFlipActive(true);
          setTimeout(() => setCoinFlipActive(false), 2500);
        }
        return data;
      });
    }
  }, [code, router]);

  // Join contest on mount
  useEffect(() => {
    async function join() {
      setJoining(true);
      await fetch(`/api/draft/${code}/join`, { method: "POST" });
      setJoining(false);
      fetchState();
    }
    join();
  }, [code, fetchState]);

  // Poll every 2s
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") fetchState();
    }, 2000);
    return () => clearInterval(id);
  }, [fetchState]);

  async function handlePick(playerKey: string) {
    if (!state?.isMyTurn || picking) return;
    setPicking(true);
    const res = await fetch(`/api/draft/${code}/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerKey }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.draftComplete) {
        router.push(`/draft/${code}/team`);
        return;
      }
    }
    await fetchState();
    setPicking(false);
  }

  if (error) {
    return (
      <main className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-red-400">{error}</p>
          <Link href="/lobby" className="text-emerald-400 underline">
            Back to lobby
          </Link>
        </div>
      </main>
    );
  }

  if (!state || joining) {
    return (
      <main className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="text-4xl animate-spin">⟳</div>
          <p className="text-zinc-400">Joining draft…</p>
        </div>
      </main>
    );
  }

  const { contest, participants, picks, playerPool, currentPicker, isMyTurn, username, totalPicks } =
    state;

  // Manual mode: redirect to team selection directly
  if (contest.mode === "manual" && contest.status === "TEAM_SELECT") {
    router.push(`/draft/${code}/team`);
    return null;
  }

  if (contest.status === "TEAM_SELECT" || contest.status === "LOCKED" || contest.status === "COMPLETED") {
    router.push(`/draft/${code}/team`);
    return null;
  }

  const teams = [...new Set(playerPool.map((p) => p.teamCode))];
  const filtered = playerPool.filter(
    (p) =>
      (filter === "ALL" || p.role === filter) &&
      (teamFilter === "ALL" || p.teamCode === teamFilter)
  );

  const myPicks = picks.filter((p) => p.pickedBy === username);
  const theirPicks = picks.filter((p) => p.pickedBy !== username);

  const isWaiting = contest.status === "WAITING";
  const isDrafting = contest.status === "DRAFTING";

  return (
    <main className="min-h-screen bg-zinc-950 text-white pb-20">
      {/* Coin flip overlay */}
      {coinFlipActive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="text-center space-y-4 animate-bounce">
            <div className="text-6xl">🪙</div>
            <p className="text-2xl font-bold text-yellow-400">
              Deciding who picks first…
            </p>
          </div>
        </div>
      )}

      <div className="max-w-lg mx-auto px-3 pt-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link href="/lobby" className="text-zinc-400 hover:text-white text-lg">
            ←
          </Link>
          <div className="flex-1">
            <h1 className="font-bold">{contest.matchLabel}</h1>
            <p className="text-xs text-zinc-400 font-mono">{code}</p>
          </div>
          <Link
            href={`/draft/${code}/results`}
            className="text-xs text-zinc-400 hover:text-white"
          >
            Results →
          </Link>
        </div>

        {/* Status banner */}
        <StatusBanner
          status={contest.status}
          participants={participants}
          currentPicker={currentPicker}
          isMyTurn={isMyTurn}
          username={username}
          pickCount={contest.pickCount}
          totalPicks={totalPicks}
        />

        {/* Filters */}
        {isDrafting && (
          <div className="space-y-2">
            <div className="flex gap-1 overflow-x-auto pb-1">
              {(["ALL", "WK", "BAT", "AR", "BOWL"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setFilter(r)}
                  className={`px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                    filter === r
                      ? "bg-emerald-600 text-white"
                      : "bg-zinc-800 text-zinc-400 hover:text-white"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <div className="flex gap-1 overflow-x-auto pb-1">
              <button
                onClick={() => setTeamFilter("ALL")}
                className={`px-3 py-1 rounded-full text-xs whitespace-nowrap transition-colors ${
                  teamFilter === "ALL"
                    ? "bg-zinc-600 text-white"
                    : "bg-zinc-800 text-zinc-500 hover:text-white"
                }`}
              >
                All teams
              </button>
              {teams.map((t) => (
                <button
                  key={t}
                  onClick={() => setTeamFilter(t)}
                  className={`px-3 py-1 rounded-full text-xs whitespace-nowrap transition-colors ${
                    teamFilter === t
                      ? "bg-zinc-600 text-white"
                      : "bg-zinc-800 text-zinc-500 hover:text-white"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Waiting state */}
        {isWaiting && (
          <div className="bg-zinc-900 rounded-xl p-6 text-center space-y-3">
            <p className="text-zinc-400">
              Waiting for all players to join…
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              {participants.map((u) => (
                <span
                  key={u}
                  className="bg-zinc-700 px-3 py-1 rounded-full text-sm"
                >
                  ✓ {getUserLabel(u)}
                </span>
              ))}
            </div>
            <div className="mt-2 bg-zinc-800 rounded-lg px-4 py-2">
              <p className="text-sm text-zinc-400">Share code with friends:</p>
              <p className="font-mono text-2xl font-bold text-emerald-400 tracking-widest">
                {code}
              </p>
            </div>
          </div>
        )}

        {/* Player pool */}
        {isDrafting && (
          <div className="space-y-2">
            <p className="text-xs text-zinc-500">
              {picks.length}/{totalPicks} picks made · tap to pick
            </p>
            <div className="space-y-1.5">
              {filtered.map((p) => (
                <PlayerCard
                  key={p.key}
                  playerKey={p.key}
                  displayName={p.displayName}
                  role={p.role}
                  teamCode={p.teamCode}
                  efppm={p.efppm}
                  takenBy={p.takenBy}
                  isMyTurn={isMyTurn && !picking}
                  onClick={() => handlePick(p.key)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Picks sidebar (collapsible) */}
        {picks.length > 0 && <PicksList myPicks={myPicks} theirPicks={theirPicks} username={username} participants={participants} />}
      </div>
    </main>
  );
}

function StatusBanner({
  status,
  participants,
  currentPicker,
  isMyTurn,
  username,
  pickCount,
  totalPicks,
}: {
  status: string;
  participants: string[];
  currentPicker: string | null;
  isMyTurn: boolean;
  username: string;
  pickCount: number;
  totalPicks: number;
}) {
  if (status === "WAITING") {
    return (
      <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl px-4 py-3">
        <p className="text-yellow-400 text-sm font-medium">
          ⏳ Waiting for all players to join…
        </p>
        <p className="text-zinc-400 text-xs mt-1">
          Share the code. Draft starts when everyone joins.
        </p>
      </div>
    );
  }

  if (status === "DRAFTING") {
    const progress = totalPicks > 0 ? (pickCount / totalPicks) * 100 : 0;
    return (
      <div
        className={`rounded-xl px-4 py-3 ${
          isMyTurn
            ? "bg-emerald-900/40 border border-emerald-600"
            : "bg-zinc-900 border border-zinc-700"
        }`}
      >
        <p className={`font-semibold ${isMyTurn ? "text-emerald-300" : "text-white"}`}>
          {isMyTurn
            ? "🎯 Your turn — pick a player!"
            : `⏳ ${getUserLabel(currentPicker ?? "")} is picking…`}
        </p>
        <div className="mt-2 bg-zinc-800 rounded-full h-1.5">
          <div
            className="bg-emerald-500 h-1.5 rounded-full transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="text-xs text-zinc-500 mt-1">
          Pick {pickCount + 1} of {totalPicks}
        </p>
      </div>
    );
  }

  return null;
}

function PicksList({
  myPicks,
  theirPicks,
  username,
  participants,
}: {
  myPicks: Pick[];
  theirPicks: Pick[];
  username: string;
  participants: string[];
}) {
  const [open, setOpen] = useState(false);
  const others = participants.filter((u) => u !== username);

  return (
    <div className="bg-zinc-900 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium"
      >
        <span>
          Your picks ({myPicks.length}) ·{" "}
          {others.map((u) => `${getUserLabel(u)}: ${theirPicks.filter((p) => p.pickedBy === u).length}`).join(", ")}
        </span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 grid grid-cols-2 gap-2">
          {/* My picks */}
          <div>
            <p className="text-xs text-zinc-500 mb-1">You</p>
            <div className="space-y-1">
              {myPicks.map((pk) => (
                <div key={pk.playerKey} className="text-xs bg-zinc-800 rounded px-2 py-1">
                  <span className="font-medium">{pk.playerName}</span>
                  <span className="text-zinc-500 ml-1">{pk.playerTeam}</span>
                </div>
              ))}
            </div>
          </div>
          {/* Their picks */}
          {others.map((u) => (
            <div key={u}>
              <p className="text-xs text-zinc-500 mb-1">{getUserLabel(u)}</p>
              <div className="space-y-1">
                {theirPicks
                  .filter((p) => p.pickedBy === u)
                  .map((pk) => (
                    <div key={pk.playerKey} className="text-xs bg-zinc-800 rounded px-2 py-1">
                      <span className="font-medium">{pk.playerName}</span>
                      <span className="text-zinc-500 ml-1">{pk.playerTeam}</span>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
