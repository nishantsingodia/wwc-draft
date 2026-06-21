"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getAllMatches, formatMatchDate } from "@/lib/matches";
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
  const [mode, setMode] = useState<"live" | "manual">("live");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // No match selected — send user back to pick one
  if (!match) {
    return (
      <main className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-zinc-400 text-center">Select a match from the lobby first.</p>
        <Link href="/lobby" className="text-emerald-400 underline">← Back to Lobby</Link>
      </main>
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchKey, picksPerUser, backupsPerUser, mode }),
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
    <main className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-lg mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center gap-3">
          <Link href={`/match/${matchKey}`} className="text-zinc-400 hover:text-white">←</Link>
          <h1 className="text-xl font-bold">Create Draft</h1>
        </div>

        {/* Selected match — read only */}
        <div className="bg-[#112347] border border-zinc-700 rounded-xl px-4 py-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-0.5">Match</p>
          <p className="font-semibold">{match.label}</p>
          <p className="text-sm text-zinc-400">{formatMatchDate(match.date)}</p>
        </div>

        <form onSubmit={handleCreate} className="space-y-6">
          {/* Mode */}
          <div className="space-y-2">
            <label className="text-sm text-zinc-400 uppercase tracking-wider">Draft Mode</label>
            <div className="grid grid-cols-2 gap-3">
              {(["live", "manual"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-xl px-4 py-3 text-left transition-colors ${
                    mode === m
                      ? "bg-emerald-700 border-2 border-emerald-400"
                      : "bg-zinc-900 hover:bg-zinc-800 border-2 border-transparent"
                  }`}
                >
                  <p className="font-semibold capitalize">
                    {m === "live" ? "🔴 Live Draft" : "📝 Manual Entry"}
                  </p>
                  <p className="text-xs text-zinc-400 mt-1">
                    {m === "live"
                      ? "Take turns picking in real-time"
                      : "Draft on WhatsApp, enter teams here"}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Team size */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm text-zinc-400 uppercase tracking-wider">Starters per team</label>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setPicksPerUser((v) => Math.max(1, v - 1))}
                  className="w-8 h-8 bg-zinc-800 rounded-lg text-lg font-bold">−</button>
                <span className="w-8 text-center text-xl font-bold">{picksPerUser}</span>
                <button type="button" onClick={() => setPicksPerUser((v) => Math.min(15, v + 1))}
                  className="w-8 h-8 bg-zinc-800 rounded-lg text-lg font-bold">+</button>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm text-zinc-400 uppercase tracking-wider">Backups per team</label>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setBackupsPerUser((v) => Math.max(0, v - 1))}
                  className="w-8 h-8 bg-zinc-800 rounded-lg text-lg font-bold">−</button>
                <span className="w-8 text-center text-xl font-bold">{backupsPerUser}</span>
                <button type="button" onClick={() => setBackupsPerUser((v) => Math.min(6, v + 1))}
                  className="w-8 h-8 bg-zinc-800 rounded-lg text-lg font-bold">+</button>
              </div>
            </div>
          </div>

          <div className="bg-zinc-900 rounded-xl px-4 py-3 text-sm text-zinc-400">
            Total picks: <span className="text-white font-semibold">{picksPerUser + backupsPerUser}</span>{" "}
            per person ({picksPerUser} starters + {backupsPerUser} backups)
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <Button
            type="submit"
            disabled={loading}
            className="w-full h-12 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
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
      <main className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <p className="text-zinc-400">Loading…</p>
      </main>
    }>
      <CreateDraftForm />
    </Suspense>
  );
}
