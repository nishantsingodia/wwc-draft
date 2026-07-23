@AGENTS.md

# wwc-draft — Setting Up a New Tour

## What this app does
Two-player fantasy cricket draft. Friends pick players from a shared pool in turns (live draft) or submit teams manually. Points come from a Google Sheet CSV updated after each match. The lobby shows live/upcoming/completed matches with C/VC comparison and running scores.

---

## TL;DR — add a new tour (the seamless path)

1. **Research the XI** for each team (Step 0). `squad_number` is only a pre-tournament seed — order self-corrects from the sheet after each match.
2. **`data/matches.json`** — add matches with correct `team1`/`team2` codes + `date`. The `label` is display-only; don't sync its number/format to anything.
3. **`data/players-raw.json`** — add players. `name` should match the bot's canonical `Full Name`; `team_code` must be registered in `lib/players.ts`. Then run `python3 registry/backfill_draft_pids.py` in the **wwc-points-bot** repo to stamp each player's stable `pid` — points now join by **Player ID**, so an exact name match is no longer required (see "Identity" below).
4. **`lib/players.ts`** — add any new team codes to `TEAM_FLAGS` + `TEAM_NAMES` (both the code AND full name matter — the points matcher uses them).
5. **wwc-points-bot `tours.json`** — register the tour (cricapi/espn series, `tab`, `gender`, `squads`) so the bot writes its tab (with `Bat Order`).
6. **`POINTS_CSV_URLS`** env (`.env.local` + Vercel) — append the new tab's gviz URL (`&headers=1`).
7. **Verify + Deploy** — `npm run check:tours` (fails loud on unknown codes / missing ESPN series), then `npx vercel --prod`.

What you do NOT need to do anymore (these are automatic/durable now):
- ❌ Match the bot's match numbers or label format — points match on **teams + date**.
- ❌ Worry about team order in the label — order-independent.
- ❌ Hand-maintain batting order after a match — the bot's `Bat Order` column drives it.
- ❌ Manually flip anything for `A v B` vs `B v A`.

The rest of this doc is the detailed reference for each step + the hard-won gotchas (see also `BUGS.md`).

---

## Step 0 — Lineup research (do this FIRST, always)

Before touching any files, determine the likely XI order for each team. This sets `squad_number` in `players-raw.json` — numbers 1–11 appear as "Expected XI" in the draft pool, 12+ as bench. Do this for every tour regardless of format or length.

### Finding the XI

Web-search `"[team] expected XI [tournament/series] [year]"` and `"[team] probable playing XI [opponent]"` for each team. Cross-reference cricinfo team pages and recent scorecards.

Sort 1–11 by expected batting position:
- Openers at 1–2
- Middle order 3–6
- Finishers / WK 7–8
- Bowling all-rounders 9–10
- Specialist bowlers 11
- When genuinely uncertain between XI and bench, keep the player at 11 — safer to show too many in XI than to bury a key pick in bench

**STRICT CHECK**: every player with `squad_number` 1–15 MUST be on the officially announced squad for that tour/series. Search `"[team] squad [tournament] [year]"` or check the ICC/board announcement. Do NOT add a player because they "usually play" — only if they're in the announced squad.

### Bench ordering (squad_number 12+)

If the player appeared in a previous match of THIS same tour (check cricsheet or the points CSV), order bench players by average fantasy points on that tour — descending. Players with tour stats are more likely to be rotated in.

If no tour stats exist yet (first match of a new tour), order bench alphabetically within each role group (WK first, then BAT, AR, BOWL — each group A–Z).

During the setup session, ask the user if they have strong views on the bench order before finalizing. They know the cricket better.

### Once match 1 completes — XI *and* batting order self-correct

`getLastPlayedXI()` in `lib/points.ts` reads the most recent match from the CSV and returns each team's XI as `name → Bat Order`:
- **Membership**: `Played = Y` overrides `isLikelyXI` — the board shows the actual last-played XI.
- **Order**: the bot's `Bat Order` column (real scorecard batting position) drives the display order via `getPlayersByTeams`. Falls back to hand-set `squad_number` only when `Bat Order` is blank (DNB) or absent (pre-first-match).

So `squad_number` in `players-raw.json` is just the **pre-tournament seed**. After a team plays, both who's in and what order they bat are automatic — do NOT hand-maintain batting order for played teams. The `Bat Order` column is emitted by `wc_fps_to_csv.py` in the wwc-points-bot (captured from cricapi's batting array / cricsheet first-appearance order).

---

## Step 1 — `data/matches.json` (match schedule)

