"use client";

import { useEffect, useState, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getUserLabel, USER_COLORS } from "@/lib/users";
import { getFlag } from "@/lib/players";

type PlayerInPool = {
  key: string;
  displayName: string;
  role: string;
  teamCode: string;
  efppm: number;
  isLikelyXI: boolean;
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

const ROLE_COLORS: Record<string, string> = {
  WK: "bg-yellow-600",
  BAT: "bg-blue-600",
  AR: "bg-purple-600",
  BOWL: "bg-red-600",
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
  const [picking, setPicking] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    const res = await fetch(`/api/draft/${code}`);
    if (res.status === 401) { router.push("/"); return; }
    if (res.status === 404) { setError("Draft not found."); return; }
    if (res.ok) {
      const data: ContestState = await res.json();
      setState((prev) => {
        if (prev?.contest.status === "WAITING" && data.contest.status === "DRAFTING") {
          setCoinFlipActive(true);
          setTimeout(() => setCoinFlipActive(false), 2500);
        }
        return data;
      });
    }
  }, [code, router]);

  useEffect(() => {
    async function join() {
      setJoining(true);
      await fetch(`/api/draft/${code}/join`, { method: "POST" });
      setJoining(false);
      fetchState();
    }
    join();
  }, [code, fetchState]);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") fetchState();
    }, 2000);
    return () => clearInterval(id);
  }, [fetchState]);

  async function handleTap(playerKey: string) {
    if (picking) return;
    if (!state?.isMyTurn) {
      // Not my turn — queue as preselection
      setPendingKey((prev) => (prev === playerKey ? null : playerKey));
      return;
    }
    if (pendingKey !== playerKey) {
      // First tap when it's my turn — select this player
      setPendingKey(playerKey);
      return;
    }
    // Second tap on selected player — confirm pick
    setPicking(true);
    const res = await fetch(`/api/draft/${code}/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerKey }),
    });
    if (res.ok) {
      const data = await res.json();
      setPendingKey(null);
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
          <Link href="/lobby" className="text-emerald-400 underline">Back to lobby</Link>
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

  const { contest, participants, picks, playerPool, currentPicker, isMyTurn, username, totalPicks } = state;

  if (contest.mode === "manual" && contest.status === "TEAM_SELECT") {
    router.push(`/draft/${code}/team`);
    return null;
  }
  if (["TEAM_SELECT", "LOCKED", "COMPLETED"].includes(contest.status)) {
    router.push(`/draft/${code}/team`);
    return null;
  }

  const isWaiting = contest.status === "WAITING";
  const isDrafting = contest.status === "DRAFTING";

  const teamCodes = [...new Set(playerPool.map((p) => p.teamCode))].sort();
  const [team1Code, team2Code] = teamCodes;
  const team1Pool = playerPool.filter((p) => p.teamCode === team1Code);
  const team2Pool = playerPool.filter((p) => p.teamCode === team2Code);

  const myPicks = picks.filter((p) => p.pickedBy === username);
  const theirPicks = picks.filter((p) => p.pickedBy !== username);
  const others = participants.filter((u) => u !== username);
  const pendingPlayer = pendingKey ? playerPool.find((p) => p.key === pendingKey) : null;

  return (
    <main className="min-h-screen bg-zinc-950 text-white pb-20">
      {coinFlipActive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="text-center space-y-4 animate-bounce">
            <div className="text-6xl">🪙</div>
            <p className="text-2xl font-bold text-yellow-400">Deciding who picks first…</p>
          </div>
        </div>
      )}

      <div className="max-w-lg mx-auto px-3 pt-4 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link href="/lobby" className="text-zinc-400 hover:text-white text-lg">←</Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-sm truncate">{contest.matchLabel}</h1>
            <p className="text-xs text-zinc-400 font-mono">{code}</p>
          </div>
          <Link href={`/draft/${code}/results`} className="text-xs text-zinc-400 hover:text-white shrink-0">
            Results →
          </Link>
        </div>

        {/* Waiting state */}
        {isWaiting && (
          <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl px-4 py-4 space-y-3">
            <p className="text-yellow-400 text-sm font-medium">⏳ Waiting for all players to join…</p>
            <div className="flex flex-wrap gap-2">
              {participants.map((u) => (
                <span key={u} className="bg-zinc-700 px-3 py-1 rounded-full text-sm">
                  ✓ {getUserLabel(u)}
                </span>
              ))}
            </div>
            <div className="bg-zinc-800 rounded-lg px-3 py-2 text-center">
              <p className="text-xs text-zinc-400">Share code:</p>
              <p className="font-mono text-2xl font-bold text-emerald-400 tracking-widest">{code}</p>
            </div>
          </div>
        )}

        {isDrafting && (
          <>
            {/* Status / alarming banner */}
            <div
              className={`rounded-xl px-4 py-3 transition-all ${
                isMyTurn
                  ? "bg-green-950 border-2 border-green-400 shadow-[0_0_20px_rgba(74,222,128,0.35)]"
                  : "bg-zinc-900 border border-zinc-700"
              }`}
            >
              {isMyTurn ? (
                <div className="text-center">
                  <p className="text-green-300 font-extrabold text-lg animate-pulse">
                    🚨 YOUR PICK — TAP TO SELECT!
                  </p>
                  <p className="text-green-500/70 text-xs mt-0.5">
                    Tap once to select · tap again to confirm
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <p className="text-zinc-400 text-sm">
                    ⏳ {getUserLabel(currentPicker ?? "")} is picking…
                  </p>
                  <p className="text-zinc-500 text-xs">{contest.pickCount + 1}/{totalPicks}</p>
                </div>
              )}
              <div className="mt-2 bg-zinc-800 rounded-full h-1">
                <div
                  className="bg-emerald-500 h-1 rounded-full transition-all"
                  style={{ width: `${totalPicks > 0 ? (contest.pickCount / totalPicks) * 100 : 0}%` }}
                />
              </div>
            </div>

            {/* Pending pick bar */}
            {pendingPlayer && (
              <div
                className={`rounded-xl px-3 py-2.5 flex items-center gap-2 ${
                  isMyTurn
                    ? "bg-green-900/40 border border-green-500"
                    : "bg-zinc-800 border border-zinc-600"
                }`}
              >
                <span>{getFlag(pendingPlayer.teamCode)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{pendingPlayer.displayName}</p>
                  <p className="text-xs text-zinc-400">
                    {isMyTurn ? "Tap again or press PICK to confirm" : "Queued for next pick"}
                  </p>
                </div>
                {isMyTurn ? (
                  <button
                    onClick={() => handleTap(pendingPlayer.key)}
                    disabled={picking}
                    className="shrink-0 bg-green-500 hover:bg-green-400 text-black font-extrabold text-sm px-4 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {picking ? "…" : "PICK"}
                  </button>
                ) : (
                  <button
                    onClick={() => setPendingKey(null)}
                    className="shrink-0 text-zinc-500 hover:text-zinc-300 px-2 text-lg"
                  >
                    ✕
                  </button>
                )}
              </div>
            )}

            {/* Two-column player pool */}
            <div className="grid grid-cols-2 divide-x divide-zinc-800">
              {team1Code && (
                <TeamColumn
                  teamCode={team1Code}
                  players={team1Pool}
                  pendingKey={pendingKey}
                  isMyTurn={isMyTurn}
                  onTap={handleTap}
                  username={username}
                />
              )}
              {team2Code && (
                <TeamColumn
                  teamCode={team2Code}
                  players={team2Pool}
                  pendingKey={pendingKey}
                  isMyTurn={isMyTurn}
                  onTap={handleTap}
                  username={username}
                />
              )}
            </div>

            {/* Picks summary */}
            {picks.length > 0 && (
              <PicksSummary
                myPicks={myPicks}
                theirPicks={theirPicks}
                username={username}
                others={others}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}

function TeamColumn({
  teamCode,
  players,
  pendingKey,
  isMyTurn,
  onTap,
  username,
}: {
  teamCode: string;
  players: PlayerInPool[];
  pendingKey: string | null;
  isMyTurn: boolean;
  onTap: (key: string) => void;
  username: string;
}) {
  const xi = players.filter((p) => p.isLikelyXI);
  const bench = players.filter((p) => !p.isLikelyXI);

  return (
    <div className="px-1.5 pb-2 space-y-0.5">
      <div className="text-center py-1.5 sticky top-0 bg-zinc-950 z-10">
        <p className="text-base">{getFlag(teamCode)}</p>
        <p className="text-xs font-bold text-zinc-200">{teamCode}</p>
      </div>

      <p className="text-center text-xs text-zinc-500 border-b border-zinc-700 pb-0.5 mb-1">— XI —</p>
      {xi.map((p) => (
        <PlayerRow
          key={p.key}
          player={p}
          isPending={pendingKey === p.key}
          isMyTurn={isMyTurn}
          onTap={onTap}
          username={username}
        />
      ))}

      {bench.length > 0 && (
        <>
          <p className="text-center text-xs text-zinc-600 border-b border-zinc-800 pb-0.5 mt-2 mb-1">— bench —</p>
          {bench.map((p) => (
            <PlayerRow
              key={p.key}
              player={p}
              isPending={pendingKey === p.key}
              isMyTurn={isMyTurn}
              onTap={onTap}
              username={username}
            />
          ))}
        </>
      )}
    </div>
  );
}

function PlayerRow({
  player,
  isPending,
  isMyTurn,
  onTap,
  username,
}: {
  player: PlayerInPool;
  isPending: boolean;
  isMyTurn: boolean;
  onTap: (key: string) => void;
  username: string;
}) {
  const isTaken = !!player.takenBy;
  const takerColor =
    player.takenBy && USER_COLORS[player.takenBy]
      ? USER_COLORS[player.takenBy]
      : "bg-gray-500";

  const bgClass = isTaken
    ? "opacity-50"
    : isPending && isMyTurn
    ? "bg-green-900/50 ring-1 ring-green-400"
    : isPending
    ? "bg-yellow-900/30 ring-1 ring-yellow-500"
    : "bg-zinc-900 active:bg-zinc-700";

  return (
    <div
      onClick={isTaken ? undefined : () => onTap(player.key)}
      className={`rounded-lg px-1.5 py-1.5 transition-colors ${bgClass} ${isTaken ? "" : "cursor-pointer"}`}
    >
      <div className="flex items-center gap-1 min-w-0">
        <span
          className={`text-xs font-bold px-1 py-0.5 rounded shrink-0 ${ROLE_COLORS[player.role] ?? "bg-zinc-600"}`}
        >
          {player.role[0]}
        </span>
        <span className={`flex-1 text-xs font-medium truncate ${isTaken ? "text-zinc-500" : "text-white"}`}>
          {player.displayName}
        </span>
        {isTaken ? (
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${takerColor}`} />
        ) : (
          <span className="text-zinc-400 text-xs shrink-0">{player.efppm.toFixed(0)}</span>
        )}
      </div>
    </div>
  );
}

