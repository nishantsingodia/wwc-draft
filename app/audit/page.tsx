import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import {
  getDb,
  draftContests,
  contestParticipants,
  teamSelections,
  type TeamSelection,
} from "@/lib/db";
import { inArray, eq, desc } from "drizzle-orm";
import { getAllMatches, formatMatchDate } from "@/lib/matches";
import { getCompletedMatchKeys } from "@/lib/points";
import { prettifyMatchLabel } from "@/lib/players";
import { calcSelectionPoints } from "@/lib/contest-scoring";
import { getSettledPointsForMatch, getMatchPointsForMatch } from "@/lib/points";
import { auditMatch, auditContest, type MatchAudit } from "@/lib/settlement-audit";
import { getUserLabel } from "@/lib/users";
import TeamLogo from "@/components/team-logo";
import { SettlementBadge, ReasonChip } from "@/components/settlement-badge";

/**
 * SETTLEMENT AUDIT — "did anything change after we settled up?"
 *
 * Exists because the points sheet is rewritten in place on every bot run, so a settled result can
 * move silently. Two LPL matches published COMPLETED with an empty flag while a captain's
 * 114-point innings read 0 (the official card spells him "PWH de Silva" and nothing joined it).
 * This page is the one place to see every completed contest's settled-vs-current total, with the
 * REASON each number moved — so squaring up with a friend is a fact, not a memory.
 */
export const dynamic = "force-dynamic";

type Loaded = {
  contests: (typeof draftContests.$inferSelect)[];
  sels: Map<number, TeamSelection[]>;
  parts: Map<number, string[]>;
};

async function loadContests(username: string): Promise<Loaded> {
  const db = getDb();
  const mine = await db
    .select({ contestId: contestParticipants.contestId })
    .from(contestParticipants)
    .where(eq(contestParticipants.user, username));
  const ids = new Set(mine.map((m) => m.contestId));
  if (ids.size === 0) return { contests: [], sels: new Map(), parts: new Map() };

  const all = await db
    .select()
    .from(draftContests)
    .orderBy(desc(draftContests.createdAt))
    .limit(200);
  const contests = all.filter((c) => ids.has(c.id) || c.createdBy === username);
  const cids = contests.map((c) => c.id);

  const selRows = cids.length
    ? await db.select().from(teamSelections).where(inArray(teamSelections.contestId, cids))
    : [];
  const partRows = cids.length
    ? await db.select().from(contestParticipants).where(inArray(contestParticipants.contestId, cids))
    : [];

  const sels = new Map<number, TeamSelection[]>();
  for (const r of selRows) sels.set(r.contestId, [...(sels.get(r.contestId) ?? []), r]);
  const parts = new Map<number, string[]>();
  for (const r of partRows) parts.set(r.contestId, [...(parts.get(r.contestId) ?? []), r.user]);
  return { contests, sels, parts };
}

function Delta({ v }: { v: number }) {
  if (v === 0) return <span className="text-mist2">—</span>;
  const down = v < 0;
  return (
    <span className={down ? "text-destructive font-bold" : "text-grn font-bold"}>
      {down ? "−" : "+"}
      {Math.abs(Math.round(v * 10) / 10)}
    </span>
  );
}

