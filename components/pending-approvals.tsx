"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getUserLabel } from "@/lib/users";
import type { PendingSummary } from "@/components/amendment-actions";

/**
 * Every amendment waiting on YOU, across every match, at the top of the lobby.
 *
 * A per-match card is the right place to decide about one change while you're looking at
 * that match. It is the wrong place to clear a backlog: after a busy evening these pile up
 * across three leagues and finding them means opening each card. So they also collect here,
 * above the tabs, with one button that clears the lot.
 *
 * Bulk approval is a real risk — it is the exact shape of "click through the dialog". Two
 * things keep it honest. Every row states its whole change and its points swing before you
 * can hit the button, and the button itself carries the AGGREGATE swing, so "Approve all 3
 * · +128 pts" can't read as a formality. Each one is still applied individually by the
 * server, with the same re-validation and the same consensus rule as a single approval —
 * this is a shortcut through the UI, never through the checks.
 */
export default function PendingApprovals({ items }: { items: (PendingSummary & { matchLabel: string })[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  const mine = items.filter((p) => p.canApprove);
  if (mine.length === 0) return null;

  const net = mine.reduce((a, p) => a + (p.pointsDelta ?? 0), 0);

  async function approveAll() {
    setBusy(true);
    setFailed([]);
    setDone(0);
    const errs: string[] = [];
    // Sequential on purpose: each apply re-reads the squad it is amending, and two
    // amendments on the same contest must not race each other into a stale check.
    for (const p of mine) {
      try {
        const res = await fetch(`/api/draft/${p.code}/amend`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve", id: p.id }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          errs.push(`${p.code}: ${j.error ?? "failed"}`);
        } else {
          setDone((d) => d + 1);
        }
      } catch {
        errs.push(`${p.code}: network error`);
      }
    }
    setFailed(errs);
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-gold bg-gradient-to-r from-gold/15 to-ink2 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="text-base">⚖️</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-gold">
            {mine.length} amendment{mine.length === 1 ? "" : "s"} need your approval
          </p>
          <p className="text-[11px] text-cloud">
            Net{" "}
            <span className={net > 0 ? "text-emerald-400" : net < 0 ? "text-live" : "text-mist"}>
              {net > 0 ? "+" : ""}
              {net} pts
            </span>{" "}
            across {new Set(mine.map((p) => p.user)).size} team
            {new Set(mine.map((p) => p.user)).size === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-[11px] text-gold shrink-0 px-1"
        >
          {open ? "hide" : "review"}
        </button>
      </div>

      {open && (
        <ul className="border-t border-gold/30 divide-y divide-gold/20">
          {mine.map((p) => (
            <li key={`${p.code}-${p.id}`} className="px-3 py-2 space-y-1">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] text-cloud min-w-0">
                  <span className="text-mist">{p.matchLabel}</span> ·{" "}
                  {getUserLabel(p.requestedBy)} → {getUserLabel(p.user)}&apos;s team
                </p>
                {p.pointsDelta !== null && (
                  <span
                    className={`text-[11px] font-mono font-bold shrink-0 ${
                      p.pointsDelta > 0
                        ? "text-emerald-400"
                        : p.pointsDelta < 0
                          ? "text-live"
                          : "text-mist"
                    }`}
                  >
                    {p.pointsDelta > 0 ? "+" : ""}
                    {p.pointsDelta}
                  </span>
                )}
              </div>
              <p className="text-[10.5px] text-mist2 italic">“{p.reason}”</p>
              <p className="text-[10.5px] text-mist">
                {p.lines.join(" · ")}
                {p.more > 0 && ` · +${p.more} more`}
              </p>
              <Link href={`/draft/${p.code}/amend`} className="text-[10.5px] text-gold">
                open {p.code} →
              </Link>
            </li>
          ))}
        </ul>
      )}

      {failed.length > 0 && (
        <div className="border-t border-live/40 px-3 py-2 space-y-0.5">
          {failed.map((f) => (
            <p key={f} className="text-[10.5px] text-live">
              {f}
            </p>
          ))}
        </div>
      )}

      <div className="border-t border-gold/30 px-3 py-2">
        <button
          type="button"
          onClick={approveAll}
          disabled={busy}
          className="w-full rounded-lg bg-emerald-500 text-ink font-bold text-xs py-2.5 disabled:opacity-50"
        >
          {busy
            ? `Approving… ${done}/${mine.length}`
            : `Approve all ${mine.length} · ${net > 0 ? "+" : ""}${net} pts`}
        </button>
        <p className="mt-1.5 text-[10px] text-mist2 text-center">
          Rejecting is per-amendment — open the match, or the draft, to turn one down.
        </p>
      </div>
    </div>
  );
}
