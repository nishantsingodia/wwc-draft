"use client";

import { getFlag } from "@/lib/players";
import type { Change } from "@/lib/effective-lineup";

// High-visibility disclosure of every BACKUP_INTELLIGENCE auto-substitution and
// armband move, mirroring the Undo handshake banner's amber style. Renders nothing
// when nothing moved (empty/absent changes).
export default function ChangesBanner({ changes }: { changes?: Change[] | null }) {
  if (!changes || changes.length === 0) return null;
  return (
    <div className="rounded-lg px-3 py-2 bg-amber-950 border border-amber-500/60 space-y-1">
      <p className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
        ⚡ Backup intelligence
      </p>
      {changes.map((c, i) => {
        if (c.type === "sub")
          return (
            <p key={i} className="text-xs text-amber-100">
              {getFlag(c.in.team)} <span className="font-semibold">{c.in.name}</span> moved into the XI —{" "}
              <span className="text-amber-300/80">{c.out.name} isn&apos;t playing</span>
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
        return (
          <p key={i} className="text-xs text-amber-300/80">
            ⚠ {c.message}
          </p>
        );
      })}
    </div>
  );
}
