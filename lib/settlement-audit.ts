import type { MatchLike } from "@/lib/points";
import {
  getLiveAuditRows,
  getSettledRowsForMatch,
  getSettledPointsForMatch,
  getMatchPointsForMatch,
  pickDupRow,
  type LiveAuditRow,
  type SettledRow,
} from "@/lib/points";
import { normName } from "@/lib/fuzzy-name-match";
import type { AuditReason } from "@/lib/audit-reasons";

/**
 * Settlement audit — "has anything changed since we settled this match?"
 *
 * Background (29 Jul 2026). LPL + both Hundreds flipped to `cricsheet · official` days after
 * their contests were settled. The bot's L2 reconciliation compares cricsheet against a LIVE
 * RE-COMPUTATION of the provisional cut, NOT against what was on screen at settlement — so it
 * is blind to anything that moves points without cricsheet's involvement, and it was blind to
 * identity failures entirely (its comparison only iterates players present on the official
 * card, so a player who vanished from it produced no gap and no flag). Two LPL matches were
 * badged `COMPLETED` with an empty flag while a captain's 114-point innings read 0.
 *
 * This module diffs the bot's WRITE-ONCE settled baseline against the live sheet and, crucially,
 * says WHY each number moved. The reason is the whole value: "−228" is alarming, "−228 because
 * the official card spells him PWH de Silva and nothing joined it" is actionable.
 */

// Reason codes live in lib/audit-reasons.ts (client-safe, no fs). Re-exported here so existing
// server-side importers keep one import site.
export {
  REASON_LABEL,
  SUSPECT_REASONS,
  type AuditReason,
} from "@/lib/audit-reasons";

/**
 * Which bucket a row belongs to. The distinction is mechanical, not cosmetic: the bot HOLDS the
 * last-approved value while an L2 revision is unapproved, so
 *   - PENDING  = reconciliation is not finished. The number on screen is still the settled one;
 *                it will only move once you act (approve the revision, or fix the registry).
 *                Nothing to re-settle yet — this is a to-do list.
 *   - CHANGED  = reconciliation IS finished (approved or auto-applied) and the current number
 *                differs from what the contest was settled on. This is the re-settle list.
 *   - NO_BASELINE / CLEAN = nothing to say.
 */
export type AuditGroup = "PENDING" | "CHANGED" | "NO_BASELINE" | "CLEAN";

export type PlayerAudit = {
  pid: string;
  name: string;
  team: string;
  settled: number | null;   // null when no baseline row exists for them
  now: number | null;       // null when they have no scored row now
  delta: number;
  reason: AuditReason;
  /** The unmatched official-card spelling we believe is the same person, when we can pair one. */
  orphanCandidate: string | null;
  provenance: SettledRow["provenance"] | null;
  l2: string;
  group: AuditGroup;
  /** The bot's per-player marker verbatim ("⚠ official revision", "⛔ identity unresolved", …) —
   *  the reason a PENDING row is pending, in the bot's own words. */
  marker: string;
};

export type MatchAudit = {
  matchKey: string;
  label: string;
  /** Tour name, taken from the settlement tab (matches.json has no tour field). "" if unknown. */
  tour: string;
  /** true when at least one player's number moved for a suspect reason. */
  changed: boolean;
  /** true when NO trustworthy baseline exists for this match at all. */
  noBaseline: boolean;
  players: PlayerAudit[];
  /** L2 recon NOT finished — manual action pending. Displayed number is still the settled one. */
  pending: PlayerAudit[];
  /** L2 recon finished AND the number differs from settlement — the actual re-settle list. */
  changedRows: PlayerAudit[];
  /** Official-card rows carrying points that no contest can ever see. */
  orphans: { name: string; points: number }[];
  /** (match, player) keys the sheet holds TWICE. The app now reduces them one way everywhere
   *  (highest score wins, an absent value never wins) — this is the list of numbers that had to be
   *  CHOSEN, so a settled total is never quietly decided by which row the bot wrote last. */
  duplicates: { pid: string; name: string; kept: number | null; values: (number | null)[] }[];
  /** Absolute points at stake in `pending` (potential, not yet applied). */
  pendingAbsDelta: number;
  /** Absolute points already moved in `changedRows` (real). */
  totalAbsDelta: number;
};

