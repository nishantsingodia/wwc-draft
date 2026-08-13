"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getUserLabel } from "@/lib/users";

/**
 * Results-page entry point for post-lock lineup amendments.
 *
 * Two jobs: make a request that's WAITING ON YOU impossible to miss (it changes a
 * scoreline you're reading right now), and offer the way in when a stand-in needs
 * swapping for the real player. Deliberately read-only — approve/reject live on the
 * amend screen next to the full diff, so nobody ever approves a number they can't see.
 */

type Pending = {
  id: number;
  user: string;
  requestedBy: string;
  pointsDelta: number | null;
  waitingOn: string[];
  canApprove: boolean;
  canCancel: boolean;
};

export default function AmendBanner({ code }: { code: string }) {
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/draft/${code}/amend`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        setPending(d.pending ?? []);
        setOpen(!!d.open);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code]);

  if (!open) return null;

  const forMe = (pending ?? []).filter((p) => p.canApprove);
  const mine = (pending ?? []).filter((p) => p.canCancel);

  if (forMe.length > 0) {
    return (
      <Link
        href={`/draft/${code}/amend`}
        className="block rounded-xl border border-gold bg-gradient-to-r from-gold/20 to-ink2 px-3 py-2.5"
      >
        <p className="text-xs font-bold text-gold uppercase tracking-wider">
          ⚖️ {forMe.length === 1 ? "An amendment needs" : `${forMe.length} amendments need`} your approval
        </p>
        <p className="text-[11px] text-cloud mt-0.5">
          {forMe
            .map(
              (p) =>
                `${getUserLabel(p.requestedBy)} → ${getUserLabel(p.user)}'s team${
                  p.pointsDelta !== null ? ` (${p.pointsDelta > 0 ? "+" : ""}${p.pointsDelta} pts)` : ""
                }`
            )
            .join(" · ")}
          <span className="text-gold"> — review →</span>
        </p>
      </Link>
    );
  }

  if (mine.length > 0) {
    return (
      <Link
        href={`/draft/${code}/amend`}
        className="block rounded-xl border border-hair bg-ink2 px-3 py-2 text-[11px] text-mist"
      >
        ⏳ Your amendment is waiting on{" "}
        <span className="text-cloud">{mine[0].waitingOn.map(getUserLabel).join(", ")}</span>
        <span className="text-gold"> — view →</span>
      </Link>
    );
  }

  return (
    <Link
      href={`/draft/${code}/amend`}
      className="block rounded-xl border border-hair bg-ink2 px-3 py-2 text-[11px] text-mist hover:text-cloud"
    >
      Someone in the XI a late addition you couldn&apos;t draft? See everyone playing and swap a
      stand-in for the real player — <span className="text-gold">amend lineup →</span>
    </Link>
  );
}
