// What the LIVE provisional H2H says about itself. CLIENT-SAFE (no `fs`, no imports) — the
// results page is a client component, so it must be able to import this directly.
//
// ONE source on purpose. Two surfaces show this (the results header and the match-hub
// "Refresh now" strip) and this codebase's standing failure mode is two copies that drift —
// see BUGS.md on the two scoring paths. Change the wording here and both move together.
//
// WHY IT NAMES THINGS RATHER THAN JUST SAYING "provisional". Until 14 Aug 2026 the live H2H was
// short by ~33 FP per match because the +8 lbw/bowled bonus and all run-out fielding were
// hard-coded to zero (BUGS.md §10). "Provisional" was true and told a friend nothing: they had
// no way to know the number was ~20 points light on their side and ~40 on a captain. So the
// label's job is to name what is genuinely still unresolved — and, since the fix, to stop
// implying a large unknown that no longer exists.
export const LIVE_SOURCE_LABEL = "Live · provisional (via ESPN)";

// EVERY CLAIM BELOW IS MEASURED, re-measured 16 Aug 2026 by replaying lib/espn.ts against 170
// cached ESPN summaries and diffing the 85 of them that now have a settled sheet row
// (1874 player rows, joined on ESPN athlete id — never on name):
//   • 1839 of 1874 rows (98.1%) and 65 of 85 matches land EXACTLY on the settled total.
//   • The 20 that moved ran from 18 FP DOWN to 8 FP UP across the FULL card (both XIs, ~22
//     players); median 2. A single friend's XI sees roughly half of that.
//   • Causes, in size order: a run-out or a wicket the official card credits to a different
//     fielder/bowler than ESPN did (ESPN names every fielder on a run out, the official card
//     sometimes names fewer) — 4 credits and one swapped wicket across the 85; ESPN's own
//     dots/maidens counters vs the bot's ball-by-ball recount (dots differ on 3 of 1874 rows;
//     maidens on 33, every one in The Hundred, which pays nothing for a maiden — 0 FP);
//     ±1 run of scorecard-vs-commentary drift, which can tip a strike-rate or economy band.
// The previous version of this note led with substitute fielders. That is now measurably WRONG:
// across the 183 cached summaries, ZERO non-starter roster entries carry any batting, bowling or
// fielding stat, and only 2 dismissal credits in ~1000 belong to someone outside the scored XI.
// Naming a gap that isn't there is the same disservice as hiding one that is.
//
// Deliberately does NOT promise a direction. Before the fix "it can only go up" was true; now the
// residual is 12 matches slightly high, 8 slightly short, 65 exact, so a promise either way is a
// lie. It says "a point or two" because that is the median, and names the ceiling honestly.
export const LIVE_GAP_NOTE =
  "Scored off the ESPN card — runs, wickets, catches, stumpings, the lbw/bowled bonus and " +
  "run-outs all count. What can still shift when the official card lands: a run-out or a wicket " +
  "credited to a different fielder or bowler, ESPN's own dot/maiden counters, and the odd single " +
  "run. Of the last 85 settled matches 65 finished on exactly this number; the rest moved by a " +
  "couple of points across both XIs — the largest was 18 down, 8 up.";
