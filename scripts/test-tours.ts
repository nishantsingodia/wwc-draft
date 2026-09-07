/**
 * tourOf / tourFacets — the lobby's tour filter.
 *
 * Runs against the REAL data/matches.json, because the thing worth guarding is that the whole
 * schedule partitions into the tours a human would name. The failure this prevents is specific:
 * a match with no `tour` slug falls back to a derived one, and while that is right for a league
 * (key prefix) or a bilateral (namespaced team codes), it shatters a multi-team event — the
 * Women's T20 World Cup would become 33 one-match "tours" in the filter row.
 */
import matches from "../data/matches.json";
import { tourFacets, tourOf, deriveSlug } from "@/lib/tours";
import { getAllMatches } from "@/lib/matches";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
};

const all = getAllMatches();

console.log("\nevery match resolves to a named tour");
const unstamped = (matches as { key: string; tour?: string }[]).filter((m) => !m.tour);
check(`all ${matches.length} matches carry a tour slug`, unstamped.length === 0);
const unnamed = all.filter((m) => {
  const t = tourOf(m);
  // humanize() falls back to the slug itself; a registered tour has a label that differs.
  return t.label === t.slug;
});
check("every slug in use is registered in lib/tours.ts", unnamed.length === 0);
if (unnamed.length) console.log(`     unregistered: ${[...new Set(unnamed.map((m) => tourOf(m).slug))].join(", ")}`);

console.log("\nthe partition matches the real schedule");
const facets = tourFacets(all);
const size = (slug: string) => facets.find((f) => f.slug === slug)?.count ?? 0;
check("the WWC is ONE tour of 33, not 33 tours of one", size("wwc-2026") === 33);
check("CPL 2026 has all 35", size("cpl-2026") === 35);
check("the two Hundreds are separate 34s", size("hundred-m-2026") === 34 && size("hundred-w-2026") === 34);
check("MLC's knockouts ride with its group games (33)", size("mlc-2026") === 33);
check("LPL is 24 despite its M_LPL_ keys", size("lpl-2026") === 24);
check("ETPL is 30", size("etpl-2026") === 30);
check("ENG v PAK is its own 3-Test tour", size("eng-pak-test-2026") === 3);
check("no match is left in an 'unscheduled' bucket", size("unscheduled") === 0);
// THE REGRESSION: the backfill's WWC rule used to be "no known key prefix ⇒ WWC", which
// swallowed the whole Namibia Tri-Series (NTITS_) the day it auto-ingested. A tour landing in
// the World Cup is invisible on the filter row — its own chip never appears and the WWC's count
// is silently wrong — so it is worth a test rather than a comment.
check("the Namibia Tri-Series is its own 6, not folded into the WWC", size("namibia-t20i-tri-series-2026") === 6);
check("...and a 3-team tri-series is ONE tour, not three team pairs", !facets.some((f) => /^mtnam-|^mtsou-|-mtzim2$/.test(f.slug)));
check(`the facets account for every match`, facets.reduce((n, f) => n + f.count, 0) === all.length);

console.log("\nIndia's two bilaterals do not merge (namespaced codes, shared country)");
check("IND v ENG T20Is is 5", size("ind-eng-t20i-2026") === 5);
check("IND v IRE T20Is is 2", size("ind-ire-t20i-2026") === 2);
check("...and they are different tours", size("ind-eng-t20i-2026") !== size("ind-ire-t20i-2026"));

console.log("\nfacet ordering + shape");
check("most-recent tour first", facets.every((f, i) => i === 0 || facets[i - 1].latestTs >= f.latestTs));
check("every facet has a chip-sized name", facets.every((f) => f.short.length > 0 && f.short.length <= 14));

console.log("\nderiveSlug — the safety net for an un-stamped row");
check(
  "a league key prefix resolves",
  deriveSlug({ key: "CPL_M9_MTGUY_MTJAM_Aug15", team1: "MTGUY", team2: "MTJAM" }) === "cpl-2026"
);
check(
  "LPL's M_ prefix does not swallow it into a bilateral",
  deriveSlug({ key: "M_LPL_QF1_0805", team1: "LPLCK", team2: "LPLKR" }) === "lpl-2026"
);
check(
  "a bilateral falls back to its (order-independent) team pair",
  deriveSlug({ key: "M_X_Y", team1: "MWI", team2: "MNZ" }) ===
    deriveSlug({ key: "M_Y_X", team1: "MNZ", team2: "MWI" })
);
check(
  "a TBD knockout gets an honest bucket, not a bogus pair",
  deriveSlug({ key: "NEW_Final", team1: "TBD", team2: "TBD" }) === "unscheduled"
);

console.log("\nan unregistered slug still reads as something");
const unknown = tourOf({ key: "BBL_M1_A_B_Dec20", team1: "A", team2: "B", tour: "bbl-2027" });
check("a future tour's slug is humanized rather than dropped", unknown.label === "BBL 2027");
check("...and keeps its slug for filtering", unknown.slug === "bbl-2027");
// The shape tour_sync actually emits: a slug of the tour's FULL name.
const ingested = tourOf({
  key: "THMC_M1_A_B_Jul21",
  team1: "A",
  team2: "B",
  tour: "the-hundred-mens-competition-2027",
});
check(
  "ordinary short words stay words, not shouted acronyms",
  ingested.label === "The Hundred Mens Competition 2027"
);
check("...and the chip trims on a WORD boundary", ingested.short === "The Hundred…");
check(
  "a format acronym stays shouted",
  tourOf({ key: "K", team1: "A", team2: "B", tour: "india-tour-of-zimbabwe-2027-t20i" }).label ===
    "India Tour Of Zimbabwe 2027 T20I"
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
