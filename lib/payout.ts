// Winnings multipliers on a finished contest.
//
// Two house rules, both decided on the FINAL points the rest of the app already shows:
//   • beat your opponent by more than 2×            -> 2× winnings, for anyone
//   • beat them by more than 1.6× having picked SECOND -> 1.5× winnings (the underdog bonus)
// They do NOT compound. A second-picker on 2.4× satisfies both and takes the higher single
// multiplier — 2×, never 3×.
//
// Pure on purpose (no DB, no sheet, no fetch): the lobby's Completed cards and the results
// page both import this, so the badge on the card and the badge on the results page can never
// disagree about who was eligible. Same reason `calcSelectionPoints` lives in one file.
//
// This is an ELIGIBILITY label, not money. The app has no stake/purse concept and this
// deliberately doesn't invent one — it says who qualified and on what ratio.

import { getUserLabel } from "@/lib/users";

export type Multiplier = 1 | 1.5 | 2;

export type Payout = {
  /** Who picked first, or null when there was no real toss (see `firstPickOf`). */
  firstPick: string | null;
  /** Top scorer, and the best of everyone else. Null when fewer than two sides are scored. */
  winner: string | null;
  runnerUp: string | null;
  winnerPts: number | null;
  runnerUpPts: number | null;
  /** winner ÷ runnerUp. `Infinity` when the runner-up is on zero or less. Null when unscored. */
  ratio: number | null;
  multiplier: Multiplier;
  /** "Double winnings" / "Underdog bonus" — null at 1×. */
  title: string | null;
  /** Whether the eligible player is the second picker (drives the underdog wording). */
  fromSecondPick: boolean;
};

/** Beat them by more than THIS and the winnings double. Strictly greater. */
export const DOUBLE_AT = 2;
/** Beat them by more than THIS, having picked second, and the winnings go 1.5×. */
export const UNDERDOG_AT = 1.6;

const NONE: Payout = {
  firstPick: null,
  winner: null,
  runnerUp: null,
  winnerPts: null,
  runnerUpPts: null,
  ratio: null,
  multiplier: 1,
  title: null,
  fromSecondPick: false,
};

/**
 * Who picked first in this contest — the toss winner, `draftOrder[0]`.
 *
 * MANUAL contests have no toss. `draft_order` is filled by a shuffle of whoever is *seated*
 * when the draft starts, and in manual mode that is the creator alone: every manual row in
 * prod reads `["nishant"]`. Reporting that as "picked first" would invent a coin toss that
 * never happened, so manual (and any order with fewer than two names) returns null — no
 * first-pick chip anywhere, and the underdog bonus can never fire.
 */
export function firstPickOf(contest: {
  mode: "live" | "manual";
  draftOrder: string | string[] | null;
}): string | null {
  if (contest.mode !== "live") return null;
  let order: unknown = contest.draftOrder;
  if (typeof order === "string") {
    try {
      order = JSON.parse(order);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(order) || order.length < 2) return null;
  const first = order[0];
  return typeof first === "string" && first ? first : null;
}

/**
 * The multiplier a finished contest earned. `totals` is one entry per drafter, carrying the
 * SAME number the card renders (null = no XI / no points, and simply doesn't compete).
 *
 * With 3+ drafters "your opponent" is the runner-up — the same head-to-head the lobby card and
 * the results hero already draw. Today every contest is 2-player, so this is theory.
 */
export function computePayout(input: {
  mode: "live" | "manual";
  draftOrder: string | string[] | null;
  totals: { user: string; pts: number | null }[];
}): Payout {
  const firstPick = firstPickOf(input);
  const scored = input.totals
    .filter((t): t is { user: string; pts: number } => t.pts !== null)
    .sort((a, b) => b.pts - a.pts);

  if (scored.length < 2) return { ...NONE, firstPick };

  const [win, run] = scored;
  // A tie pays nothing, and neither does a "win" by a hair — both fall out of the thresholds
  // below anyway, but bail early so `ratio` is never a meaningless 1.0-ish number on a draw.
  if (win.pts <= run.pts) {
    return { ...NONE, firstPick, winner: null, runnerUp: null };
  }

  // Runner-up on zero (or negative) makes the ratio infinite rather than undefined: you cannot
  // beat them by less than 2× when they scored nothing. Callers render this as "scored 0", not
  // as a number.
  const ratio = run.pts > 0 ? win.pts / run.pts : Infinity;
  const fromSecondPick = firstPick !== null && win.user !== firstPick;

  // max(), never a product — the two rules are alternatives. An underdog above 2× takes 2×.
  const multiplier: Multiplier =
    ratio > DOUBLE_AT ? 2 : fromSecondPick && ratio > UNDERDOG_AT ? 1.5 : 1;

  return {
    firstPick,
    winner: win.user,
    runnerUp: run.user,
    winnerPts: win.pts,
    runnerUpPts: run.pts,
    ratio,
    multiplier,
    title: multiplier === 2 ? "Double winnings" : multiplier === 1.5 ? "Underdog bonus" : null,
    fromSecondPick,
  };
}

/**
 * The ratio as it should read on screen.
 *
 * Two decimals normally, THREE when rounding would park it exactly on a threshold it did not
 * actually clear — a card showing "2.00×" with no badge beside it looks like a bug, and this is
 * the cheapest way to make the strictly-greater rule visible instead of mysterious.
 */
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "∞";
  const two = ratio.toFixed(2);
  const parked = Number(two) === DOUBLE_AT || Number(two) === UNDERDOG_AT;
  return (parked && Number(two) !== ratio ? ratio.toFixed(3) : two) + "×";
}

/**
 * The two lines the payout strip renders, from the VIEWER's side of the table. Shared by the
 * lobby card and the results hero so the wording can't drift between them.
 *
 * It states the fact rather than congratulating: when the opponent is the eligible one, it says
 * so plainly, because you need to know what the game paid out either way.
 */
export function payoutCopy(
  p: Payout,
  viewer: string
): { title: string; detail: string } | null {
  if (p.multiplier === 1 || !p.winner || !p.runnerUp || p.ratio === null) return null;
  const mine = p.winner === viewer;
  const them = getUserLabel(p.winner);
  const loser = mine ? getUserLabel(p.runnerUp) : "you";
  const who = mine ? "You" : them;
  const title = mine ? p.title! : `${p.title} — ${them}`;

  // A runner-up on zero has no meaningful ratio to quote — say what actually happened.
  const margin = Number.isFinite(p.ratio)
    ? `scored ${formatRatio(p.ratio)} ${loser}`
    : `won it with ${loser === "you" ? "you" : loser} on ${(p.runnerUpPts ?? 0).toFixed(0)}`;

  return {
    title,
    detail: p.fromSecondPick ? `${who} picked 2nd and ${margin}` : `${who} ${margin}`,
  };
}