function surnameOf(n: string): string {
  const t = normName(n).split(" ").filter(Boolean);
  return t.length ? t[t.length - 1] : "";
}

/**
 * Pair an unjoinable official-card row with the squad player it probably IS.
 *
 * Only ever used to EXPLAIN a delta in the UI — never to move points. Identity is fixed in the
 * shared registry, by id; guessing here is how "Dale → Glenn" style merges happen. So this is
 * a hint, and it is labelled as one.
 */
function pairOrphan(zeroed: { name: string; team: string }, orphans: LiveAuditRow[]): string | null {
  const sn = surnameOf(zeroed.name);
  // cricsheet's initials form usually shares the surname ("T Mathew" ~ "Traveen Mathews"). It
  // does not always ("PWH de Silva" IS Wanindu Hasaranga — his surname really is de Silva), which
  // is exactly why this is a hint and the bot's id-anchored `⛔ identity unresolved` marker is the
  // authority. Name evidence only; the weak same-team guess is a separate, stricter pass.
  const byName = orphans.filter((o) => {
    const os = surnameOf(o.name);
    return os && sn && (os === sn || os.startsWith(sn) || sn.startsWith(os));
  });
  return byName.length === 1 ? byName[0].name : null;
}

function reasonFor(
  settled: number | null,
  now: number | null,
  provenance: SettledRow["provenance"] | null,
  live: LiveAuditRow | undefined,
  /** True only when an unjoined official-card row was paired to THIS player (1:1). */
  pairedToOrphan: boolean
): AuditReason {
  const l2 = live?.l2 ?? "";
  const recon = live?.recon ?? "";
  const changed = (settled ?? 0) !== (now ?? 0);

  // An identity failure is the one case where the sheet's own columns already say so.
  if (recon.includes("identity") || l2.includes("identity")) return "IDENTITY_BREAK";
  // Fell to nothing while the official card carries an unjoinable row for this team.
  if (changed && (now ?? 0) === 0 && (settled ?? 0) > 0 && pairedToOrphan) return "IDENTITY_BREAK";
  if (!changed) {
    // Equal numbers still aren't proof when the baseline itself is unverified.
    return provenance === "unknown" ? "NO_BASELINE" : "UNCHANGED";
  }
  if (provenance === "unknown") return "NO_BASELINE";
  // Order matters: "⚠ revised: not in official XI" ALSO starts with "⚠ revised", so the omission
  // case must be tested first or every dropped player reads as a stat revision.
  if ((now ?? 0) === 0 && l2.includes("not in official XI")) return "NOT_IN_OFFICIAL_XI";
  if (recon.includes("official revision") || l2.startsWith("⚠ revised")) return "FIELD_REVISION";
  if ((settled ?? 0) === 0 && (now ?? 0) > 0) return "NEW_POINTS";
  // Nothing in reconciliation explains it => it came from our side.
  return "SCORER_FIX";
}

/**
 * PENDING vs CHANGED. A non-empty per-player recon marker means the bot is still holding the
 * settled value for that player — so the delta is POTENTIAL, not applied. Only once nothing is
 * pending does a non-zero delta mean the result genuinely changed.
 */
function groupFor(reason: AuditReason, marker: string, delta: number): AuditGroup {
  if (reason === "NO_BASELINE") return "NO_BASELINE";
  // The bot's own marker is authoritative: it is written exactly when a human still has to act.
  if (marker) return "PENDING";
  // An identity break needs a registry alias — pending by definition, marker or not (the marker
  // only appears after the bot re-runs with the identity gate).
  if (reason === "IDENTITY_BREAK") return "PENDING";
  return delta !== 0 ? "CHANGED" : "CLEAN";
}

