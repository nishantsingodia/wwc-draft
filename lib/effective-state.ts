// Single source of truth for "where does this draft go, and what is its state right
// now" — merging the runtime MATCH state (upcoming / live / completed, derived from
// the schedule + points sheet) with the DB draft STATUS.
//
// Why this exists: the match page's row label used to come from the raw contest
// status (`TEAM_SELECT → "Select your team"`) while its arrow came from match state,
// so a LIVE match could still say "Select your team". And the bare `/draft/[code]`
// redirect branched only on `contest.status`, which never advances past TEAM_SELECT
// once a match is live — stranding live users on the locked team editor. Route the
// match hub, the results/lobby links, and the draft-board redirect through this one
// function so label + CTA + destination can never disagree again.
//
// This module is pure (no DB / sheet / fetch) so both server components and the
// client draft board can import it.

export type DraftPhase =
  | "waiting" // pre-draft: awaiting players / coin toss
  | "drafting" // snake draft in progress
  | "team_select" // draft done (or manual) — build / lock the XI
  | "live" // match started, team locked — watch scores
  | "completed"; // match over — final result

export interface EffectiveState {
  phase: DraftPhase;
  /** Where a tap — or the bare /draft/[code] URL — should land. */
  href: string;
  /** Human status for this draft, right now. */
  label: string;
  labelColor: string;
  /** Trailing action text. */
  cta: string;
  ctaColor: string;
}

export function getEffectiveState(input: {
  code: string;
  status: string; // contest.status (DB)
  mode: "live" | "manual";
  started: boolean; // match past lock buffer (deadline + LOCK_BUFFER)
  isCompleted: boolean; // points sheet says the match is done
}): EffectiveState {
  const { code, status, mode, started, isCompleted } = input;
  const results = `/draft/${code}/results`;
  const team = `/draft/${code}/team`;
  const board = `/draft/${code}`;

  // Match state wins over draft status. A started or finished match is NEVER an
  // invitation to pick a team — the team is locked; you watch the score.
  if (isCompleted || status === "COMPLETED") {
    return {
      phase: "completed",
      href: results,
      label: "Final",
      labelColor: "text-emerald-400",
      cta: "Results →",
      ctaColor: "text-emerald-400",
    };
  }
  if (started) {
    return {
      phase: "live",
      href: results,
      label: "Match in progress",
      labelColor: "text-red-400",
      cta: "Scores →",
      ctaColor: "text-red-400",
    };
  }

  // Manual mode has no snake-draft board — team entry is always the destination
  // pre-start (preserves the old `mode === "manual" → /team` redirect).
  if (mode === "manual") {
    if (status === "LOCKED")
      return {
        phase: "team_select",
        href: team,
        label: "Team locked",
        labelColor: "text-mist",
        cta: "View team →",
        ctaColor: "text-mist",
      };
    if (status === "WAITING")
      return {
        phase: "waiting",
        href: team,
        label: "Waiting for opponent",
        labelColor: "text-yellow-400",
        cta: "Set team →",
        ctaColor: "text-emerald-400",
      };
    return {
      phase: "team_select",
      href: team,
      label: "Enter your team",
      labelColor: "text-emerald-400",
      cta: "Set team →",
      ctaColor: "text-emerald-400",
    };
  }

  // Live mode, pre-start: the draft's own lifecycle drives it.
  switch (status) {
    case "WAITING":
      return {
        phase: "waiting",
        href: board,
        label: mode === "live" ? "Waiting for players" : "Waiting…",
        labelColor: "text-yellow-400",
        cta: "Open →",
        ctaColor: "text-mist",
      };
    case "DRAFTING":
      return {
        phase: "drafting",
        href: board,
        label: "Draft in progress",
        labelColor: "text-blue-400",
        cta: "Continue →",
        ctaColor: "text-blue-400",
      };
    case "TEAM_SELECT":
      return {
        phase: "team_select",
        href: team,
        label: "Select your team",
        labelColor: "text-emerald-400",
        cta: "Set team →",
        ctaColor: "text-emerald-400",
      };
    case "LOCKED":
      return {
        phase: "team_select",
        href: team,
        label: "Team locked",
        labelColor: "text-mist",
        cta: "View team →",
        ctaColor: "text-mist",
      };
    default:
      return {
        phase: "waiting",
        href: board,
        label: status,
        labelColor: "text-mist",
        cta: "Open →",
        ctaColor: "text-mist",
      };
  }
}
