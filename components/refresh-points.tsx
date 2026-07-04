"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// "Refresh live points" — a human-triggered pull of the latest scores during a live match.
// Tapping it dispatches the wwc-points-bot's on-demand workflow (via /api/points/refresh),
// which recomputes points into the sheet in ~1–2 min; the parent's results poll then shows
// them. A cricapi "hits left today" gauge sits under the button as the anti-abuse guardrail
// (the server also enforces a cooldown + quota floor). Hidden until the match has started,
// and hidden entirely if live-refresh isn't configured (no PAT on the server).

type Quota = {
  hitsLeft: number | null;
  hitsLimit: number | null;
  hitsUsed: number | null;
  updatedUtc: string | null;
};
type Status = {
  configured: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastRunUrl: string | null;
  conclusion: string | null;
  cooldownRemaining: number;
  quota: Quota | null;
};

const WAIT_TIMEOUT_MS = 180_000; // stop spinning after 3 min even if we never see it finish

function fmtUpdated(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function RefreshPoints({
  matchStarted,
  onRefreshed,
}: {
  matchStarted: boolean;
  onRefreshed: () => void | Promise<void>;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [waiting, setWaiting] = useState(false); // a refresh we triggered is in flight
  const [busy, setBusy] = useState(false); // POST request itself in flight
  const [cooldown, setCooldown] = useState(0); // local ticking copy of cooldownRemaining
  const [msg, setMsg] = useState("");

  const dispatchedAt = useRef<number | null>(null); // client ms when we last dispatched
  const wasRunning = useRef(false); // last observed server "running" (for external runs)
  const waitingRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/points/refresh", { cache: "no-store" });
      if (!res.ok) return;
      const s: Status = await res.json();
      setStatus(s);
      setCooldown(s.cooldownRemaining ?? 0);

      // A run we dispatched: "ours" once GitHub creates it (lastRunAt at/after dispatch,
      // small skew tolerance) and finished once it's no longer running.
      const ourFinished =
        dispatchedAt.current != null &&
        s.lastRunAt != null &&
        s.lastRunAt * 1000 >= dispatchedAt.current - 5000 &&
        !s.running;
      const timedOut =
        dispatchedAt.current != null && Date.now() > dispatchedAt.current + WAIT_TIMEOUT_MS;

      if (waitingRef.current && (ourFinished || timedOut)) {
        waitingRef.current = false;
        setWaiting(false);
        dispatchedAt.current = null;
        await onRefreshed();
        setMsg(ourFinished ? "" : "Taking longer than usual — points will appear shortly.");
      } else if (!waitingRef.current && wasRunning.current && !s.running) {
        // Someone else's refresh (or the cron) just finished — pull the fresh points too.
        await onRefreshed();
      }
      wasRunning.current = s.running;
    } catch {
      // transient — next poll retries
    }
  }, [onRefreshed]);

  // Initial status on mount.
  useEffect(() => {
    async function init() {
      await fetchStatus();
    }
    init();
  }, [fetchStatus]);

  // Poll every 8s only while a run is in flight (ours or observed) — no idle polling.
  const active = waiting || !!status?.running;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(fetchStatus, 8000);
    return () => clearInterval(id);
  }, [active, fetchStatus]);

  // 1s local countdown so the cooldown label ticks without hitting the server.
  const cooling = cooldown > 0;
  useEffect(() => {
    if (!cooling) return;
    const id = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [cooling]);

  const trigger = useCallback(async () => {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/points/refresh", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        dispatchedAt.current = Date.now();
        waitingRef.current = true;
        setWaiting(true);
        setMsg("Refreshing… points update in ~1–2 min.");
        // Nudge a status read shortly after so the poller latches onto the new run.
        setTimeout(fetchStatus, 5000);
      } else {
        setMsg(data.error ?? "Couldn't refresh right now.");
        if (typeof data.cooldownRemaining === "number") setCooldown(data.cooldownRemaining);
        if (data.quota) setStatus((s) => (s ? { ...s, quota: data.quota } : s));
      }
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }, [fetchStatus]);

  if (!matchStarted) return null;
  if (status && !status.configured) return null; // not wired up → hide the whole control

  const running = busy || active;
  const disabled = running || cooldown > 0;
  const q = status?.quota;

  // Quota gauge tone: green plenty, amber getting low, red near the floor, grey unknown.
  const left = q?.hitsLeft ?? null;
  const gaugeTone =
    left == null
      ? "text-mist2"
      : left < 5
      ? "text-red-400"
      : left < 20
      ? "text-amber-300"
      : left < 40
      ? "text-amber-200"
      : "text-emerald-300";
  const gaugeText =
    left == null
      ? "🎟️ quota —"
      : `🎟️ ${left}${q?.hitsLimit ? `/${q.hitsLimit}` : ""} cricapi hits left today`;

  const base =
    "w-full flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-bold transition border";
  const label = running
    ? "Refreshing points…"
    : cooldown > 0
    ? `Refresh again in ${cooldown}s`
    : "🔄 Refresh live points";

  return (
    <div className="space-y-1">
      <button
        onClick={trigger}
        disabled={disabled}
        className={`${base} ${
          disabled
            ? "bg-navy border-hair2 text-mist cursor-not-allowed"
            : "bg-navy border-gold/50 text-gold hover:brightness-110"
        }`}
      >
        {running && (
          <span className="h-3.5 w-3.5 rounded-full border-2 border-mist/30 border-t-cloud animate-spin" />
        )}
        {label}
      </button>
      <div className="flex items-center justify-between px-1 text-[11px]">
        <span className={`tabular-nums ${gaugeTone}`}>{gaugeText}</span>
        {msg ? (
          <span className="text-mist2 text-right ml-2 truncate">{msg}</span>
        ) : q?.updatedUtc ? (
          <span className="text-mist2">updated {fmtUpdated(q.updatedUtc)}</span>
        ) : null}
      </div>
    </div>
  );
}
