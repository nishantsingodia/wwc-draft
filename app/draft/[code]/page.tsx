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

const ROLES = ["ALL", "WK", "BAT", "AR", "BOWL"] as const;
type RoleFilter = (typeof ROLES)[number];

const ROLE_COLORS: Record<string, string> = {
  WK: "bg-yellow-500 text-black",
  BAT: "bg-blue-500 text-white",
  AR: "bg-purple-500 text-white",
  BOWL: "bg-red-500 text-white",
};

const ROLE_FULL: Record<string, string> = {
  WK: "Wicket Keepers",
  BAT: "Batters",
  AR: "All-Rounders",
  BOWL: "Bowlers",
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
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("ALL");

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
      setPendingKey((prev) => (prev === playerKey ? null : playerKey));
      return;
    }
    if (pendingKey !== playerKey) {
      setPendingKey(playerKey);
      return;
    }
    // Second tap — confirm pick
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
    router.push(`/draft/${code}/team`); return null;
  }
  if (["TEAM_SELECT", "LOCKED", "COMPLETED"].includes(contest.status)) {
    router.push(`/draft/${code}/team`); return null;
  }

  const isWaiting = contest.status === "WAITING";
  const isDrafting = contest.status === "DRAFTING";

  const teamCodes = [...new Set(playerPool.map((p) => p.teamCode))].sort();
  const [team1Code, team2Code] = teamCodes;

  const myPicks = picks.filter((p) => p.pickedBy === username);
  const theirPicks = picks.filter((p) => p.pickedBy !== username);
  const others = participants.filter((u) => u !== username);
  const pendingPlayer = pendingKey ? playerPool.find((p) => p.key === pendingKey) : null;

  // Pool split by team, filtered by role
  const filteredPool = roleFilter === "ALL"
    ? playerPool
    : playerPool.filter((p) => p.role === roleFilter);
  const t1 = filteredPool.filter((p) => p.teamCode === team1Code);
  const t2 = filteredPool.filter((p) => p.teamCode === team2Code);

  // Role counts (available only)
  const available = playerPool.filter((p) => !p.takenBy);
  const roleCounts: Record<string, number> = { ALL: available.length };
  for (const r of ["WK", "BAT", "AR", "BOWL"]) {
    roleCounts[r] = available.filter((p) => p.role === r).length;
  }

  return (
    <main className="min-h-screen bg-[#0a1628] text-white">
      {coinFlipActive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="text-center space-y-4 animate-bounce">
            <div className="text-6xl">🪙</div>
            <p className="text-2xl font-bold text-yellow-400">Deciding who picks first…</p>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="bg-[#112347] px-3 pt-3 pb-0 sticky top-0 z-20">
        <div className="flex items-center gap-2 pb-3">
          <Link href="/lobby" className="text-zinc-400 hover:text-white text-xl leading-none">←</Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-sm truncate">{contest.matchLabel}</h1>
            <p className="text-xs text-zinc-400 font-mono">{code}</p>
          </div>
          <Link href={`/draft/${code}/results`} className="text-xs text-zinc-400 hover:text-white shrink-0">
            Results →
          </Link>
        </div>

        {/* Team header row */}
        {isDrafting && team1Code && team2Code && (
          <div className="grid grid-cols-2 divide-x divide-zinc-600 border-t border-zinc-700">
            <div className="text-center py-1.5">
              <p className="text-base">{getFlag(team1Code)}</p>
              <p className="text-xs font-bold text-zinc-200">{team1Code}</p>
            </div>
            <div className="text-center py-1.5">
              <p className="text-base">{getFlag(team2Code)}</p>
              <p className="text-xs font-bold text-zinc-200">{team2Code}</p>
            </div>
          </div>
        )}

        {/* Role tabs (D11-style) */}
        {isDrafting && (
          <div className="flex border-t border-zinc-700">
            {ROLES.map((r) => (
              <button
                key={r}
                onClick={() => setRoleFilter(r)}
                className={`flex-1 py-2 text-xs font-semibold transition-colors relative ${
                  roleFilter === r
                    ? "text-[#d4af37]"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {r}
                {r !== "ALL" && (
                  <span className="ml-0.5 text-zinc-500">({roleCounts[r] ?? 0})</span>
                )}
                {roleFilter === r && (
                  <span className="absolute bottom-0 inset-x-0 h-0.5 bg-[#d4af37] rounded-t" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-3 pt-3 pb-24 space-y-3 max-w-lg mx-auto">
        {/* Waiting state */}
        {isWaiting && (
          <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl px-4 py-4 space-y-3">
            <p className="text-yellow-400 text-sm font-medium">⏳ Waiting for all players to join…</p>
            <div className="flex flex-wrap gap-2">
              {participants.map((u) => (
                <span key={u} className="bg-zinc-700 px-3 py-1 rounded-full text-sm">✓ {getUserLabel(u)}</span>
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
                  : "bg-[#1a2f56] border border-zinc-700"
              }`}
            >
              {isMyTurn ? (
                <div className="text-center">
                  <p className="text-green-300 font-extrabold text-lg animate-pulse">🚨 YOUR PICK!</p>
                  <p className="text-green-500/70 text-xs mt-0.5">Tap once to select · tap again to confirm</p>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <p className="text-zinc-300 text-sm">
                    ⏳ <span className="font-semibold">{getUserLabel(currentPicker ?? "")}</span> is picking…
                  </p>
                  <p className="text-zinc-500 text-xs bg-zinc-800 px-2 py-0.5 rounded-full">
                    {contest.pickCount + 1}/{totalPicks}
                  </p>
                </div>
              )}
              <div className="mt-2 bg-zinc-800 rounded-full h-1">
                <div
                  className="bg-[#d4af37] h-1 rounded-full transition-all"
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
                    : "bg-[#1a2f56] border border-zinc-600"
                }`}
              >
                <span className="text-lg">{getFlag(pendingPlayer.teamCode)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{pendingPlayer.displayName}</p>
                  <p className="text-xs text-zinc-400">
                    {isMyTurn ? "Tap PICK or tap player again to confirm" : "Queued — will pick when it's your turn"}
                  </p>
                </div>
                {isMyTurn ? (
                  <button
                    onClick={() => handleTap(pendingPlayer.key)}
                    disabled={picking}
                    className="shrink-0 bg-green-500 hover:bg-green-400 text-black font-extrabold text-sm px-4 py-2 rounded-xl transition-colors disabled:opacity-50"
                  >
                    {picking ? "…" : "PICK ✓"}
                  </button>
                ) : (
                  <button onClick={() => setPendingKey(null)} className="shrink-0 text-zinc-500 hover:text-zinc-300 px-2 text-lg">✕</button>
                )}
              </div>
            )}

            {/* Role section header */}
            {roleFilter !== "ALL" && (
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider px-1">
                {ROLE_FULL[roleFilter]} — {roleCounts[roleFilter] ?? 0} available
              </p>
            )}

            {/* Two-column D11-style player grid */}
            <div className="grid grid-cols-2 gap-px bg-zinc-800 rounded-xl overflow-hidden">
              {/* Team 1 column */}
              <div className="bg-[#0a1628] space-y-px">
                {renderTeamSection(t1, pendingKey, isMyTurn, handleTap, username)}
              </div>
              {/* Team 2 column */}
              <div className="bg-[#0a1628] space-y-px">
                {renderTeamSection(t2, pendingKey, isMyTurn, handleTap, username)}
              </div>
            </div>

            {/* Picks summary */}
            {picks.length > 0 && (
              <PicksSummary myPicks={myPicks} theirPicks={theirPicks} username={username} others={others} />
            )}
          </>
        )}
      </div>

      {/* Bottom picks counter */}
      {isDrafting && (
        <div className="fixed bottom-0 inset-x-0 bg-[#112347] border-t border-zinc-700 px-4 py-2 z-20">
          <div className="max-w-lg mx-auto flex items-center justify-between text-xs">
            <span className="text-zinc-400">
              Your picks: <span className="text-white font-bold">{myPicks.length}</span>/{contest.picksPerUser + contest.backupsPerUser}
            </span>
            {others.map((u) => (
              <span key={u} className="text-zinc-400">
                {getUserLabel(u)}: <span className="text-white font-bold">{theirPicks.filter((p) => p.pickedBy === u).length}</span>
              </span>
            ))}
            <Link href={`/draft/${code}/team`} className="text-[#d4af37] font-semibold">Team →</Link>
          </div>
        </div>
      )}
    </main>
  );
}

function renderTeamSection(
  players: PlayerInPool[],
  pendingKey: string | null,
  isMyTurn: boolean,
  onTap: (key: string) => void,
  username: string
) {
  if (players.length === 0) {
    return <div className="py-6 text-center text-xs text-zinc-600">—</div>;
  }
  const xi = players.filter((p) => p.isLikelyXI);
  const bench = players.filter((p) => !p.isLikelyXI);
  return (
    <>
      {xi.map((p, i) => (
        <PlayerCard
          key={p.key}
          player={p}
          isPending={pendingKey === p.key}
          isMyTurn={isMyTurn}
          onTap={onTap}
          username={username}
          showBarrier={i === xi.length - 1 && bench.length > 0}
        />
      ))}
      {bench.map((p) => (
        <PlayerCard
          key={p.key}
          player={p}
          isPending={pendingKey === p.key}
          isMyTurn={isMyTurn}
          onTap={onTap}
          username={username}
          isBench
        />
      ))}
    </>
  );
}

function PlayerCard({
  player,
  isPending,
  isMyTurn,
  onTap,
  username,
  isBench = false,
  showBarrier = false,
}: {
  player: PlayerInPool;
  isPending: boolean;
  isMyTurn: boolean;
  onTap: (key: string) => void;
  username: string;
  isBench?: boolean;
  showBarrier?: boolean;
}) {
  const isTaken = !!player.takenBy;
  const isOwnPick = player.takenBy === username;

  const takerColor =
    player.takenBy && USER_COLORS[player.takenBy]
      ? USER_COLORS[player.takenBy]
      : "bg-gray-500";

  const bg = isTaken
    ? "bg-zinc-900"
    : isPending && isMyTurn
    ? "bg-green-900/60"
    : isPending
    ? "bg-[#2a2010]"
    : "bg-[#0d1f3c] active:bg-[#1a3558]";

  const border = isPending && isMyTurn
    ? "border-l-2 border-green-400"
    : isPending
    ? "border-l-2 border-yellow-500"
    : isOwnPick
    ? "border-l-2 border-blue-500"
    : isBench
    ? "border-l border-zinc-700/50"
    : "";

  return (
    <>
      <div
        onClick={isTaken ? undefined : () => onTap(player.key)}
        className={`px-2 py-2 flex items-center gap-1.5 transition-colors ${bg} ${border} ${
          isTaken ? "cursor-default" : "cursor-pointer"
        } ${isBench ? "opacity-70" : ""}`}
      >
        {/* Role badge */}
        <span className={`text-xs font-bold px-1 py-0.5 rounded shrink-0 ${ROLE_COLORS[player.role] ?? "bg-zinc-600 text-white"}`}>
          {player.role[0]}
        </span>
        {/* Name + team */}
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-semibold truncate leading-tight ${isTaken ? "text-zinc-500" : "text-white"}`}>
            {player.displayName}
          </p>
          {!isTaken && (
            <p className="text-zinc-500 text-xs leading-tight">{player.efppm.toFixed(0)} pts</p>
          )}
          {isTaken && (
            <p className="text-zinc-600 text-xs leading-tight flex items-center gap-1">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${takerColor}`} />
              {getUserLabel(player.takenBy!)}
            </p>
          )}
        </div>
        {/* Pick indicator */}
        {isPending && isMyTurn && (
          <span className="shrink-0 text-green-400 text-base">⊕</span>
        )}
        {isPending && !isMyTurn && (
          <span className="shrink-0 text-yellow-500 text-base">◌</span>
        )}
      </div>
      {showBarrier && (
        <div className="h-px bg-zinc-700/60 mx-2 my-0.5" />
      )}
    </>
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
    <div className="bg-[#112347] rounded-xl overflow-hidden border border-zinc-700">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium"
      >
        <span className="text-zinc-300">
          You: <strong>{myPicks.length}</strong>
          {others.map((u) => (
            <span key={u}> · {getUserLabel(u)}: <strong>{theirPicks.filter((p) => p.pickedBy === u).length}</strong></span>
          ))}
        </span>
        <span className="text-zinc-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 grid grid-cols-2 gap-2">
          <div>
            <p className="text-xs text-zinc-500 mb-1">You</p>
            <div className="space-y-0.5">
              {myPicks.map((pk) => (
                <div key={pk.playerKey} className="text-xs bg-zinc-800 rounded px-2 py-1 flex justify-between gap-1">
                  <span className="font-medium truncate">{pk.playerName}</span>
                  <span className="text-zinc-500 shrink-0">{pk.playerTeam}</span>
                </div>
              ))}
            </div>
          </div>
          {others.map((u) => (
            <div key={u}>
              <p className="text-xs text-zinc-500 mb-1">{getUserLabel(u)}</p>
              <div className="space-y-0.5">
                {theirPicks.filter((p) => p.pickedBy === u).map((pk) => (
                  <div key={pk.playerKey} className="text-xs bg-zinc-800 rounded px-2 py-1 flex justify-between gap-1">
                    <span className="font-medium truncate">{pk.playerName}</span>
                    <span className="text-zinc-500 shrink-0">{pk.playerTeam}</span>
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
