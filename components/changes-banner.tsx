"use client";

import { getFlag } from "@/lib/players";
import { getUserLabel } from "@/lib/users";
import type { Change } from "@/lib/effective-lineup";

// High-visibility disclosure of every BACKUP_INTELLIGENCE auto-substitution and armband
// move, mirroring the Undo handshake banner's amber style. Renders nothing when nothing
// moved (empty/absent changes).
//
// A lineup set by an APPROVED AMENDMENT flows through the same list — same shape, same
// place — but must never be labelled "backup intelligence": the app didn't decide it,
// the friends did. The `amendment` marker retitles the banner and names who asked and
// who agreed, so a human decision is never passed off as an automatic one.
export default function ChangesBanner({ changes }: { changes?: Change[] | null }) {
  if (!changes || changes.length === 0) return null;
  const amendment = changes.find((c) => c.type === "amendment");
  return (
    <div className="rounded-lg px-3 py-2 bg-amber-950 border border-amber-500/60 space-y-1">
      <p className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
        {amendment ? "⚖️ Approved amendment" : "⚡ Backup intelligence"}
      </p>
      {changes.map((c, i) => {
        if (c.type === "amendment")
          return (
            <p key={i} className="text-xs text-amber-100">
              Set by <span className="font-semibold">{getUserLabel(c.by)}</span>
              {c.approvedBy.length > 0 ? (
                <span className="text-amber-300/80">
                  {" "}· approved by {c.approvedBy.map(getUserLabel).join(", ")}
                </span>
              ) : null}
              {c.reason ? <span className="text-amber-300/80"> — “{c.reason}”</span> : null}
            </p>
          );
        if (c.type === "sub")
          return (
            <p key={i} className="text-xs text-amber-100">
              {getFlag(c.in.team)} <span className="font-semibold">{c.in.name}</span> moved into the XI —{" "}
              <span className="text-amber-300/80">
                {amendment ? `replacing ${c.out.name}` : `${c.out.name} isn't playing`}
              </span>
            </p>
          );
        if (c.type === "captain")
          return (
            <p key={i} className="text-xs text-amber-100">
              👑 Captain → <span className="font-semibold">{c.in.name}</span>
              {c.out ? <span className="text-amber-300/80"> (was {c.out.name})</span> : null}
            </p>
          );
        if (c.type === "vice")
          return (
            <p key={i} className="text-xs text-amber-100">
              🅥 Vice-Captain → <span className="font-semibold">{c.in.name}</span>
              {c.out ? <span className="text-amber-300/80"> (was {c.out.name})</span> : null}
            </p>
          );
        if (c.type === "warning")
          return (
            <p key={i} className="text-xs text-amber-300/80">
              ⚠ {c.message}
            </p>
          );
        return null;
      })}
    </div>
  );
}