/** Audit one match: settled baseline vs the live sheet, per player, with reasons. */
export async function auditMatch(match: MatchLike & { key: string; label: string }): Promise<MatchAudit> {
  const [settledRows, liveRows] = await Promise.all([
    getSettledRowsForMatch(match),
    getLiveAuditRows(match),
  ]);

  // A pid can appear on MORE THAN ONE live row for the same match (LPL Match 6 carries Vishva
  // Kumara twice — once scored, once a blank Played=N row). Last-wins would let the blank row
  // erase a real score and manufacture a phantom "−38". Prefer the row that actually has points.
  //
  // This was the ONLY path that guarded duplicates, and it did so with its own rule — hence the
  // Audit tab printing 2 for Jane Maguire while the results page beside it printed −1. It now
  // calls the SAME pickDupRow as every points map (lib/points.ts), so the audit can no longer
  // disagree with the thing it is auditing.
  //
  // It also scored an ABSENCE as the literal value −1: `(prev.points ?? -1) < (r.points ?? -1)`
  // means a blank partner row (null) ranked ABOVE any genuinely negative score, so a real −3 lost
  // to an empty slot → the player read 0, and the audit invented a delta with a SCORER_FIX reason
  // that nothing on the sheet caused. pickDupRow ranks a pointless row −Infinity instead.
  const liveByPid = new Map<string, LiveAuditRow>();
  const duplicates: MatchAudit["duplicates"] = [];
  const byPid = new Map<string, LiveAuditRow[]>();
  for (const r of liveRows) {
    if (!r.pid) continue;
    byPid.set(r.pid, [...(byPid.get(r.pid) ?? []), r]);
  }
  for (const [pid, group] of byPid) {
    const kept = pickDupRow(`${match.label} ${pid}`, group, (r) => r.points);
    liveByPid.set(pid, kept);
    // Surface it rather than absorb it: two rows for one (match, player) is a bot-side slot bug,
    // and the reader deserves to know a number was CHOSEN between two candidates.
    if (group.length > 1) {
      duplicates.push({
        pid,
        name: kept.name || pid,
        kept: kept.points,
        values: group.map((r) => r.points),
      });
    }
  }

  // Official-card rows that resolved to NO player id AND carry points — the smoking gun for an
  // identity break, and points that are invisible to every contest.
  const orphans = liveRows.filter((r) => !r.pid && (r.points ?? 0) > 0);

  // Candidates for an identity break: scored at settlement, nothing now.
  const zeroedNow = settledRows.filter((s) => {
    if (!s.pid) return false;
    const live = liveByPid.get(s.pid);
    return (s.points ?? 0) > 0 && ((live ? live.points : null) ?? 0) === 0;
  });

  // Assign each orphan to AT MOST ONE zeroed player. Without this a single orphan "explains"
  // every player who dropped to 0 on that team — which wrongly branded Dale Phillips an identity
  // break on the strength of Hasaranga's unmatched row. Name evidence first; the
  // one-orphan/one-casualty fallback only fires when it is genuinely unambiguous.
  const pairedTo = new Map<string, string>(); // settled pid -> orphan name
  const takenOrphans = new Set<string>();
  // PASS A — strong evidence (shared surname). Runs for every casualty first, so a weak guess
  // can never consume an orphan that a name match would have claimed.
  for (const s of zeroedNow) {
    const cand = pairOrphan(s, orphans.filter((o) => !takenOrphans.has(o.name)));
    if (cand) {
      pairedTo.set(s.pid, cand);
      takenOrphans.add(cand);
    }
  }
  // PASS B — weak fallback, only when genuinely unambiguous: ONE leftover orphan and EXACTLY ONE
  // unexplained casualty on that team. Two casualties and one orphan is a coin flip, and naming
  // the wrong player is worse than saying nothing (the sheet's own marker will settle it).
  for (const o of orphans.filter((x) => !takenOrphans.has(x.name))) {
    const cands = zeroedNow.filter(
      (s) => !pairedTo.has(s.pid) && (!o.team || !s.team || o.team === s.team)
    );
    if (cands.length === 1) {
      pairedTo.set(cands[0].pid, o.name);
      takenOrphans.add(o.name);
    }
  }

  const players: PlayerAudit[] = [];
  for (const s of settledRows) {
    if (!s.pid) continue;
    const live = liveByPid.get(s.pid);
    const now = live ? live.points : null;
    const orphanCandidate = pairedTo.get(s.pid) ?? null;
    const reason = reasonFor(s.points, now, s.provenance, live, !!orphanCandidate);
    const marker = live?.recon ?? "";
    players.push({
      group: groupFor(reason, marker, (now ?? 0) - (s.points ?? 0)),
      marker,
      pid: s.pid,
      name: s.name || live?.name || s.pid,
      team: s.team || live?.team || "",
      settled: s.points,
      now,
      delta: (now ?? 0) - (s.points ?? 0),
      reason,
      orphanCandidate: reason === "IDENTITY_BREAK" ? orphanCandidate : null,
      provenance: s.provenance,
      l2: live?.l2 ?? "",
    });
  }

  // Players scoring NOW who had no baseline row at all (added to the squad after settlement).
  for (const r of liveRows) {
    if (!r.pid || (r.points ?? 0) === 0) continue;
    if (settledRows.some((s) => s.pid === r.pid)) continue;
    players.push({
      pid: r.pid, name: r.name, team: r.team, settled: null, now: r.points,
      delta: r.points ?? 0, reason: "NO_BASELINE", orphanCandidate: null,
      provenance: null, l2: r.l2, group: "NO_BASELINE", marker: r.recon,
    });
  }

  players.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const pending = players.filter((p) => p.group === "PENDING");
  const changedRows = players.filter((p) => p.group === "CHANGED");
  return {
    matchKey: match.key,
    label: match.label,
    tour: settledRows[0]?.tour ?? "",
    // "changed" now means the RESULT moved (L2 done) — a pending revision has not moved anything
    // yet, so it must not make a settled match look mis-settled.
    changed: changedRows.length > 0,
    noBaseline: settledRows.length === 0 || settledRows.every((s) => s.provenance === "unknown"),
    players,
    pending,
    changedRows,
    orphans: orphans.map((o) => ({ name: o.name, points: o.points ?? 0 })),
    duplicates,
    pendingAbsDelta: pending.reduce((a, p) => a + Math.abs(p.delta), 0),
    totalAbsDelta: changedRows.reduce((a, p) => a + Math.abs(p.delta), 0),
  };
}

