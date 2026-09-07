/**
 * One-time: stamp `tour` onto every match in data/matches.json.
 *
 * Everything ingested from here on gets its slug from tour_sync.py, so this only exists to
 * catch up the matches that predate the field. Idempotent — a row that already carries a tour
 * is left alone, so re-running it after a hand-added fixture stamps only the new one.
 *
 *   npx tsx scripts/backfill-tours.ts --dry
 *   npx tsx scripts/backfill-tours.ts
 *
 * `deriveSlug` (lib/tours.ts) handles the leagues and the bilaterals. It cannot do the Women's
 * T20 World Cup — 33 unprefixed keys across ten teams, which derive into one bucket per fixture —
 * so that one event is named explicitly below. Bilateral pair-slugs are mapped to the registered
 * slugs so the tour reads as a tour ("India in England, T20Is") rather than as two team codes.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { deriveSlug } from "../lib/tours";

const FILE = join(process.cwd(), "data/matches.json");

// The one event `deriveSlug` genuinely cannot see: unprefixed group keys (ENG_SL_Jun12) plus
// bare knockouts (SF1_Jun30, FINAL_Jul05).
//
// This used to be "no known key prefix ⇒ WWC", and that is a trap, not a rule — it swallows any
// tour whose prefix isn't listed. It did: the Namibia T20I Tri-Series (NTITS_) auto-ingested
// before tour_sync learned to stamp its own slug, and all 6 of its matches landed in the World
// Cup. So the window and the gender are part of the test now, and it can only ever match the one
// event it names.
// Its keys are shaped like everything else's (ENG_SL_Jun12, SF1_Jun30), so the prefix cannot
// tell them apart. What CAN: it is the only women's tour inside this window — the Hundred
// Women's starts 21 Jul and the IRE-W v WI-W ODIs are 10-15 Jul.
const WWC_WINDOW = ["2026-06-12", "2026-07-05"];
const isLegacyWwc = (m: Row) =>
  m.gender === "W" &&
  m.date.slice(0, 10) >= WWC_WINDOW[0] &&
  m.date.slice(0, 10) <= WWC_WINDOW[1];

// Pair-slug (from deriveSlug) -> the registered slug in lib/tours.ts.
const PAIR_TO_TOUR: Record<string, string> = {
  "maus-mban": "aus-ban-t20i-2026",
  "mind-mire": "ind-ire-t20i-2026",
  "meng-mind": "ind-eng-t20i-2026",
  "mnz-mwi": "nz-wi-odi-2026",
  "oeng-oind": "eng-ind-odi-2026",
  "oire-owi": "ire-wi-w-odi-2026",
  "mtind-mtzim": "zim-ind-t20i-2026",
  "teng-tpak": "eng-pak-test-2026",
};

type Row = {
  key: string;
  team1: string;
  team2: string;
  gender: string;
  date: string;
  tour?: string;
  [k: string]: unknown;
};

// deriveSlug returns a registered league slug (ends in a year) or a bare team pair ("mind-mire").
const isLeagueSlug = (slug: string) => /-\d{4}$/.test(slug);

const dry = process.argv.includes("--dry");
const rows: Row[] = JSON.parse(readFileSync(FILE, "utf-8"));

const counts = new Map<string, number>();
let stamped = 0;
let already = 0;

for (const m of rows) {
  if (m.tour) {
    already++;
    counts.set(m.tour, (counts.get(m.tour) ?? 0) + 1);
    continue;
  }
  // A league prefix is the strongest signal and is checked FIRST, so a league can never fall
  // through to the WWC window test below.
  const derived = deriveSlug(m);
  const slug = isLeagueSlug(derived)
    ? derived
    : isLegacyWwc(m)
      ? "wwc-2026"
      : PAIR_TO_TOUR[derived] ?? derived;
  m.tour = slug;
  stamped++;
  counts.set(slug, (counts.get(slug) ?? 0) + 1);
}

for (const [slug, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(3)}  ${slug}`);
}
console.log(`\n${stamped} stamped, ${already} already had one, ${rows.length} total`);

if (dry) {
  console.log("(dry run — nothing written)");
} else {
  // No trailing newline, matching what tour_sync.py's json.dump(indent=2) leaves behind — so
  // the next ingest doesn't produce a spurious whole-file diff.
  writeFileSync(FILE, JSON.stringify(rows, null, 2));
  console.log(`wrote ${FILE}`);
}
