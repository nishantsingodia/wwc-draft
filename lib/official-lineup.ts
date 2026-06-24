// Single source of truth for "the official XI + announced status" used by the
// results route (backup-intelligence swap) and the /api/draft/[code] route (live
// In-XI / Not-in-XI display). Prefers a direct ESPN fetch (getEspnLineup) and
// falls back to the bot's sheet (getLastPlayedXI / getLineupMeta) when ESPN hasn't
// posted the XI yet. Returns the exact shapes those sheet functions return, so it
// is a drop-in for both call sites.

import { getEspnLineup } from "./espn";
import { getLastPlayedXI, getLineupMeta } from "./points";
import { type Match } from "./matches";

export type OfficialLineup = {
  lastXI: Map<string, Map<string, number>>; // teamCode -> (name|pid) -> batOrder
  lineupMeta: Map<string, { announced: boolean; toss: string | null }>;
};

export async function getOfficialLineup(match: Match | undefined): Promise<OfficialLineup> {
  const [sheetXI, sheetMeta, espn] = await Promise.all([
    getLastPlayedXI(),
    getLineupMeta(),
    match ? getEspnLineup(match) : Promise.resolve(null),
  ]);

  if (!espn || !match) return { lastXI: sheetXI, lineupMeta: sheetMeta };

  // ESPN is authoritative for this match's two teams; the sheet remains for all
  // other teams (irrelevant to this contest, but keeps the maps complete).
  const lastXI = new Map(sheetXI);
  const lineupMeta = new Map(sheetMeta);
  const espnToss = [...espn.lineupMeta.values()][0]?.toss ?? null;

  for (const code of [match.team1, match.team2]) {
    const xi = espn.xiByTeam.get(code);
    if (xi) {
      lastXI.set(code, xi);
      lineupMeta.set(code, espn.lineupMeta.get(code)!);
    } else {
      // We're inside ESPN's lineup window (the other side posted) but THIS side
      // isn't up yet. Mark it explicitly not-announced for this match — never trust
      // a stale, global sheet toss-flag from a previous match. Keep the sheet's
      // last-played XI as the "likely XI" fallback for ordering/predicted display.
      lineupMeta.set(code, { announced: false, toss: espnToss });
    }
  }

  return { lastXI, lineupMeta };
}