export default async function AuditPage() {
  const username = await getSession();
  if (!username) redirect("/");

  const allMatches = getAllMatches();
  const completedKeys = await getCompletedMatchKeys(allMatches);
  const { contests, sels, parts } = await loadContests(username);

  // Only completed matches the viewer actually has a contest in — an audit of matches you never
  // played is noise.
  const myKeys = new Set(contests.map((c) => c.matchKey).filter((k) => completedKeys.has(k)));
  const matches = allMatches
    .filter((m) => myKeys.has(m.key))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  type Row = {
    audit: MatchAudit;
    date: string;
    team1: string;
    team2: string;
    label: string;
    contests: {
      code: string;
      totals: { user: string; settled: number | null; now: number | null; delta: number }[];
      winnerChanged: boolean;
      settledWinners: string[];
      currentWinners: string[];
    }[];
    myDelta: number;
  };

  const rows: Row[] = await Promise.all(
    matches.map(async (m) => {
      // Sheet points, NOT the live/ESPN path: every match here is completed, and an audit must
      // compare against the settled record rather than a provisional in-play recomputation.
      const [audit, nowPts, settledPts] = await Promise.all([
        auditMatch(m),
        getMatchPointsForMatch(m),
        getSettledPointsForMatch(m),
      ]);
      const cs = contests.filter((c) => c.matchKey === m.key);
      const contestRows = cs.map((c) => {
        const selections = sels.get(c.id) ?? [];
        const users = parts.get(c.id) ?? [];
        // BOTH sides scored by the same shared scorer — only the points map differs.
        const score = (user: string, pts: Map<string, number>) => {
          const sel = selections.find((s) => s.user === user);
          return sel ? calcSelectionPoints(sel, c.picksPerUser, pts) : null;
        };
        const ca = auditContest(users, score, settledPts, nowPts);
        return { code: c.code, ...ca };
      });
      const myDelta = contestRows.reduce(
        (a, c) => a + (c.totals.find((t) => t.user === username)?.delta ?? 0),
        0
      );
      return {
        audit, date: m.date, team1: m.team1, team2: m.team2,
        label: prettifyMatchLabel(m.label), contests: contestRows, myDelta,
      };
    })
  );

  const byTour = new Map<string, Row[]>();
  for (const r of rows) {
    const t = r.audit.tour || "Other";
    byTour.set(t, [...(byTour.get(t) ?? []), r]);
  }

  // Two very different states, deliberately counted apart:
  //  · pending — L2 recon still open, so the bot is HOLDING the settled value. Nothing has moved;
  //              this is a to-do list (approve in Recon Review / fix a registry alias).
  //  · changed — L2 recon finished and the number already differs from settlement. Re-settle list.
  const changed = rows.filter((r) => r.audit.changed);
  const pendingRows = rows.filter((r) => r.audit.pending.length > 0);
  const flipped = rows.filter((r) => r.contests.some((c) => c.winnerChanged));
  const netMine = rows.reduce((a, r) => a + r.myDelta, 0);

  return (
    <main className="min-h-dvh bg-navy text-cloud pb-16">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="flex items-center gap-3 mb-1">
          <Link href="/lobby" className="text-mist2 text-sm hover:text-cloud">
            ‹ Lobby
          </Link>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Settlement Audit</h1>
        <p className="text-mist text-sm mt-1">
          What each completed contest was <strong className="text-cloud">settled</strong> on, versus
          what the sheet says <strong className="text-cloud">now</strong>.
        </p>

        {/* Summary — lead with the number that matters, then the caveat. */}
        <div className="mt-4 grid grid-cols-4 gap-2">
          <div className="card-stadium rounded-xl px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-mist2">Recon pending</p>
            <p className={`text-xl font-bold ${pendingRows.length ? "text-gold" : ""}`}>
              {pendingRows.length}
            </p>
          </div>
          <div className="card-stadium rounded-xl px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-mist2">Result changed</p>
            <p className={`text-xl font-bold ${changed.length ? "text-destructive" : ""}`}>
              {changed.length}
              <span className="text-mist2 text-sm font-normal">/{rows.length}</span>
            </p>
          </div>
          <div className="card-stadium rounded-xl px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-mist2">Results flipped</p>
            <p className={`text-xl font-bold ${flipped.length ? "text-destructive" : ""}`}>
              {flipped.length}
            </p>
          </div>
          <div className="card-stadium rounded-xl px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-mist2">Your net swing</p>
            <p className="text-xl font-bold">
              <Delta v={netMine} />
            </p>
          </div>
        </div>

        {rows.length === 0 && (
          <p className="mt-8 text-mist text-sm">
            No completed contests yet — nothing to audit.
          </p>
        )}

        {[...byTour.entries()].map(([tour, tourRows]) => (
          <section key={tour} className="mt-7">
            <h2 className="text-xs font-bold uppercase tracking-widest text-gold mb-2">
              {tour}
              <span className="ml-2 text-mist2 font-normal normal-case tracking-normal">
                {tourRows.filter((r) => r.audit.changed).length} of {tourRows.length} changed
              </span>
            </h2>

            <div className="space-y-3">
              {tourRows.map((r) => {
                return (
                  <div key={r.audit.matchKey} className="card-stadium rounded-2xl overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-3 border-b border-hair">
                      <span className="flex items-center gap-1 shrink-0">
                        <TeamLogo code={r.team1} size={20} />
                        <TeamLogo code={r.team2} size={20} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-semibold block truncate">{r.label}</span>
                        <p className="text-[11px] text-mist font-mono">{formatMatchDate(r.date)}</p>
                      </div>
                      <SettlementBadge
                        delta={r.myDelta}
                        noBaseline={r.audit.noBaseline && r.myDelta === 0}
                      />
                    </div>

                    {/* Contest totals: settled -> now, per user. */}
                    <div className="divide-y divide-hair">
                      {r.contests.map((c) => (
                        <div key={c.code} className="px-4 py-3">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-mist2 font-mono text-xs">{c.code}</span>
                            {c.winnerChanged && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-destructive/50 bg-destructive/15 text-destructive uppercase tracking-wide">
                                result flipped
                              </span>
                            )}
                            <span className="flex-1" />
                            <Link
                              href={`/draft/${c.code}/results?tab=audit`}
                              className="text-xs text-mist2 hover:text-cloud"
                            >
                              Detail →
                            </Link>
                          </div>
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-mist2 text-[10px] uppercase tracking-wide">
                                <th className="text-left font-medium pb-1">Player</th>
                                <th className="text-right font-medium pb-1">Settled</th>
                                <th className="text-right font-medium pb-1">Now</th>
                                <th className="text-right font-medium pb-1">Δ</th>
                              </tr>
                            </thead>
                            <tbody>
                              {c.totals.map((t) => {
                                const wasWinner = c.settledWinners.includes(t.user);
                                const isWinner = c.currentWinners.includes(t.user);
                                return (
                                  <tr key={t.user} className="border-t border-hair/50">
                                    <td className="py-1 pr-2">
                                      <span
                                        className={
                                          t.user === username ? "text-cloud font-semibold" : "text-mist"
                                        }
                                      >
                                        {getUserLabel(t.user)}
                                      </span>
                                      {wasWinner && !isWinner && (
                                        <span className="ml-1 text-[9px] text-destructive">
                                          lost 🏆
                                        </span>
                                      )}
                                      {!wasWinner && isWinner && (
                                        <span className="ml-1 text-[9px] text-grn">gained 🏆</span>
                                      )}
                                    </td>
                                    <td className="py-1 text-right font-mono text-mist">
                                      {t.settled === null ? "—" : Math.round(t.settled * 10) / 10}
                                    </td>
                                    <td className="py-1 text-right font-mono">
                                      {t.now === null ? "—" : Math.round(t.now * 10) / 10}
                                    </td>
                                    <td className="py-1 text-right font-mono">
                                      <Delta v={t.delta} />
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>

                    {/* Two groups, because they ask different things of you. */}
                    {(["PENDING", "CHANGED"] as const).map((grp) => {
                      const list = grp === "PENDING" ? r.audit.pending : r.audit.changedRows;
                      if (list.length === 0) return null;
                      const pend = grp === "PENDING";
                      return (
                        <div
                          key={grp}
                          className={`px-4 py-3 border-t border-hair ${pend ? "bg-gold/5" : "bg-destructive/5"}`}
                        >
                          <p className={`text-[10px] uppercase tracking-wide mb-0.5 font-bold ${pend ? "text-gold" : "text-destructive"}`}>
                            {pend
                              ? `⏳ L2 recon pending — action needed (${list.length})`
                              : `⚠ L2 recon done — changed vs L1 settlement (${list.length})`}
                          </p>
                          <p className="text-[10px] text-mist2 mb-2">
                            {pend
                              ? "Settled value still shown — moves only once you approve (or fix the identity)."
                              : "Already applied: these differ from what the contest was settled on."}
                          </p>
                          <ul className="space-y-1.5">
                            {list.slice(0, 8).map((p) => (
                              <li key={p.pid} className="text-xs flex flex-wrap items-center gap-1.5">
                                <span className="font-medium text-cloud">{p.name}</span>
                                <span className="font-mono text-mist">
                                  {p.settled === null ? "—" : p.settled} {pend ? "⇢" : "→"}{" "}
                                  {p.now === null ? "0" : p.now}
                                </span>
                                {p.delta !== 0 && (
                                  <span className={p.delta < 0 ? "text-destructive font-semibold" : "text-grn font-semibold"}>
                                    ({p.delta < 0 ? "−" : "+"}
                                    {Math.abs(p.delta)}
                                    {pend ? " if applied" : ""})
                                  </span>
                                )}
                                <ReasonChip reason={p.reason} />
                                {p.orphanCandidate && (
                                  <span className="text-[10px] text-mist2">
                                    official card says{" "}
                                    <span className="font-mono text-destructive">{p.orphanCandidate}</span>{" "}
                                    — unjoined
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                          {pend && r.audit.orphans.length > 0 && (
                            <p className="mt-2 text-[10px] text-mist2">
                              {r.audit.orphans.length} official-card row
                              {r.audit.orphans.length === 1 ? "" : "s"} carrying{" "}
                              <span className="text-destructive font-semibold">
                                {r.audit.orphans.reduce((a, o) => a + o.points, 0)} pts
                              </span>{" "}
                              that no contest can see — fix the registry alias to recover them.
                            </p>
                          )}
                        </div>
                      );
                    })}

                    {r.audit.noBaseline && (
                      <p className="px-4 py-2 border-t border-hair text-[10px] text-mist2">
                        This match completed before the settlement baseline existed, so an
                        unchanged total here is <strong>not</strong> proof nothing moved.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
