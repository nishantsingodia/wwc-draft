import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { draftContests, contestParticipants } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import Link from "next/link";
import { getMatchByKey, formatMatchDate, LOCK_BUFFER } from "@/lib/matches";
import { isMatchCompleted } from "@/lib/points";
import { getUserLabel } from "@/lib/users";
import { getFlag as getTeamFlag } from "@/lib/players";
import DeleteDraftButton from "@/components/delete-draft-button";

async function getDraftsForMatch(matchKey: string) {
  const db = getDb();
  const all = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.matchKey, matchKey))
    .orderBy(desc(draftContests.createdAt))
    .limit(20);
  return all;
}

async function getParticipantsMap(contestIds: number[]) {
  if (contestIds.length === 0) return new Map<number, string[]>();
  const db = getDb();
  const rows = await db.select().from(contestParticipants);
  const map = new Map<number, string[]>();
  for (const r of rows) {
    if (!contestIds.includes(r.contestId)) continue;
    const arr = map.get(r.contestId) ?? [];
    arr.push(r.user);
    map.set(r.contestId, arr);
  }
  return map;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  WAITING: { label: "Waiting for players", color: "text-yellow-400" },
  DRAFTING: { label: "Draft in progress", color: "text-blue-400" },
  TEAM_SELECT: { label: "Select your team", color: "text-emerald-400" },
  LOCKED: { label: "Match started", color: "text-zinc-400" },
  COMPLETED: { label: "Completed", color: "text-zinc-500" },
};

export default async function MatchPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const username = await getSession();
  if (!username) redirect("/");

  const { key } = await params;
  const match = getMatchByKey(key);
  if (!match) redirect("/lobby");

  const now = Math.floor(Date.now() / 1000);
  const hasStarted = match.deadlineTs + LOCK_BUFFER <= now;

  let isCompleted = false;
  let drafts: Awaited<ReturnType<typeof getDraftsForMatch>> = [];
  let participantsMap = new Map<number, string[]>();

  try {
    [isCompleted, drafts] = await Promise.all([
      isMatchCompleted(match),
      getDraftsForMatch(key),
    ]);
    participantsMap = await getParticipantsMap(drafts.map((d) => d.id));
  } catch {
    // DB not configured
  }

  const isLive = hasStarted && !isCompleted;
  const isUpcoming = !hasStarted;

  // Separate joinable vs user's own drafts
  // Manual TEAM_SELECT drafts are still joinable (second user hasn't picked yet)
  const openDrafts = drafts.filter((d) => {
    const isJoinable =
      ["WAITING", "DRAFTING"].includes(d.status) ||
      (d.mode === "manual" && d.status === "TEAM_SELECT");
    return isJoinable && !participantsMap.get(d.id)?.includes(username);
  });
  const myDrafts = drafts.filter((d) =>
    participantsMap.get(d.id)?.includes(username) || d.createdBy === username
  );

  return (
    <main className="min-h-screen bg-zinc-950 text-white pb-8">
      <div className="max-w-lg mx-auto px-4 pt-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/lobby" className="text-zinc-400 hover:text-white text-xl">←</Link>
          <div className="flex-1">
            <h1 className="font-bold text-lg">{match.label}</h1>
            <p className="text-xs text-zinc-400">{formatMatchDate(match.date)}</p>
          </div>
        </div>

        {/* Match status banner */}
        <div className={`rounded-xl px-4 py-3 flex items-center gap-3 ${
          isLive
            ? "bg-red-900/25 border border-red-700/40"
            : isCompleted
            ? "bg-zinc-900 border border-zinc-700"
            : "bg-[#112347] border border-zinc-700"
        }`}>
          <div className="text-3xl">{getTeamFlag(match.team1)}{getTeamFlag(match.team2)}</div>
          <div>
            <p className="font-bold">{match.team1} vs {match.team2}</p>
            <p className={`text-sm ${isLive ? "text-red-400" : isCompleted ? "text-zinc-400" : "text-emerald-400"}`}>
              {isLive ? "🔴 Match in progress" : isCompleted ? "✅ Match completed · points available" : `⏳ Starts ${formatMatchDate(match.date)}`}
            </p>
          </div>
        </div>

        {/* Open drafts to join */}
        {openDrafts.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm text-zinc-400 uppercase tracking-wider">Open Drafts</h2>
            {openDrafts.map((d) => {
              const st = STATUS_LABELS[d.status] ?? { label: d.status, color: "text-zinc-400" };
              const members = participantsMap.get(d.id) ?? [];
              return (
                <Link
                  key={d.id}
                  href={`/draft/${d.code}`}
                  className="flex items-center justify-between bg-zinc-900 rounded-xl px-4 py-3 hover:bg-zinc-800 transition-colors"
                >
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className={`text-sm font-semibold ${st.color}`}>{st.label}</p>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${d.mode === "live" ? "bg-red-900/50 text-red-400" : "bg-zinc-700 text-zinc-300"}`}>
                        {d.mode === "live" ? "Live" : "Manual"}
                      </span>
                    </div>
                    {members.length > 0 && (
                      <p className="text-xs text-zinc-500">
                        {members.map((u) => getUserLabel(u)).join(" vs ")}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-zinc-400 font-mono text-sm">{d.code}</p>
                    <p className="text-emerald-400 text-xs font-semibold">Join →</p>
                  </div>
                </Link>
              );
            })}
          </section>
        )}

        {/* Your drafts for this match */}
        {myDrafts.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm text-zinc-400 uppercase tracking-wider">Your Drafts</h2>
            {myDrafts.map((d) => {
              const st = STATUS_LABELS[d.status] ?? { label: d.status, color: "text-zinc-400" };
              const href = isCompleted || d.status === "COMPLETED"
                ? `/draft/${d.code}/results`
                : d.status === "TEAM_SELECT" ? `/draft/${d.code}/team`
                : `/draft/${d.code}`;
              const isDeletable = d.createdBy === username && !["COMPLETED", "LOCKED"].includes(d.status);
              return (
                <div key={d.id} className="flex items-center gap-2 bg-zinc-900 rounded-xl px-4 py-3">
                  <Link href={href} className="flex-1 flex items-center justify-between hover:opacity-80 transition-opacity">
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className={`text-sm font-semibold ${st.color}`}>{st.label}</p>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${d.mode === "live" ? "bg-red-900/50 text-red-400" : "bg-zinc-700 text-zinc-300"}`}>
                          {d.mode === "live" ? "Live" : "Manual"}
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-zinc-400 font-mono text-sm">{d.code}</p>
                      <p className={`text-xs font-semibold ${isCompleted ? "text-emerald-400" : "text-zinc-400"}`}>
                        {isCompleted ? "Results →" : "Open →"}
                      </p>
                    </div>
                  </Link>
                  {isDeletable && <DeleteDraftButton code={d.code} />}
                </div>
              );
            })}
          </section>
        )}

        {/* Create draft CTA */}
        {!isCompleted && (
          <Link
            href={`/draft/create?matchKey=${key}`}
            className="flex items-center justify-center gap-2 w-full h-14 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-base transition-colors"
          >
            + Create Draft for this match
          </Link>
        )}

        {isCompleted && myDrafts.length === 0 && (
          <p className="text-center text-zinc-600 py-4 text-sm">
            Match completed — no draft for this match.
          </p>
        )}
      </div>
    </main>
  );
}
