import { LIVE_GAP_NOTE } from "@/lib/live-label";

// The provisional-scoring caveat, collapsed to one tappable line. The full wording (see
// lib/live-label.ts) is honest but ~9 lines on a phone — it buried the live header.
export default function LiveGapNote({ className = "" }: { className?: string }) {
  return (
    <details className={`text-[11px] leading-snug text-mist2 ${className}`}>
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden underline decoration-dotted underline-offset-2 w-fit">
        Could these points still change? ⓘ
      </summary>
      <p className="mt-1">{LIVE_GAP_NOTE}</p>
    </details>
  );
}
