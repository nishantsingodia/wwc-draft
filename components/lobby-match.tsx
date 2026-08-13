import Link from "next/link";
import type { ReactNode } from "react";
import MatchCard from "@/components/match-card";
import AmendmentActions, { type PendingSummary } from "@/components/amendment-actions";
import TeamLogo from "@/components/team-logo";
import DeleteDraftButton from "@/components/delete-draft-button";
import { getUserLabel } from "@/lib/users";
import { prettifyMatchLabel, getTeamName } from "@/lib/players";
import type { InningsLine } from "@/lib/live-points";

/**
 * One match on the lobby, live or completed — everything that used to need a trip to
 * `/match/[key]` and then a second trip to the results page.
 *
 * SERVER component on purpose. Every number here (each drafter's total, the head-to-head
 * margin) is computed upstream by `calcSelectionPoints` — the one scorer the results page
 * settles with — and handed in ready to render. The scoreline strip is the single exception
 * and is display-only: it comes off the ESPN summary and never feeds a total. Only the
 * expand/collapse shell and the amendment buttons are client-side.
 */

export type DraftRow = {
  id: number;
  code: string;
  mode: "live" | "manual";
  deletable: boolean;
  users: { user: string; capName: string | null; vcName: string | null; pts: number | null }[];
  pending: PendingSummary[];
};

