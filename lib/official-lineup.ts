// Single source of truth for "the official XI + announced status" used by the
// results route (backup-intelligence swap) and the /api/draft/[code] route (live
// In-XI / Not-in-XI display). Prefers a direct ESPN fetch (getEspnLineup) and
// falls back to the bot's sheet (getLastPlayedXI / getLineupMeta) when ESPN hasn't
// posted the XI yet. Returns the exact shapes those sheet functions return, so it
// is a drop-in for both call sites.

import { getEspnLineup } from "./espn";
import { getLastPlayedXI, getLineupMeta, getMatchXI } from "./points";
import { type Match } from "./matches";

export type OfficialLineup = {
  lastXI: Map<string, Map<string, number>>; // teamCode -> (name|pid) -> batOrder
  lineupMeta: Map<string, { announced: boolean; toss: string | null }>;
};

export async function getOfficialLineup(match: Match | undefined): Promise<OfficialLineup> {
  const [sheetXI, sheetMeta, matchXI, espn] = await Promise.all([
    getLastPlayedXI(),
    getLineupMeta(),
    match ? getMatchXI(match) : Promise.resolve(new Map<string, Map<string, number>>()),
    match ? getEspnLineup(match) : Promise.resolve(null),
  ]);

  if (!match) return { lastXI: sheetXI, lineupMeta: sheetMeta };

  const lastXI = new Map(sheetXI);
  const lineupMeta = new Map(sheetMeta);
  const espnToss = espn ? [...espn.lineupMeta.values()][0]?.toss ?? null : null;

  // Per-team precedence for THIS match's two teams:
  //   1. The sheet's own per-match XI (getMatchXI) — the bot resolved each player to their
  //      stable registry pid, so it matches our players by pid exactly (no espn:id-vs-slug
  //      mismatch, no fuzzy-name surname collisions). Use it the moment the sheet has the
  //      match (toss-announced OR completed). This is the authoritative, identity-safe XI.
  //   2. ESPN's announced XI — only before the sheet has posted this match (live window).
  //   3. The sheet's last-played XI (unchanged) — predicted-display fallback otherwise.
  for (const code of [match.team1, match.team2]) {
    const fromMatch = matchXI.get(code);
    const fromEspn = espn?.xiByTeam.get(code);
    if (fromMatch && fromMatch.size > 0) {
      lastXI.set(code, fromMatch);
      lineupMeta.set(code, { announced: true, toss: espn?.lineupMeta.get(code)?.toss ?? espnToss });
    } else if (fromEspn) {
      lastXI.set(code, fromEspn);
      lineupMeta.set(code, espn!.lineupMeta.get(code)!);
    } else if (espn) {
      // ESPN window open but this side isn't up yet AND the sheet has nothing for this
      // match — explicitly not-announced (never trust a stale global sheet toss-flag).
      lineupMeta.set(code, { announced: false, toss: espnToss });
    }
    // else: no ESPN + no sheet-match rows -> keep the sheet's last-played XI + meta as-is.
  }

  return { lastXI, lineupMeta };
}
