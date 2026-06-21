"use client";

import { useEffect, useState, use, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PlayerCard from "@/components/player-card";
import { getPlayerByKey } from "@/lib/players";
import { getUserLabel } from "@/lib/users";

type ContestInfo = {
  code: string;
  matchKey: string;
  matchLabel: string;
  matchDeadline: number;
  picksPerUser: number;
  backupsPerUser: number;
  mode: "live" | "manual";
  status: string;
};

type PickRow = {
  playerKey: string;
  playerName: string;
  playerRole: string;
  playerTeam: string;
  pickedBy: string;
  pickNumber: number;
};

type SelectionRow = {
  user: string;
  selectedPlayers: string[] | string;
  captainKey: string | null;
  viceCaptainKey: string | null;
  isLocked: boolean;
} | null;

type PageData = {
  contest: ContestInfo;
  picks: PickRow[];
  playerPool: { key: string; displayName: string; role: string; teamCode: string; efppm: number; tourPoints: number | null; isLikelyXI: boolean; takenBy: string | null }[];
  username: string;
  mySelection: SelectionRow;
  allSelections: { user: string; selectedPlayers: string[] | string; captainKey: string | null; viceCaptainKey: string | null; isLocked: boolean }[];
  participants: string[];
  lineups: { announced: boolean; toss: string | null; perTeam: Record<string, boolean> };
};

// selectedPlayers is stored as a JSON string in the DB
function parsePlayers(raw: string[] | string | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

function ManualPool({
  pool,
  selectedSet,
  opponentKey,
  opponentPicked,
  canAddMore,
  onAdd,
}: {
  pool: { key: string; displayName: string; role: string; teamCode: string; efppm: number; tourPoints: number | null; isLikelyXI: boolean }[];
  selectedSet: Set<string>;
  opponentKey: string | null;
  opponentPicked: Set<string>;
  canAddMore: boolean;
  onAdd: (key: string) => void;
}) {
  const available = pool.filter((p) => !selectedSet.has(p.key));
  if (available.length === 0) return null;
  const xi = available.filter((p) => p.isLikelyXI);
  const bench = available.filter((p) => !p.isLikelyXI);
  return (
    <div className="space-y-2 pt-2 border-t border-zinc-800">
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider px-1">Player Pool</h2>
      <div className="space-y-1.5">
        {xi.map((p) => {
          const taken = opponentPicked.has(p.key);
          return (
            <PlayerCard
              key={p.key}
              playerKey={p.key}
              displayName={p.displayName}
              role={p.role}
              teamCode={p.teamCode}
              efppm={p.efppm}
              tourPoints={p.tourPoints}
              takenBy={taken ? opponentKey : null}
              isMyTurn={!taken && canAddMore}
              onClick={!taken && canAddMore ? () => onAdd(p.key) : undefined}
            />
          );
        })}
        {bench.length > 0 && xi.length > 0 && (
          <div className="flex items-center gap-2 py-1 px-1">
            <div className="flex-1 h-px bg-zinc-800" />
            <p className="text-[10px] text-zinc-600 uppercase tracking-widest">Others</p>
            <div className="flex-1 h-px bg-zinc-800" />
          </div>
        )}
        {bench.map((p) => {
          const taken = opponentPicked.has(p.key);
          return (
            <PlayerCard
              key={p.key}
              playerKey={p.key}
              displayName={p.displayName}
              role={p.role}
              teamCode={p.teamCode}
              efppm={p.efppm}
              tourPoints={p.tourPoints}
              takenBy={taken ? opponentKey : null}
              isMyTurn={!taken && canAddMore}
              onClick={!taken && canAddMore ? () => onAdd(p.key) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

function useCountdown(deadlineTs: number) {
  const [remaining, setRemaining] = useState(() => deadlineTs - Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(deadlineTs - Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [deadlineTs]);

  if (remaining <= 0) return "Teams locked";
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  if (h > 0) return `${h}h ${m}m to lock`;
  if (m > 0) return `${m}m ${s}s to lock`;
  return `${s}s to lock`;
}

export default function TeamPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const router = useRouter();
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState("");

  const initializedRef = useRef(false);

  // My team state
  const [starters, setStarters] = useState<string[]>([]);
  const [backups, setBackups] = useState<string[]>([]);
  const [captainKey, setCaptainKey] = useState<string | null>(null);
  const [vcKey, setVcKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Inline swap UI
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const res = await fetch(`/api/draft/${code}`);
    if (res.status === 401) { router.push("/"); return; }
    if (!res.ok) {
      setError("Failed to load team data.");
      return;
    }
    const d: PageData = await res.json();
    setData(d);

    if (initializedRef.current) return;
    initializedRef.current = true;

    const players = parsePlayers(d.mySelection?.selectedPlayers);
    if (players.length > 0) {
      const ppu = d.contest.picksPerUser;
      setStarters(players.slice(0, ppu));
      setBackups(players.slice(ppu));
      setCaptainKey(d.mySelection?.captainKey ?? null);
      setVcKey(d.mySelection?.viceCaptainKey ?? null);
    } else if (d.contest.mode === "live") {
      const myPicks = (d.picks ?? [])
        .filter((p) => p.pickedBy === d.username)
        .sort((a, b) => a.pickNumber - b.pickNumber);
      const ppu = d.contest.picksPerUser;
      const allKeys = myPicks.map((p) => p.playerKey);
      setStarters(allKeys.slice(0, ppu));
      setBackups(allKeys.slice(ppu));
    }
  }, [code]);

  useEffect(() => {
    async function joinAndFetch() {
      // Ensure user is in contestParticipants regardless of how they arrived
      await fetch(`/api/draft/${code}/join`, { method: "POST" });
      fetchData();
    }
    joinAndFetch();
  }, [code, fetchData]);

  const isManual = data?.contest.mode === "manual";

  // Poll opponent's picks every 5s for manual drafts (no real-time turn order)
  useEffect(() => {
    if (!isManual) return;
    const id = setInterval(fetchData, 5000);
    return () => clearInterval(id);
  }, [isManual, fetchData]);

  const LOCK_BUFFER = 15 * 60;
  const lockTs = (data?.contest?.matchDeadline ?? 0) + LOCK_BUFFER;

  const isLocked =
    data?.mySelection?.isLocked ||
    (data?.contest?.mode === "live" &&
      data?.contest?.matchDeadline != null &&
      Math.floor(Date.now() / 1000) >= lockTs);

  const countdown = useCountdown(lockTs);

  async function handleSave() {
    setSaving(true);
    setSaveError("");
    const res = await fetch(`/api/draft/${code}/team`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedPlayers: [...starters, ...backups],
        captainKey,
        viceCaptainKey: vcKey,
      }),
    });
    setSaving(false);
    if (res.ok) {
      router.push(`/match/${data?.contest.matchKey}`);
    } else {
      const err = await res.json().catch(() => ({}));
      setSaveError(err.error ?? "Save failed. Try again.");
    }
  }

  function handleTogglePlayer(key: string) {
    setActiveKey((prev) => (prev === key ? null : key));
  }

  function moveToXI(key: string) {
    setBackups((b) => b.filter((k) => k !== key));
    setStarters((s) => [...s, key]);
    setActiveKey(null);
  }

  function moveToBench(key: string) {
    setStarters((s) => s.filter((k) => k !== key));
    if (key === captainKey) setCaptainKey(null);
    if (key === vcKey) setVcKey(null);
    setBackups((b) => [...b, key]);
    setActiveKey(null);
  }

  function addNew(key: string) {
    const ppu = data?.contest.picksPerUser ?? 11;
    const bpu = data?.contest.backupsPerUser ?? 4;
    if (starters.length < ppu) {
      setStarters((s) => [...s, key]);
    } else if (backups.length < bpu) {
      setBackups((b) => [...b, key]);
    }
    setActiveKey(null);
  }

  function setCaptain(key: string) {
    if (key === vcKey) setVcKey(null);
    setCaptainKey(key === captainKey ? null : key);
  }

  function setVC(key: string) {
    if (key === captainKey) setCaptainKey(null);
    setVcKey(key === vcKey ? null : key);
  }

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
        <p className="text-zinc-400">Loading…</p>
      </main>
    );
  }

  const ppu = data.contest.picksPerUser;
  const bpu = data.contest.backupsPerUser;
  const selectedSet = new Set([...starters, ...backups]);

  // Official-lineup status for the swap helper: show In XI / Not in XI per player
  // only once that player's team's lineup is actually announced.
  const poolByKey = new Map(data.playerPool.map((p) => [p.key, p]));
  const lineupsMeta = data.lineups;
  function xiStatusFor(keyVal: string): "in" | "out" | null {
    const meta = poolByKey.get(keyVal);
    if (!meta) return null;
    if (!lineupsMeta?.perTeam?.[meta.teamCode]) return null; // lineup not out yet
    return meta.isLikelyXI ? "in" : "out";
  }

  // Opponent's team
  const opponent = data.participants.find((u) => u !== data.username);
  const opponentSel = data.allSelections.find((s) => s.user === opponent);
  const opponentPlayers = parsePlayers(opponentSel?.selectedPlayers);
  const opponentStarters = opponentPlayers.slice(0, ppu);
  const opponentBackups = opponentPlayers.slice(ppu);

  function MyPlayerRow({ keyVal, section }: { keyVal: string; section: "starter" | "backup" }) {
    const p = getPlayerByKey(keyVal);
    if (!p) return null;
    const isActive = activeKey === keyVal;

    return (
      <div>
        <PlayerCard
          playerKey={keyVal}
          displayName={p.displayName}
          role={p.role}
          teamCode={p.teamCode}
          efppm={p.efppm}
          tourPoints={poolByKey.get(keyVal)?.tourPoints ?? null}
          takenBy={null}
          isSelected
          isCaptain={keyVal === captainKey}
          isViceCaptain={keyVal === vcKey}
          onClick={isLocked ? undefined : () => handleTogglePlayer(keyVal)}
          onCaptainClick={isLocked ? undefined : () => setCaptain(keyVal)}
          onViceCaptainClick={isLocked ? undefined : () => setVC(keyVal)}
          isMyTurn={!isLocked}
          compact={section === "backup"}
          xiStatus={xiStatusFor(keyVal)}
        />
        {isActive && !isLocked && (
          <div className="flex gap-2 px-2 pb-1.5 -mt-0.5">
            {section === "backup" && (
              <button
                onClick={() => moveToXI(keyVal)}
                className="flex-1 text-xs py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-medium transition-colors"
              >
                ↑ Move to XI
              </button>
            )}
            {section === "starter" && (
              <button
                onClick={() => moveToBench(keyVal)}
                className="flex-1 text-xs py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white font-medium transition-colors"
              >
                ↓ Move to Bench
              </button>
            )}
            <button
              onClick={() => setActiveKey(null)}
              className="px-3 text-xs py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  function OpponentPlayerRow({ keyVal, isCaptain, isVC, compact }: { keyVal: string; isCaptain: boolean; isVC: boolean; compact?: boolean }) {
    const p = getPlayerByKey(keyVal);
    if (!p) return null;
    return (
      <PlayerCard
        playerKey={keyVal}
        displayName={p.displayName}
        role={p.role}
        teamCode={p.teamCode}
        efppm={p.efppm}
        tourPoints={poolByKey.get(keyVal)?.tourPoints ?? null}
        takenBy={null}
        isSelected
        isCaptain={isCaptain}
        isViceCaptain={isVC}
        isMyTurn={false}
        compact={compact}
      />
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-white pb-28">
      <div className="max-w-lg mx-auto px-3 pt-4 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link href={`/match/${data.contest.matchKey}`} className="text-zinc-400 hover:text-white text-lg">←</Link>
          <div className="flex-1">
            <h1 className="font-bold">{data.contest.matchLabel}</h1>
            <p className="text-xs text-zinc-400">{countdown}</p>
          </div>
          <Link href={`/draft/${code}/results`} className="text-xs text-emerald-400 hover:text-emerald-300">
            Results →
          </Link>
        </div>

        {isLocked && (
          <div className="bg-zinc-800 rounded-xl px-4 py-3 text-center">
            <p className="text-zinc-400 font-medium">
              🔒 Team locked ·{" "}
              <Link href={`/draft/${code}/results`} className="text-emerald-400">View results</Link>
            </p>
          </div>
        )}

        {/* Lineup status — when official XIs are out, the rows show In XI / Not in XI */}
        {data.lineups?.announced && (
          <div className="rounded-xl px-4 py-2.5 bg-emerald-950 border border-emerald-500/60 space-y-0.5">
            <p className="text-xs text-emerald-200">
              <span className="font-extrabold uppercase tracking-wider text-emerald-300">🟢 Lineups Out</span>
              {data.lineups.toss ? <span className="text-emerald-300/70"> · 🪙 {data.lineups.toss}</span> : null}
            </p>
            {!isLocked && (
              <p className="text-[11px] text-emerald-300/70">Swap anyone marked ✗ Not in XI for a player who&apos;s ✓ In XI.</p>
            )}
          </div>
        )}

        {/* ── MY TEAM ── */}
        <div className="space-y-1">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider px-1">My Team</p>

          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold text-zinc-200">Starting XI</h2>
              <span className={`text-xs ${starters.length === ppu ? "text-emerald-400" : "text-zinc-500"}`}>
                {starters.length}/{ppu}
              </span>
            </div>
            {starters.length === 0 ? (
              <p className="text-zinc-600 text-sm py-2 px-1">
                {isManual ? "Tap players below to add them" : "Your starters from the draft"}
              </p>
            ) : (
              <div className="space-y-1">
                {starters.map((key) => <MyPlayerRow key={key} keyVal={key} section="starter" />)}
              </div>
            )}
          </div>

          {bpu > 0 && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold text-zinc-500">Bench</h2>
                <span className="text-xs text-zinc-600">{backups.length}/{bpu}</span>
              </div>
              {backups.length === 0 ? (
                <p className="text-zinc-700 text-sm py-2 px-1">No bench players</p>
              ) : (
                <div className="space-y-1">
                  {backups.map((key) => <MyPlayerRow key={key} keyVal={key} section="backup" />)}
                </div>
              )}
            </div>
          )}

          {isManual && !isLocked && (
            <ManualPool
              pool={data.playerPool}
              selectedSet={selectedSet}
              opponentKey={opponentSel?.user ?? null}
              opponentPicked={new Set(opponentPlayers)}
              canAddMore={starters.length < ppu || backups.length < bpu}
              onAdd={addNew}
            />
          )}

          {!isLocked && (starters.length > 0 || backups.length > 0) && (
            <p className="text-xs text-zinc-600 text-center pt-1">
              Tap a player to move between XI ↕ Bench ·{" "}
              <span className="text-yellow-400 font-bold">C</span> 2× ·{" "}
              <span className="text-blue-400 font-bold">VC</span> 1.5×
            </p>
          )}
        </div>

        {/* ── OPPONENT'S TEAM ── */}
        <div className="space-y-1 pt-2 border-t border-zinc-800">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider px-1">
            {opponent ? `${getUserLabel(opponent)}'s Team` : "Opponent's Team"}
          </p>

          {!opponentSel ? (
            <p className="text-zinc-600 text-sm py-3 px-1">
              {opponent ? `${getUserLabel(opponent)} hasn't set their team yet` : "Waiting for opponent…"}
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <h2 className="text-sm font-semibold text-zinc-200">Starting XI</h2>
                  <span className="text-xs text-zinc-500">{opponentStarters.length}/{ppu}</span>
                </div>
                <div className="space-y-1">
                  {opponentStarters.map((key) => (
                    <OpponentPlayerRow
                      key={key}
                      keyVal={key}
                      isCaptain={key === opponentSel.captainKey}
                      isVC={key === opponentSel.viceCaptainKey}
                    />
                  ))}
                </div>
              </div>

              {bpu > 0 && opponentBackups.length > 0 && (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between px-1">
                    <h2 className="text-sm font-semibold text-zinc-500">Bench</h2>
                    <span className="text-xs text-zinc-600">{opponentBackups.length}/{bpu}</span>
                  </div>
                  <div className="space-y-1">
                    {opponentBackups.map((key) => (
                      <OpponentPlayerRow
                        key={key}
                        keyVal={key}
                        isCaptain={false}
                        isVC={false}
                        compact
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Save button */}
      {!isLocked && (
        <div className="fixed bottom-0 inset-x-0 p-3 bg-zinc-950/95 backdrop-blur border-t border-zinc-800">
          <div className="max-w-lg mx-auto space-y-2">
            {starters.length !== ppu && starters.length > 0 && (
              <p className="text-yellow-400 text-xs text-center">
                Need exactly {ppu} starters — currently {starters.length}
              </p>
            )}
            {saveError && <p className="text-red-400 text-xs text-center">{saveError}</p>}
            <button
              onClick={handleSave}
              disabled={saving || starters.length !== ppu}
              className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 text-white font-semibold transition-colors"
            >
              {saving ? "Saving…" : "Save Team"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
