# wwc-draft — Bugs & What Not To Do

Real incidents that happened in production. Each section is a root cause + what broke + the rule to never repeat.

---

## 0. One CSV tab read, but tours live in many tabs — CONFIRMED BUG

**What broke:** The AUS v BAN men's series was added with points "present in sheet", but the app only ever read the women's tab (single `POINTS_CSV_URL`, gid=1607218200). The men's tab was never fetched, so every men's match showed 0 pts. Doubly broken: the men's tab labels were `"Match 1 — Bangladesh v Australia"` (full names), while matches.json had `"T20I 1 — AUS v BAN"` — they'd never match even if the tab were read.

**Root cause:** The points feed is one Google spreadsheet with one tab per tour. The app read a single URL. Adding a tour's matches without wiring its tab = silent 0 pts.

**Fix:** `lib/points.ts` now reads `POINTS_CSV_URLS` (comma-separated) and merges all tabs at read time (identical schema). gviz tabs need `&headers=1`. See CLAUDE.md Step 4.

**Rule: when adding a tour, you MUST (a) add its tab URL to `POINTS_CSV_URLS`, and (b) set matches.json labels to the EXACT format the bot writes in that tab — fetch the tab and look, never assume. Label format differs per tour (codes vs full country names).**

---

## 1. Unordered DB query for ordered data split

**What broke:** Team page initialized starters/backups incorrectly for live drafts. Backup-round picks appeared in the starting XI; starter-round picks got benched. Users saved the wrong team, leading to wrong points totals.

**Root cause:** The picks query had no `ORDER BY`:
```typescript
// WRONG — undefined row order
await db.select().from(draftPicks).where(eq(draftPicks.contestId, id));
```
Then client sliced `myPicks.slice(0, ppu)` to get starters. SQLite returns rows in undefined order without `ORDER BY`, so the first `ppu` rows weren't the first `ppu` picks — they were whoever happened to be physically first on disk.

**Fix:**
```typescript
// RIGHT
await db.select().from(draftPicks)
  .where(eq(draftPicks.contestId, id))
  .orderBy(asc(draftPicks.pickNumber));
```
And always sort on the client too: `myPicks.sort((a, b) => a.pickNumber - b.pickNumber)` before slicing.

**Rule: whenever the meaning of a slice depends on order, the query MUST have `ORDER BY` on the ordering field. Never trust implicit SQLite row order.**

---

## 2. Double-applying C/VC multipliers

**What broke:** Captain showed ×4 points (592 for a player who scored ~150), VC showed ×2.25 (×1.5²). Total was wildly inflated.

**Root cause:** The results API returned `fantasyPoints = rawPoints × multiplier`. The results page `PlayerRow` then multiplied `fantasyPoints` by `mult` again:
```typescript
// WRONG — fantasyPoints already has multiplier applied
const displayPts = player.fantasyPoints * mult;  // rawPts × mult × mult
```

**Fix:**
```typescript
// RIGHT — use rawPoints as base, apply mult once for display
const displayPts = player.rawPoints !== null ? player.rawPoints * mult : null;
```
The total `calcXITotal` should use `fantasyPoints` (which already has the multiplier), never re-multiply it.

**Rule: rawPoints = base CSV score. fantasyPoints = rawPoints × role multiplier (applied ONCE in the API). Never re-multiply fantasyPoints anywhere. If you need to display a player's contributing score, derive it from rawPoints × mult — not from fantasyPoints × mult.**

---

## 3. Caching null (hiding the retry)

**What broke:** Google Sheet not ready yet (first new tour). App fetched the CSV, got null (sheet URL not set or sheet empty), cached null permanently in a module-level `Promise`. Every subsequent request returned null without re-fetching. Points never appeared even after the sheet was ready.

**Root cause:**
```typescript
// WRONG — caches failures
let _cachePromise = fetchCsvText().then(text => parseCsv(text));
// If text is null → _cachePromise resolves to null and stays cached forever
```

**Fix:**
```typescript
// RIGHT — don't cache failures
_cachePromise = fetchCsvText().then(text => {
  if (!text) {
    _cachePromise = null;  // clear so next request retries
    return null;
  }
  return parseCsv(text);
});
```

**Rule: module-level caches must never cache failure states. If the underlying fetch fails or returns empty, clear the cache pointer so the next request retries. Permanent null-caching is indistinguishable from "data doesn't exist" and is very hard to debug.**

---

## 4. Match label order must match the CSV exactly — CONFIRMED BUG

**What broke (production):** Matches 4 (NZ v WI), 5 (NED v BAN), and 11 (PAK v SA) showed 0 pts for every player despite the sheet having full data. Root cause: `matches.json` had `"Match 4: NZ v WI"` → app looked for `"Match 4 — NZ v WI"`. The WWC Points Bot wrote `"Match 4 — WI v NZ"` (teams reversed). Exact string match → zero rows found → empty points map → all players show 0.

