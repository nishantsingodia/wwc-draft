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
export async function getMatchPointsMap(
  match: Match,
  opts: { live: boolean; fresh?: boolean }
): Promise<Map<string, number>> {
  if (opts.live) {
    const live = await getLiveMatchPoints(match, { fresh: opts.fresh });
    if (live) return live.points;
  }
  return getMatchPointsForMatch(match);
}
