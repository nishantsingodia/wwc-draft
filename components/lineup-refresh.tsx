"use client";

import { useCallback, useEffect, useState } from "react";

// Compact "refresh the lineup" chip that sits under the lock header on the team
// and draft-board pages. Official-XI status (`announced`) is owned by the parent
// (it comes back on /api/draft/[code] and flows in as a prop); this component adds
// (1) a MANUAL refresh the user can tap any time, and (2) ONE automatic check that
// fires at roundlock (match start + 15 min), then up to two more ~15 min apart if
// the XI still isn't posted. After 3 misses it stops polling and surfaces an
// explicit "couldn't confirm" state so the miss is never silent.
//
// `onRefresh` should re-fetch the page data (e.g. the page's fetchData); the
// parent re-render flips `announced`, which this component reads to resolve state.

const RETRY_GAP = 15 * 60; // seconds between auto-checks
const MAX_AUTO = 4; // total auto-checks: first at roundlock, then ~15m apart

function fmtClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtCountdown(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function LineupRefresh({
  announced,
  roundlockTs,
  onRefresh,
}: {
  announced: boolean;
  roundlockTs: number; // epoch seconds — match start + 15 min lock buffer
  onRefresh: () => Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  const [autoAttempts, setAutoAttempts] = useState(0);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  // When the next auto-check fires. First one is anchored to roundlock; each
  // subsequent one is set to "15 min from the last actual fire" so opening the
  // page long after roundlock does ONE catch-up check, not MAX_AUTO instant ones.
  const [nextCheckAt, setNextCheckAt] = useState(roundlockTs);

  // 1s tick so the "retry in m:ss" / "auto at" copy stays live.
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const runRefresh = useCallback(async () => {
    setChecking(true);
    try {
      await onRefresh();
      setLastChecked(Math.floor(Date.now() / 1000));
    } finally {
      setChecking(false);
    }
  }, [onRefresh]);

  // Auto-check scheduler: fire at `nextCheckAt`, then re-arm for 15 min after the
  // actual fire. Stops once lineups are announced, once we've exhausted MAX_AUTO,
  // or with no known lock time. Wall-clock-anchored so a late page open does one
  // catch-up check rather than burning every overdue attempt instantly.
  useEffect(() => {
    if (announced || !roundlockTs || autoAttempts >= MAX_AUTO) return;
    const delayMs = Math.max(0, (nextCheckAt - Math.floor(Date.now() / 1000)) * 1000);
    const t = setTimeout(async () => {
      await runRefresh();
      setAutoAttempts((a) => a + 1);
      setNextCheckAt(Math.floor(Date.now() / 1000) + RETRY_GAP);
    }, delayMs);
    return () => clearTimeout(t);
  }, [announced, roundlockTs, autoAttempts, nextCheckAt, runRefresh]);

  // ── resolve display state ──
  const pastLock = roundlockTs > 0 && now >= roundlockTs;
  let phase: "idle" | "checking" | "waiting" | "found" | "failed";
  if (announced) phase = "found";
  else if (checking) phase = "checking";
  else if (autoAttempts >= MAX_AUTO) phase = "failed";
  else if (pastLock) phase = "waiting";
  else phase = "idle";

  const base =
    "w-full flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-bold transition border";

  if (phase === "checking") {
    return (
      <button disabled className={`${base} bg-navy border-hair2 text-mist`}>
        <span className="h-3.5 w-3.5 rounded-full border-2 border-mist/30 border-t-cloud animate-spin" />
        Checking lineups…
      </button>
    );
  }

  if (phase === "found") {
    return (
      <button
        onClick={runRefresh}
        className={`${base} bg-emerald-950 border-emerald-500/60 text-emerald-300 hover:brightness-110`}
      >
        🟢 Lineups out · re-check{lastChecked ? ` · ${fmtClock(lastChecked)}` : ""}
      </button>
    );
  }

  if (phase === "failed") {
    return (
      <button
        onClick={runRefresh}
        className={`${base} bg-amber-950 border-amber-500/60 text-amber-300 hover:brightness-110`}
      >
        ⚠ Lineups not confirmed after {MAX_AUTO} checks · retry
      </button>
    );
  }

  if (phase === "waiting") {
    const remaining = nextCheckAt - now;
    const retryLabel =
      remaining > 0
        ? `retry in ${fmtCountdown(remaining)} (${autoAttempts + 1}/${MAX_AUTO})`
        : "checking again…";
    return (
      <button
        onClick={runRefresh}
        className={`${base} bg-navy border-amber-500/40 text-amber-300 hover:brightness-110`}
      >
        <span className="tabular-nums">↻ XI not out · {retryLabel}</span>
      </button>
    );
  }

  // idle — before roundlock
  return (
    <button
      onClick={runRefresh}
      className={`${base} bg-navy border-hair2 text-cloud hover:border-gold/50`}
    >
      ↻ Check for lineups{roundlockTs > 0 ? ` · auto at ${fmtClock(roundlockTs)}` : ""}
    </button>
  );
}