**How to detect:** Results page shows `0.0 pts` in grey for ALL players of a match simultaneously. If only ONE player shows grey 0 while others show green, it's a name mismatch (see rule 5). ALL grey = label mismatch.

**How to validate:** Fetch the sheet CSV directly and compare:
```bash
curl -sL "$POINTS_CSV_URL" | cut -d',' -f1 | sort -u
```
Each match label in the output must have an exact corresponding entry in `matches.json` (after `label.replace(":", " —")`).

**Code fix (first attempt):** added `flipTeams()` to also try `B v A`. This was **superseded** — see the update below.

**SUPERSEDED → now matched by teams + date.** The label approach kept breaking (team order, then per-tour label formats like full names vs codes, then the bot's match *numbering* differing from ours). The durable fix is `getMatchPointsForMatch(match)` / `getCompletedMatchKeys(matches)` in `lib/points.ts`, which match on **team pair (order-independent, code-or-fullname) + closest date** and ignore the `Match N` label entirely. `getMatchPoints`/`getCompletedMatchLabels`/`flipTeams`/`toCsvMatchLabel` are gone.

**Rule: never match points on the label string. Match on teams + date. The bot's label/number/order is display trivia, not a key.**

---

## 5. Player name in players-raw.json must match the sheet's "Full Name" column

> **UPDATE 2026-06-22 — largely SUPERSEDED by the Player ID join.** Points now join on the
> stable `pid` (the sheet's `Player ID` column ↔ `players-raw.json` `pid`), not on the name.
> So a name mismatch no longer drops a player as long as both sides share a `pid` (the points
> bot resolves all feed spellings to one identity via its global registry). A grey `0.0` now
> means a **missing pid link**, not a spelling typo: run `registry/backfill_draft_pids.py`, and
> if the player isn't in the registry, add/alias them in `wwc-points-bot/registry/` and re-run
> `build_registry.py`. The name-spelling advice below applies ONLY on the no-pid fuzzy fallback.

**What breaks:** Individual player shows `0.0 pts` in grey while teammates show real scores.

**How to diagnose:** On the results page, one player shows grey 0 while others show green points. That player's name in `players-raw.json` doesn't fuzzy-match any name in the CSV for that match.

**Common causes:**
- Player has a completely different cricsheet name vs announced name (e.g., Chamari Athapaththu stored as "AC Jayangani" — not fixable by fuzzy match, needs `NAME_ALIASES`)
- Typo in `players-raw.json` that breaks even the fuzzy strategies
- Player from a completely different country (wrong `team_code`) who never appears in the sheet

**Fix:** Find their exact name in the Google Sheet "Full Name" column. Update `players-raw.json`. Redeploy. Do NOT change the `id` field — it's referenced in existing draft_picks rows.

---

## 6. Don't remove player IDs mid-tournament

**What breaks:** `draft_picks` and `team_selections` store player keys (string of `id`). Removing or changing the `id` of a player mid-tournament orphans those references. They show as unknown players with no name/role/points.

**Rule: only ever ADD entries to `players-raw.json`. Never delete or change `id` values once a tournament has started. If a player is replaced, add a new entry for the replacement; keep the old entry.**

---

## 7. Match key collisions for simultaneous tournaments

**What could break:** Two tournaments running at the same time (e.g., Women's T20 WC + Men's T20I series) could have matches with the same key if both use `"AUS_BAN_Jun17"` format.

**Fix:** Prefix keys for non-primary tournaments: `"M_AUS_BAN_T20I1_Jun17"` vs `"AUS_BAN_Jun17"`. The `key` is stored in `draft_contests.matchKey` and must be globally unique across all tournaments in the app.

**Rule: when adding a new tournament, scan existing keys in matches.json for potential collisions. If any team pair + date overlaps, add a tournament prefix to the key.**

---

## 8. C/VC results display showed the ALREADY-multiplied value next to "×2"

**What broke:** During a live game a captain who scored 102 showed on the results page as `204.0 ×2` (and a VC of 64 as `96.0 ×1.5`). 204 is *correct* (102×2 = the captain's contribution), but printing it beside `×2` reads as "204 will be doubled" → looked like a double-multiply bug and prompted "is this expected?".

**Root cause:** `PlayerRow` rendered `displayPts = rawPoints × mult` AND a `×mult` chip — i.e. the already-multiplied number next to the multiplier.

**Fix:** C/VC rows now render `base ×mult = total` (`102.0 ×2 = 204.0`) — multiplier visibly already applied, the emphasised number is the contribution. `app/draft/[code]/results/page.tsx`.

**Rule: never show a multiplied points value next to a bare "×N". Show `base ×mult = total` (or just the total). The sheet stores RAW points only — multipliers are applied + displayed in the app (see CLAUDE.md "Never double-apply C/VC multipliers").**
