"use client";

import { useEffect, useState, use, useCallback } from "react";
import Link from "next/link";
import { getUserLabel, USER_COLORS } from "@/lib/users";
import { prettifyMatchLabel } from "@/lib/players";
import { LOCK_BUFFER } from "@/lib/lock-buffer";
import type { Change } from "@/lib/effective-lineup";
import type { LiveStatus, Innings } from "@/lib/espn";
import ChangesBanner from "@/components/changes-banner";
import LineupRefresh from "@/components/lineup-refresh";
import TeamLogo from "@/components/team-logo";
import { auctionOwnersFor, tourForTeamCode, type AuctionOwner } from "@/lib/auction-ownership";
import { ReasonChip } from "@/components/settlement-badge";
import type { AuditReason } from "@/lib/audit-reasons";

type AuditRow = {
  pid: string; name: string; team: string;
  settled: number | null; now: number | null; delta: number;
  reason: AuditReason; orphanCandidate: string | null;
  provenance: "live" | "seed" | "unknown" | null; l2: string;
  group: "PENDING" | "CHANGED" | "NO_BASELINE" | "CLEAN"; marker: string;
};

type PlayerResult = {
  key: string;
  name: string;
  role: string;
  team: string;
  isCaptain: boolean;
  isViceCaptain: boolean;
  isBackup: boolean;
  fantasyPoints: number | null;
  rawPoints: number | null;
  photo?: string | null; // ESPN headshot (live only); null/absent → fall back to the flag
  live?: LiveStatus | null; // per-player live batting/bowling status (live matches only)
  efppm: number;
  recon?: string | null; // per-player: "⏳ unreconciled" / "⚠ official revision", null when settled
};

type TeamResult = {
  user: string;
  players: PlayerResult[];
  captainKey: string | null;
  viceCaptainKey: string | null;
  isLocked: boolean;
  totalPoints: number | null;
  changes?: Change[]; // BACKUP_INTELLIGENCE: what auto-substitution did (empty if nothing moved)
};

type ResultsData = {
  contest: {
    code: string;
    matchKey: string;
    matchLabel: string;
    matchDeadline: number;
    status: string;
  };
  teams: TeamResult[];
  username: string;
  announced: boolean; // both teams' official XIs are out
  // Recon status from the bot's "Match Status" column (null on legacy sheets).
  matchStatus: { status: "LIVE" | "COMPLETED" | "COMPLETED_FLAGGED"; flag: string;
      recon?: "L1_OPEN" | "L1_DONE" | "L2_PENDING" | "L2_DONE" | null;
      delta?: number } | null;
  started: boolean; // match has begun (server-computed; gates the live-refresh button)
  completed: boolean; // the COMPLETED pipeline has finalized this match (sheet drives it)
  pointsSource: "live-espn" | "sheet";
  liveProvisional: boolean; // H2H is computed live from ESPN (provisional, in-app, no bot)
  liveFreshness: string | null; // "Points updated till 14.3 overs (138/4)" — live only
  scorecard?: Innings[] | null; // full innings breakdown for the live Scorecard tab (live only)
  // Settlement audit (completed only): settled baseline vs what the sheet says now, and WHY it
  // moved. Null while live — nothing is settled yet, so there is nothing to audit.
  audit?: {
    changed: boolean;
    noBaseline: boolean;
    pending: AuditRow[];
    changedRows: AuditRow[];
    pendingAbsDelta: number;
    players: {
      pid: string; name: string; team: string;
      settled: number | null; now: number | null; delta: number;
      reason: AuditReason; orphanCandidate: string | null;
      provenance: "live" | "seed" | "unknown" | null; l2: string;
    }[];
    orphans: { name: string; points: number }[];
    totals: { user: string; settled: number | null; now: number | null; delta: number }[];
    winnerChanged: boolean;
    settledWinners: string[];
    currentWinners: string[];
  } | null;
};

const ROLE_COLORS: Record<string, string> = {
  WK: "text-yellow-400",
  BAT: "text-blue-400",
  AR: "text-purple-400",
  BOWL: "text-red-400",
};

// Only XI counts toward total (backups excluded)
function calcXITotal(team: TeamResult): number {
  return team.players
    .filter((p) => !p.isBackup)
    .reduce((sum, p) => sum + (p.fantasyPoints ?? 0), 0);
}

// Is this player one of YOUR "still to come" cheer targets? — role-relevant "yet" state.
// (BOWL → yet to bowl; BAT/WK → yet to bat; AR → either.)
function stillToCome(p: PlayerResult): boolean {
  if (!p.live) return false;
  if (p.role === "BOWL") return p.live.bowling === "YET";
  if (p.role === "AR") return p.live.batting === "YET" || p.live.bowling === "YET";
  return p.live.batting === "YET";
}

// Deliberately quiet. Each column carries ~11 rows and most rows carry two chips, so any
// saturated tone here multiplies into noise that drowns out the actual points. Only the
// LIVE-now state keeps a colour — it's the one thing worth looking at mid-match; every
// other state (out / done / yet / DNB) is greyscale and reads as reference text.
const CHIP_TONES: Record<string, string> = {
  emerald: "bg-white/[0.03] text-mist2 border-hair2/40", // yet to bat
  gold: "bg-white/[0.03] text-mist2 border-hair2/40", // yet to bowl
  green: "bg-emerald-500/10 text-emerald-300/85 border-emerald-500/25", // live now — the one signal
  muted: "bg-white/[0.03] text-mist border-hair2/40", // done / not out
  mutedRed: "bg-white/[0.03] text-mist border-hair2/40", // out — being dismissed isn't an alert
  faint: "bg-transparent text-mist2 border-transparent", // DNB
};