export default function LobbyMatch({
  match,
  state,
  freshness,
  innings,
  drafts,
  username,
  defaultOpen,
  statusChip,
  actions,
}: {
  match: { key: string; label: string; team1: string; team2: string; dateLabel: string };
  state: "live" | "completed";
  freshness: string | null;
  innings: InningsLine[];
  drafts: DraftRow[];
  username: string;
  defaultOpen: boolean;
  /** Recon / settlement state for this match, if there's anything to say. */
  statusChip?: ReactNode;
  /** Match-level controls for the "···" sheet. */
  actions?: ReactNode;
}) {
  const isLive = state === "live";

  // Head-to-head across every draft on this match: your best total vs the best of anyone
  // else. With one draft (the normal case) that is simply you vs your opponent.
  const totals = new Map<string, number>();
  for (const d of drafts) {
    for (const u of d.users) {
      if (u.pts === null) continue;
      totals.set(u.user, Math.max(totals.get(u.user) ?? -Infinity, u.pts));
    }
  }
  const mine = totals.get(username) ?? null;
  const others = [...totals.entries()].filter(([u]) => u !== username);
  const leader = others.sort((a, b) => b[1] - a[1])[0] ?? null;
  const margin = mine !== null && leader ? mine - leader[1] : null;
  const share =
    mine !== null && leader && mine + leader[1] > 0
      ? Math.round((mine / (mine + leader[1])) * 100)
      : 50;

  const verdict =
    margin === null
      ? null
      : margin > 0
        ? `${isLive ? "▲ Ahead" : "🏆 Won"} by ${margin.toFixed(1)}`
        : margin < 0
          ? `${isLive ? "▼ Behind" : "Lost"} by ${(-margin).toFixed(1)}`
          : isLive
            ? "● Level"
            : "● Tied";

  return (
    <MatchCard
      tone={state}
      defaultOpen={defaultOpen}
      actions={actions}
      header={
        <>
          <span className="flex items-center gap-1 shrink-0">
            <TeamLogo code={match.team1} size={22} />
            <TeamLogo code={match.team2} size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold truncate">{prettifyMatchLabel(match.label)}</p>
            <p className="text-[11px] flex items-center gap-1.5 flex-wrap">
              {isLive ? (
                <span className="text-live font-bold flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulse" />
                  In progress
                </span>
              ) : (
                <span className="text-emerald-400 font-semibold">Final</span>
              )}
              <span className="text-mist2 font-mono">{match.dateLabel}</span>
              {statusChip}
            </p>
          </div>
        </>
      }
      collapsedRight={
        verdict ? (
          <span
            className={`shrink-0 text-[11px] font-bold ${
              margin! > 0 ? "text-emerald-400" : margin! < 0 ? "text-live" : "text-mist"
            }`}
          >
            {verdict}
          </span>
        ) : null
      }
    >
      {/* ── scoreline (display only — never an input to any total) ── */}
      {innings.length > 0 && (
        <div className="flex gap-3 px-3 pb-2.5">
          {innings.map((i, idx) => (
            <div key={`${i.team}-${idx}`} className={`flex-1 min-w-0 ${idx > 0 ? "text-right" : ""}`}>
              <p className="text-[9px] uppercase tracking-wider text-mist truncate">
                {getTeamName(i.team)}
              </p>
              <p className="text-base font-extrabold tabular-nums leading-tight">
                {i.runs}/{i.wickets}
              </p>
              <p className="text-[9px] text-mist2 font-mono">{i.overs} ov</p>
            </div>
          ))}
        </div>
      )}

      {/* ── head-to-head ── */}
      {mine !== null && leader && (
        <div className="px-3 pb-2.5">
          <div className="flex justify-between items-end gap-2">
            <div>
              <p className="text-[10px] text-gold">{getUserLabel(username)} (you)</p>
              <p className="text-xl font-extrabold tabular-nums text-amber-300">{mine.toFixed(1)}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-mist">{getUserLabel(leader[0])}</p>
              <p className="text-xl font-extrabold tabular-nums text-mist">{leader[1].toFixed(1)}</p>
            </div>
          </div>
          <div className="mt-1.5 h-1.5 rounded-full bg-navy2 overflow-hidden flex">
            <span
              className="h-full bg-gradient-to-r from-gold to-amber-300"
              style={{ width: `${share}%` }}
            />
            <span className="h-full bg-[#33456b]" style={{ width: `${100 - share}%` }} />
          </div>
          <p
            className={`mt-1 text-[11px] font-semibold ${
              margin! > 0 ? "text-emerald-400" : margin! < 0 ? "text-live" : "text-mist"
            }`}
          >
            {verdict}
          </p>
        </div>
      )}

      {isLive && freshness && (
        <p className="px-3 pb-2 text-[10px] text-mist2">{freshness}</p>
      )}

      {/* ── amendments needing a decision, right where the score is ── */}
      {drafts.flatMap((d) => d.pending).length > 0 && (
        <div className="px-3 pb-2.5 space-y-2">
          {drafts.flatMap((d) => d.pending).map((p) => (
            <AmendmentActions key={p.id} p={p} />
          ))}
        </div>
      )}

      {/* ── the drafts on this match ── */}
      <div className="border-t border-hair divide-y divide-hair">
        {drafts.map((d) => (
          <div key={d.id}>
            <div className="flex items-center gap-2 px-3 pt-2 pb-1">
              <span
                className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                  d.mode === "live"
                    ? "bg-live/15 text-live border border-live/40"
                    : "bg-navy2 text-mist"
                }`}
              >
                {d.mode === "live" ? "Live" : "Manual"}
              </span>
              <span className="text-mist2 font-mono text-xs">{d.code}</span>
              <span className="flex-1" />
              {d.deletable && <DeleteDraftButton code={d.code} />}
            </div>
            <Link href={`/draft/${d.code}/results`} className="block px-3 pb-2.5 space-y-1.5">
              {d.users.map(({ user, capName, vcName, pts }) => (
                <div key={user} className="flex items-center gap-2 text-xs">
                  <span className="text-mist w-14 shrink-0 font-medium truncate">
                    {getUserLabel(user)}
                    {user === username ? " (you)" : ""}
                  </span>
                  <div className="flex-1 flex items-center gap-1.5 min-w-0 overflow-hidden">
                    {capName ? (
                      <>
                        <span className="bg-yellow-500 text-black text-[9px] font-bold px-1 rounded shrink-0">
                          C
                        </span>
                        <span className="text-cloud truncate">{capName}</span>
                        {vcName && (
                          <>
                            <span className="bg-blue-500 text-white text-[9px] font-bold px-1 rounded shrink-0">
                              VC
                            </span>
                            <span className="text-cloud truncate">{vcName}</span>
                          </>
                        )}
                      </>
                    ) : (
                      <span className="text-mist2">Team not set</span>
                    )}
                  </div>
                  <span
                    className={`font-bold shrink-0 tabular-nums ${
                      pts !== null ? "text-emerald-400" : "text-mist2"
                    }`}
                  >
                    {(pts ?? 0).toFixed(0)}pt
                  </span>
                </div>
              ))}
              <p className="text-[10px] text-mist2 font-mono pt-0.5">Full XI breakdown →</p>
            </Link>
          </div>
        ))}
      </div>
    </MatchCard>
  );
}
