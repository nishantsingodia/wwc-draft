import Link from "next/link";
import { REASON_LABEL, type AuditReason } from "@/lib/audit-reasons";

/**
 * "This settled result moved" badge. Deliberately loud and always carries a NUMBER — a bare
 * warning icon gets ignored, "−228 pts" does not. Used on the lobby's Completed tab (so a
 * changed match is visible without opening anything) and on the results page.
 */
export function SettlementBadge({
  delta,
  href,
  noBaseline,
  compact,
  pendingCount = 0,
}: {
  /** Signed points movement for the viewer's own XI — APPLIED movement only. */
  delta: number;
  href?: string;
  /** No trustworthy baseline exists — say so rather than implying "verified unchanged". */
  noBaseline?: boolean;
  compact?: boolean;
  /** Players whose L2 recon is still open. Distinct from `delta`: while a revision is unapproved
   *  the bot HOLDS the settled value, so nothing has moved — it's a to-do, not a mis-settlement.
   *  Shown in gold ("recon open") vs red ("revised") so the two are never confused at a glance. */
  pendingCount?: number;
}) {
  if (noBaseline) {
    const body = (
      <span
        className={`inline-flex items-center gap-1 rounded border border-mist2/40 bg-navy2 text-mist2 font-semibold ${
          compact ? "text-[9px] px-1.5 py-0.5" : "text-[10px] px-2 py-1"
        }`}
        title="This match completed before the settlement baseline existed, so we cannot prove nothing changed."
      >
        ? no settled baseline
      </span>
    );
    return href ? <Link href={href}>{body}</Link> : body;
  }
  // Applied movement outranks a pending one: if the number has ALREADY changed, say that first.
  if (delta === 0) {
    if (pendingCount > 0) {
      const p = (
        <span
          className={`inline-flex items-center gap-1 rounded border border-gold/50 bg-gold/15 text-gold font-bold ${
            compact ? "text-[9px] px-1.5 py-0.5" : "text-[10px] px-2 py-1"
          }`}
          title="Reconciliation is still open for this match. The settled value is what you see — it only moves once you approve the revision (or fix the identity)."
        >
          ⏳ recon open ({pendingCount})
        </span>
      );
      return href ? <Link href={href}>{p}</Link> : p;
    }
    return null;
  }
  const down = delta < 0;
  const body = (
    <span
      className={`inline-flex items-center gap-1 rounded font-bold border ${
        down
          ? "border-destructive/50 bg-destructive/15 text-destructive"
          : "border-grn/50 bg-grn/15 text-grn"
      } ${compact ? "text-[9px] px-1.5 py-0.5" : "text-[10px] px-2 py-1"}`}
      title="Your XI total has changed since this match was settled. Tap to see which players moved and why."
    >
      ⚠ revised {down ? "−" : "+"}
      {Math.abs(Math.round(delta * 10) / 10)} pts
    </span>
  );
  return href ? (
    <Link href={href} className="hover:opacity-80 transition-opacity">
      {body}
    </Link>
  ) : (
    body
  );
}

const REASON_STYLE: Record<AuditReason, string> = {
  IDENTITY_BREAK: "border-destructive/50 bg-destructive/15 text-destructive",
  FIELD_REVISION: "border-gold/50 bg-gold/15 text-gold",
  SCORER_FIX: "border-accent/50 bg-accent/15 text-accent",
  NEW_POINTS: "border-grn/50 bg-grn/15 text-grn",
  NOT_IN_OFFICIAL_XI: "border-hair2 bg-navy2 text-mist2",
  NO_BASELINE: "border-mist2/40 bg-navy2 text-mist2",
  UNCHANGED: "border-hair2 bg-navy2 text-mist2",
};

export function ReasonChip({ reason }: { reason: AuditReason }) {
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${REASON_STYLE[reason]}`}
    >
      {REASON_LABEL[reason]}
    </span>
  );
}
