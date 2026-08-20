"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getAllMatches, formatMatchDate } from "@/lib/matches";
import { getFullSquadByTeams, prettifyMatchLabel } from "@/lib/players";
import { ALL_USERS, MAX_ROSTER, getUserLabel, getUserColor } from "@/lib/users";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const allMatches = getAllMatches().filter((m) => m.team1 !== "TBD");

function CreateDraftForm({ username }: { username: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const matchKey = searchParams.get("matchKey") ?? "";
  const match = allMatches.find((m) => m.key === matchKey);

  const [picksPerUser, setPicksPerUser] = useState(11);
  const [backupsPerUser, setBackupsPerUser] = useState(4);
  const [maxPlayers, setMaxPlayers] = useState(2);
  // MANUAL mode: exactly WHICH friends are playing, not just how many — nobody joins a
  // manual draft, so this is the only place their identity can come from. Defaults to the
  // old 2-player shape (you + the next roster member) so the common case is one tap.
  const [drafters, setDrafters] = useState<string[]>(() => [
    username,
    ...ALL_USERS.filter((u) => u !== username),
  ].slice(0, 2));
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
  // Live mode counts seats (friends join into them); manual mode counts the friends actually
  // picked. One number downstream so the pool gauge and the payload can't disagree.
  const drafterCount = mode === "manual" ? drafters.length : maxPlayers;
  const needed = drafterCount * (picksPerUser + backupsPerUser);
  const overPool = mode === "live" && needed > poolSize;
  // A manual draft needs at least two teams to be a contest. You are always in it.
  const tooFewDrafters = mode === "manual" && drafters.length < 2;

  const toggleDrafter = (u: string) => {
    if (u === username) return; // you're playing in your own draft
    setDrafters((cur) =>
      cur.includes(u) ? cur.filter((x) => x !== u) : [...cur, u].slice(0, MAX_ROSTER)
    );
  };

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchKey,
          picksPerUser,
          backupsPerUser,
          mode,
          maxPlayers: drafterCount,
          // Manual only — live drafters arrive by joining, so sending a roster there would
          // seat people who never opted in.
          drafters: mode === "manual" ? drafters : undefined,
        }),
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
          <Link href="/lobby" className="text-mist hover:text-white">←</Link>
          <h1 className="text-xl font-bold">Create Draft</h1>
        </div>

        {/* Selected match — read only */}
        <div className="bg-[#112347] border border-hair2 rounded-xl px-4 py-3">
          <p className="text-xs text-mist2 uppercase tracking-wider mb-0.5">Match</p>
          <p className="font-semibold">{prettifyMatchLabel(match.label)}</p>
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

          {/* Who's playing.
              LIVE: a count is enough — friends join with their own login code, so they
              choose themselves and the count is just how many seats to hold open.
              MANUAL: nobody joins, so a count can't say WHICH friends. It used to be a
              count only, which silently meant "the first N in roster order" — so a draft
              with you, Pushap, Sharan and Mihir was not expressible, and the two you did
              want were unreachable. Pick them by name instead. */}
          {mode === "manual" ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <label className="text-sm text-mist uppercase tracking-wider">Friends playing</label>
                <span className={`text-xs tabular-nums ${tooFewDrafters ? "text-red-400" : "text-mist2"}`}>
                  {drafters.length} of {MAX_ROSTER}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {ALL_USERS.map((u) => {
                  const on = drafters.includes(u);
                  const isMe = u === username;
                  return (
                    <button
                      key={u}
                      type="button"
                      onClick={() => toggleDrafter(u)}
                      aria-pressed={on}
                      disabled={isMe}
                      className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors border-2 ${
                        on
                          ? "bg-gold/15 border-gold"
                          : "bg-ink2 hover:bg-navy border-transparent"
                      } ${isMe ? "cursor-default" : ""}`}
                    >
                      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${getUserColor(u)}`} />
                      <span className="font-semibold text-sm truncate">{getUserLabel(u)}</span>
                      {isMe && <span className="text-[10px] text-mist2 shrink-0">you</span>}
                      <span className="flex-1" />
                      {on && <span className="text-gold text-xs shrink-0">✓</span>}
                    </button>
                  );
                })}
              </div>
              {tooFewDrafters && (
                <p className="text-xs text-red-400">Pick at least one friend to draft against.</p>
              )}
            </div>
          ) : (
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
            <div className="bg-ink2 rounded-xl px-4 py-3 text-sm text-mist space-y-1">
              <p>
                Total picks: <span className="text-white font-semibold">{picksPerUser + backupsPerUser}</span>{" "}
                per person ({picksPerUser} starters + {backupsPerUser} backups)
              </p>
              <p className="text-xs text-mist2">
                You&apos;ll enter all {drafters.length} teams ·{" "}
                {drafters.map((u) => getUserLabel(u)).join(", ")}
              </p>
            </div>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <Button
            type="submit"
            disabled={loading || overPool || tooFewDrafters}
            className="w-full h-12 bg-gold hover:brightness-110 text-ink font-bold uppercase tracking-wide glow-gold transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? "Creating…" : "Create Draft →"}
          </Button>
        </form>
      </div>
    </main>
  );
}

/**
 * Client shell. `username` is threaded in from the server page rather than fetched, because
 * the manual-mode picker has to pre-select and lock YOU — a static page had no session, which
 * is why "which friends" could only ever be a count.
 */
export default function CreateDraft({ username }: { username: string }) {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-ink text-white flex items-center justify-center">
        <p className="text-mist">Loading…</p>
      </main>
    }>
      <CreateDraftForm username={username} />
    </Suspense>
  );
}
