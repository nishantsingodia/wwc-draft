// Which tour a match belongs to.
//
// A match carries its tour as a SLUG in data/matches.json (`"tour": "cpl-2026"`), written by
// tour_sync.py at ingest and backfilled for everything older by scripts/backfill-tours.ts.
// The display names live here rather than in the data, so one added field per match keeps
// matches.json readable and renaming a tour is a code change, not a 35-row edit.
//
// Why an explicit field instead of deriving one: a tour is only sometimes recoverable from a
// match. Franchise leagues namespace their key prefix (CPL_, THMSC_) and bilaterals namespace
// their team codes (MIND+MENG vs MIND+MIRE are two different India tours), but the Women's T20
// World Cup is 33 matches with unprefixed keys across ten teams — deriving it shatters the whole
// event into one "tour" per fixture. `deriveSlug` below is the safety net for an un-stamped row,
// not the mechanism; `npm run check:tours` fails loud so a gap can't sit there silently.

import type { Match } from "@/lib/matches";

export type Tour = {
  slug: string;
  /** Full name — headers, tooltips. */
  label: string;
  /** Chip-sized name for the lobby's filter row. Keep it under ~14 chars where possible. */
  short: string;
};

const TOURS: Record<string, { label: string; short: string }> = {
  "wwc-2026": { label: "Women's T20 World Cup 2026", short: "WWC" },
  "mlc-2026": { label: "Major League Cricket 2026", short: "MLC" },
  "lpl-2026": { label: "Lanka Premier League 2026", short: "LPL" },
  "hundred-m-2026": { label: "The Hundred Men's 2026", short: "Hundred (M)" },
  "hundred-w-2026": { label: "The Hundred Women's 2026", short: "Hundred (W)" },
  "cpl-2026": { label: "Caribbean Premier League 2026", short: "CPL" },
  "etpl-2026": { label: "European T20 Premier League 2026", short: "ETPL" },
  "aus-ban-t20i-2026": { label: "Australia in Bangladesh, T20Is", short: "AUS v BAN" },
  "ind-ire-t20i-2026": { label: "India in Ireland, T20Is", short: "IND v IRE" },
  "ind-eng-t20i-2026": { label: "India in England, T20Is", short: "IND v ENG" },
  "nz-wi-odi-2026": { label: "New Zealand in West Indies, ODIs", short: "WI v NZ" },
  "eng-ind-odi-2026": { label: "India in England, ODIs", short: "ENG v IND" },
  "ire-wi-w-odi-2026": { label: "West Indies Women in Ireland, ODIs", short: "IRE-W v WI-W" },
  "zim-ind-t20i-2026": { label: "India in Zimbabwe, T20Is", short: "ZIM v IND" },
  "eng-pak-test-2026": { label: "England v Pakistan, Tests", short: "ENG v PAK" },
  "namibia-t20i-tri-series-2026": { label: "Namibia T20I Tri-Series 2026", short: "NAM Tri" },
};

// Key prefix -> slug, for tours whose matches all share one. This is ALSO what the backfill
// leans on, so a prefix added here is picked up by both.
const LEAGUE_PREFIX: Record<string, string> = {
  MLC: "mlc-2026",
  THMSC: "hundred-m-2026",
  THWSC: "hundred-w-2026",
  CPL: "cpl-2026",
  ETPL: "etpl-2026",
  // Auto-ingested 8 Sep 2026, before tour_sync learned to stamp its own slug. The slug matches
  // what tour_sync would now emit for it, so a re-ingest is a no-op.
  NTITS: "namibia-t20i-tri-series-2026",
};

/** Un-stamped rows only. Never returns null — an unknown match gets its own honest bucket. */
export function deriveSlug(match: Pick<Match, "key" | "team1" | "team2">): string {
  const prefix = match.key.split("_")[0];
  if (LEAGUE_PREFIX[prefix]) return LEAGUE_PREFIX[prefix];
  if (match.key.startsWith("M_LPL_")) return "lpl-2026";
  const pair = [match.team1, match.team2].sort();
  if (pair.includes("TBD")) return "unscheduled";
  return `${pair[0]}-${pair[1]}`.toLowerCase();
}

/** Slug -> readable, for a tour nobody has registered above ("bbl-2027" -> "Bbl 2027"). */
const ACRONYMS = new Set(["odi", "odis", "t20i", "t20is"]);
function humanize(slug: string): string {
  return slug
    .split("-")
    .map((w) =>
      // A short word is an acronym when it has no vowel or carries a digit — "cpl" -> CPL,
      // "t20" -> T20 — which leaves ordinary short words as words ("the" -> The, not THE).
      ACRONYMS.has(w) || (w.length <= 4 && (/\d/.test(w) || !/[aeiou]/.test(w)))
        ? w.toUpperCase()
        : w[0].toUpperCase() + w.slice(1)
    )
    .join(" ");
}

/**
 * Chip-sized fallback. tour_sync slugs a tour's FULL name, which can run long. Cuts on a word
 * boundary where there is one — "The Hundred…" reads; "The Hundred M…" looks broken.
 */
const CHIP_MAX = 14;
function shorten(label: string): string {
  if (label.length <= CHIP_MAX) return label;
  const cut = label.slice(0, CHIP_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut.slice(0, CHIP_MAX - 1)) + "…";
}

/**
 * A tour that isn't registered in TOURS above still filters correctly — it just wears its
 * slug, humanized and trimmed to chip width (the full name stays in `label`, which the chip
 * carries as a tooltip). Adding it to TOURS is the one-line polish that gives it a proper
 * name; nothing breaks without it, so auto-ingest never needs a code change to work.
 */
export function tourOf(match: Pick<Match, "key" | "team1" | "team2" | "tour">): Tour {
  const slug = match.tour || deriveSlug(match);
  const known = TOURS[slug];
  if (known) return { slug, ...known };
  const label = humanize(slug);
  return { slug, label, short: shorten(label) };
}

/**
 * The filter row for a list of matches: one entry per tour present, each with its count,
 * ordered by the tour's most recent match. Built from ALL of the viewer's completed matches
 * (not the page's visible slice) so the counts are true rather than "true of what fits".
 */
export function tourFacets(
  matches: Pick<Match, "key" | "team1" | "team2" | "tour" | "deadlineTs">[]
): (Tour & { count: number; latestTs: number })[] {
  const by = new Map<string, Tour & { count: number; latestTs: number }>();
  for (const m of matches) {
    const t = tourOf(m);
    const hit = by.get(t.slug);
    if (hit) {
      hit.count += 1;
      hit.latestTs = Math.max(hit.latestTs, m.deadlineTs);
    } else {
      by.set(t.slug, { ...t, count: 1, latestTs: m.deadlineTs });
    }
  }
  return [...by.values()].sort((a, b) => b.latestTs - a.latestTs);
}
