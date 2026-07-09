import type { TeamSelection } from "@/lib/db";
import { getPlayerByKey } from "@/lib/players";
import { lookupPlayerPoints } from "@/lib/points";
import { rankingFromSelection } from "@/lib/effective-lineup";

// Lightweight per-selection XI total — the ONE scorer shared by every "summary"
// surface (lobby cards, match-hub head-to-head). It MUST agree byte-for-byte with
// the in-draft total (app/api/draft/[code]/results/route.ts), which produces the
// same number the long way (per-player rows).
//
// Prefer the FROZEN effective lineup BACKUP_INTELLIGENCE persisted (auto-subbed XI +
// cascaded C/VC) — that's what the results page shows for a locked/announced match.
// Only when nothing is frozen do we fall back to top-N by rank with C/VC floated to
// the head, mirroring the route's pass-through path. (This function was previously
// inlined in lobby/page.tsx; extracted so the match hub reuses it verbatim instead
// of spawning a third copy that could drift — see the two-scoring-paths history.)
export function calcSelectionPoints(
  sel: TeamSelection,
  ppu: number,
  matchPts: Map<string, number>
): number | null {
  const playerKeys: string[] = JSON.parse(sel.selectedPlayers ?? "[]");

  let xi: string[];
  let captainKey: string | null;
  let viceCaptainKey: string | null;

  if (sel.effectiveComputedAt && sel.effectiveLineup) {
    const fz = JSON.parse(sel.effectiveLineup) as {
      xi: string[];
      captainKey: string | null;
      viceCaptainKey: string | null;
    };
    xi = fz.xi;
    captainKey = fz.captainKey;
    viceCaptainKey = fz.viceCaptainKey;
  } else {
    const ranking = rankingFromSelection(playerKeys, sel.captainKey, sel.viceCaptainKey);
    xi = ranking.slice(0, ppu);
    captainKey = ranking[0] ?? null;
    viceCaptainKey = ranking[1] ?? null;
  }

  let total = 0;
  let hasAny = false;
  for (const key of xi) {
    const p = getPlayerByKey(key);
    if (!p) continue;
    const raw = lookupPlayerPoints(p.pid, p.displayName, p.name, matchPts);
    if (raw !== null) {
      hasAny = true;
      const mult = key === captainKey ? 2 : key === viceCaptainKey ? 1.5 : 1;
      total += raw * mult;
    }
  }
  return hasAny ? total : null;
}
