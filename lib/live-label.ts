// What the LIVE provisional H2H says about itself. CLIENT-SAFE (no `fs`, no imports) — the
// results page is a client component, so it must be able to import this directly.
//
// ONE source on purpose. Two surfaces show this (the results header and the match-hub
// "Refresh now" strip) and this codebase's standing failure mode is two copies that drift —
// see BUGS.md on the two scoring paths. Change the wording here and both move together.
//
// WHY IT NAMES THINGS RATHER THAN JUST SAYING "provisional". Until 14 Aug 2026 the live H2H
// was short by ~35–41 FP per match (measured bot-minus-app over 99 cached ESPN events, 2236
// player rows: +3472 FP total) because the +8 lbw/bowled bonus and all run-out fielding were
// hard-coded to zero. "Provisional" was true and told a friend nothing: they had no way to
// know the number was ~20 points light on their side and ~40 on a captain. Both are now read
// from ESPN's own scorecard, and after the fix 87 of those 99 matches land EXACTLY on the
// bot's settled total (mean residual −0.6 FP/match). So the label's job changed: it must now
// name the genuinely-unavailable remainder instead of implying a large unknown.
export const LIVE_SOURCE_LABEL = "Live · provisional (via ESPN)";

// The remainder, all of it measured over the same corpus (139 cached summaries):
//   • substitute fielders — 11 of 1034 fielding credits (9 catches, 2 run-outs) belong to a
//     fielder ESPN flags isSubstitute, who has no roster line to score against. ≈0.6 FP/match.
//   • dots/maidens — ESPN's own per-bowler counters, not a ball-by-ball recount like the bot's.
//     Dots differ on 4 of 2236 rows (2 FP in total); maidens differ on 31 rows, every one of
//     them in The Hundred, which awards no maiden points at all — so 0 FP today.
//   • ±1 run / ±1 ball scorecard-vs-commentary drift on 25 of 2236 rows, which can occasionally
//     tip a strike-rate or economy band.
// Deliberately does NOT promise a direction: post-fix the residual is 9 matches slightly high,
// 3 slightly short, 87 exact — so "it can only go up" would now be a lie.
export const LIVE_GAP_NOTE =
  "Scored off the ESPN card, including lbw/bowled and run-outs. Not counted: a substitute " +
  "fielder's catch or run-out. Dots and maidens are ESPN's own counters, so the official card " +
  "can still move this by a point or two.";
