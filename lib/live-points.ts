import { type Match } from "@/lib/matches";
import { getMatchPointsForMatch } from "@/lib/points";
import { getLiveMatchPoints } from "@/lib/espn";

// Single source for "which points map to show for a match right now" on the summary
// surfaces (lobby cards + match hub). While a match is LIVE we score the head-to-head
// IN-APP from the ESPN scorecard — zero cricapi, no bot run — exactly the way the results
// route (app/api/draft/[code]/results/route.ts) does via getLiveMatchPoints + lib/d11-score.
// Once the match is COMPLETED the bot's reconciled Google Sheet drives it
// (getMatchPointsForMatch). ESPN is best-effort: if it yields nothing we fall back to the
// sheet so a feed hiccup never blanks a live scoreline.
//
// The returned map is keyed the same way both sources are (stable pid / espn:<id> / name),
// so calcSelectionPoints + lookupPlayerPoints consume it unchanged. Callers pass `live`
// (they already know it from their own started/completed split) rather than us re-deriving
// it, and `fresh: true` to bypass the 20s ESPN cache on an explicit "Refresh now" tap.
//
// `freshness` rides along for live matches — a "Points updated till 14.3 overs (138/4)"
// line the refresh surfaces show so the provisional numbers read as a point-in-time, not a
// final. Null for completed matches (the sheet is the final) or before the first ball.
export type MatchPoints = {
  points: Map<string, number>;
  freshness: string | null;
};

/** One innings as the lobby card shows it — DISPLAY ONLY, never an input to any score. */
export type InningsLine = {
  team: string;
  teamName: string;
  runs: number;
  wickets: number;
  overs: string;
};

/**
 * The scoreline strip for a match card ("138/4 · 14.3 ov").
 *
 * Read off the same cached ESPN summary the live path already pulls, and used for COMPLETED
 * matches too — a finished game still has its card there, and the final score is the most
 * useful thing on a completed row. This is deliberately separate from points: the sheet
 * stays the only source of a COMPLETED score, and this function's output never reaches
 * calcSelectionPoints. Empty array when ESPN has nothing, so the strip just doesn't render.
 *
 * Call it only for the cards you are actually going to expand — it costs one ESPN summary
 * per match, and a lobby with twenty completed matches shouldn't pay twenty of them.
 */
export async function getMatchScoreline(match: Match): Promise<InningsLine[]> {
  const live = await getLiveMatchPoints(match);
  return (live?.scorecard ?? []).map((i) => ({
    team: i.teamCode,
    teamName: i.teamName,
    runs: i.runs,
    wickets: i.wickets,
    overs: i.overs,
  }));
}

export async function getMatchPointsMap(
  match: Match,
  opts: { live: boolean; fresh?: boolean }
): Promise<MatchPoints> {
  if (opts.live) {
    const live = await getLiveMatchPoints(match, { fresh: opts.fresh });
    if (live) return { points: live.points, freshness: live.freshness };
  }
  return { points: await getMatchPointsForMatch(match), freshness: null };
}