// The captain and vice-captain are the two rows that decide the contest, and a 10px badge
// among the other row chrome was too easy to miss. So the WHOLE row is tinted: gold for C,
// blue for VC — the same two colours their badges already use, so this amplifies the
// existing language rather than teaching a new one. Deliberately NOT green/orange: green
// already means "your pick" on the draft board and "batting now" in the status chips, and
// orange is the fantasy-points number on every single row.
//
// Two hues (not two intensities of one) because C vs VC has to be distinguishable at a
// glance, and low-alpha washes of the same hue on a dark background are not.
//
// The left rail + tint are an inset shadow, never a border, so there's no layout shift and
// the fixed row height that keeps the two columns aligned is untouched.
const ROW_TONE_C = "bg-gold/[0.14] shadow-[inset_3px_0_0_rgba(212,175,55,0.9)]";
const ROW_TONE_VC = "bg-blue-500/[0.13] shadow-[inset_3px_0_0_rgba(59,130,246,0.9)]";
// Still-to-come is a NEUTRAL wash, not gold: it used to be gold, which now belongs to the
// captain. It's also the weakest cue here on purpose — it's already stated by the row's own
// "yet to bat" chip and counted in the "Still to come" strip above both columns.
const ROW_TONE_STC = "bg-white/[0.03]";

// C beats VC beats still-to-come — a captain who's yet to bat reads as the captain.
function armbandRowTone(p: PlayerResult, stillToComeRow: boolean): string {
  if (p.isCaptain) return ROW_TONE_C;
  if (p.isViceCaptain) return ROW_TONE_VC;
  return stillToComeRow ? ROW_TONE_STC : "";
}