Each entry:
```json
{
  "matchNum": 1,
  "key": "ENG_SL_Jun12",
  "gender": "W",
  "team1": "ENG",
  "team2": "SL",
  "label": "Match 1: ENG v SL",
  "date": "2026-06-12T23:00:00+05:30"
}
```

- `key` — unique string, never reuse across tournaments (it's stored as `matchKey` in DB rows). For men's and women's tours running simultaneously, prefix keys: `"W_ENG_SL_Jun12"` vs `"M_ENG_SL_Jun12"` to avoid collisions.
- `gender` — `"W"` for women's, `"M"` for men's. Required. This differentiates simultaneous tournaments (e.g., Women's T20 WC + Men's T20 WC) and ensures the correct player pool is shown.
- `label` — **display only** (shown in lobby/match pages). Use `"Match N: TEAM1 v TEAM2"` for readability, but it has NO role in points matching (that's teams+date — see Step 4). Don't waste time syncing it to the bot's numbering.
- `team1` / `team2` — team codes. These ARE used for points matching (resolved against the sheet's team tokens), so they must be correct and registered in `lib/players.ts`.
- `date` — ISO 8601 with IST offset (`+05:30`). The toss/lock time. Lobby flips Upcoming → Live at `date + 15 min` (the `LOCK_BUFFER` editing grace window). Also used (loosely, ±1 day) to disambiguate points lookup.
- Knockouts: use `"TBD"` for teams until confirmed, then update just `team1`/`team2`. Note: knockout rows can't be points-matched until real teams are filled in (no team pair to match on).

---

## Step 2 — `data/players-raw.json` (squad roster)

Each entry:
```json
{
  "id": 852,
  "name": "Beth Mooney",
  "country": "Australia",
  "role": "WK",
  "squad_number": 1,
  "team_code": "AUS",
  "efppm": 52.0
}
```

- `id` — the draft's internal player key (integer). Must be unique. **Never change/remove it** once a draft has started (`draft_picks`/`team_selections` reference it).
- `pid` — **stable global identity** from the points registry (cricsheet hash / `espn:` / `slug:`). Backfilled by `registry/backfill_draft_pids.py` (wwc-points-bot); do NOT hand-edit. This is what points join on now (the sheet's `Player ID` column) — robust even when the sheet's canonical name differs from `name` (e.g. sheet "Tajinder Singh" vs our "Tajinder Dhillon").
- `name` — **CANONICAL ANNOUNCED NAME only**. Never cricsheet initials (see pitfalls). Source: official squad announcement page or cricinfo player profile.
- `role` — `"WK"`, `"BAT"`, `"AR"`, or `"BOWL"`.
- `squad_number` — set per Step 0 research. 1–11 = likely XI, 12+ = bench.
- `team_code` — must exist in `TEAM_FLAGS` in `lib/players.ts`.
- `efppm` — used only as a draft-picking guide (shown as `~XX exp` in the draft board, never as real points). Rough estimates: top bat/bowl 50–90, mid-tier 20–50, tail/bench 10–20. Get from cricket-auction-helper valuations if available, otherwise estimate.

---

## Step 3 — `lib/players.ts` (new team codes only)

Only needed if the tour includes a team not in the current list. Add to both maps:
```typescript
const TEAM_FLAGS: Record<string, string> = {
  UAE: "🇦🇪",
};
export const TEAM_NAMES: Record<string, string> = {
  UAE: "United Arab Emirates",
};
```

---

## Step 4 — Google Sheet (points CSV)

**The sheet can be set up after drafts have already started — see below.**

Required column headers (exact, case-sensitive — written by the bot):
```
Match | Date | Team | Player ID | Full Name | Played | Fantasy Points | Bat Order
```

- `Match` — display label only (see below — points are NOT matched on this string).
- `Date` — match date (US-local). Used with the teams to identify which match a row belongs to.
- `Team` — team code (must equal your `team_code`, or its full name for name-based tabs — see below).
- `Player ID` — **stable identity (`pid`)** the bot emits per player. The PRIMARY join key: the app matches a player's `players-raw.json` `pid` to this column. Fuzzy name is only a fallback for rows/players without a pid.
- `Full Name` — canonical announced name (now consistent across feeds because the bot resolves it via the registry). Fuzzy matcher handles surname/hyphen variations on the fallback path.
- `Fantasy Points` — raw score only. Multipliers (C×2, VC×1.5) are applied in code — never pre-multiply in the sheet.
- `Played` — `"Y"` if the player featured; drives `isLikelyXI`.
- `Bat Order` — scorecard batting position; drives the draft-board XI order (see Step 0). Emitted automatically by the bot.
- `Match Status` (optional) — `LIVE` / `COMPLETED` / `COMPLETED_FLAGGED`. The completion gate
  (`getCompletedMatchKeys` + `isMatchCompleted`, via `statusByLabel`/`showsResults` in
  `lib/points.ts`) reads this: a scored match whose cricapi↔ESPN feeds still disagree stays
  **LIVE** (results hidden, live points shown) until the owner approves a value in the bot's
  `Recon Review` tab. **Optional + backward-compatible** — absent ⇒ legacy "scored ⇒ completed".
  `getMatchStatusFor` surfaces the `Recon Flag` for the results-page badges (provisional /
  official-revision-pending / single-feed-unverified). See `wwc-points-bot/RECON_REVIEW_WORKFLOW.md`.

### ✅ Points are matched by TEAMS + DATE, not the label string

`getMatchPointsForMatch()` in `lib/points.ts` ignores the `Match N` label entirely. It matches a sheet block to one of our matches by **team pair (order-independent) + closest date**. This is deliberate and durable — it means you do NOT need your `matches.json` label/number/team-order to agree with what the bot writes (the bot numbers matches by its own cricapi scheme, which often differs). Earlier we wasted cycles hand-syncing labels; don't. What MUST line up:
- **Team identifiers**: each label token must resolve to your `team1`/`team2`. The matcher accepts either the code (`TSK`, `ENG`) or the full team name via `TEAM_NAMES` (`"Bangladesh"` → `MBAN`). So as long as the team's code+name are registered in `lib/players.ts`, code-based tabs (women's, MLC) and full-name tabs (the AUS v BAN men's tab) both resolve.
- **Player `name`**: must match the bot's `Full Name` (fuzzy handles minor variants). Copy names straight from the bot's squad config (`squads.json` / `mlc_squads.json`).
- **Date**: roughly correct (±1 day tolerance covers US-vs-IST date skew). Only matters to disambiguate the two meetings of a double round-robin pair.

The `label` in `matches.json` is just what users see in the UI — keep it readable (`"Match N: A v B"`); it has no role in points lookup.

### Multiple tours = multiple tabs (`POINTS_CSV_URLS`)

Each tour is a **separate tab** in the one spreadsheet. The app reads a comma-separated list and merges all tabs at read time (identical column schema across tabs). A single `POINTS_CSV_URL` only reads ONE tab — adding a tour without adding its tab here means its points silently show 0.
```
# .env.local + Vercel (Production). Comma-separated, no spaces.
POINTS_CSV_URLS=<womens export?gid url>,<mlc gviz url>,<mens gviz url>
```
- A tab with a stable `gid` → `.../export?format=csv&gid=<gid>` (clean headers).
- A tab by name → `.../gviz/tq?tqx=out:csv&sheet=<URL-encoded tab name>&headers=1`. **`&headers=1` is REQUIRED** — without it gviz merges the header row into the first data row and column lookups break.
- `POINTS_CSV_PATH` (local dev) still overrides everything as a single source.

### Live lineups come from ESPN — keep `lib/espn.ts` in sync (tour-setup touchpoint)

"🟢 Lineups Out", the ✓ In-XI / ✗ Not-in-XI markers, BACKUP_INTELLIGENCE's auto-substitution, **and the LIVE-match H2H points** (`getLiveMatchPoints` scores in-app from ESPN via `lib/d11-score.ts`) all need ESPN, resolved by **gender** via `SERIES_BY_GENDER` = **`data/espn-series.json`**, which **must stay in sync with the points-bot's `tours.json` `espn_series`**. **Auto-ingest keeps it in sync** (`tour_sync.apply_to_repos` writes it) — it's only manual for a hand-added tour: add the series id to `data/espn-series.json[gender]`, else lineups fall back to the sheet AND live points show **0** (the 22 Jul Hundred bug). Same for `lib/registry-players.json` (the ESPN→pid mirror `resolveEspnPid` reads) — auto-synced by `tour_sync_finalize`, manual `cp` otherwise; a stale mirror = ESPN players don't join = 0 live points. Run **`npm run check:tours`** after any tour edit — it fails loud on unknown codes / a gender with no series. Cross-referenced from the bot's `TOURS.md`.

### Sheet not ready yet?

All drafts, team selection, and lobby work with no sheet at all. Until a sheet is ready:
- **Draft board** — fully functional, shows `~XX exp` next to players as a picking guide
- **Team selection** — fully functional
- **Results page** — shows `0.0 pts` in grey for all players and the scoreboard (honest: no data yet)
- **Lobby** — all matches show as Upcoming or Live; nothing moves to Completed

Once the sheet has data, the next request picks it up automatically — no redeploy needed. Failed fetches are not cached (the server retries on every request until the sheet is available).

---

## Step 5 — Vercel env vars

Update in Vercel dashboard → wwc-draft → Settings → Environment Variables:
- `POINTS_CSV_URLS` — comma-separated list of ALL tour tabs (one gviz URL per tab, each with `&headers=1`). **Add the new tour's tab here or its points silently show 0.** (`POINTS_CSV_URL`, singular, is the legacy single-tab fallback.)
- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — keep unless moving DB
- `JWT_SECRET` — keep (changing this logs everyone out)

Then also register the tour in the **wwc-points-bot** `tours.json` (cricapi/espn series, `tab`, `gender`, `squads` path) so the bot writes that tab — otherwise there's no data to read.

---

## Step 6 — DB

No migration needed. The schema is tournament-agnostic. Old contest rows stay in DB and show up in Completed for the previous tour's matches. For a clean slate: delete rows from `draft_contests`, `draft_picks`, `team_selections`, `contest_participants` via Turso dashboard. Do NOT drop/recreate tables.

---

## Step 7 — Deploy

```bash
npx vercel --prod
```

---

## Identity — the global player registry (PRIMARY; read this first)

Points are joined by a **stable identity (`pid`)**, not by name. The bot
(wwc-points-bot) maintains ONE global `registry/players.json` (keyed on `cricsheet_id`
when known) listing every feed spelling of every player, and emits a **`Player ID`**
column in every points tab. In this app:
- `players-raw.json` carries `pid` (backfilled by `registry/backfill_draft_pids.py`).
- `lib/points.ts` keys its maps by pid (and name); `lib/players.ts` `getPlayersByTeams`
  matches XI membership by `pid` first; `lookupPlayerPoints(pid, …)` looks up by pid first.
- `isPidKey()` keeps pid keys out of fuzzy name matching.
- This fixes the cases names can't: same player, different spelling across feeds
  (sheet "Tajinder Singh" ↔ our "Tajinder Dhillon" → same `pid` → joined correctly).

To add a player's missing spelling: do it ONCE in the registry
(`wwc-points-bot/registry/manual_aliases.json` → re-run `build_registry.py`), not here.

## Fuzzy name matching — the FALLBACK (shared across projects)

Used only for rows/players without a `pid`. The algorithm now lives in **one shared package**, `cricket-identity` (`github:nishantsingodia/cricket-identity`), consumed by both apps:
- `wwc-draft/lib/fuzzy-name-match.ts` — thin re-export shim → `cricket-identity`
- `cricket-auction-helper/src/lib/fuzzy-name-match.ts` — same shim

Both export `normName` and `fuzzyMatchName`. `wwc-draft/lib/points.ts` wraps it into `fuzzyLookupPoints`. `cricket-auction-helper/src/lib/squads/build-womens-pool.ts` calls `fuzzyMatchName` directly. (Previously these were two hand-mirrored copies with a "copy verbatim" rule, which drifted — now extracted to kill that hazard.)

**Rule: edit the algorithm ONLY in the cricket-identity repo, bump its version, then `npm update cricket-identity` in both apps.** Do NOT paste the algorithm back into the shim files. The package has fixtures (`src/index.test.ts`) — keep the points-bot's Python matcher aligned with them.

Do NOT duplicate this algorithm anywhere else — not in quick-sell route, not in pool/import, not inline in any component.

### Strategies (in order)
1. Exact normalized match
2. Surname + first initial — `"A Canning"` ↔ `"Ava Canning"`
3. Surname prefix + initial — `"Wyatt"` ↔ `"Wyatt-Hodge"` (norm: "wyatt" prefixes "wyatthodge"); min length 4 guards false positives
4. Full-name prefix either direction — `"Renuka Singh"` ↔ `"Renuka Singh Thakur"`, mononyms
5. Surname unique in candidate set — `"WK Dilhari"` ↔ `"Kaveesha Dilhari"` when she's the only "dilhari"

Returns `null` (not a guess) when multiple candidates match — ambiguity surfaces rather than silently resolves.

### `normName` behaviour
- NFKD decompose + diacritic strip (`"Élise"` → `"elise"`)
- Lowercase
- Strip everything except `[a-z ]` — hyphens removed joining words (`"Wyatt-Hodge"` → `"wyatthodge"`), which is what makes strategy 3 work
- Collapse whitespace

### Known aliases (auction-helper only)
Chamari Athapaththu is in the cricsheet DB as "AC Jayangani". Handled via `NAME_ALIASES` in `build-womens-pool.ts` before calling `fuzzyMatchName`. Add to that map when a player's announced name and DB name are completely unrelated (not just a format difference).

---

## Critical pitfalls

### Canonical names in players-raw.json

The CSV "Full Name" column uses the official announced name. `players-raw.json` must match. The fuzzy matcher handles surname+initial and hyphenated name variations — but NOT completely different names (e.g. Chamari Athapaththu is stored in cricsheet as "AC Jayangani" — must be set to "Chamari Athapaththu" manually).

**Rule**: Always use the announced tournament name. Never cricsheet initials.

**How to spot a mismatch**: Results page shows `0.0` in grey for a player when real data exists for others. Fix their name in `players-raw.json` and redeploy.

### Never double-apply C/VC multipliers

The results API returns both `rawPoints` (base) and `fantasyPoints` (raw × multiplier). The results page uses `rawPoints` as base and applies `mult` once for display. `calcXITotal()` sums `fantasyPoints` (already multiplied). Never re-multiply `fantasyPoints` anywhere.

**Display rule (C/VC rows):** show the multiplier *visibly already applied* — `102.0 ×2 = 204.0` (base ×mult = total), never the multiplied value next to a bare `×2`. Rendering `204.0 ×2` reads as if 204 will be doubled again (→ "is this 408? is it a bug?") — exactly the confusion that made a captain's legit 102→204 look broken. The base (`rawPoints`) goes before the `×mult`; the emphasised number is the resulting contribution. Applies anywhere C/VC points surface (results page today). See BUGS.md #8.

### Points lookup is teams + date (not label)

Historical note: matching used to be exact-label (`toCsvMatchLabel` + `flipTeams`), which broke repeatedly on team order, per-tour label formats, and the bot's match numbering. It's now `getMatchPointsForMatch(match)` keyed on **team pair + closest date** (`lib/points.ts`). Pass the `Match` object (via `getMatchByKey(contest.matchKey)`), not a label string. Don't reintroduce label-string matching.

### Don't remove player IDs mid-tournament

`draft_picks` and `team_selections` store player keys (string of `id`). Removing a player from `players-raw.json` after a draft started makes them show as unknown. Only add new entries; never delete.

---

## Points reference

```
starter_points = rawPoints × multiplier   (C=2, VC=1.5, others=1)
team_total     = sum(starter_points) for XI starters only
bench          = shown in results but NOT counted in total
```

Fuzzy match order in `fuzzyLookupPoints` (`lib/points.ts`):
1. Exact normalized (strips hyphens/apostrophes/dots)
2. Surname + first initial
3. Surname prefix match (handles "Wyatt" ↔ "Wyatt-Hodge")
4. Full name prefix either direction
5. Surname unique in candidate set

---

## Common mid-tour operations

**Squad replacement**: Add a new entry to `players-raw.json` (keep the old one — `id` is referenced in existing draft data). Re-run `registry/backfill_draft_pids.py` (wwc-points-bot) so the new player gets a `pid`. Deploy.

**Points not showing for a player**: grey `0.0` now almost always means **no `pid` link**, not a name typo. Check: (a) does the player have a `pid` in `players-raw.json`? If not, run `backfill_draft_pids.py`. (b) Is that `pid` present in the sheet's `Player ID` column for the match? If the sheet has the player under a `pid` your seed doesn't carry, the registry needs that player (add/alias in `wwc-points-bot/registry/`, re-run `build_registry.py` + backfill). Only if there's genuinely no pid on either side does it fall to the fuzzy name path (then the old "match the Full Name spelling" advice applies). Deploy.

**A whole (franchise-league) match shows "—" for players who clearly PLAYED** (e.g. The Hundred, 22 Jul — Rashid Khan took a wicket but showed "—"): the sheet's `Player ID` column is **BLANK** for those players, so the pid join fails and there's no fallback (the draft player HAS a pid, so `lookupPlayerPoints` never tries fuzzy name). Root cause is almost always that **tour-sync auto-added the tour without running `build_registry`** in wwc-points-bot, so the bot never anchored the squad → emits blank pids. Fix in the BOT: `build_registry.py "<tour>"` → `identity_healthcheck.py` → `backfill_draft_pids.py`, push the registry, then **redeploy this app** (players-raw.json is bundled at build — the re-stamped pids only take effect on deploy). Sheet pid and draft pid must be identical (both derive from the registry); deploy the draft + bot registry push together. Don't misread "Won by X" on such a match as premature — verify against the actual scorecard first (I once wrongly claimed benched when the player had a wicket).

**Confirm knockout teams**: Update `team1`/`team2` in `matches.json` from `"TBD"` to actual codes. Key and label unchanged. Deploy. Player pools update automatically at runtime.
