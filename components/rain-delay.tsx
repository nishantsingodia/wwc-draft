"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Manual rain/delay control shown on the match hub. Any friend can push the match start
// (and thus team-lock / "Live" / scoring) back 30 min at a time when a game is delayed,
// or reset it. Writes to /api/match/[key]/delay and refreshes so every deadline-driven
// gate re-reads the new time.
export default function RainDelay({
  matchKey,
  initialExtraMinutes,
  scheduledStart,
}: {
  matchKey: string;
  initialExtraMinutes: number;
  scheduledStart: string;
}) {
  const router = useRouter();
  const [mins, setMins] = useState(initialExtraMinutes);
  const [busy, setBusy] = useState(false);

  async function send(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/match/${matchKey}/delay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setMins(data.extraMinutes ?? 0);
        router.refresh(); // re-pull every deadline-gated surface with the new time
      }
    } finally {
      setBusy(false);
    }
  }

  const delayed = mins > 0;
  const label =
    mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;

  return (
    <div
      className={`rounded-xl px-4 py-3 border ${
        delayed ? "bg-amber-950/40 border-amber-500/50" : "bg-ink2 border-hair2"
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-lg leading-none">🌧️</span>
        <div className="flex-1 min-w-0">
          {delayed ? (
            <>
              <p className="text-sm font-semibold text-amber-200">
                Start pushed back <span className="tabular-nums">+{label}</span>
              </p>
              <p className="text-xs text-mist2">
                Scheduled {scheduledStart} · teams stay editable until the new start
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-cloud">Match delayed by rain?</p>
              <p className="text-xs text-mist2">
                Push the start back so teams don&apos;t lock early. Scheduled {scheduledStart}.
              </p>
            </>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={() => send({ addMinutes: 30 })}
          disabled={busy}
          className="h-9 px-3 rounded-lg bg-amber-500 hover:brightness-110 text-black font-bold text-sm disabled:opacity-40 transition"
        >
          {busy ? "…" : "+30 min"}
        </button>
        {delayed && (
          <button
            onClick={() => send({ reset: true })}
            disabled={busy}
            className="h-9 px-3 rounded-lg bg-navy2 hover:bg-navy text-cloud font-semibold text-sm disabled:opacity-40 transition"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