function PicksSummary({
  myPicks,
  theirPicks,
  username,
  others,
}: {
  myPicks: Pick[];
  theirPicks: Pick[];
  username: string;
  others: string[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-zinc-900 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium"
      >
        <span>
          You: {myPicks.length}{" "}
          {others.map((u) => `· ${getUserLabel(u)}: ${theirPicks.filter((p) => p.pickedBy === u).length}`).join(" ")}
        </span>
        <span className="text-zinc-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 grid grid-cols-2 gap-2">
          <div>
            <p className="text-xs text-zinc-500 mb-1">You</p>
            <div className="space-y-0.5">
              {myPicks.map((pk) => (
                <div key={pk.playerKey} className="text-xs bg-zinc-800 rounded px-2 py-1 flex justify-between">
                  <span className="font-medium truncate">{pk.playerName}</span>
                  <span className="text-zinc-500 ml-1 shrink-0">{pk.playerTeam}</span>
                </div>
              ))}
            </div>
          </div>
          {others.map((u) => (
            <div key={u}>
              <p className="text-xs text-zinc-500 mb-1">{getUserLabel(u)}</p>
              <div className="space-y-0.5">
                {theirPicks
                  .filter((p) => p.pickedBy === u)
                  .map((pk) => (
                    <div key={pk.playerKey} className="text-xs bg-zinc-800 rounded px-2 py-1 flex justify-between">
                      <span className="font-medium truncate">{pk.playerName}</span>
                      <span className="text-zinc-500 ml-1 shrink-0">{pk.playerTeam}</span>
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
