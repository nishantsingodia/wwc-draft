/**
 * Settlement-audit reason codes — the CLIENT-SAFE half of the audit.
 *
 * Kept separate from `lib/settlement-audit.ts` on purpose: that module reaches into
 * `lib/points.ts`, which reads the filesystem (`readFileSync`) and must never be pulled into a
 * browser bundle. The results page is a client component and needs these labels to render, so
 * anything a client touches lives here — pure data, zero imports.
 */
export type AuditReason =
  /** Points cannot reach a contest: the squad row dropped to 0 while an unjoinable
   *  official-card row (blank Player ID) carries the score. A registry alias fixes it. */
  | "IDENTITY_BREAK"
  /** cricsheet genuinely revised a stat; awaiting approval in the bot's Recon Review tab. */
  | "FIELD_REVISION"
  /** Points moved but reconciliation reads clean — so the change came from OUR side (a scorer
   *  fix, an ESPN backfill, a registry change), not from the official card. */
  | "SCORER_FIX"
  /** Scored 0 at settlement, has points now (e.g. a bowler the balls-gate bug had zeroed). */
  | "NEW_POINTS"
  /** The player genuinely wasn't in the official XI — a correct 0, not a break. */
  | "NOT_IN_OFFICIAL_XI"
  /** No trustworthy baseline exists (match completed before the baseline did), so a zero
   *  delta here proves nothing. Never render this as "unchanged". */
  | "NO_BASELINE"
  | "UNCHANGED";

export const REASON_LABEL: Record<AuditReason, string> = {
  IDENTITY_BREAK: "Identity unresolved on official card",
  FIELD_REVISION: "Official revision (pending approval)",
  SCORER_FIX: "Changed by our scoring, not cricsheet",
  NEW_POINTS: "Newly scored (was 0)",
  NOT_IN_OFFICIAL_XI: "Not in official XI",
  NO_BASELINE: "No settled baseline recorded",
  UNCHANGED: "Unchanged",
};

/** Reasons that mean a settled result is materially in doubt (drives every ⚠ badge). */
export const SUSPECT_REASONS: AuditReason[] = [
  "IDENTITY_BREAK",
  "FIELD_REVISION",
  "SCORER_FIX",
  "NEW_POINTS",
];
