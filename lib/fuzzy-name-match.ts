/**
 * Re-export shim — the fuzzy name-matcher now lives in the shared package
 * `cricket-identity` (github:nishantsingodia/cricket-identity), the single
 * source of truth shared with cricket-auction-helper.
 *
 * This used to be a hand-mirrored copy ("copy verbatim when you change one"),
 * which let the two drift. Do NOT paste the algorithm back here — edit it in the
 * cricket-identity repo, bump its version, and `npm update cricket-identity`.
 *
 * The file is kept as a thin shim so existing `./fuzzy-name-match` imports
 * (lib/players.ts, lib/espn.ts, lib/points.ts) keep working untouched.
 */
export { normName, fuzzyMatchName } from "cricket-identity";