function Chip({ tone, children }: { tone: keyof typeof CHIP_TONES; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded border tabular-nums whitespace-nowrap ${
        CHIP_TONES[tone] ?? CHIP_TONES.muted
      }`}
    >
      {children}
    </span>
  );
}

// Small role-relevant live-status pill. Prefers the "cheer" states (yet to bat / yet to bowl)
// for all-rounders. Renders nothing when nothing meaningful applies.
function LiveStatusChip({ role, live }: { role: string; live?: LiveStatus | null }) {
  if (!live) return null;
  const { batting: bat, bowling: bowl, batLine, bowlLine } = live;
  // Role is used ONLY to decide which segments are relevant — it's never printed (the status
  // text says what the player is doing). "yet to bat" is meaningful only for players who bat;
  // "yet to bowl" only for players who bowl.
  const bats = role === "WK" || role === "BAT" || role === "AR";
  const bowls = role === "BOWL" || role === "AR";

  // No emoji in any of these. 🟢 / 🎯 / 🏏 render at a larger optical size than the 9px chip
  // text, so they were the loudest pixels in the row and repeated ~20 times per screen. The
  // wording already says what's happening, and a bowling line ("0/39 (4.0)") is unmistakable
  // against a batting one ("72 (38)").

  // Batting segment: their score once they've batted, else "yet to bat" (batters only).
  let batSeg: React.ReactNode = null;
  if (bat === "NOW") batSeg = <Chip tone="green">{batLine}</Chip>;
  else if (bat === "OUT") batSeg = <Chip tone="mutedRed">out {batLine}</Chip>;
  else if (bat === "NOTOUT") batSeg = <Chip tone="muted">{batLine}</Chip>;
  else if (bat === "YET" && bats) batSeg = <Chip tone="emerald">yet to bat</Chip>;

  // Bowling segment: figures once they've bowled, else "yet to bowl" (bowlers only).
  let bowlSeg: React.ReactNode = null;
  if (bowl === "NOW") bowlSeg = <Chip tone="green">{bowlLine}</Chip>;
  else if (bowl === "DONE") bowlSeg = <Chip tone="muted">{bowlLine}</Chip>;
  else if (bowl === "YET" && bowls) bowlSeg = <Chip tone="gold">yet to bowl</Chip>;

  if (!batSeg && !bowlSeg) return null;
  // Both show when a player has both batted and bowled (a true all-rounder's line).
  return <>{batSeg}{bowlSeg}</>;
}

// One innings block for the live Scorecard tab: header + batting table + bowling table.
// YOUR drafted players are marked with a gold dot (name match, best-effort).
// Auction ownership tags for one scorecard player: "Ni1", "Pu2" (short name + auction serial),
// each in that friend's colour. Empty → renders nothing. This is the "A" layer — draft
// ownership is the gold name, so no "D" here.
function AuctionTags({ owners }: { owners: AuctionOwner[] }) {
  if (owners.length === 0) return null;
  return (
    <span className="flex items-center gap-1 mt-0.5">
      {owners.map((o) => (
        <span
          key={`${o.short}-${o.no}`}
          className="inline-flex items-center gap-0.5 text-[9px] font-bold rounded px-1 py-px border"
          style={{ color: o.hex, borderColor: `${o.hex}66` }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: o.hex }} />
          {o.short}
          <span className="opacity-70">{o.no}</span>
        </span>
      ))}
    </span>
  );
}

function Scorecard({ innings, mine }: { innings: Innings; mine: Set<string> }) {
  // On the scorecard, a player's name is white by default and GOLD if YOU drafted them — that
  // gold name IS the "I own this in the draft" signal (no separate dot / draft tag needed).
  const isMine = (n: string) => mine.has(n.toLowerCase().trim());
  // Auction tour for this match (both innings' teams share it) → per-player "A" owner tags.
  const tour = tourForTeamCode(innings.teamCode);
  return (
    <div className="rounded-xl border border-hair2 bg-ink2 overflow-hidden">
      <div className="px-3 py-2.5 border-b border-hair2 flex items-center gap-2">
        <TeamLogo code={innings.teamCode} size={20} />
        <span className="text-sm font-semibold text-cloud truncate">{innings.teamName}</span>
        <span className="ml-auto text-sm font-bold text-amber-300 tabular-nums shrink-0">
          {innings.runs}/{innings.wickets}{" "}
          <span className="text-mist2 font-normal">({innings.overs})</span>
        </span>
      </div>

      {/* Batting */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-mist2 text-[10px] uppercase tracking-wide">
              <th className="text-left font-semibold px-3 py-1.5">Batter</th>
              <th className="text-right font-semibold px-1.5 py-1.5">R</th>
              <th className="text-right font-semibold px-1.5 py-1.5">B</th>
              <th className="text-right font-semibold px-1.5 py-1.5">4s</th>
              <th className="text-right font-semibold px-1.5 py-1.5">6s</th>
              <th className="text-right font-semibold px-3 py-1.5">SR</th>
            </tr>
          </thead>
          <tbody>
            {innings.batting.map((b, i) => (
              <tr key={`${b.name}-${i}`} className="border-t border-hair2/50">
                <td className="px-3 py-1.5 text-cloud">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className={`truncate font-semibold ${isMine(b.name) ? "text-gold" : "text-cloud"}`}>{b.name}</span>
                    <span className="text-mist2 text-[10px] shrink-0">
                      {b.out ? "out" : b.notOut ? "not out" : ""}
                    </span>
                  </span>
                  <AuctionTags owners={auctionOwnersFor(b.pid, tour)} />
                </td>
                <td className="text-right px-1.5 py-1.5 tabular-nums font-semibold text-cloud">{b.runs}</td>
                <td className="text-right px-1.5 py-1.5 tabular-nums text-mist">{b.balls}</td>
                <td className="text-right px-1.5 py-1.5 tabular-nums text-mist">{b.fours}</td>
                <td className="text-right px-1.5 py-1.5 tabular-nums text-mist">{b.sixes}</td>
                <td className="text-right px-3 py-1.5 tabular-nums text-mist">{b.sr.toFixed(1)}</td>
              </tr>
            ))}
            {innings.batting.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-2 text-center text-[11px] text-mist2">
                  Yet to bat
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Bowling */}
      {innings.bowling.length > 0 && (
        <div className="overflow-x-auto border-t border-hair2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-mist2 text-[10px] uppercase tracking-wide">
                <th className="text-left font-semibold px-3 py-1.5">Bowler</th>
                <th className="text-right font-semibold px-1.5 py-1.5">O</th>
                <th className="text-right font-semibold px-1.5 py-1.5">M</th>
                <th className="text-right font-semibold px-1.5 py-1.5">R</th>
                <th className="text-right font-semibold px-1.5 py-1.5">W</th>
                <th className="text-right font-semibold px-3 py-1.5">Econ</th>
              </tr>
            </thead>
            <tbody>
              {innings.bowling.map((bw, i) => (
                <tr key={`${bw.name}-${i}`} className="border-t border-hair2/50">
                  <td className="px-3 py-1.5 text-cloud">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className={`truncate font-semibold ${isMine(bw.name) ? "text-gold" : "text-cloud"}`}>{bw.name}</span>
                    </span>
                    <AuctionTags owners={auctionOwnersFor(bw.pid, tour)} />
                  </td>
                  <td className="text-right px-1.5 py-1.5 tabular-nums text-mist">{bw.overs}</td>
                  <td className="text-right px-1.5 py-1.5 tabular-nums text-mist">{bw.maidens}</td>
                  <td className="text-right px-1.5 py-1.5 tabular-nums text-mist">{bw.runs}</td>
                  <td className="text-right px-1.5 py-1.5 tabular-nums font-semibold text-cloud">{bw.wickets}</td>
                  <td className="text-right px-3 py-1.5 tabular-nums text-mist">{bw.econ.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Surfaces the bot's recon status so a provisional/revised result never looks plain-final.
function ReconBanner({
  ms,
  hasPoints,
}: {
  ms: { status: "LIVE" | "COMPLETED" | "COMPLETED_FLAGGED"; flag: string;
      recon?: "L1_OPEN" | "L1_DONE" | "L2_PENDING" | "L2_DONE" | null;
      delta?: number } | null;
  hasPoints: boolean;
}) {
  if (!ms) return null;
  // RECON STATE — the second axis. Rendered first because it is the specific, actionable line:
  // "L2 recon pending · -72 pts" tells you what is open AND what it is worth, where the older
  // status-derived banners below could only say "something may change". Absent on tours whose tab
  // predates the Recon State column, in which case the legacy banners are all there is.
  if (ms.recon === "L2_PENDING") {
    const d = ms.delta ?? 0;
    return (
      <div className="rounded-lg border border-sky-400/60 bg-sky-400/10 px-3 py-2 text-sm text-sky-300">
        🔵 L2 recon pending — the official scorecard differs from the settled result
        {d ? (
          <>
            {" "}by{" "}
            <span className={d < 0 ? "font-semibold text-red-300" : "font-semibold text-emerald-300"}>
              {d > 0 ? "+" : ""}
              {d} pts
            </span>
          </>
        ) : null}
        . Approve it in the bot&rsquo;s Recon Review tab to apply.
      </div>
    );
  }
  if (ms.recon === "L1_OPEN") {
    return (
      <div className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-sm text-amber-300">
        ⏳ L1 recon open — feeds disagree or data is missing, so this result is not final yet.
      </div>
    );
  }
  if (ms.status === "COMPLETED_FLAGGED" && ms.flag.includes("revision")) {
    return (
      <div className="rounded-lg border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        ⚠ Official revision pending — these points may change once the official scorecard is approved.
      </div>
    );
  }
  if (ms.status === "LIVE" && hasPoints) {
    return (
      <div className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-sm text-amber-300">
        ⏳ Provisional — awaiting reconciliation. Points shown are live and may be revised before final.
      </div>
    );
  }
  if (ms.status === "COMPLETED_FLAGGED") {
    return (
      <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/90">
        ⚠ Unverified — scored from a single source (no cross-check available).
      </div>
    );
  }
  // The SETTLED states. Deliberately shown rather than left blank: "L1 recon done" is the
  // difference between "nobody has checked this" and "this was checked and agreed", and only one
  // of those is worth settling money on. Quiet chip, not a banner — it is reassurance, not an alert.
  if (ms.recon === "L1_DONE" || ms.recon === "L2_DONE") {
    const done = ms.recon === "L2_DONE";
    return (
      <div className="flex items-center gap-1.5 px-1 text-xs text-emerald-300/80">
        <span aria-hidden>✅</span>
        <span>{done ? "L2 recon done — reconciled against the official scorecard" : "L1 recon done — feeds agreed; awaiting the official scorecard"}</span>
      </div>
    );
  }
  return null;
}

export default function ResultsPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const [data, setData] = useState<ResultsData | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"h2h" | "detail" | "scorecard" | "audit">("h2h");
  const [refreshing, setRefreshing] = useState(false);

  const fetchResults = useCallback(
    async (fresh = false) => {
      // `fresh` (the manual tap) busts the 20s ESPN cache for an instant live pull.
      const res = await fetch(`/api/draft/${code}/results${fresh ? "?fresh=1" : ""}`);
      if (!res.ok) {
        setError("Failed to load results.");
        return;
      }
      setData(await res.json());
    },
    [code]
  );

  // Live-only instant refresh: re-pull the ESPN scorecard right now (no bot, no cricapi).
  const refreshLive = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchResults(true);
    } finally {
      setRefreshing(false);
    }
  }, [fetchResults]);

  useEffect(() => {
    async function init() {
      await fetchResults();
    }
    init();
    const id = setInterval(fetchResults, 30000);
    return () => clearInterval(id);
  }, [fetchResults]);

  if (error) {
    return (
      <main className="min-h-screen bg-ink text-white flex items-center justify-center">
        <p className="text-red-400">{error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="min-h-screen bg-ink text-white flex items-center justify-center">
        <p className="text-mist">Loading results…</p>
      </main>
    );
  }

  const { contest, teams, username } = data;
  const myTeam = teams.find((t) => t.user === username);
  const otherTeams = teams.filter((t) => t.user !== username);

  const hasPoints = teams.some((t) => t.players.some((p) => p.fantasyPoints !== null));
  const orderedTeams = [myTeam, ...otherTeams].filter(Boolean) as TeamResult[];
  const totals = orderedTeams.map((t) => calcXITotal(t));
  const maxTotal = hasPoints && totals.length ? Math.max(...totals) : null;

  // Head-to-head hero framing (built for the common 2-player draft; for 3+ the hero
  // shows you vs the current leader, plus your rank).
  const myTotal = myTeam ? calcXITotal(myTeam) : 0;
  const rankedOpps = otherTeams
    .map((t) => ({ team: t, total: calcXITotal(t) }))
    .sort((a, b) => b.total - a.total);
  const topOpp = rankedOpps[0] ?? null;
  const myRank = 1 + rankedOpps.filter((o) => o.total > myTotal).length;
  const leadMargin = topOpp ? myTotal - topOpp.total : null;
  const denom = topOpp ? myTotal + topOpp.total : myTotal;
  const myShare = denom > 0 ? (myTotal / denom) * 100 : 50;
  const isFinal =
    data.matchStatus?.status === "COMPLETED" || data.matchStatus?.status === "COMPLETED_FLAGGED";
  // Live = started but the COMPLETED pipeline hasn't finalized it. The H2H is then scored
  // in-app from ESPN (instant, no cricapi/bot); tapping "Refresh" re-pulls that immediately.
  const live = data.started && !data.completed;

  // The Scorecard tab is live-only. If the match completes while it's selected, fall back to
  // Head-to-head so the view never goes blank (the button is hidden once not live).
  // Scorecard is live-only; Audit is completed-only. If the match changes state while one of
  // them is selected, fall back to H2H rather than rendering an empty tab.
  const activeTab =
    tab === "scorecard" && !live ? "h2h" : tab === "audit" && !data.audit ? "h2h" : tab;

  // "Still to come" cheer summary from YOUR XI's live statuses (live only).
  const myXI = (myTeam?.players ?? []).filter((p) => !p.isBackup);
  const battingYet = myXI.filter((p) => p.live?.batting === "YET").length;
  const bowlingYet = myXI.filter((p) => p.live?.bowling === "YET").length;
  // Your drafted players (by name, best-effort) — marked with a gold dot in the Scorecard.
  const mineNames = new Set(
    (myTeam?.players ?? []).map((p) => p.name.toLowerCase().trim())
  );
  // Team-hued, readable, guaranteed-distinct name colours for the two teams in this match.
  // Players' team identity reads from the NAME colour, so no per-player logo is needed.
  // Only TWO sober tones — near-white and a muted slate-blue — instead of a distinct
  // saturated hue per team: a match has exactly two sides, so two tones carry the same
  // information, and the old per-team hues (a bright green vs a bright red, at 0.7 sat)
  // made every single row shout for attention.
  // Tones are assigned off the ALPHABETICAL team-code order, NOT first-appearance order:
  // rows are sorted by points and re-sort as live points land, so first-appearance would
  // let the two teams swap colours mid-match.
  // Near-white vs muted CYAN, not vs a slate-blue. The first attempt paired #e6ebf4 with
  // #8ea6c6, and on a navy background those both just read as "light" — a lightness-only
  // difference between two cool greys is not separable at a glance in a dense list.
  // A hue shift is, so the second tone moves off the grey axis entirely.
  // Cyan specifically because every warm slot is taken and would fight something: gold is
  // the captain's row wash, amber is the points number on every row. Cyan also holds up
  // where it has to sit ON a tint — legible over both the gold C row and the blue VC row.
  const NAME_TONES = ["#eef3fa", "#6fc3d6"];
  const teamOrder = [
    ...new Set(teams.flatMap((t) => t.players.map((p) => p.team)).filter(Boolean)),
  ].sort();
  const nameColor = (code: string) => {
    const i = teamOrder.indexOf(code);
    return i < 0 ? NAME_TONES[0] : NAME_TONES[i % NAME_TONES.length];
  };

  return (
    <main className="min-h-screen bg-ink text-white pb-8">
      <div className="max-w-lg mx-auto px-3 pt-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link href={`/match/${contest.matchKey}`} className="text-mist hover:text-white text-lg">←</Link>
          <div className="flex-1">
            <h1 className="font-bold">{prettifyMatchLabel(contest.matchLabel)}</h1>
            <p className="text-xs text-mist">
              {live && data.liveFreshness
                ? `${data.liveFreshness} · via ESPN (provisional)`
                : live && data.liveProvisional
                ? "Live · provisional (via ESPN) — auto-refreshes every 30s"
                : live
                ? "Live — waiting for scores"
                : hasPoints
                ? "Refreshes every 30s"
                : "Waiting for match to start"}
            </p>
          </div>
          {live && (
            <button
              onClick={refreshLive}
              disabled={refreshing}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition ${
                refreshing
                  ? "bg-navy border-hair2 text-mist cursor-not-allowed"
                  : "bg-navy border-gold/50 text-gold hover:brightness-110"
              }`}
            >
              {refreshing && (
                <span className="h-3 w-3 rounded-full border-2 border-mist/30 border-t-cloud animate-spin" />
              )}
              {refreshing ? "…" : "🔄 Refresh"}
            </button>
          )}
          <Link href="/lobby" className="text-xs text-mist2 hover:text-cloud">Home</Link>
        </div>

        {/* Recon-status banner: a provisional/awaiting-recon or revised-but-pending result is
            never presented as plain "final" — the numbers may still change. */}
        <ReconBanner ms={data.matchStatus} hasPoints={hasPoints} />

        {/* Refresh the lineup — manual + auto-check at roundlock. On the results
            page this re-pulls the official XI so backup-intelligence subs + the
            effective lineup update the moment lineups post. */}
        <LineupRefresh
          announced={data.announced}
          roundlockTs={(contest.matchDeadline ?? 0) + LOCK_BUFFER}
          onRefresh={fetchResults}
        />

        {/* ── Head-to-head hero — answers "am I winning?" before anything else ── */}
        {orderedTeams.length > 0 && (
          <div className={`rounded-2xl p-4 border ${hasPoints && leadMargin !== null && leadMargin > 0 ? "border-yellow-400/40 bg-gradient-to-b from-yellow-400/10 to-ink2" : "border-hair2 bg-ink2"}`}>
            {topOpp ? (
              <>
                <div className="flex items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-mist font-medium truncate">
                      <span className="text-gold">{getUserLabel(username)}</span> (you)
                    </p>
                    <p className={`text-3xl font-bold tabular-nums ${myTotal >= topOpp.total ? "text-amber-300" : "text-cloud"}`}>
                      {myTotal.toFixed(1)}
                    </p>
                  </div>
                  <span className="text-mist2 text-xs font-bold pb-2">vs</span>
                  <div className="min-w-0 text-right">
                    <p className="text-xs text-mist font-medium truncate">{getUserLabel(topOpp.team.user)}</p>
                    <p className={`text-3xl font-bold tabular-nums ${topOpp.total > myTotal ? "text-amber-300" : "text-cloud"}`}>
                      {topOpp.total.toFixed(1)}
                    </p>
                  </div>
                </div>
                {/* Share bar */}
                <div className="mt-3 h-2 rounded-full bg-navy2 overflow-hidden flex">
                  <span className="h-full bg-gradient-to-r from-gold to-amber-300" style={{ width: `${myShare}%` }} />
                  <span className="h-full bg-[#33456b]" style={{ width: `${100 - myShare}%` }} />
                </div>
                {/* Verdict */}
                <p className={`mt-2.5 text-sm font-semibold ${
                  !hasPoints ? "text-mist2" : leadMargin! > 0 ? "text-emerald-400" : leadMargin! < 0 ? "text-red-400" : "text-mist"
                }`}>
                  {!hasPoints
                    ? "Waiting for points"
                    : leadMargin! > 0
                    ? `${isFinal ? "🏆 " : "▲ "}${
                        otherTeams.length > 1
                          ? `${myRank === 1 ? (isFinal ? "Won" : "Leading") : ordinal(myRank) + " of " + orderedTeams.length}`
                          : isFinal
                          ? "Won"
                          : "Ahead"
                      } by ${leadMargin!.toFixed(1)} pts`
                    : leadMargin! < 0
                    ? `${isFinal ? "Lost" : "▼ Behind"} by ${(-leadMargin!).toFixed(1)} pts`
                    : isFinal ? "● Tied" : "● Level"}
                </p>
              </>
            ) : (
              // Solo (no opponent submitted): just your total.
              <div>
                <p className="text-xs text-mist font-medium">
                  <span className="text-gold">{getUserLabel(username)}</span> (you)
                </p>
                <p className={`text-3xl font-bold tabular-nums ${hasPoints ? "text-amber-300" : "text-mist2"}`}>
                  {myTotal.toFixed(1)}<span className="text-sm text-mist2 font-normal"> pts</span>
                </p>
              </div>
            )}
          </div>
        )}

        {/* Tab switcher — H2H comparison, single-team breakdown, and (live-only) full scorecard */}
        {orderedTeams.length > 0 && (
          <div className="flex bg-ink2 rounded-xl p-1 gap-1">
            <button
              onClick={() => setTab("h2h")}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${activeTab === "h2h" ? "bg-ink text-gold" : "text-mist hover:text-cloud"}`}
            >
              Head-to-head
            </button>
            <button
              onClick={() => setTab("detail")}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${activeTab === "detail" ? "bg-ink text-gold" : "text-mist hover:text-cloud"}`}
            >
              My XI detail
            </button>
            {live && (
              <button
                onClick={() => setTab("scorecard")}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${activeTab === "scorecard" ? "bg-ink text-gold" : "text-mist hover:text-cloud"}`}
              >
                Scorecard
              </button>
            )}
            {data.audit && (
              <button
                onClick={() => setTab("audit")}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${activeTab === "audit" ? "bg-ink text-gold" : "text-mist hover:text-cloud"}`}
              >
                Audit
                {(data.audit.changed || data.audit.noBaseline) && (
                  <span className={`ml-1 ${data.audit.changed ? "text-destructive" : "text-mist2"}`}>
                    {data.audit.changed ? "⚠" : "?"}
                  </span>
                )}
              </button>
            )}
          </div>
        )}

        {/* Still-to-come cheer strip — your XI's yet-to-bat / yet-to-bowl count (live only) */}
        {live && (battingYet > 0 || bowlingYet > 0) && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gold/40 bg-gradient-to-r from-gold/10 to-ink2 px-3 py-2 text-xs font-semibold">
            <span className="text-cloud">Still to come</span>
            <span className="text-mist2">·</span>
            {battingYet > 0 && <span className="text-emerald-300">🟢 {battingYet} to bat</span>}
            {battingYet > 0 && bowlingYet > 0 && <span className="text-mist2">·</span>}
            {bowlingYet > 0 && <span className="text-gold">🎯 {bowlingYet} to bowl</span>}
          </div>
        )}

        {/* ── HEAD-TO-HEAD: both XIs side by side, full names, sorted by points ── */}
        {activeTab === "h2h" && orderedTeams.length > 0 && (
          <div className={orderedTeams.length === 2 ? "grid grid-cols-2 gap-2" : "flex gap-2 overflow-x-auto pb-1"}>
            {orderedTeams.map((team) => {
              const total = calcXITotal(team);
              const isWinner = maxTotal !== null && total === maxTotal && total > 0 && orderedTeams.length > 1;
              const isMine = team.user === username;
              const color = USER_COLORS[team.user] ?? "bg-gray-500";
              const xi = team.players
                .filter((p) => !p.isBackup)
                .sort((a, b) => (b.fantasyPoints ?? 0) - (a.fantasyPoints ?? 0));

              return (
                <div
                  key={team.user}
                  className={`rounded-xl border overflow-hidden ${orderedTeams.length === 2 ? "" : "min-w-[47%] shrink-0"} ${isWinner ? "border-yellow-400/50 ring-1 ring-yellow-400/20" : "border-hair2"} bg-ink2`}
                >
                  {/* Column head — FIXED height, not padding-derived. Two things used to make
                      the leader's header taller than the other's and knock every row below
                      out of alignment: the per-column "still to come" line (removed earlier),
                      and the 👑, which is a full-size emoji whose line box is taller than the
                      12px name text beside it. The crown is now clamped (leading-none at chip
                      size) AND the header height is pinned, so no future winner-only ornament
                      can desync the columns again. */}
                  <div className={`h-[4.25rem] px-3 flex flex-col justify-center border-b border-hair2 ${isWinner ? "bg-yellow-400/[0.06]" : ""}`}>
                    <div className="flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
                      <span className="text-xs font-semibold text-cloud truncate">
                        {getUserLabel(team.user)}{team.user === username ? " (you)" : ""}
                      </span>
                      {isWinner && <span className="ml-auto shrink-0 text-[13px] leading-none">👑</span>}
                    </div>
                    <p className={`text-xl font-bold tabular-nums mt-1 ${isWinner ? "text-amber-300" : "text-cloud"}`}>
                      {total.toFixed(1)}
                    </p>
                    {/* The per-column "still to come" line lived here but only rendered for
                        YOUR column, making your header taller than the opponent's and
                        knocking every row below out of alignment. It's already shown in the
                        "Still to come" strip above both columns, so it's dropped here to keep
                        both headers — and therefore every player row — the same height. */}
                  </div>
                  {/* Rows — two lines each so full names always read */}
                  <div className="flex flex-col">
                    {xi.map((p) => {
                      const highlight = live && isMine && stillToCome(p);
                      return (
                        <div
                          key={p.key}
                          className={`flex flex-col justify-center gap-0.5 h-[3.25rem] px-2.5 border-t border-hair2/50 first:border-t-0 ${armbandRowTone(p, highlight)}`}
                        >
                          {/* Name line. The armband badge stays as the unambiguous label — the
                              row tint is the thing you spot, the letter is what confirms it. */}
                          <div className="flex items-center gap-1.5 min-w-0">
                            <PlayerAvatar photo={p.photo} size={22} />
                            {p.isCaptain && <span className="text-[10px] leading-none bg-gold text-ink px-1.5 py-0.5 rounded font-extrabold shrink-0">C</span>}
                            {p.isViceCaptain && <span className="text-[10px] leading-none bg-blue-500 text-white px-1.5 py-0.5 rounded font-extrabold shrink-0">VC</span>}
                            <span
                              className="text-xs font-semibold truncate"
                              style={{ color: nameColor(p.team) }}
                            >
                              {p.name}
                            </span>
                          </div>
                          {/* Fixed to a single line so both columns' rows stay the same height.
                              Live: the status text says what they're doing — no loud role tag.
                              Non-live (completed): show the role tag since there's no status. */}
                          <div className="flex items-center gap-1.5 flex-nowrap overflow-hidden">
                            {!live && <span className={`text-[9px] font-bold shrink-0 ${ROLE_COLORS[p.role] ?? "text-mist"}`}>{p.role}</span>}
                            {live && <span className="flex items-center gap-1 min-w-0 overflow-hidden"><LiveStatusChip role={p.role} live={p.live} /></span>}
                            <span className={`ml-auto text-xs font-bold tabular-nums shrink-0 ${p.fantasyPoints !== null ? "text-amber-300" : "text-mist2"}`}>
                              {p.fantasyPoints !== null ? p.fantasyPoints.toFixed(1) : "–"}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── MY XI DETAIL: the rich single-column breakdown (C/VC math, bench, recon) ── */}
        {activeTab === "detail" &&
          orderedTeams.map((team) => {
            const color = USER_COLORS[team.user] ?? "bg-gray-500";
            const isMine = team.user === username;
            const xi = team.players.filter((p) => !p.isBackup);
            const bench = team.players.filter((p) => p.isBackup);

            return (
              <div key={team.user} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${color}`} />
                  <h2 className="text-sm font-semibold text-cloud">
                    {getUserLabel(team.user)}{team.user === username ? "'s team (you)" : "'s team"}
                  </h2>
                </div>

                {/* What backup intelligence changed for this team */}
                <ChangesBanner changes={team.changes ?? []} />

                {/* XI */}
                <div className="space-y-1">
                  {xi.map((p) => (
                    <PlayerRow
                      key={p.key}
                      player={p}
                      showLive={live}
                      highlight={!!(live && isMine && stillToCome(p))}
                      nameColorHex={nameColor(p.team)}
                    />
                  ))}
                </div>

                {/* Bench */}
                {bench.length > 0 && (
                  <div className="space-y-1 opacity-60">
                    <p className="text-xs text-mist2 uppercase tracking-wider px-1 pt-1">Bench — not counted</p>
                    {bench.map((p) => (
                      <PlayerRow key={p.key} player={p} isBench showLive={live} nameColorHex={nameColor(p.team)} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

        {/* ── SCORECARD (live only): full innings breakdown, your drafted players dotted gold ── */}
        {activeTab === "scorecard" && live && (
          <div className="space-y-3">
            {data.scorecard && data.scorecard.length > 0 ? (
              data.scorecard.map((inn) => (
                <Scorecard key={inn.teamCode} innings={inn} mine={mineNames} />
              ))
            ) : (
              <p className="text-center text-mist2 text-sm py-8">Scorecard appears once play begins.</p>
            )}
          </div>
        )}


        {/* ── AUDIT: was this result settled on the same numbers the sheet shows now? ──
            The points sheet is rewritten in place on every bot run, so a settled result can move
            without anyone touching it. This tab is the receipt. */}
        {activeTab === "audit" && data.audit && (
          <div className="space-y-3">
            {/* Verdict first — the user's question is "do we need to re-settle?" */}
            <div
              className={`rounded-xl border px-3 py-2.5 ${
                data.audit.winnerChanged
                  ? "border-destructive/50 bg-destructive/10"
                  : data.audit.changed
                    ? "border-gold/50 bg-gold/10"
                    : data.audit.noBaseline
                      ? "border-mist2/30 bg-ink2"
                      : "border-grn/40 bg-grn/10"
              }`}
            >
              <p className="text-sm font-bold">
                {data.audit.winnerChanged
                  ? "⚠ The result changed — this contest would settle differently now"
                  : data.audit.changed
                    ? "⚠ Points moved since settlement, but the winner is unchanged"
                    : data.audit.pending.length > 0
                      ? "⏳ Reconciliation still open — nothing has moved yet"
                      : data.audit.noBaseline
                        ? "? No settled baseline recorded for this match"
                        : "✓ Unchanged since settlement"}
              </p>
              {data.audit.pending.length > 0 && (
                <p className="text-[11px] text-mist mt-1">
                  {data.audit.pending.length} player
                  {data.audit.pending.length === 1 ? "" : "s"} awaiting your action
                  {data.audit.pendingAbsDelta > 0 && (
                    <> · <span className="text-cloud font-semibold">{data.audit.pendingAbsDelta} pts</span> at stake if applied</>
                  )}
                  . Until then the settled value is what you see.
                </p>
              )}
              {data.audit.noBaseline && (
                <p className="text-[11px] text-mist mt-1">
                  This match completed before the audit baseline existed, so an unchanged total
                  here is not proof that nothing moved.
                </p>
              )}
            </div>

            {/* Then/now per user */}
            <div className="rounded-xl border border-hair bg-ink2 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-mist2 text-[10px] uppercase tracking-wide border-b border-hair">
                    <th className="text-left font-medium px-3 py-2">Player</th>
                    <th className="text-right font-medium px-2 py-2">Settled</th>
                    <th className="text-right font-medium px-2 py-2">Now</th>
                    <th className="text-right font-medium px-3 py-2">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {data.audit.totals.map((t) => {
                    const wasW = data.audit!.settledWinners.includes(t.user);
                    const isW = data.audit!.currentWinners.includes(t.user);
                    return (
                      <tr key={t.user} className="border-b border-hair/50 last:border-0">
                        <td className="px-3 py-2">
                          <span className={t.user === username ? "font-semibold text-cloud" : "text-mist"}>
                            {getUserLabel(t.user)}
                          </span>
                          {wasW && !isW && <span className="ml-1 text-[9px] text-destructive">lost 🏆</span>}
                          {!wasW && isW && <span className="ml-1 text-[9px] text-grn">gained 🏆</span>}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-mist">
                          {t.settled === null ? "—" : Math.round(t.settled * 10) / 10}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums font-semibold">
                          {t.now === null ? "—" : Math.round(t.now * 10) / 10}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {t.delta === 0 ? (
                            <span className="text-mist2">—</span>
                          ) : (
                            <span className={t.delta < 0 ? "text-destructive font-bold" : "text-grn font-bold"}>
                              {t.delta < 0 ? "−" : "+"}
                              {Math.abs(Math.round(t.delta * 10) / 10)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* ── Split, because these demand different things from you ──
                 PENDING  = L2 recon not finished. The bot is HOLDING the settled value, so nothing
                            has moved. This is a to-do list (approve in Recon Review, or fix the
                            registry alias).
                 CHANGED  = L2 recon finished and the number already differs from settlement. This
                            is the list that decides whether you re-settle. */}
            {(["PENDING", "CHANGED"] as const).map((grp) => {
              const rows = grp === "PENDING" ? data.audit!.pending : data.audit!.changedRows;
              if (rows.length === 0) return null;
              const pend = grp === "PENDING";
              return (
                <div
                  key={grp}
                  className={`rounded-xl border p-3 ${pend ? "border-gold/40 bg-gold/5" : "border-destructive/40 bg-destructive/5"}`}
                >
                  <p className={`text-[10px] uppercase tracking-wide mb-0.5 font-bold ${pend ? "text-gold" : "text-destructive"}`}>
                    {pend
                      ? `⏳ L2 recon pending — action needed (${rows.length})`
                      : `⚠ L2 recon done — result changed (${rows.length})`}
                  </p>
                  <p className="text-[10px] text-mist2 mb-2">
                    {pend
                      ? "Settled value is still being shown. It only moves once you approve the revision (or fix the identity)."
                      : "Reconciliation is complete and these numbers already differ from what this contest was settled on."}
                  </p>
                  <ul className="space-y-2">
                    {rows.map((p) => (
                      <li key={p.pid} className="text-xs">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-cloud">{p.name}</span>
                          {p.team && <span className="text-[10px] text-mist2 font-mono">{p.team}</span>}
                          <span className="font-mono text-mist tabular-nums">
                            {p.settled === null ? "—" : p.settled}
                            {" "}
                            {pend ? "⇢" : "→"}
                            {" "}
                            {p.now === null ? "0" : p.now}
                          </span>
                          {p.delta !== 0 && (
                            <span className={p.delta < 0 ? "text-destructive font-bold" : "text-grn font-bold"}>
                              ({p.delta < 0 ? "−" : "+"}
                              {Math.abs(p.delta)}
                              {pend ? " if applied" : ""})
                            </span>
                          )}
                          <ReasonChip reason={p.reason} />
                        </div>
                        {p.marker && (
                          <p className="text-[10px] text-mist2 mt-0.5 font-mono">{p.marker}</p>
                        )}
                        {p.orphanCandidate && (
                          <p className="text-[10px] text-mist2 mt-0.5">
                            The official card lists{" "}
                            <span className="font-mono text-destructive">{p.orphanCandidate}</span>, which
                            resolves to no player id — so these points reach no contest. Fixing the
                            registry alias recovers them.
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}

            {data.audit.orphans.length > 0 && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
                <p className="text-[10px] uppercase tracking-wide text-destructive mb-1.5">
                  Points no contest can see
                </p>
                <ul className="text-xs space-y-0.5">
                  {data.audit.orphans.map((o) => (
                    <li key={o.name} className="flex items-center gap-2">
                      <span className="font-mono text-cloud">{o.name}</span>
                      <span className="text-mist2">no player id</span>
                      <span className="ml-auto font-bold tabular-nums text-destructive">{o.points} pts</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-[10px] text-mist2 text-center">
              Baseline = each player&apos;s points the first time this match published as completed
              (bot&apos;s write-once SETTLEMENT AUDIT tab).
            </p>
          </div>
        )}

        {teams.length === 0 && (
          <div className="text-center py-12">
            <p className="text-mist2">No teams submitted yet. Go finalize your team!</p>
            <Link href={`/draft/${code}/team`} className="mt-4 inline-block text-gold underline">
              Set my team →
            </Link>
          </div>
        )}

        <p className="text-xs text-mist2 text-center">
          Points refresh every 30s · ~ means projected EFPPM (no live data yet)
        </p>
      </div>
    </main>
  );
}

// Player headshot from ESPN (live matches only). Falls back to a neutral greyscale
// silhouette when there's no photo, and — crucially — also on a runtime image error
// (onError), so a dead URL can never render as a broken image. Plain <img> keeps us off
// next/image remote-host config.
// The fallback is deliberately NOT the team flag any more: only ~25% of players have a
// photo, so a column was mostly loud emoji flags sitting at a different optical size and
// baseline to the round photos — and the team is already carried by the name colour.
function PlayerAvatar({ photo, size }: { photo?: string | null; size: number }) {
  const [failed, setFailed] = useState(false);
  if (photo && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photo}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        style={{ width: size, height: size }}
        className="rounded-full object-cover bg-navy2 ring-1 ring-hair2 shrink-0"
      />
    );
  }
  // Generic avatar: same round footprint/ring as a real headshot so rows never shift when a
  // photo does exist. The silhouette runs to the bottom of the viewBox and is clipped by the
  // circle, which is what makes it read as a stock profile picture rather than a floating icon.
  return (
    <span
      style={{ width: size, height: size }}
      className="shrink-0 inline-flex items-end justify-center overflow-hidden rounded-full bg-navy2 ring-1 ring-hair2/60"
    >
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ fill: "#5f6b82" }}>
        <circle cx="12" cy="9" r="4.2" />
        <path d="M12 14.6c-4.2 0-7.6 2.6-7.6 5.9V24h15.2v-3.5c0-3.3-3.4-5.9-7.6-5.9z" />
      </svg>
    </span>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function PlayerRow({
  player,
  isBench = false,
  showLive = false,
  highlight = false,
  nameColorHex = "#e4e9f2",
}: {
  player: PlayerResult;
  isBench?: boolean;
  showLive?: boolean; // match is live → render the live status chip
  highlight?: boolean; // one of YOUR still-to-come players → faint neutral wash (see rowTone)
  nameColorHex?: string; // team-hued name colour (team identity, no per-player logo)
}) {
  const mult = player.isCaptain ? 2 : player.isViceCaptain ? 1.5 : 1;
  // rawPoints is the base score; fantasyPoints already has mult applied (do NOT re-multiply)
  const raw = player.rawPoints;
  const displayPts = raw !== null ? raw * mult : null;

  // Same C/gold, VC/blue, still-to-come/neutral language as the head-to-head columns, so
  // switching tabs doesn't switch visual vocabulary. Painted entirely with inset shadows
  // (a 3px left rail plus a full-bleed 100px-spread inset acting as the tint) rather than a
  // `bg-*` class: this row already carries a solid `bg-ink2`, and two competing background
  // utilities would resolve by stylesheet order, not by the order written here.
  const rowTone = player.isCaptain
    ? "shadow-[inset_3px_0_0_rgba(212,175,55,0.9),inset_0_0_0_100px_rgba(212,175,55,0.11)]"
    : player.isViceCaptain
    ? "shadow-[inset_3px_0_0_rgba(59,130,246,0.9),inset_0_0_0_100px_rgba(59,130,246,0.10)]"
    : highlight
    ? "shadow-[inset_0_0_0_100px_rgba(255,255,255,0.03)]"
    : "";

  return (
    <div
      className={`flex items-center gap-2 bg-ink2 rounded-lg px-3 py-2 ${isBench ? "opacity-70" : ""} ${rowTone}`}
    >
      <PlayerAvatar photo={player.photo} size={26} />
      {/* Role tag only when not live — live rows let the status text speak instead. */}
      {!showLive && (
        <span className={`text-xs font-bold ${ROLE_COLORS[player.role] ?? "text-mist"}`}>
          {player.role}
        </span>
      )}
      <span className="flex-1 text-sm font-semibold min-w-0 truncate" style={{ color: nameColorHex }}>
        {player.name}
        {player.isCaptain && (
          <span className="ml-1 text-xs bg-gold text-ink px-1 rounded font-bold">C</span>
        )}
        {player.isViceCaptain && (
          <span className="ml-1 text-xs bg-blue-500 text-white px-1 rounded font-bold">VC</span>
        )}
        {player.recon && (
          <span
            title={
              player.recon === "⚠ official revision"
                ? "Official scorecard differs from the approved value — pending review."
                : "cricapi & ESPN disagree on this player — points not yet reconciled."
            }
            className={`ml-1.5 align-middle text-[10px] px-1.5 py-0.5 rounded font-semibold border ${
              player.recon === "⚠ official revision"
                ? "bg-red-500/15 text-red-300 border-red-500/40"
                : "bg-amber-400/15 text-amber-300 border-amber-400/40"
            }`}
          >
            {player.recon === "⚠ official revision" ? "⚠ revision" : "⏳ provisional"}
          </span>
        )}
      </span>
      {/* Live batting/bowling status (live matches only). */}
      {showLive && <LiveStatusChip role={player.role} live={player.live} />}
      {/* For C/VC, show base ×mult = total so the multiplier is visibly ALREADY
          applied (102 ×2 = 204) — never the multiplied value beside a bare "×2",
          which misreads as if it'll be doubled again. */}
      <span className="text-sm text-mist shrink-0 whitespace-nowrap">
        {mult > 1 && displayPts !== null && raw !== null && (
          <span className="text-mist2 text-xs mr-1">{raw.toFixed(1)} ×{mult} =</span>
        )}
        <span className={displayPts !== null ? "text-amber-300 font-semibold" : "text-mist2"}>
          {(displayPts ?? 0).toFixed(1)}
        </span>
      </span>
    </div>
  );
}
