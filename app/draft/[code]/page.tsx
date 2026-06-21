"use client";

import { useEffect, useState, useCallback, use, useRef } from "react";
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
  tourPoints: number | null; // accumulated real tour points (null until they've played)
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

type PendingUndo = {
  by: string;
  target: number;
  requestedAt: number;
  discarded: {
    playerKey: string;
    playerName: string;
    playerTeam: string;
    playerRole: string;
    pickedBy: string;
    pickNumber: number;
  }[];
  resumePicker: string | null;
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
    createdBy: string;
  };
  participants: string[];
  picks: Pick[];
  playerPool: PlayerInPool[];
  currentPicker: string | null;
  isMyTurn: boolean;
  totalPicks: number;
  username: string;
  takenCount: number;
  pendingUndo: PendingUndo | null;
  lineups: { announced: boolean; toss: string | null; perTeam: Record<string, boolean> };
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

const MAX_QUEUE = 5;

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
  const pickingRef = useRef(false); // ref so async closures always read latest value
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // True only when pendingKey was armed while it was NOT our turn (a pre-queued
  // pick that should auto-fire the moment our turn arrives). A tap made DURING
  // our turn is a manual two-tap selection and must be explicitly confirmed —
  // it never auto-fires. This is what stops a single tap from self-confirming.
  const [armedWhileWaiting, setArmedWhileWaiting] = useState(false);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("ALL");

  // Steal toast
  const [stealToast, setStealToast] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  // Undo handshake
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoToast, setUndoToast] = useState<string | null>(null);
  const prevPickCountRef = useRef<number | null>(null);

  // Quick Draft
  const [quickDraftOn, setQuickDraftOn] = useState(false);
  const [draftQueue, setDraftQueue] = useState<string[]>([]);
  const [savedQueue, setSavedQueue] = useState<string[]>([]);
  const [qdPulse, setQdPulse] = useState(false);
  const [showQdTooltip, setShowQdTooltip] = useState(false);

  // Pulse Quick Draft pill on first few sessions
  useEffect(() => {
    const count = parseInt(localStorage.getItem("wwc_draft_count") ?? "0");
    if (count < 4) {
      setQdPulse(true);
      const t = setTimeout(() => setQdPulse(false), 3000);
      return () => clearTimeout(t);
    }
  }, []);

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

  // Detect an applied undo (pickCount dropped). Reset local pick/queue state so
  // a stale Quick Draft queue can't instantly re-grab a just-freed player, and
  // surface what happened to both players.
  useEffect(() => {
    if (!state) return;
    const pc = state.contest.pickCount;
    const prev = prevPickCountRef.current;
    if (prev !== null && pc < prev) {
      setSavedQueue([]);
      setDraftQueue([]);
      setQuickDraftOn(false);
      setPendingKey(null);
      setArmedWhileWaiting(false);
      setUndoToast(`↩ Picks undone — ${getUserLabel(state.currentPicker ?? "")}'s turn now`);
      setTimeout(() => setUndoToast(null), 3500);
    }
    prevPickCountRef.current = pc;
  }, [state?.contest.pickCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ref-based lock so async closures always see the latest picking state
  async function handleConfirmPick(playerKey: string) {
    if (pickingRef.current) return;
    if (state?.pendingUndo) return; // picking frozen while an undo is pending
    pickingRef.current = true;
    setPicking(true);
    const res = await fetch(`/api/draft/${code}/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerKey }),
    });
    if (res.ok) {
      const data = await res.json();
      setPendingKey(null);
      setArmedWhileWaiting(false);
      setSavedQueue((prev) => prev.filter((k) => k !== playerKey));
      if (data.draftComplete) {
        const count = parseInt(localStorage.getItem("wwc_draft_count") ?? "0");
        localStorage.setItem("wwc_draft_count", String(count + 1));
        router.push(`/draft/${code}/team`);
        return;
      }
    }
    await fetchState();
    pickingRef.current = false;
    setPicking(false);
  }

  async function sendUndoAction(action: "request" | "approve" | "reject" | "cancel") {
    if (undoBusy) return;
    setUndoBusy(true);
    const res = await fetch(`/api/draft/${code}/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      setUndoToast(e.error ?? "Undo failed");
      setTimeout(() => setUndoToast(null), 3000);
    }
    await fetchState();
    setUndoBusy(false);
  }

  function handleTap(playerKey: string) {
    if (pickingRef.current) return;
    if (state?.pendingUndo) return; // picking frozen while an undo is pending
    if (quickDraftOn) return; // Quick Draft mode uses queue logic only
    if (!state?.isMyTurn) {
      // Not our turn → arm/disarm a pre-queued pick that auto-fires on our turn.
      setPendingKey((prev) => {
        const next = prev === playerKey ? null : playerKey;
        setArmedWhileWaiting(next !== null);
        return next;
      });
      return;
    }
    // Our turn → manual two-tap. First tap arms (NO auto-fire), second confirms.
    if (pendingKey !== playerKey) {
      setPendingKey(playerKey);
      setArmedWhileWaiting(false);
      return;
    }
    handleConfirmPick(playerKey);
  }

  function handleQueueTap(playerKey: string) {
    setDraftQueue((prev) => {
      if (prev.includes(playerKey)) return prev.filter((k) => k !== playerKey);
      if (prev.length >= MAX_QUEUE) return prev;
      return [...prev, playerKey];
    });
  }

  function handleSaveQueue() {
    setSavedQueue(draftQueue);
    setQuickDraftOn(false);
    setDraftQueue([]);
    setSavedToast(`⚡ ${draftQueue.length} picks queued — auto-firing each turn`);
    setTimeout(() => setSavedToast(null), 3000);
  }

  function handleQdToggle() {
    if (!quickDraftOn) {
      const tipSeen = localStorage.getItem("wwc_qdraft_tip_seen");
      if (!tipSeen) {
        setShowQdTooltip(true);
        localStorage.setItem("wwc_qdraft_tip_seen", "1");
        setTimeout(() => setShowQdTooltip(false), 4000);
      }
      // Re-edit existing queue but strip out already-taken players
      const available = savedQueue.filter((key) => {
        const p = state?.playerPool.find((pl) => pl.key === key);
        return p && !p.takenBy;
      });
      setDraftQueue(available);
    } else {
      setDraftQueue([]);
    }
    setQuickDraftOn((v) => !v);
  }

  // Keep draftQueue clean when players get taken while Quick Draft panel is open
  useEffect(() => {
    if (!quickDraftOn || !state) return;
    setDraftQueue((prev) => {
      const cleaned = prev.filter((key) => {
        const p = state.playerPool.find((pl) => pl.key === key);
        return p && !p.takenBy;
      });
      return cleaned.length === prev.length ? prev : cleaned;
    });
  }, [state?.playerPool, quickDraftOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-pick a PRE-QUEUED pick (armed while waiting) the moment our turn arrives.
  // Guarded by armedWhileWaiting so a manual single tap during our turn never
  // auto-confirms — that path requires an explicit second tap / Confirm.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!state?.isMyTurn || !pendingKey || !armedWhileWaiting || savedQueue.length > 0) return;
    if (state.pendingUndo) return; // frozen during an undo handshake
    const player = state.playerPool.find((p) => p.key === pendingKey);
    if (!player || player.takenBy) return;
    const t = setTimeout(() => handleConfirmPick(pendingKey), 600);
    return () => clearTimeout(t);
  }, [state?.isMyTurn, pendingKey, armedWhileWaiting, savedQueue.length]); // intentionally omit handleConfirmPick

  // Steal detection for pendingKey
  useEffect(() => {
    if (!pendingKey || !state) return;
    const p = state.playerPool.find((pl) => pl.key === pendingKey);
    if (p?.takenBy && p.takenBy !== state.username) {
      setStealToast(`${getUserLabel(p.takenBy)} just picked ${p.displayName}!`);
      setPendingKey(null);
      setArmedWhileWaiting(false);
      setTimeout(() => setStealToast(null), 3000);
    }
  }, [state?.playerPool]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-pick from savedQueue when turn arrives — clears any pendingKey to prevent double-pick
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!state?.isMyTurn || savedQueue.length === 0) return;
    if (state.pendingUndo) return; // frozen during an undo handshake
    const next = savedQueue.find((key) => {
      const p = state.playerPool.find((pl) => pl.key === key);
      return p && !p.takenBy;
    });
    if (!next) return;
    setPendingKey(null); // disarm pendingKey so it can't double-fire
    const t = setTimeout(() => handleConfirmPick(next), 400);
    return () => clearTimeout(t);
  }, [state?.isMyTurn, savedQueue]); // intentionally omit handleConfirmPick

  // Steal detection for savedQueue
  useEffect(() => {
    if (!state || savedQueue.length === 0) return;
    const stolen = savedQueue.filter((key) => {
      const p = state.playerPool.find((pl) => pl.key === key);
      return p?.takenBy && p.takenBy !== state.username;
    });
    if (stolen.length === 0) return;
    const names = stolen.map(
      (k) => state.playerPool.find((p) => p.key === k)?.displayName ?? k
    );
    setSavedQueue((prev) => prev.filter((k) => !stolen.includes(k)));
    setStealToast(`Stolen: ${names.join(", ")} — moving to next pick`);
    setTimeout(() => setStealToast(null), 3500);
  }, [state?.playerPool]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const { contest, participants, picks, playerPool, currentPicker, isMyTurn, username, totalPicks, pendingUndo } = state;

  if (contest.mode === "manual" || ["TEAM_SELECT", "LOCKED", "COMPLETED"].includes(contest.status)) {
    router.push(`/draft/${code}/team`); return null;
  }

  const isWaiting = contest.status === "WAITING";
  const isDrafting = contest.status === "DRAFTING";

  const awaitingToss =
    isWaiting &&
    contest.mode === "live" &&
    !contest.draftOrder &&
    participants.length >= 2;

  if (awaitingToss) {
    return (
      <CoinTossScreen
        code={code}
        matchLabel={contest.matchLabel}
        participants={participants}
        username={username}
        isCreator={username === contest.createdBy}
        onDraftStart={fetchState}
      />
    );
  }

  const teamCodes = [...new Set(playerPool.map((p) => p.teamCode))].sort();
  const [team1Code, team2Code] = teamCodes;

  const myPicks = picks.filter((p) => p.pickedBy === username);
  const theirPicks = picks.filter((p) => p.pickedBy !== username);
  const others = participants.filter((u) => u !== username);
  // Opponent's most recent pick (picks come ordered by pickNumber asc), so the
  // last opponent entry is their latest. Surfaced as a banner + pool badge so
  // it's easy to track what they just took before you pick.
  const lastOppPick = theirPicks.length > 0 ? theirPicks[theirPicks.length - 1] : null;

  const filteredPool = roleFilter === "ALL"
    ? playerPool
    : playerPool.filter((p) => p.role === roleFilter);
  const t1 = filteredPool.filter((p) => p.teamCode === team1Code);
  const t2 = filteredPool.filter((p) => p.teamCode === team2Code);

  const available = playerPool.filter((p) => !p.takenBy);
  const roleCounts: Record<string, number> = { ALL: available.length };
  for (const r of ["WK", "BAT", "AR", "BOWL"]) {
    roleCounts[r] = available.filter((p) => p.role === r).length;
  }

  // Queue position helpers
  const getDraftQueuePos = (key: string) => {
    const i = draftQueue.indexOf(key);
    return i >= 0 ? i + 1 : null;
  };
  const getSavedQueuePos = (key: string) => {
    const i = savedQueue.indexOf(key);
    return i >= 0 ? i + 1 : null;
  };

  return (
    <main className="min-h-screen bg-[#0a1628] text-white">

      {/* Steal / saved / undo toast */}
      {(stealToast || savedToast || undoToast) && (
        <div className="fixed top-0 inset-x-0 z-50 flex justify-center pt-2 px-3 pointer-events-none">
          <div className={`rounded-full px-4 py-2 text-sm font-semibold shadow-xl ${
            stealToast ? "bg-red-600 text-white" : undoToast ? "bg-amber-500 text-black" : "bg-[#d4af37] text-black"
          }`}>
            {stealToast ?? undoToast ?? savedToast}
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

          {/* ⚡ Quick Draft toggle */}
          {isDrafting && (
            <div className="relative shrink-0">
              <button
                onClick={handleQdToggle}
                className={`text-xs px-2 py-1 rounded-full border transition-all ${
                  quickDraftOn || savedQueue.length > 0
                    ? "text-[#d4af37] border-[#d4af37] bg-[#d4af37]/10"
                    : qdPulse
                    ? "text-[#d4af37] border-[#d4af37] animate-pulse"
                    : "text-zinc-400 border-zinc-600 hover:border-zinc-400"
                }`}
              >
                ⚡{savedQueue.length > 0 && !quickDraftOn ? ` ${savedQueue.length}` : " Quick"}
              </button>
              {showQdTooltip && (
                <div className="absolute top-full right-0 mt-2 w-44 bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-2 text-xs text-zinc-300 shadow-xl z-30">
                  Queue up to 5 picks — auto-fired each turn
                  <div className="absolute -top-1.5 right-4 w-3 h-3 bg-zinc-800 border-l border-t border-zinc-600 rotate-45" />
                </div>
              )}
            </div>
          )}

          <Link href={`/draft/${code}/results`} className="text-xs text-zinc-400 hover:text-white shrink-0">
            Results →
          </Link>
        </div>

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

        {isDrafting && (
          <div className="flex border-t border-zinc-700">
            {ROLES.map((r) => (
              <button
                key={r}
                onClick={() => setRoleFilter(r)}
                className={`flex-1 py-2 text-xs font-semibold transition-colors relative ${
                  roleFilter === r ? "text-[#d4af37]" : "text-zinc-400 hover:text-zinc-200"
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
        {/* Dream11-style lineup status: green when official XIs are out, with toss */}
        {(isWaiting || isDrafting) && (
          state.lineups?.announced ? (
            <div className="rounded-xl px-4 py-2.5 bg-emerald-950 border border-emerald-500/60 flex items-center gap-2">
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-300 bg-emerald-500/15 border border-emerald-500/50 rounded px-1.5 py-0.5">
                🟢 Lineups Out
              </span>
              <span className="text-xs text-emerald-200/90">
                Showing the official Playing XI
                {state.lineups.toss ? <span className="text-emerald-300/70"> · 🪙 {state.lineups.toss}</span> : null}
              </span>
            </div>
          ) : (
            <div className="rounded-xl px-4 py-2 bg-zinc-900 border border-zinc-700/60 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 bg-zinc-700/40 rounded px-1.5 py-0.5">
                Likely XI
              </span>
              <span className="text-xs text-zinc-500">Predicted from last match — lineups not announced yet</span>
            </div>
          )
        )}

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
            {/* Status banner */}
            <div
              className={`rounded-xl px-4 py-3 transition-all ${
                isMyTurn
                  ? "bg-green-950 border-2 border-green-400 shadow-[0_0_20px_rgba(74,222,128,0.35)]"
                  : "bg-[#1a2f56] border border-zinc-700"
              }`}
            >
              {savedQueue.length > 0 && !quickDraftOn ? (
                <div className="flex items-center justify-between">
                  <p className="text-[#d4af37] text-sm font-semibold">
                    ⚡ Auto-pick armed · {savedQueue.length} queued
                  </p>
                  <button
                    onClick={() => setSavedQueue([])}
                    className="text-zinc-500 hover:text-zinc-300 text-xs"
                  >
                    Clear
                  </button>
                </div>
              ) : isMyTurn ? (
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

            {/* Undo handshake */}
            {pendingUndo ? (
              pendingUndo.by === username ? (
                /* Requester: waiting for the other player to approve */
                <div className="rounded-xl px-4 py-3 bg-amber-950 border border-amber-500/60 flex items-center justify-between gap-3">
                  <p className="text-amber-200 text-sm">
                    ⏳ Waiting for <span className="font-semibold">{getUserLabel(others[0] ?? "")}</span> to approve your undo
                    {(() => {
                      const tgt = pendingUndo.discarded.find((d) => d.pickNumber === pendingUndo.target);
                      return tgt ? <> of <span className="font-semibold">{tgt.playerName}</span></> : null;
                    })()}…
                  </p>
                  <button
                    onClick={() => sendUndoAction("cancel")}
                    disabled={undoBusy}
                    className="shrink-0 text-xs text-zinc-400 hover:text-white underline disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                /* Approver: confirm or decline the rollback */
                <div className="rounded-xl px-4 py-3 bg-amber-950 border-2 border-amber-400 space-y-2.5 shadow-[0_0_20px_rgba(251,191,36,0.25)]">
                  <p className="text-amber-100 text-sm">
                    <span className="font-bold">{getUserLabel(pendingUndo.by)}</span> wants to undo — this returns{" "}
                    <span className="font-bold">{pendingUndo.discarded.length}</span> pick
                    {pendingUndo.discarded.length === 1 ? "" : "s"} to the pool:
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {pendingUndo.discarded.map((d) => (
                      <span
                        key={d.playerKey}
                        className={`text-xs rounded px-1.5 py-0.5 ${
                          d.pickedBy === username
                            ? "bg-red-500/20 text-red-200 border border-red-500/50"
                            : "bg-zinc-700 text-zinc-200"
                        }`}
                      >
                        {getFlag(d.playerTeam)} {d.playerName}
                        {d.pickedBy === username ? " · yours" : ""}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-amber-300/80">
                    Then it&apos;s <span className="font-semibold">{getUserLabel(pendingUndo.resumePicker ?? "")}</span>&apos;s turn.
                  </p>
                  <div className="grid grid-cols-2 gap-2 pt-0.5">
                    <button
                      onClick={() => sendUndoAction("approve")}
                      disabled={undoBusy}
                      className="h-10 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm disabled:opacity-40 transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => sendUndoAction("reject")}
                      disabled={undoBusy}
                      className="h-10 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 font-semibold text-sm disabled:opacity-40 transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )
            ) : (
              myPicks.length > 0 && (
                <div className="flex justify-end">
                  <button
                    onClick={() => sendUndoAction("request")}
                    disabled={undoBusy}
                    className="text-xs text-zinc-400 hover:text-amber-300 border border-zinc-600 hover:border-amber-400 rounded-full px-3 py-1 transition-colors disabled:opacity-40"
                  >
                    ↩ Undo my last pick
                    {myPicks.length > 0 ? `: ${myPicks[myPicks.length - 1].playerName}` : ""}
                  </button>
                </div>
              )
            )}

            {/* Opponent's last pick — quick tracking of what they just took */}
            {lastOppPick && (
              <div className="flex items-center gap-2 bg-[#1a2f56]/60 border border-zinc-700 rounded-lg px-3 py-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#d4af37] bg-[#d4af37]/10 border border-[#d4af37]/40 rounded px-1.5 py-0.5 shrink-0">
                  Last pick
                </span>
                <span className="text-base shrink-0">{getFlag(lastOppPick.playerTeam)}</span>
                <span className="text-sm text-zinc-200 font-medium truncate">
                  {lastOppPick.playerName}
                </span>
                <span className="text-xs text-zinc-500 shrink-0">{lastOppPick.playerRole}</span>
                <span className="text-xs text-zinc-500 ml-auto shrink-0 truncate">
                  by {getUserLabel(lastOppPick.pickedBy)}
                </span>
              </div>
            )}

            {roleFilter !== "ALL" && (
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider px-1">
                {ROLE_FULL[roleFilter]} — {roleCounts[roleFilter] ?? 0} available
              </p>
            )}

            {/* Two-column player grid */}
            <div className="grid grid-cols-2 gap-px bg-zinc-800 rounded-xl overflow-hidden">
              <div className="bg-[#0a1628] space-y-px">
                {renderTeamSection(
                  t1, pendingKey, isMyTurn, handleTap, username,
                  quickDraftOn, getDraftQueuePos, getSavedQueuePos, handleQueueTap,
                  lastOppPick?.playerKey ?? null
                )}
              </div>
              <div className="bg-[#0a1628] space-y-px">
                {renderTeamSection(
                  t2, pendingKey, isMyTurn, handleTap, username,
                  quickDraftOn, getDraftQueuePos, getSavedQueuePos, handleQueueTap,
                  lastOppPick?.playerKey ?? null
                )}
              </div>
            </div>

            {picks.length > 0 && (
              <PicksSummary myPicks={myPicks} theirPicks={theirPicks} username={username} others={others} />
            )}
          </>
        )}
      </div>

      {/* Bottom bar */}
      {isDrafting && (
        quickDraftOn ? (
          /* Quick Draft bottom bar */
          <div className="fixed bottom-0 inset-x-0 bg-[#112347] border-t border-[#d4af37]/50 px-3 py-2 z-20">
            <div className="max-w-lg mx-auto flex items-center gap-2">
              <button
                onClick={() => { setQuickDraftOn(false); setDraftQueue([]); }}
                className="text-zinc-400 hover:text-white text-sm px-2 shrink-0"
              >
                ✕
              </button>
              <div className="flex-1 min-w-0">
                {draftQueue.length === 0 ? (
                  <p className="text-zinc-500 text-xs">Tap players to queue picks (max 5)</p>
                ) : (
                  <p className="text-xs text-[#d4af37] truncate">
                    {draftQueue.map((key, i) => {
                      const p = playerPool.find((pl) => pl.key === key);
                      const surname = p?.displayName.split(" ").pop() ?? "?";
                      return `${i + 1}.${surname}`;
                    }).join("  ")}
                  </p>
                )}
              </div>
              <button
                onClick={handleSaveQueue}
                disabled={draftQueue.length === 0}
                className="shrink-0 bg-[#d4af37] text-black font-bold text-sm px-3 py-1.5 rounded-lg disabled:opacity-40 transition-opacity"
              >
                SAVE ⚡
              </button>
            </div>
          </div>
        ) : (
          /* Normal picks counter */
          <div className="fixed bottom-0 inset-x-0 bg-[#112347] border-t border-zinc-700 px-4 py-2 z-20">
            <div className="max-w-lg mx-auto flex items-center justify-between text-xs">
              <span className="text-zinc-400">
                You: <span className="text-white font-bold">{myPicks.length}</span>/{contest.picksPerUser + contest.backupsPerUser}
              </span>
              {others.map((u) => (
                <span key={u} className="text-zinc-400">
                  {getUserLabel(u)}: <span className="text-white font-bold">{theirPicks.filter((p) => p.pickedBy === u).length}</span>
                </span>
              ))}
              <Link href={`/draft/${code}/team`} className="text-[#d4af37] font-semibold">Team →</Link>
            </div>
          </div>
        )
      )}
    </main>
  );
}

function renderTeamSection(
  players: PlayerInPool[],
  pendingKey: string | null,
  isMyTurn: boolean,
  onTap: (key: string) => void,
  username: string,
  quickDraftOn: boolean,
  getDraftQueuePos: (key: string) => number | null,
  getSavedQueuePos: (key: string) => number | null,
  onQueueTap: (key: string) => void,
  lastPickedKey: string | null,
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
          quickDraftOn={quickDraftOn}
          draftQueuePos={getDraftQueuePos(p.key)}
          savedQueuePos={getSavedQueuePos(p.key)}
          onQueueTap={onQueueTap}
          isLastPick={p.key === lastPickedKey}
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
          quickDraftOn={quickDraftOn}
          draftQueuePos={getDraftQueuePos(p.key)}
          savedQueuePos={getSavedQueuePos(p.key)}
          onQueueTap={onQueueTap}
          isLastPick={p.key === lastPickedKey}
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
  quickDraftOn = false,
  draftQueuePos = null,
  savedQueuePos = null,
  onQueueTap,
  isLastPick = false,
}: {
  player: PlayerInPool;
  isPending: boolean;
  isMyTurn: boolean;
  onTap: (key: string) => void;
  username: string;
  isBench?: boolean;
  showBarrier?: boolean;
  quickDraftOn?: boolean;
  draftQueuePos?: number | null;
  savedQueuePos?: number | null;
  onQueueTap?: (key: string) => void;
  isLastPick?: boolean;
}) {
  const isTaken = !!player.takenBy;
  const isOwnPick = player.takenBy === username;

  const takerColor =
    player.takenBy && USER_COLORS[player.takenBy]
      ? USER_COLORS[player.takenBy]
      : "bg-gray-500";

  const bg = isTaken
    ? "bg-zinc-900"
    : "bg-[#0d1f3c] active:bg-[#1a3558]";

  const border = isOwnPick
    ? "border-l-2 border-blue-500"
    : isBench
    ? "border-l border-zinc-700/50"
    : "";

  function handleClick() {
    if (isTaken) return;
    if (quickDraftOn && onQueueTap) {
      onQueueTap(player.key);
    } else {
      onTap(player.key);
    }
  }

  // Right-side indicator
  const rightEl = quickDraftOn && !isTaken ? (
    draftQueuePos != null ? (
      <span className="w-5 h-5 rounded-full bg-[#d4af37] text-black text-xs font-bold flex items-center justify-center shrink-0">
        {draftQueuePos}
      </span>
    ) : (
      <span className="w-5 h-5 rounded-full border border-zinc-600 text-zinc-500 text-xs flex items-center justify-center shrink-0">
        +
      </span>
    )
  ) : !quickDraftOn && savedQueuePos != null && !isTaken ? (
    <span className="text-[#d4af37] text-xs font-bold shrink-0">⚡{savedQueuePos}</span>
  ) : null;

  return (
    <>
      <div
        onClick={handleClick}
        className={`relative overflow-hidden px-2 py-2.5 flex items-center gap-1.5 transition-colors ${bg} ${border} ${
          isTaken ? "cursor-default" : "cursor-pointer"
        } ${isBench ? "opacity-70" : ""}`}
      >
        {/* Role badge */}
        <span className={`text-xs font-bold px-1 py-0.5 rounded shrink-0 ${ROLE_COLORS[player.role] ?? "bg-zinc-600 text-white"}`}>
          {player.role[0]}
        </span>
        {/* Name + pts */}
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-semibold truncate leading-tight ${isTaken ? "text-zinc-500" : "text-white"}`}>
            {player.displayName}
          </p>
          {!isTaken && (
            player.tourPoints != null ? (
              <p className="text-amber-300 text-xs font-semibold leading-tight" title="Total points this tour">{player.tourPoints.toFixed(0)} pts</p>
            ) : (
              <p className="text-zinc-500 text-xs leading-tight" title="Projected (pre-tournament estimate)">~{player.efppm.toFixed(0)} exp</p>
            )
          )}
          {isTaken && (
            <p className="text-zinc-600 text-xs leading-tight flex items-center gap-1">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${takerColor}`} />
              {getUserLabel(player.takenBy!)}
            </p>
          )}
        </div>
        {/* "LAST" tag on the opponent's most-recent pick */}
        {isTaken && isLastPick && !isOwnPick && (
          <span className="text-[9px] font-bold uppercase tracking-wider text-[#d4af37] bg-[#d4af37]/10 border border-[#d4af37]/40 rounded px-1 py-0.5 shrink-0">
            Last
          </span>
        )}
        {rightEl}

        {/* Confirm overlay — fixed position inside card, no layout shift */}
        {!isTaken && !quickDraftOn && (
          <div
            className={`absolute inset-0 flex items-center justify-center text-xs font-bold tracking-wide transition-all duration-150 ${
              isPending
                ? isMyTurn
                  ? "opacity-100 bg-green-500/90 text-black"
                  : "opacity-100 bg-[#d4af37]/90 text-black"
                : "opacity-0 pointer-events-none"
            }`}
          >
            {isMyTurn ? "✓  CONFIRM PICK" : "⟳  QUEUED"}
          </div>
        )}
      </div>
      {showBarrier && (
        <div className="h-px bg-zinc-700/60 mx-2 my-0.5" />
      )}
    </>
  );
}

type TossPhase = "ASK" | "REAL_TOSS" | "CHOOSE" | "FLIPPING" | "RESULT";

function CoinTossScreen({
  code,
  matchLabel,
  participants,
  username,
  isCreator,
  onDraftStart,
}: {
  code: string;
  matchLabel: string;
  participants: string[];
  username: string;
  isCreator: boolean;
  onDraftStart: () => void;
}) {
  const [phase, setPhase] = useState<TossPhase>("ASK");
  const [myCall, setMyCall] = useState<"H" | "T" | null>(null);
  const [coinFace, setCoinFace] = useState<"H" | "T">("H");
  const [tossResult, setTossResult] = useState<{
    result: "H" | "T";
    callerWins: boolean;
    winner: string;
  } | null>(null);

  const others = participants.filter((u) => u !== username);

  async function assignWinner(winner: string) {
    const res = await fetch(`/api/draft/${code}/toss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ winner }),
    });
    const data = await res.json();
    setTossResult({ result: "H", callerWins: winner === username, winner: data.winner });
    setPhase("RESULT");
    setTimeout(() => onDraftStart(), 2000);
  }

  async function callToss(call: "H" | "T") {
    setMyCall(call);
    setPhase("FLIPPING");

    let flips = 0;
    const interval = setInterval(() => {
      setCoinFace((f) => (f === "H" ? "T" : "H"));
      flips++;
    }, 100);

    const res = await fetch(`/api/draft/${code}/toss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call }),
    });
    const data = await res.json();

    await new Promise((r) => setTimeout(r, 2500));
    clearInterval(interval);
    setCoinFace(data.result);
    setTossResult(data);
    setPhase("RESULT");

    setTimeout(() => onDraftStart(), 2500);
  }

  return (
    <main className="min-h-screen bg-[#0a1628] text-white flex flex-col items-center justify-center px-6 gap-8">
      <div className="text-center space-y-1">
        <p className="text-zinc-400 text-xs uppercase tracking-widest">Live Draft</p>
        <h1 className="font-bold text-lg">{matchLabel}</h1>
      </div>

      <div className="flex gap-6 justify-center">
        {participants.map((u) => (
          <div key={u} className="text-center space-y-1">
            <div className="w-12 h-12 rounded-full bg-[#112347] border-2 border-zinc-600 flex items-center justify-center text-lg font-bold">
              {getUserLabel(u)[0].toUpperCase()}
            </div>
            <p className="text-sm text-zinc-300">{getUserLabel(u)}</p>
          </div>
        ))}
      </div>

      <div
        className={`w-28 h-28 rounded-full flex items-center justify-center text-5xl border-4 transition-all duration-150 ${
          phase === "FLIPPING"
            ? "border-yellow-400 bg-yellow-900/30 scale-110"
            : phase === "RESULT" && tossResult?.callerWins
            ? "border-green-400 bg-green-900/30"
            : phase === "RESULT"
            ? "border-red-400 bg-red-900/20"
            : "border-zinc-600 bg-[#112347]"
        }`}
      >
        {phase === "FLIPPING" ? (
          <span className="font-black text-yellow-300 text-4xl">{coinFace}</span>
        ) : phase === "RESULT" ? (
          <span className="font-black text-4xl">
            {tossResult?.result === "H" ? "🪙" : "🥏"}
          </span>
        ) : (
          <span className="text-5xl">🪙</span>
        )}
      </div>

      {phase === "ASK" && (
        <div className="space-y-4 text-center w-full max-w-xs">
          {isCreator ? (
            <>
              <p className="text-zinc-300 font-semibold">Has the real toss happened yet?</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setPhase("REAL_TOSS")}
                  className="h-14 rounded-2xl bg-emerald-800/50 border-2 border-emerald-600 hover:bg-emerald-700/50 transition-all text-emerald-300 font-semibold text-sm"
                >
                  Yes, already done
                </button>
                <button
                  onClick={() => setPhase("CHOOSE")}
                  className="h-14 rounded-2xl bg-[#112347] border-2 border-zinc-600 hover:border-yellow-400 hover:bg-yellow-900/20 transition-all text-zinc-300 font-semibold text-sm"
                >
                  No, flip now
                </button>
              </div>
            </>
          ) : (
            <div className="text-center space-y-2">
              <p className="text-zinc-400 animate-pulse">
                ⏳ Waiting for <span className="text-white font-semibold">{getUserLabel(others[0] ?? "")}</span> to set the draft order…
              </p>
            </div>
          )}
        </div>
      )}

      {phase === "REAL_TOSS" && isCreator && (
        <div className="space-y-4 text-center w-full max-w-xs">
          <p className="text-zinc-300 font-semibold">Who picks first?</p>
          <div className="grid grid-cols-2 gap-3">
            {participants.map((u) => (
              <button
                key={u}
                onClick={() => assignWinner(u)}
                className="h-14 rounded-2xl bg-[#112347] border-2 border-zinc-600 hover:border-emerald-400 hover:bg-emerald-900/20 transition-all text-white font-semibold text-sm"
              >
                {getUserLabel(u)}
                {u === username && <span className="block text-xs text-zinc-400 font-normal mt-0.5">you</span>}
              </button>
            ))}
          </div>
          <button
            onClick={() => setPhase("ASK")}
            className="text-xs text-zinc-500 hover:text-zinc-300 underline"
          >
            ← back
          </button>
        </div>
      )}

      {phase === "CHOOSE" && (
        <div className="space-y-4 text-center w-full max-w-xs">
          {isCreator ? (
            <>
              <p className="text-zinc-300 font-semibold">Call the toss!</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => callToss("H")}
                  className="h-16 rounded-2xl bg-[#112347] border-2 border-zinc-600 hover:border-yellow-400 hover:bg-yellow-900/20 transition-all font-black text-2xl text-yellow-300"
                >
                  H
                  <p className="text-xs font-normal text-zinc-400 mt-0.5">Heads</p>
                </button>
                <button
                  onClick={() => callToss("T")}
                  className="h-16 rounded-2xl bg-[#112347] border-2 border-zinc-600 hover:border-yellow-400 hover:bg-yellow-900/20 transition-all font-black text-2xl text-yellow-300"
                >
                  T
                  <p className="text-xs font-normal text-zinc-400 mt-0.5">Tails</p>
                </button>
              </div>
              <button
                onClick={() => setPhase("ASK")}
                className="text-xs text-zinc-500 hover:text-zinc-300 underline"
              >
                ← back
              </button>
            </>
          ) : (
            <div className="text-center space-y-2">
              <p className="text-zinc-400 animate-pulse">
                ⏳ Waiting for <span className="text-white font-semibold">{getUserLabel(others[0] ?? "")}</span> to call the toss…
              </p>
            </div>
          )}
        </div>
      )}

      {phase === "FLIPPING" && (
        <p className="text-yellow-400 font-semibold animate-pulse text-lg">Flipping…</p>
      )}

      {phase === "RESULT" && tossResult && (
        <div className="text-center space-y-3">
          {tossResult.result && (
            <>
              <p className="text-2xl font-black text-white">
                {tossResult.result === "H" ? "HEADS!" : "TAILS!"}
              </p>
              {myCall && (
                <p className={`text-lg font-semibold ${tossResult.callerWins ? "text-green-400" : "text-red-400"}`}>
                  {tossResult.callerWins ? "You called it! 🎉" : "Unlucky! 😅"}
                </p>
              )}
            </>
          )}
          <p className="text-zinc-300">
            <span className="font-bold text-white">{getUserLabel(tossResult.winner)}</span> picks first!
          </p>
          <p className="text-zinc-500 text-sm animate-pulse">Starting draft…</p>
        </div>
      )}
    </main>
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
