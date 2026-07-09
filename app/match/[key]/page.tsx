import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { draftContests, contestParticipants, teamSelections, type TeamSelection } from "@/lib/db";
import { eq, desc, inArray } from "drizzle-orm";
import Link from "next/link";
import { getMatchByKey, formatMatchDate, LOCK_BUFFER } from "@/lib/matches";
import { isMatchCompleted, getMatchPointsForMatch } from "@/lib/points";
import { getUserLabel } from "@/lib/users";
import { getFlag as getTeamFlag } from "@/lib/players";
import { calcSelectionPoints } from "@/lib/contest-scoring";
import { getEffectiveState } from "@/lib/effective-state";
import DeleteDraftButton from "@/components/delete-draft-button";
import MatchRefresh from "@/components/match-refresh";

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

async function getSelectionsMap(contestIds: number[]) {
  if (contestIds.length === 0) return new Map<number, TeamSelection[]>();
  const db = getDb();
  const rows = await db
    .select()
    .from(teamSelections)
    .where(inArray(teamSelections.contestId, contestIds));
  const map = new Map<number, TeamSelection[]>();
  for (const r of rows) {
    const arr = map.get(r.contestId) ?? [];
    arr.push(r);
    map.set(r.contestId, arr);
  }
  return map;
}

// Labels for the "Open Drafts" (joinable, someone else's) section only — my own
// drafts are labelled by getEffectiveState so their state can never lie.
const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  WAITING: { label: "Waiting for players", color: "text-yellow-400" },
  DRAFTING: { label: "Draft in progress", color: "text-blue-400" },
  TEAM_SELECT: { label: "Select your team", color: "text-emerald-400" },
  LOCKED: { label: "Match started", color: "text-mist" },
  COMPLETED: { label: "Completed", color: "text-mist2" },
};

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

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
  // "scored" = the match has begun, so a head-to-head scoreline is meaningful.
  const scored = hasStarted;

  // Separate joinable vs the user's own drafts.
  // Manual TEAM_SELECT drafts are still joinable (second user hasn't picked yet).
  const openDrafts = drafts.filter((d) => {
    const isJoinable =
      ["WAITING", "DRAFTING"].includes(d.status) ||
      (d.mode === "manual" && d.status === "TEAM_SELECT");
    return isJoinable && !participantsMap.get(d.id)?.includes(username);
  });
  const myDrafts = drafts.filter(
    (d) => participantsMap.get(d.id)?.includes(username) || d.createdBy === username
  );

  // Points + selections only when the match has started (powers the H2H scorelines).
  let selectionsMap = new Map<number, TeamSelection[]>();
  let matchPts = new Map<string, number>();
  try {
    selectionsMap = await getSelectionsMap(myDrafts.map((d) => d.id));
    if (scored) matchPts = await getMatchPointsForMatch(match);
  } catch {
    // sheet/DB unavailable — cards degrade to "awaiting points"
  }

  // Build a view-model per draft: effective state (label/cta/href) + a per-draft
  // head-to-head when scored + whether it needs the user's action pre-start.
  const cards = myDrafts.map((d) => {
    const sels = selectionsMap.get(d.id) ?? [];
    const parts = participantsMap.get(d.id) ?? [];
    const eff = getEffectiveState({
      code: d.code,
      status: d.status,
      mode: d.mode,
      started: hasStarted,
      isCompleted,
    });
    const oppNames = parts.filter((u) => u !== username).map((u) => getUserLabel(u));

    let myPts: number | null = null;
    let oppMax: number | null = null;
    let rank = 1;
    let leading = false;
    let behind = false;
    let tied = false;

    if (scored) {
      const perUser = parts.map((u) => {
        const sel = sels.find((s) => s.user === u);
        return sel ? calcSelectionPoints(sel, d.picksPerUser, matchPts) : null;
      });
      const meIdx = parts.indexOf(username);
      myPts = meIdx >= 0 ? perUser[meIdx] : null;
      const others = perUser
        .filter((_, i) => parts[i] !== username)
        .filter((p): p is number => p !== null);
      oppMax = others.length ? Math.max(...others) : null;
      const allValid = perUser.filter((p): p is number => p !== null);
      if (myPts !== null) rank = 1 + allValid.filter((p) => p > (myPts as number)).length;
      if (myPts !== null && parts.length > 1) {
        if (oppMax === null || myPts > oppMax) leading = true;
        else if (myPts === oppMax) tied = true;
        else behind = true;
      }
    }

    // Does this draft need the user's move before lock?
    const mySel = sels.find((s) => s.user === username);
    let teamSet = false;
    if (mySel) {
      try {
        teamSet = JSON.parse(mySel.selectedPlayers ?? "[]").length > 0;
      } catch {
        teamSet = false;
      }
    }
    let isMyTurn = false;
    if (!scored && d.status === "DRAFTING") {
      const order: string[] = d.draftOrder ? JSON.parse(d.draftOrder) : [];
      isMyTurn = order.length ? order[d.pickCount % order.length] === username : false;
    }
    const needsAction =
      !scored &&
      (isMyTurn || (d.status === "TEAM_SELECT" && !(d.mode === "manual" && teamSet)));

    const isDeletable =
      d.createdBy === username &&
      !hasStarted &&
      !["COMPLETED", "LOCKED"].includes(d.status);

    return {
      d,
      eff,
      parts,
      oppNames,
      myPts,
      oppMax,
      rank,
      leading,
      behind,
      tied,
      isMyTurn,
      needsAction,
      isDeletable,
    };
  });

  // Surface the drafts that need action first (only reorders pre-start).
  cards.sort((a, b) => Number(b.needsAction) - Number(a.needsAction));

  // Tally for the section header.
  let tally = "";
  if (scored && cards.length > 0) {
    const won = cards.filter((c) => c.leading).length;
    tally = isCompleted ? `won ${won} of ${cards.length}` : `leading ${won} of ${cards.length}`;
  } else {
    const n = cards.filter((c) => c.needsAction).length;
    if (n > 0) tally = `${n} need${n === 1 ? "s" : ""} you`;
  }

  return (
    <main className="min-h-screen bg-ink text-white pb-8">
      <div className="max-w-lg mx-auto px-4 pt-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/lobby" className="text-mist hover:text-white text-xl">←</Link>
          <div className="flex-1">
            <h1 className="font-bold text-lg">{match.label}</h1>
            <p className="text-xs text-mist">{formatMatchDate(match.date)}</p>
          </div>
        </div>

        {/* Match status banner */}
        <div className={`rounded-xl px-4 py-3 flex items-center gap-3 ${
          isLive
            ? "bg-red-900/25 border border-red-700/40"
            : isCompleted
            ? "bg-ink2 border border-hair2"
            : "bg-[#112347] border border-hair2"
        }`}>
          <div className="text-3xl">{getTeamFlag(match.team1)}{getTeamFlag(match.team2)}</div>
          <div>
            <p className="font-bold">{match.team1} vs {match.team2}</p>
            <p className={`text-sm flex items-center gap-1.5 ${isLive ? "text-red-400" : isCompleted ? "text-emerald-400" : "text-emerald-400"}`}>
              {isLive ? (
                <><span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />Match in progress</>
              ) : isCompleted ? (
                "✅ Match complete · final"
              ) : (
                `⏳ Starts ${formatMatchDate(match.date)}`
              )}
            </p>
          </div>
        </div>

        {/* Match-level live-points refresh (scores every contest on this match) + quota gauge.
            Shown while the match is in progress. */}
        {isLive && <MatchRefresh matchStarted />}

        {/* Open drafts to join */}
        {openDrafts.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm text-mist uppercase tracking-wider">Open Drafts</h2>
            {openDrafts.map((d) => {
              const st = STATUS_LABELS[d.status] ?? { label: d.status, color: "text-mist" };
              const members = participantsMap.get(d.id) ?? [];
              return (
                <Link
                  key={d.id}
                  href={`/draft/${d.code}`}
                  className="flex items-center justify-between bg-ink2 rounded-xl px-4 py-3 hover:bg-navy transition-colors"
                >
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className={`text-sm font-semibold ${st.color}`}>{st.label}</p>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${d.mode === "live" ? "bg-red-900/50 text-red-400" : "bg-navy2 text-cloud"}`}>
                        {d.mode === "live" ? "Live" : "Manual"}
                      </span>
                    </div>
                    {members.length > 0 && (
                      <p className="text-xs text-mist2">
                        {members.map((u) => getUserLabel(u)).join(" vs ")}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-mist font-mono text-sm">{d.code}</p>
                    <p className="text-gold text-xs font-semibold">Join →</p>
                  </div>
                </Link>
              );
            })}
          </section>
        )}

        {/* Your drafts for this match — each independently state-driven */}
        {cards.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm text-mist uppercase tracking-wider">
              Your Drafts{tally && <span className="text-mist2 normal-case tracking-normal"> · {tally}</span>}
            </h2>
            {cards.map((c) => {
              const { d, eff } = c;
              const modeBadge = `text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${d.mode === "live" ? "bg-red-900/50 text-red-400" : "bg-navy2 text-cloud"}`;

              // Row-1 chip (verdict when scored, else the effective status label)
              let chip = eff.label;
              let chipColor = eff.labelColor;
              if (scored) {
                if (c.parts.length <= 1 || c.myPts === null) {
                  chip = isCompleted ? "Final" : "Live";
                  chipColor = isCompleted ? "text-emerald-400" : "text-red-400";
                } else if (c.leading) {
                  chip = c.parts.length > 2 ? `${ordinal(c.rank)} of ${c.parts.length}` : "▲ Leading";
                  chipColor = "text-emerald-400";
                } else if (c.tied) {
                  chip = "● Level";
                  chipColor = "text-mist";
                } else {
                  chip = c.parts.length > 2 ? `${ordinal(c.rank)} of ${c.parts.length}` : "▼ Behind";
                  chipColor = "text-red-400";
                }
              }

              // Row-3 verdict / hint
              let verdict = "";
              let verdictColor = "text-mist2";
              if (scored) {
                if (c.myPts === null) verdict = "Awaiting points";
                else if (c.oppMax === null) verdict = `You: ${c.myPts.toFixed(1)}`;
                else if (c.leading) {
                  verdict = `${isCompleted ? "Won" : "Ahead"} by ${(c.myPts - c.oppMax).toFixed(1)}`;
                  verdictColor = "text-emerald-400";
                } else if (c.tied) verdict = isCompleted ? "Tied" : "Level";
                else {
                  verdict = `${isCompleted ? "Lost" : "Down"} by ${(c.oppMax - c.myPts).toFixed(1)}`;
                  verdictColor = "text-red-400";
                }
              } else if (c.needsAction) {
                verdict = c.isMyTurn ? "Your pick" : "Your move";
                verdictColor = "text-gold";
              }

              // Row-2 sub (pre-start only)
              let sub: string;
              if (d.status === "WAITING" && c.parts.length < 2) sub = "Waiting for opponent to join";
              else if (d.status === "DRAFTING") sub = c.isMyTurn ? "You're up — make your pick" : "Draft in progress";
              else sub = c.oppNames.length ? `You vs ${c.oppNames.join(", ")}` : "Build your XI";

              const oppLabel = c.oppNames.length ? `vs ${c.oppNames.join(", ")}` : "";

              const cardCls = c.needsAction
                ? "border border-gold/50 bg-gradient-to-br from-gold/10 to-ink2"
                : scored && c.leading
                ? "border border-hair2 border-l-4 border-l-emerald-500 bg-ink2"
                : scored && c.behind
                ? "border border-hair2 border-l-4 border-l-red-500 bg-ink2"
                : "border border-hair2 bg-ink2";

              return (
                <div key={d.id} className={`rounded-xl px-4 py-3 ${cardCls}`}>
                  <div className="flex items-start gap-2">
                    <Link href={eff.href} className="flex-1 min-w-0 space-y-1.5 hover:opacity-90 transition-opacity">
                      {/* Row 1 — code + mode + verdict/status */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono text-sm text-cloud">{d.code}</span>
                          <span className={modeBadge}>{d.mode === "live" ? "Live" : "Manual"}</span>
                        </div>
                        <span className={`text-xs font-semibold shrink-0 ${chipColor}`}>{chip}</span>
                      </div>

                      {/* Row 2 — scoreline (scored) or context (pre-start) */}
                      {scored ? (
                        <div className="flex items-baseline gap-2">
                          <span className="text-2xl font-bold text-amber-300 tabular-nums">
                            {c.myPts !== null ? c.myPts.toFixed(1) : "—"}
                          </span>
                          {c.oppMax !== null && (
                            <>
                              <span className="text-mist2 font-bold">–</span>
                              <span className="text-lg font-bold text-mist tabular-nums">{c.oppMax.toFixed(1)}</span>
                            </>
                          )}
                          {oppLabel && (
                            <span className="ml-auto text-[11px] text-mist2 truncate max-w-[45%]">{oppLabel}</span>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-mist">{sub}</p>
                      )}

                      {/* Row 3 — verdict + CTA */}
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-[11px] font-semibold ${verdictColor}`}>{verdict}</span>
                        <span className={`text-xs font-semibold shrink-0 ${eff.ctaColor}`}>{eff.cta}</span>
                      </div>
                    </Link>
                    {c.isDeletable && <DeleteDraftButton code={d.code} />}
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {/* Create draft CTA */}
        {!isCompleted && (
          <Link
            href={`/draft/create?matchKey=${key}`}
            className="flex items-center justify-center gap-2 w-full h-14 rounded-xl bg-gold hover:brightness-110 text-ink font-bold text-base uppercase tracking-wide glow-gold transition"
          >
            + Create Draft for this match
          </Link>
        )}

        {isCompleted && cards.length === 0 && (
          <p className="text-center text-mist2 py-4 text-sm">
            Match completed — no draft for this match.
          </p>
        )}
      </div>
    </main>
  );
}
