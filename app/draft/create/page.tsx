"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getUpcomingMatches, formatMatchDate } from "@/lib/matches";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const matches = getUpcomingMatches();

export default function CreateDraftPage() {
  const router = useRouter();
  const [matchKey, setMatchKey] = useState(matches[0]?.key ?? "");
  const [picksPerUser, setPicksPerUser] = useState(11);
  const [backupsPerUser, setBackupsPerUser] = useState(4);
  const [mode, setMode] = useState<"live" | "manual">("live");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
        router.push(`/draft/${code}`);
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
          <Link href="/lobby" className="text-zinc-400 hover:text-white">
            ←
          </Link>
          <h1 className="text-xl font-bold">Create Draft</h1>
        </div>

        <form onSubmit={handleCreate} className="space-y-6">
          {/* Match selection */}
          <div className="space-y-2">
            <label className="text-sm text-zinc-400 uppercase tracking-wider">
              Select Match
            </label>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {matches.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMatchKey(m.key)}
                  className={`w-full text-left rounded-xl px-4 py-3 transition-colors ${
                    matchKey === m.key
                      ? "bg-emerald-700 border-2 border-emerald-400"
                      : "bg-zinc-900 hover:bg-zinc-800 border-2 border-transparent"
                  }`}
                >
                  <p className="font-semibold">{m.label}</p>
                  <p className="text-sm text-zinc-400">
                    {formatMatchDate(m.date)}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Mode */}
          <div className="space-y-2">
            <label className="text-sm text-zinc-400 uppercase tracking-wider">
              Draft Mode
            </label>
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
              <label className="text-sm text-zinc-400 uppercase tracking-wider">
                Starters per team
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPicksPerUser((v) => Math.max(1, v - 1))}
                  className="w-8 h-8 bg-zinc-800 rounded-lg text-lg font-bold"
                >
                  −
                </button>
                <span className="w-8 text-center text-xl font-bold">
                  {picksPerUser}
                </span>
                <button
                  type="button"
                  onClick={() => setPicksPerUser((v) => Math.min(15, v + 1))}
                  className="w-8 h-8 bg-zinc-800 rounded-lg text-lg font-bold"
                >
                  +
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-zinc-400 uppercase tracking-wider">
                Backups per team
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setBackupsPerUser((v) => Math.max(0, v - 1))}
                  className="w-8 h-8 bg-zinc-800 rounded-lg text-lg font-bold"
                >
                  −
                </button>
                <span className="w-8 text-center text-xl font-bold">
                  {backupsPerUser}
                </span>
                <button
                  type="button"
                  onClick={() => setBackupsPerUser((v) => Math.min(6, v + 1))}
                  className="w-8 h-8 bg-zinc-800 rounded-lg text-lg font-bold"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          <div className="bg-zinc-900 rounded-xl px-4 py-3 text-sm text-zinc-400">
            Total picks:{" "}
            <span className="text-white font-semibold">
              {picksPerUser + backupsPerUser}
            </span>{" "}
            per person (
            {picksPerUser} starters + {backupsPerUser} backups)
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <Button
            type="submit"
            disabled={loading || !matchKey}
            className="w-full h-12 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
          >
            {loading ? "Creating…" : "Create Draft →"}
          </Button>
        </form>
      </div>
    </main>
  );
}
