"use client";

import { useEffect, useState, use, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PlayerCard from "@/components/player-card";
import { getPlayerByKey } from "@/lib/players";

type ContestInfo = {
  code: string;
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
};

type SelectionState = {
  selectedPlayers: string[];
  captainKey: string | null;
  viceCaptainKey: string | null;
  isLocked: boolean;
} | null;

type PageData = {
  contest: ContestInfo;
  picks: PickRow[]; // from draft_picks for live mode
  playerPool: { key: string; displayName: string; role: string; teamCode: string; efppm: number; takenBy: string | null }[];
  username: string;
  mySelection: SelectionState;
};

function useCountdown(deadlineTs: number) {
  const [remaining, setRemaining] = useState(() => deadlineTs - Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(deadlineTs - Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [deadlineTs]);

  if (remaining <= 0) return "Match started — teams locked";
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

  // Team state
  const [starters, setStarters] = useState<string[]>([]);
  const [backups, setBackups] = useState<string[]>([]);
  const [captainKey, setCaptainKey] = useState<string | null>(null);
  const [vcKey, setVcKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const fetchData = useCallback(async () => {
    const res = await fetch(`/api/draft/${code}`);
    if (!res.ok) {
      setError("Failed to load team data.");
      return;
    }
    const d: PageData = await res.json();
    setData(d);

    // Populate from existing selection
    if (d.mySelection?.selectedPlayers?.length) {
      const all = d.mySelection.selectedPlayers;
      const ppu = d.contest.picksPerUser;
      setStarters(all.slice(0, ppu));
      setBackups(all.slice(ppu));
      setCaptainKey(d.mySelection.captainKey ?? null);
      setVcKey(d.mySelection.viceCaptainKey ?? null);
      return;
    }

    // Auto-populate from draft picks for live mode
    if (d.contest.mode === "live") {
      const myPicks = (d.picks ?? []).filter(
        (p) => p.pickedBy === d.username
      );
      const ppu = d.contest.picksPerUser;
      const allKeys = myPicks.map((p) => p.playerKey);
      setStarters(allKeys.slice(0, ppu));
      setBackups(allKeys.slice(ppu));
    }
  }, [code]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const isLocked =
    data?.mySelection?.isLocked ||
    (data?.contest?.matchDeadline != null &&
      Math.floor(Date.now() / 1000) >= data.contest.matchDeadline);

  const countdown = useCountdown(data?.contest?.matchDeadline ?? 0);

  async function handleSave() {
    setSaving(true);
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
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      fetchData();
    }
  }

  function handleTogglePlayer(key: string, forceSection?: "starters" | "backups") {
    const ppu = data?.contest.picksPerUser ?? 11;
    const bpu = data?.contest.backupsPerUser ?? 4;

    if (starters.includes(key)) {
      if (forceSection === "starters") return;
      // Move to backups
      if (backups.length < bpu) {
        setStarters((s) => s.filter((k) => k !== key));
        setBackups((b) => [...b, key]);
      } else {
        // Remove entirely
        setStarters((s) => s.filter((k) => k !== key));
        if (key === captainKey) setCaptainKey(null);
        if (key === vcKey) setVcKey(null);
      }
    } else if (backups.includes(key)) {
      if (forceSection === "backups") return;
      // Move to starters
      if (starters.length < ppu) {
        setBackups((b) => b.filter((k) => k !== key));
        setStarters((s) => [...s, key]);
      } else {
        // Remove entirely
        setBackups((b) => b.filter((k) => k !== key));
      }
    } else {
      // Add new
      if (starters.length < ppu) {
        setStarters((s) => [...s, key]);
      } else if (backups.length < bpu) {
        setBackups((b) => [...b, key]);
      }
    }
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
  const isManual = data.contest.mode === "manual";

  // Available pool for manual mode (all pool players not yet selected)
  const selectedSet = new Set([...starters, ...backups]);
  const availablePool = isManual
    ? data.playerPool.filter((p) => !selectedSet.has(p.key))
    : [];

  return (
    <main className="min-h-screen bg-zinc-950 text-white pb-24">
      <div className="max-w-lg mx-auto px-3 pt-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link
            href={isManual ? "/lobby" : `/draft/${code}`}
            className="text-zinc-400 hover:text-white text-lg"
          >
            ←
          </Link>
          <div className="flex-1">
            <h1 className="font-bold">{data.contest.matchLabel}</h1>
            <p className="text-xs text-zinc-400">{countdown}</p>
          </div>
          <Link
            href={`/draft/${code}/results`}
            className="text-xs text-emerald-400 hover:text-emerald-300"
          >
            Results →
          </Link>
        </div>

        {/* Lock notice */}
        {isLocked && (
          <div className="bg-zinc-800 rounded-xl px-4 py-3 text-center">
            <p className="text-zinc-400 font-medium">🔒 Team locked</p>
          </div>
        )}

        {/* Starters section */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              Starting XI
            </h2>
            <span
              className={`text-xs ${
                starters.length === ppu ? "text-emerald-400" : "text-zinc-500"
              }`}
            >
              {starters.length}/{ppu}
            </span>
          </div>
          {starters.length === 0 ? (
            <p className="text-zinc-600 text-sm py-2">
              {isManual
                ? "Tap players below to add them"
                : "Your starters from the draft"}
            </p>
          ) : (
            <div className="space-y-1.5">
              {starters.map((key) => {
                const p = getPlayerByKey(key);
                if (!p) return null;
                return (
                  <PlayerCard
                    key={key}
                    playerKey={key}
                    displayName={p.displayName}
                    role={p.role}
                    teamCode={p.teamCode}
                    efppm={p.efppm}
                    takenBy={null}
                    isSelected
                    isCaptain={key === captainKey}
                    isViceCaptain={key === vcKey}
                    onClick={isLocked ? undefined : () => handleTogglePlayer(key)}
                    onCaptainClick={isLocked ? undefined : () => setCaptain(key)}
                    onViceCaptainClick={isLocked ? undefined : () => setVC(key)}
                    isMyTurn={!isLocked}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Backups section */}
        {bpu > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider">
                Backups
              </h2>
              <span className="text-xs text-zinc-600">
                {backups.length}/{bpu}
              </span>
            </div>
            {backups.length === 0 ? (
              <p className="text-zinc-700 text-sm py-2">No backups selected</p>
            ) : (
              <div className="space-y-1.5">
                {backups.map((key) => {
                  const p = getPlayerByKey(key);
                  if (!p) return null;
                  return (
                    <PlayerCard
                      key={key}
                      playerKey={key}
                      displayName={p.displayName}
                      role={p.role}
                      teamCode={p.teamCode}
                      efppm={p.efppm}
                      takenBy={null}
                      isSelected
                      onClick={isLocked ? undefined : () => handleTogglePlayer(key)}
                      isMyTurn={!isLocked}
                      compact
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Manual mode: player pool to pick from */}
        {isManual && !isLocked && (
          <div className="space-y-2 pt-2 border-t border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
              Add Players
            </h2>
            <div className="space-y-1.5">
              {availablePool.map((p) => (
                <PlayerCard
                  key={p.key}
                  playerKey={p.key}
                  displayName={p.displayName}
                  role={p.role}
                  teamCode={p.teamCode}
                  efppm={p.efppm}
                  takenBy={null}
                  isMyTurn
                  onClick={() => handleTogglePlayer(p.key)}
                />
              ))}
            </div>
          </div>
        )}

        {/* C/VC reminder */}
        {!isLocked && (starters.length > 0 || backups.length > 0) && (
          <div className="text-xs text-zinc-500 text-center">
            Tap <span className="text-yellow-400 font-bold">C</span> for Captain (2×) ·{" "}
            <span className="text-blue-400 font-bold">VC</span> for Vice-Captain (1.5×)
          </div>
        )}
      </div>

      {/* Save button (sticky bottom) */}
      {!isLocked && (
        <div className="fixed bottom-0 inset-x-0 p-4 bg-zinc-950/95 backdrop-blur border-t border-zinc-800">
          <div className="max-w-lg mx-auto">
            <button
              onClick={handleSave}
              disabled={saving || starters.length === 0}
              className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 text-white font-semibold transition-colors"
            >
              {saving ? "Saving…" : saved ? "✓ Saved!" : "Save Team"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
