"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

// Match-level "Refresh now" for a LIVE match. Points are scored IN-APP from the ESPN
// scorecard (the same provisional scoring the results page uses via lib/d11-score +
// getLiveMatchPoints) — so a tap costs ZERO cricapi budget and triggers NO bot run. It
// simply re-renders the server component (router.refresh()), which re-pulls a fresh ESPN
// scorecard for every contest on this match. useTransition keeps the spinner up until the
// refreshed server render commits. Shown only while the match is in progress.
export default function MatchRefresh({ matchStarted }: { matchStarted: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (!matchStarted) return null;

  return (
    <div className="space-y-1">
      <button
        onClick={() => startTransition(() => router.refresh())}
        disabled={pending}
        className={`w-full flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-bold transition border ${
          pending
            ? "bg-navy border-hair2 text-mist cursor-not-allowed"
            : "bg-navy border-gold/50 text-gold hover:brightness-110"
        }`}
      >
        {pending && (
          <span className="h-3.5 w-3.5 rounded-full border-2 border-mist/30 border-t-cloud animate-spin" />
        )}
        {pending ? "Refreshing…" : "🔄 Refresh now"}
      </button>
      <p className="px-1 text-[11px] text-mist2">Live points · provisional (via ESPN)</p>
    </div>
  );
}
