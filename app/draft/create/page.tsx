"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getAllMatches, formatMatchDate } from "@/lib/matches";
import { getFullSquadByTeams } from "@/lib/players";
import { MAX_ROSTER } from "@/lib/users";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const allMatches = getAllMatches().filter((m) => m.team1 !== "TBD");

function CreateDraftForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const matchKey = searchParams.get("matchKey") ?? "";
  const match = allMatches.find((m) => m.key === matchKey);

  const [picksPerUser, setPicksPerUser] = useState(11);
  const [backupsPerUser, setBackupsPerUser] = useState(4);
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [mode, setMode] = useState<"live" | "manual">("live");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // No match selected — send user back to pick one
  if (!match) {
    return (
      <main className="min-h-screen bg-ink text-white flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-mist text-center">Select a match from the lobby first.</p>
        <Link href="/lobby" className="text-gold underline">← Back to Lobby</Link>
      </main>
    );
  }

  // The draftable pool is the two squads combined. getFullSquadByTeams is the exact
  // count the server validates against, so client and server never disagree. It only
  // ever grows at runtime (self-heal + no-delete), so a setup valid now stays valid.
  const poolSize = getFullSquadByTeams(match.team1, match.team2).length;
  const needed = maxPlayers * (picksPerUser + backupsPerUser);
  const overPool = mode === "live" && needed > poolSize;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchKey, picksPerUser, backupsPerUser, mode, maxPlayers }),
      });
      if (res.ok) {
        const { code } = await res.json();
        router.push(mode === "manual" ? `/draft/${code}/team` : `/draft/${code}`);
      } else {
        const { error: e } = await res.json();
        setError(e ?? "Failed to create");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-ink text-white">
      <div className="max-w-lg mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center gap-3">
          <Link href={`/match/${matchKey}`} className="text-mist hover:text-white">←</Link>
          <h1 className="text-xl font-bold">Create Draft</h1>
        </div>

        {/* Selected match — read only */}
        <div className="bg-[#112347] border border-hair2 rounded-xl px-4 py-3">
          <p className="text-xs text-mist2 uppercase tracking-wider mb-0.5">Match</p>
          <p className="font-semibold">{match.label}</p>
          <p className="text-sm text-mist">{formatMatchDate(match.date)}</p>
        </div>

        <form onSubmit={handleCreate} className="space-y-6">
          {/* Mode */}
          <div className="space-y-2">
            <label className="text-sm text-mist uppercase tracking-wider">Draft Mode</label>
            <div className="grid grid-cols-2 gap-3">
              {(["live", "manual"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-xl px-4 py-3 text-left transition-colors ${
                    mode === m
                      ? "bg-gold/15 border-2 border-gold"
                      : "bg-ink2 hover:bg-navy border-2 border-transparent"
                  }`}
                >
                  <p className="font-semibold capitalize">
                    {m === "live" ? "🔴 Live Draft" : "📝 Manual Entry"}
                  </p>
                  <p className="text-xs text-mist mt-1">
                    {m === "live"
                      ? "Take turns picking in real-time"
                      : "Draft on WhatsApp, enter teams here"}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Friends — how many drafters (live only; manual is one entry point) */}
          {mode === "live" && (
            <div className="space-y-2">
              <label className="text-sm text-mist uppercase tracking-wider">Friends drafting</label>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setMaxPlayers((v) => Math.max(2, v - 1))}
                  className="w-8 h-8 bg-navy rounded-lg text-lg font-bold">−</button>
                <span className="w-8 text-center text-xl font-bold">{maxPlayers}</span>
                <button type="button" onClick={() => setMaxPlayers((v) => Math.min(MAX_ROSTER, v + 1))}
                  className="w-8 h-8 bg-navy rounded-lg text-lg font-bold">+</button>
                <span className="text-xs text-mist2 ml-1">2–{MAX_ROSTER} players</span>
              </div>
            </div>
          )}

          {/* Team size */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm text-mist uppercase tracking-wider">Starters per team</label>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setPicksPerUser((v) => Math.max(1, v - 1))}
                  className="w-8 h-8 bg-navy rounded-lg text-lg font-bold">−</button>
                <span className="w-8 text-center text-xl font-bold">{picksPerUser}</span>
                <button type="button" onClick={() => setPicksPerUser((v) => Math.min(15, v + 1))}
                  className="w-8 h-8 bg-navy rounded-lg text-lg font-bold">+</button>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm text-mist uppercase tracking-wider">Backups per team</label>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setBackupsPerUser((v) => Math.max(0, v - 1))}
                  className="w-8 h-8 bg-navy rounded-lg text-lg font-bold">−</button>
                <span className="w-8 text-center text-xl font-bold">{backupsPerUser}</span>
                <button type="button" onClick={() => setBackupsPerUser((v) => Math.min(6, v + 1))}
                  className="w-8 h-8 bg-navy rounded-lg text-lg font-bold">+</button>
              </div>
            </div>
          </div>

          {/* Squad-pool gauge — a live exclusive draft can't deal more unique players
              than the two squads hold. Manual mode is non-exclusive, so it's exempt. */}
          {mode === "live" ? (
            <div className="bg-ink2 rounded-xl px-4 py-3 space-y-2">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-mist">Squad pool</span>
                <span className={`font-semibold tabular-nums ${overPool ? "text-red-400" : "text-white"}`}>
                  {needed} / {poolSize} drafted
                </span>
              </div>
              <div className="h-2 rounded-full bg-navy overflow-hidden flex">
                <span
                  className={`h-full ${overPool ? "bg-gold" : "bg-gold"}`}
                  style={{ width: `${Math.min(100, (needed / poolSize) * 100)}%` }}
                />
                {overPool && (
                  <span className="h-full bg-red-500" style={{ width: `${Math.min(100, ((needed - poolSize) / poolSize) * 100)}%` }} />
                )}
              </div>
              <p className={`text-xs ${overPool ? "text-red-400" : "text-emerald-400"}`}>
                {overPool
                  ? `✕ ${maxPlayers} × ${picksPerUser + backupsPerUser} = ${needed} — ${needed - poolSize} more than the pool holds. Fewer picks or friends.`
                  : `✓ ${maxPlayers} ${maxPlayers === 1 ? "friend" : "friends"} × ${picksPerUser + backupsPerUser} picks = ${needed} · ${poolSize - needed} left in the pool`}
              </p>
            </div>
          ) : (
            <div className="bg-ink2 rounded-xl px-4 py-3 text-sm text-mist">
              Total picks: <span className="text-white font-semibold">{picksPerUser + backupsPerUser}</span>{" "}
              per person ({picksPerUser} starters + {backupsPerUser} backups)
            </div>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <Button
            type="submit"
            disabled={loading || overPool}
            className="w-full h-12 bg-gold hover:brightness-110 text-ink font-bold uppercase tracking-wide glow-gold transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? "Creating…" : "Create Draft →"}
          </Button>
        </form>
      </div>
    </main>
  );
}

export default function CreateDraftPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-ink text-white flex items-center justify-center">
        <p className="text-mist">Loading…</p>
      </main>
    }>
      <CreateDraftForm />
    </Suspense>
  );
}
