/**
 * gviz returns HTTP 200 and the WRONG SHEET for an unknown tab name.
 *
 * Verified live against the real spreadsheet:
 *   ?sheet=CARIBBEAN%20PREMIER%20LEAGUE%202026%20POINTS  -> 200, md5 b0217ad7…
 *   ?sheet=ZZZ_TOTALLY_BOGUS_TAB                         -> 200, md5 b0217ad7…  (byte-identical)
 * gviz silently falls back to the spreadsheet's FIRST sheet. That tab is a WWC auction-budget
 * board, and because the CPL tour has no cricapi_series the bot never writes its points tab — so
 * the draft was merging 33 rows of budget data ("EF = 10k", "1st : 27.5k", Sophie Devine…) into
 * its points pool on every request, with no error anywhere.
 *
 * This is the transport-layer form of the project's recurring bug class: an ABSENCE (missing tab)
 * presenting as a VALUE (a healthy 200). A missing tab must never look healthy.
 */
const REQUIRED = ["Match", "Player ID", "Full Name", "Fantasy Points"];

// Mirrors looksLikePointsTab() in lib/points.ts (module-private there).
function looksLikePointsTab(text: string): boolean {
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  return REQUIRED.every((c) => header.includes(`"${c}"`) || header.includes(c));
}

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
};

console.log("\npoints-tab guard (gviz unknown-tab fallback)");

const BUDGET_BOARD =
  '"","","EF = 10k","1st : 27.5k","","2nd : 17.5k","","3rd : 5k"\n' +
  '"","Sophie Devine","","","","","",""';
const REAL_TAB =
  '"Match","Date","Team","Player ID","Full Name","Role","Played","Runs","Fantasy Points"\n' +
  '"Match 1 — A v B","2026-07-21","KR","ci:1","A Player","BAT","Y","30","45"';

check("the auction-budget board is REJECTED", looksLikePointsTab(BUDGET_BOARD) === false);
check("a real points tab is ACCEPTED", looksLikePointsTab(REAL_TAB) === true);
check("an empty body is rejected", looksLikePointsTab("") === false);
check("an HTML error page is rejected", looksLikePointsTab("<HTML><HEAD>...") === false);
// A tab missing only the identity column must fail too — that is the column the whole join
// depends on, and half a schema is not a points tab.
check(
  "a tab missing Player ID is rejected",
  looksLikePointsTab('"Match","Date","Team","Full Name","Fantasy Points"') === false
);

// The manifest must not carry a tab the bot will never write.
const tabs: string[] = require("../data/points-tabs.json");
check(
  "points-tabs.json has no CPL tab (no cricapi_series -> never written)",
  !tabs.some((u) => u.toUpperCase().includes("CARIBBEAN"))
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
