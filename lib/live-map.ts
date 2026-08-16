// Which `Map<string, number>` of points came from the LIVE ESPN scorer, and which is the bot's
// settled sheet. No imports, no state that outlives the map itself (a WeakSet).
//
// ⚠ 16 Aug 2026 — WHY A MAP HAS TO CARRY THIS FACT INSTEAD OF THE CALLER PASSING IT.
// `lookupPlayerPoints` takes a `liveFallback` flag. On the LIVE map a pid miss MAY fall back to
// the shared fuzzy name matcher — the map is keyed by name as well as pid, and the whole number
// is provisional. On the bot's settled sheet it must NOT: a namesake could steal settled points.
// The results route passed the flag. `calcSelectionPoints` — the one scorer behind the LOBBY
// cards, the match-hub head-to-head, the /audit page and every amendment preview — passed four
// arguments and got the `= false` default. Same match, same map, same instant, two different
// totals, and the smaller one was on the screen friends actually watch.
//
// MEASURED by replaying lib/espn.ts#liveScoreFromSummary over 170 cached ESPN summaries
// (LPL / Hundred M+W / CPL / WWC / MLC / the bilaterals), at 6ac9b40: **46 pool players worth
// 2384 FP** were present in the live map and dropped to zero by the strict lookup — **14.0 FP per
// match** — and against the prod DB it moved 15 real selections:
//   IND v NED,      contest ZLHXQJ  674 → 1007   (Shafali Verma 222, vice ×1.5)
//   BAN v IND,      contest R5P7J3  523 → 757    (Shafali Verma 117, captain ×2)
//   Hundred M23,    contest 6T8SQY  400 → 438    (Matthew Fisher 38)
//   LPL DS v GG,    contest G9CH9A  655 → 707    (Vishva Kumara 52)
// Every one is an identity fork, never a scoring error: the pool's pid came from the bot's
// registry, the live map's is `ci:<ESPN athlete id>` by construction (lib/registry.ts) — Shafali
// Verma pool `ci:597821` vs ESPN athlete 1182523, Matthew Fisher pool `ci:1129635` vs 639080,
// Rinku Singh pool `ci:1463383` vs 723105. The forks themselves are an IDENTITY question and
// belong in the bot's "Needs Cricinfo ID" tab, NOT here.
//
// AND THE FORK LIST KEEPS MOVING, which is the argument for fixing it at this layer too: while
// this was being measured, 6ac9b40 corrected five seeds (Gus Atkinson ci:1126982 → ci:1039481,
// Shai Hope ci:443150 → ci:581379, Glenn Phillips, Mavendra Dindyal, Dwaine Pretorius) and the
// figure fell from 20.6 FP/match to 14.0 on the same corpus. Seeds will keep being corrected and
// new debutants will keep arriving; what must not survive either way is the app answering
// "I don't know who that is" with "he scored 0".
//
// Adding the flag to eight call sites is the fix that decays — this codebase's history says a
// caller WILL forget, and forgetting is silent. So the MAP knows: lib/espn.ts marks the one it
// builds, `lookupPlayerPoints` defaults to it, and a caller now has to opt OUT on purpose.
const LIVE_MAPS = new WeakSet<Map<string, number>>();

/** Tag a points map as the provisional live-ESPN one. Returns it, so it can wrap a `new Map()`. */
export function markLivePointsMap(m: Map<string, number>): Map<string, number> {
  LIVE_MAPS.add(m);
  return m;
}

/** True only for a map lib/espn.ts built from an ESPN scorecard. False for the settled sheet. */
export function isLivePointsMap(m: Map<string, number>): boolean {
  return LIVE_MAPS.has(m);
}
