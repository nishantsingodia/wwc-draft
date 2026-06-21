/**
 * Canonical fuzzy player-name matching for cricket projects.
 *
 * SHARED FILE — kept in sync across:
 *   wwc-draft:             lib/fuzzy-name-match.ts          ← canonical
 *   cricket-auction-helper: src/lib/fuzzy-name-match.ts     ← mirror
 *
 * When you improve this logic, update BOTH files identically.
 * Do NOT duplicate this algorithm elsewhere in either project.
 */

/**
 * Normalize a player name for comparison:
 *   - NFKD decompose + strip combining diacritics  (handles "Élise" → "elise")
 *   - lowercase
 *   - strip everything except [a-z ] — removes hyphens (joining for surname-prefix
 *     matching: "Wyatt-Hodge" → "wyatthodge"), apostrophes, dots, digits
 *   - collapse whitespace
 */
export function normName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function surnameOf(norm: string): string {
  const parts = norm.split(" ").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function initialOf(norm: string): string {
  const parts = norm.split(" ").filter(Boolean);
  return parts.length ? parts[0][0] ?? "" : "";
}

/**
 * Given a player name and an array of candidate names, return the best-matching
 * candidate (returned as the original un-normalized string) or null.
 *
 * Callers do NOT need to pre-normalize — both sides are normalized internally
 * with the same normName function, guaranteeing consistency.
 *
 * Strategies (in descending confidence):
 *
 *   1. Exact normalized match
 *      "Sophie Ecclestone" ↔ "Sophie Ecclestone" ✓
 *
 *   2. Surname + first initial
 *      "A Canning" ↔ "Ava Canning"  (surname "canning", initial "a")
 *      "S Mandhana" ↔ "Smriti Mandhana"
 *
 *   3. Surname prefix + initial — married / hyphenated name changes
 *      "Wyatt" ↔ "Wyatt-Hodge"   (norm: "wyatt" prefix of "wyatthodge")
 *      "Sciver" ↔ "Sciver-Brunt" (norm: "sciver" prefix of "sciverbrunt")
 *      Guard: min(len_a, len_b) >= 4 — prevents short-surname false positives
 *
 *   4. Full-name prefix either direction
 *      "Renuka Singh" ↔ "Renuka Singh Thakur"
 *      "Chamari" ↔ "Chamari Athapaththu"
 *
 *   5. Surname unique in candidate set
 *      "WK Dilhari" ↔ "Kaveesha Dilhari" when she's the only "dilhari"
 *
 * Edge cases handled:
 *   - Diacritics: "Élise" matches "Elise" (NFKD strip)
 *   - Hyphenated first names: "Sarah-Jane" → "sarahjane" (strip, not space)
 *   - Dutch/South Asian prefixes ("van der", "bin"): last-word surname extraction
 *     works correctly since surnameOf returns the final word
 *   - Mononyms: "Chamari" → strategy 4 prefix fires against "Chamari Athapaththu"
 *   - Returns null (not a guess) when multiple candidates match a strategy —
 *     ambiguity is surfaced, not silently resolved
 */
export function fuzzyMatchName(name: string, candidates: string[]): string | null {
  if (!candidates.length) return null;

  const norm = normName(name);
  const surname = surnameOf(norm);
  const initial = initialOf(norm);
  const normC = candidates.map(normName);

  // 1. Exact
  const exactIdx = normC.indexOf(norm);
  if (exactIdx !== -1) return candidates[exactIdx];

  // 2. Surname + initial
  const bySurname = candidates.filter((_, i) =>
    surnameOf(normC[i]) === surname && initialOf(normC[i]) === initial
  );
  if (bySurname.length === 1) return bySurname[0];

  // 3. Surname prefix + initial
  const byPrefix = candidates.filter((_, i) => {
    const cs = surnameOf(normC[i]);
    return (
      initialOf(normC[i]) === initial &&
      (cs.startsWith(surname) || surname.startsWith(cs)) &&
      Math.min(cs.length, surname.length) >= 4
    );
  });
  if (byPrefix.length === 1) return byPrefix[0];

  // 4. Full-name prefix either direction
  const byFull = candidates.filter((_, i) => normC[i].startsWith(norm) || norm.startsWith(normC[i]));
  if (byFull.length === 1) return byFull[0];

  // 5. Surname unique
  const bySurnameOnly = candidates.filter((_, i) => surnameOf(normC[i]) === surname);
  if (bySurnameOnly.length === 1) return bySurnameOnly[0];

  return null;
}
