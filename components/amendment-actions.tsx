"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getUserLabel } from "@/lib/users";

/**
 * Approve or reject a pending lineup amendment without leaving the lobby.
 *
 * The compact diff shown here is the WHOLE change, not a teaser — every replacement, both
 * armbands, and the points swing measured just now. Approving is a real decision about
 * somebody's score, so it must never be a blind tap: if a change is too big to state in
 * these few lines, the summary says so and the only route on is "see the full diff".
 */

export type PendingSummary = {
  id: number;
  code: string;
  user: string;
  requestedBy: string;
  reason: string;
  pointsDelta: number | null;
  /** One line per change: "Brookes → Dickson", "C → Raza". */
  lines: string[];
  /** Changes beyond the ones summarised above. */
  more: number;
  canApprove: boolean;
  canCancel: boolean;
  waitingOn: string[];
};

export default function AmendmentActions({ p }: { p: PendingSummary }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function act(action: "approve" | "reject" | "cancel") {
    setBusy(action);
    setError("");
    try {
      const res = await fetch(`/api/draft/${p.code}/amend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id: p.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "That didn't go through");
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const delta = p.pointsDelta;

  return (
    <div className="rounded-xl border border-gold/50 bg-gold/[0.07] px-3 py-2.5 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-gold">
          ⚖️ {getUserLabel(p.requestedBy)} wants to amend {getUserLabel(p.user)}&apos;s team
        </p>
        {delta !== null && (
          <span
            className={`text-[11px] font-mono font-bold shrink-0 ${
              delta > 0 ? "text-emerald-400" : delta < 0 ? "text-live" : "text-mist"
            }`}
          >
            {delta > 0 ? "+" : ""}
            {delta} pts
          </span>
        )}
      </div>

      <p className="text-[11px] text-cloud italic">“{p.reason}”</p>

      <ul className="space-y-0.5">
        {p.lines.map((l) => (
          <li key={l} className="text-[11px] text-mist">
            {l}
          </li>
        ))}
        {p.more > 0 && (
          <li className="text-[11px] text-mist2">
            +{p.more} more change{p.more === 1 ? "" : "s"} — read it in full before deciding
          </li>
        )}
      </ul>

      {error && <p className="text-[11px] text-live">{error}</p>}

      <div className="flex items-center gap-2">
        {p.canApprove ? (
          <>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => act("approve")}
              className="flex-1 rounded-lg bg-emerald-500 text-ink font-bold text-xs py-2 disabled:opacity-40"
            >
              {busy === "approve" ? "…" : "Approve"}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => act("reject")}
              className="flex-1 rounded-lg border border-live/60 text-live font-semibold text-xs py-2 disabled:opacity-40"
            >
              {busy === "reject" ? "…" : "Reject"}
            </button>
          </>
        ) : p.canCancel ? (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => act("cancel")}
            className="flex-1 rounded-lg border border-hair text-mist text-xs py-2 disabled:opacity-40"
          >
            {busy === "cancel"
              ? "…"
              : `Cancel — waiting on ${p.waitingOn.map(getUserLabel).join(", ")}`}
          </button>
        ) : (
          <p className="flex-1 text-[11px] text-mist2">
            Waiting on {p.waitingOn.map(getUserLabel).join(", ")}
          </p>
        )}
        <Link
          href={`/draft/${p.code}/amend`}
          className="text-[11px] text-gold shrink-0 px-1"
        >
          full diff →
        </Link>
      </div>
    </div>
  );
}