export type ContestAudit = {
  /** per-user settled vs current XI total, using the SAME scorer for both sides. */
  totals: { user: string; settled: number | null; now: number | null; delta: number }[];
  /** did the winner change? the question that actually matters for money. */
  winnerChanged: boolean;
  settledWinners: string[];
  currentWinners: string[];
};

function winnersOf(totals: { user: string; pts: number | null }[]): string[] {
  const scored = totals.filter((t) => t.pts !== null) as { user: string; pts: number }[];
  if (scored.length === 0) return [];
  const max = Math.max(...scored.map((t) => t.pts));
  return scored.filter((t) => t.pts === max).map((t) => t.user);
}

/**
 * Contest-level audit. `score` is injected (rather than imported) so this stays free of the
 * selection/DB types and can be unit-tested — and so BOTH sides are computed by the caller's
 * one scorer. Feeding "then" and "now" through different code is exactly how the lobby and
 * results totals diverged once before.
 */
export function auditContest(
  users: string[],
  score: (user: string, pts: Map<string, number>) => number | null,
  settledPts: Map<string, number>,
  nowPts: Map<string, number>
): ContestAudit {
  const totals = users.map((user) => {
    const settled = score(user, settledPts);
    const now = score(user, nowPts);
    return { user, settled, now, delta: (now ?? 0) - (settled ?? 0) };
  });
  const settledWinners = winnersOf(totals.map((t) => ({ user: t.user, pts: t.settled })));
  const currentWinners = winnersOf(totals.map((t) => ({ user: t.user, pts: t.now })));
  const winnerChanged =
    settledWinners.length > 0 &&
    currentWinners.length > 0 &&
    (settledWinners.length !== currentWinners.length ||
      settledWinners.some((w) => !currentWinners.includes(w)));
  return { totals, winnerChanged, settledWinners, currentWinners };
}

/** Convenience for a match page / lobby badge: the settled + current points maps together. */
export async function bothPointMaps(
  match: MatchLike
): Promise<{ settled: Map<string, number>; now: Map<string, number> }> {
  const [settled, now] = await Promise.all([
    getSettledPointsForMatch(match),
    getMatchPointsForMatch(match),
  ]);
  return { settled, now };
}
