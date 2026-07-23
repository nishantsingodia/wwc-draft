import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { getAllMatches, formatMatchDate, LOCK_BUFFER } from "@/lib/matches";
import { getFlag, prettifyMatchLabel } from "@/lib/players";

// Coarse tour grouping by team codes present in the match, for a small tag.
function tourTag(team1: string, team2: string, gender: "W" | "M"): string {
  const mlc = new Set(["MINY", "WAF", "TSK", "SFU", "SEO", "LAKR"]);
  if (mlc.has(team1) || mlc.has(team2)) return "MLC";
  return gender === "M" ? "Men" : "Women";
}

export default async function SchedulePage() {
  const username = await getSession();
  if (!username) redirect("/");

  const now = Math.floor(Date.now() / 1000);
  const all = getAllMatches();
  const upcoming = all.filter((m) => m.deadlineTs + LOCK_BUFFER > now);

  return (
    <main className="min-h-screen bg-ink text-white">
      <div className="max-w-lg mx-auto px-4 py-6 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/lobby" className="text-mist hover:text-white text-xl">←</Link>
          <div>
            <h1 className="text-lg font-bold flex items-center gap-2">
              <span>📅</span> Full Schedule
            </h1>
            <p className="text-xs text-mist">{upcoming.length} upcoming matches</p>
          </div>
        </div>

        {upcoming.length === 0 ? (
          <p className="text-mist2 text-sm py-8 text-center">No upcoming matches.</p>
        ) : (
          <div className="space-y-1.5">
            {upcoming.map((m) => {
              const tag = tourTag(m.team1, m.team2, m.gender);
              const tagColor =
                tag === "MLC"
                  ? "bg-amber-900/50 text-amber-300"
                  : tag === "Men"
                  ? "bg-sky-900/50 text-sky-300"
                  : "bg-pink-900/40 text-pink-300";
              return (
                <Link
                  key={m.key}
                  href={`/match/${m.key}`}
                  className="flex items-center justify-between bg-ink2 rounded-xl px-4 py-3 hover:bg-navy transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="text-xl shrink-0">{getFlag(m.team1)}{getFlag(m.team2)}</div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-sm truncate">{prettifyMatchLabel(m.label)}</p>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0 ${tagColor}`}>
                          {tag}
                        </span>
                      </div>
                      <p className="text-xs text-mist">{formatMatchDate(m.date)}</p>
                    </div>
                  </div>
                  <span className="text-mist2 text-sm shrink-0 ml-2">Draft →</span>
                </Link>
              );
            })}
          </div>
        )}

        <p className="text-[11px] text-mist2 text-center pt-2">
          Tap a match to create or join a draft.
        </p>
      </div>
    </main>
  );
}
