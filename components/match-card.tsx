"use client";

import { useState, type ReactNode } from "react";

/**
 * One match on the lobby — the dashboard card that replaced the old `/match/[key]` hub.
 *
 * This is a CLIENT SHELL only. It owns exactly two pieces of state — is the card expanded,
 * and is the actions sheet open — and renders server-rendered JSX for everything else. That
 * split matters: the score, the head-to-head totals and the draft rows are all computed on
 * the server (by the same `calcSelectionPoints` the results page settles with), so nothing
 * here can quietly become a second source of a number.
 *
 * Collapsed, a card is one line: who's playing, the state, and your own total. Expanded, it
 * is the whole match — scoreline, head-to-head, every draft on it, and the match-level
 * actions that used to justify a separate page.
 */
export default function MatchCard({
  header,
  collapsedRight,
  children,
  actions,
  defaultOpen = false,
  tone = "live",
  accent,
}: {
  /** Crests + title + status line. Always visible, and the tap target for expanding. */
  header: ReactNode;
  /** The one number worth seeing without expanding (your total, or the verdict). */
  collapsedRight?: ReactNode;
  /** Scoreline, H2H, draft rows — rendered only when open. */
  children: ReactNode;
  /** Match-level actions behind "···" (rain delay, create/join, scorecard). */
  actions?: ReactNode;
  defaultOpen?: boolean;
  tone?: "live" | "completed";
  /**
   * Lifts the card's edge to gold so a result worth finding is visible while scrolling past a
   * season of them, without opening anything. "strong" adds the glow; "soft" is edge only.
   * Overrides `tone`'s border — the ONE thing allowed to, and only ever for money.
   */
  accent?: "strong" | "soft";
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [sheet, setSheet] = useState(false);

  const edge =
    accent === "strong"
      ? "border-gold/40 glow-gold"
      : accent === "soft"
        ? "border-gold/25"
        : "border-hair";

  return (
    <div
      className={`rounded-2xl border overflow-hidden ${edge} ${
        tone === "live" ? "bg-gradient-to-b from-navy to-ink2" : "bg-ink2"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
        >
          {header}
        </button>
        {!open && collapsedRight}
        {actions && (
          <button
            type="button"
            onClick={() => setSheet((v) => !v)}
            aria-label="Match actions"
            aria-expanded={sheet}
            className={`shrink-0 h-7 w-7 grid place-items-center rounded-lg text-sm transition-colors ${
              sheet ? "bg-gold text-ink" : "text-mist2 hover:text-cloud hover:bg-navy2"
            }`}
          >
            ···
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse match" : "Expand match"}
          className="shrink-0 text-mist2 text-sm w-4"
        >
          {open ? "⌃" : "⌄"}
        </button>
      </div>

      {sheet && actions && (
        <div className="border-t border-hair px-3 py-2.5 bg-ink/40 space-y-2">{actions}</div>
      )}

      {open && children}
    </div>
  );
}
