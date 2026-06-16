import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { draftContests, contestParticipants } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import Link from "next/link";
import { getUserLabel } from "@/lib/users";
import LogoutButton from "@/components/logout-button";

async function getActiveContests(username: string) {
  const db = getDb();
  // Get contests the user has joined or created
  const participated = await db
    .select({ contestId: contestParticipants.contestId })
    .from(contestParticipants)
    .where(eq(contestParticipants.user, username));

  const createdContests = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.createdBy, username))
    .orderBy(desc(draftContests.createdAt))
    .limit(10);

  // Merge
  const ids = new Set([
    ...participated.map((p) => p.contestId),
    ...createdContests.map((c) => c.id),
  ]);

  if (ids.size === 0) return [];

  const all = await db
    .select()
    .from(draftContests)
    .orderBy(desc(draftContests.createdAt))
    .limit(20);

  return all.filter((c) => ids.has(c.id));
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  WAITING: { label: "Waiting for players", color: "text-yellow-400" },
  DRAFTING: { label: "Draft in progress", color: "text-blue-400" },
  TEAM_SELECT: { label: "Select your team", color: "text-emerald-400" },
  LOCKED: { label: "Match started", color: "text-zinc-400" },
  COMPLETED: { label: "Completed", color: "text-zinc-500" },
};

export default async function LobbyPage() {
  const username = await getSession();
  if (!username) redirect("/");

  let contests: Awaited<ReturnType<typeof getActiveContests>> = [];
  try {
    contests = await getActiveContests(username);
  } catch {
    // DB not configured yet — show empty state
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-lg mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">🏏 WWC Draft</h1>
            <p className="text-zinc-400 text-sm">
              Welcome, {getUserLabel(username)}
            </p>
          </div>
          <LogoutButton />
        </div>

        {/* Actions */}
        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/draft/create"
            className="flex flex-col items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 rounded-xl p-6 transition-colors"
          >
            <span className="text-3xl">+</span>
            <span className="font-semibold">Create Draft</span>
          </Link>

          <JoinDraftCard />
        </div>

        {/* Active Contests */}
        <div className="space-y-3">
          <h2 className="text-sm text-zinc-400 uppercase tracking-wider">
            Your Drafts
          </h2>
          {contests.length === 0 ? (
            <p className="text-zinc-600 text-sm py-4">
              No drafts yet. Create one or join with a code.
            </p>
          ) : (
            contests.map((c) => {
              const st = STATUS_LABELS[c.status] ?? {
                label: c.status,
                color: "text-zinc-400",
              };
              return (
                <Link
                  key={c.id}
                  href={`/draft/${c.code}`}
                  className="flex items-center justify-between bg-zinc-900 rounded-xl px-4 py-3 hover:bg-zinc-800 transition-colors"
                >
                  <div>
                    <p className="font-semibold">{c.matchLabel}</p>
                    <p className={`text-sm ${st.color}`}>{st.label}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-zinc-400 font-mono text-sm">{c.code}</p>
                    <p className="text-zinc-600 text-xs">
                      {c.mode === "live" ? "Live Draft" : "Manual Entry"}
                    </p>
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </div>
    </main>
  );
}

function JoinDraftCard() {
  return (
    <form action="/api/draft/join-redirect" method="GET" className="contents">
      <div className="flex flex-col items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 rounded-xl p-6 transition-colors">
        <span className="text-3xl">→</span>
        <span className="font-semibold">Join Draft</span>
        <input
          name="code"
          placeholder="Enter code"
          className="w-full bg-zinc-700 rounded px-2 py-1 text-center font-mono text-sm placeholder-zinc-500 border-0 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          autoComplete="off"
        />
        <button
          type="submit"
          className="w-full bg-zinc-600 hover:bg-zinc-500 rounded px-3 py-1 text-sm font-medium transition-colors"
        >
          Go
        </button>
      </div>
    </form>
  );
}
