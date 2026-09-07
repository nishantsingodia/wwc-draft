import { payoutCopy, type Multiplier, type Payout } from "@/lib/payout";

/**
 * The winnings-multiplier badges, shared by the lobby's Completed cards and the results page so
 * the two can never label the same result differently.
 *
 * ONE colour family on purpose. 2× is a filled gold chip, 1.5× the same chip outlined — same
 * currency, lesser amount — rather than a second accent hue, which would be the only colour in
 * the app outside gold / green / red and would read as a different KIND of thing.
 */

/** `2×` / `1.5×`. `provisional` dashes it: recon is still open, so the result can still move. */
export function PayoutChip({
  multiplier,
  provisional,
  size = "sm",
}: {
  multiplier: Multiplier;
  provisional?: boolean;
  size?: "sm" | "lg";
}) {
  if (multiplier === 1) return null;
  const dims = size === "lg" ? "text-sm px-2.5 py-1 rounded-md" : "text-[10px] px-1.5 py-0.5 rounded";
  const skin =
    multiplier === 2
      ? provisional
        ? "border border-dashed border-gold/70 bg-gold/15 text-gold"
        : "bg-gold text-ink"
      : provisional
        ? "border border-dashed border-gold/70 text-gold"
        : "border border-gold/55 text-gold";
  return (
    <span
      className={`inline-flex items-center font-extrabold shrink-0 ${dims} ${skin}`}
      title={
        provisional
          ? "Reconciliation is still open on this match — the points behind this can still move."
          : undefined
      }
    >
      {multiplier}×
    </span>
  );
}

/**
 * The full callout, under the verdict: what was won and the ratio it turned on. Quoting the
 * ratio matters — the rule is strictly-greater, so the number is the only thing that explains
 * why a close result did or didn't qualify.
 */
export function PayoutStrip({
  payout,
  viewer,
  provisional,
  size = "sm",
}: {
  payout: Payout;
  viewer: string;
  provisional?: boolean;
  size?: "sm" | "lg";
}) {
  const copy = payoutCopy(payout, viewer);
  if (!copy) return null;
  const lg = size === "lg";
  return (
    <div
      className={`flex items-center gap-2 rounded-xl border ${
        provisional ? "border-dashed" : ""
      } border-gold/30 ${payout.multiplier === 2 ? "bg-gold/10" : "bg-gold/[0.06]"} ${
        lg ? "px-3 py-2.5 gap-2.5" : "px-2.5 py-2"
      }`}
    >
      <PayoutChip multiplier={payout.multiplier} provisional={provisional} size={size} />
      <div className="min-w-0 flex-1">
        <p className={`font-bold text-gold ${lg ? "text-xs" : "text-[11px]"}`}>{copy.title}</p>
        <p className={`text-mist ${lg ? "text-[11px]" : "text-[10px]"}`}>
          {copy.detail}
          {provisional && <span className="text-mist2"> · provisional</span>}
        </p>
      </div>
    </div>
  );
}

/**
 * "1st pick" / "2nd pick". Deliberately the same chip as the Live/Manual badge beside it —
 * this is context for the underdog rule, not a prize, so it must not compete with the gold.
 *
 * Renders nothing when there was no real toss (manual drafts — see `firstPickOf`).
 */
export function PickChip({ first, compact }: { first: boolean; compact?: boolean }) {
  const label = compact ? (first ? "1st" : "2nd") : first ? "1st pick" : "2nd pick";
  if (!first) {
    return (
      <span className="text-[9px] font-bold uppercase tracking-wide text-mist2 shrink-0">
        {label}
      </span>
    );
  }
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide bg-navy2 text-mist shrink-0">
      {label}
    </span>
  );
}
