# N-Player Drafts (2–6) — Design & Build Plan

> **Status:** BUILT 2026-07-10 (all areas A–G), verified (tsc + build + 45 tests green), **not yet committed/deployed**. Turso migrated (`max_players`, `pending_undo_approvals`). Blocking deploy: the 4 extra roster seats are placeholders (`PLAYER3`–`PLAYER6`) — swap in real names + codes first.
> **Scope:** Grow live + manual drafts from exactly 2 players to a **creator-configurable N (2–6)**.
> **Framing:** This is "N-player drafts," not "6-player." Everything is parameterised on N; 6 is just the ceiling the friend group needs.

## Build status (2026-07-10)

| Area | State | Where |
|---|---|---|
| A · Identity roster (→6) | ✅ | `lib/users.ts` (`ROSTER` list, `MAX_ROSTER`) — 2 real + 4 placeholders |
| B · Config + invariant | ✅ | `max_players` col; create form "Friends" stepper + live pool gauge; server re-validates `N×(picks+backups) ≤ pool` |
| C · Join cap / start-when-full | ✅ | `join/route.ts` — waits for all seats, rejects overflow, toss only when N=2 |
| D · Order reveal (3+) | ✅ | `OrderRevealScreen` in the board — shuffle→reveal→snake note, once per device |
| E · Undo consensus | ✅ | `pending_undo_approvals` col; every affected picker must approve; instant if none affected |
| F · Team page (N others) | ✅ | collapsible per-other-team; manual pool exclusive across ALL others |
| G · Copy | ✅ | "Waiting for players (x/N)" in hub + lobby + effective-state |

All new behaviour no-ops for `maxPlayers = 2`; verified 2-player path unchanged.

---

## 1. The decision that shaped this (read first)

A contest's draft pool is **exactly the two cricket teams in the match** (`getPlayersByTeams`), i.e. the combined squads ≈ **30 players** for a T20 international (15+15), up to ~40 for the biggest franchise pairings. An *exclusive* draft can therefore only hand out `poolSize` unique players total.

**Chosen model — creator-configured, exclusive, pool-bounded.** The draft creator sets three numbers:

- **Friends** — N, the number of drafters (2–6)
- **Starters per friend**
- **Backups per friend**

subject to one **hard invariant**:

```
N × (starters + backups)  ≤  matchSquadSize
```

where `matchSquadSize = getFullSquadByTeams(team1, team2).length` (both teams' full seeded squads).

There is **no fixed 6→5-a-side table**. If two big squads give a 40-player pool, six friends can draft 6 apiece; if it's a lean 26-player pool, the form won't let six friends past ~4 each. The form computes the pool live and clamps/blocks accordingly.

### Why this invariant is safe for the whole draft's life

`getPlayersByTeams` returns the **full combined squad** and only ever **grows**:
- self-heal merges in live-feed players not in `players-raw.json`,
- squad replacements only ever *add* rows (the CLAUDE.md "never delete a player" rule).

It **never shrinks** — not even when official lineups drop (announced XI only flips the `isLikelyXI` flag; non-XI players stay draftable). So a draft that satisfied the invariant at creation can never become over-subscribed later. Validated once at creation = valid forever.

> Use `getFullSquadByTeams(team1, team2)` for the create-time count — it's deterministic (no lineup/sheet fetch) and matches the seeded pool. Knockout matches with `TBD` teams are already excluded from the create flow (`create/page.tsx` filters `team1 !== "TBD"`), so an empty pool can't be drafted.

---

## 2. What's already N-ready (do NOT touch)

The data + turn layer was written generically, and the **9 Jul 2026 live-match revamp** (`0ded7c2`) extended N-awareness into the scoring surfaces too. Confirmed working for N>2 today:

| Area | File | Note |
|---|---|---|
| Turn order | `lib/snake-draft.ts` | Snake for N>2 already implemented; `isDraftComplete` uses `order.length × (picks+backups)` |
| Schema | `lib/db.ts` | All tables keyed **per user**; `draftOrder` is a JSON username array — no `user1/user2` anywhere |
| Autopick | `lib/autopick.ts` | Cascades over the full `order`, N-generic |
| Pick | `app/api/draft/[code]/pick/route.ts` | N-generic |
| Auto-start 3+ | `app/api/draft/[code]/join/route.ts:88-99` | **Already auto-shuffles & starts for 3+ players** |
| Summary scorer | `lib/contest-scoring.ts` | `calcSelectionPoints` — the ONE shared per-selection scorer (lobby + match hub). N-generic. Must byte-match the results route. |
| Effective state | `lib/effective-state.ts` | Pure `match-state × draft-status → {label, cta, href}`. N-agnostic except two copy strings ("Waiting for opponent/players"). |
| Match hub | `app/match/[key]/page.tsx` | **Already N-aware**: computes rank-of-N, renders "Nth of M" chips (:316-323), floats the action-needed draft. Scoreline is you-vs-leader (H2H reduction). Only copy polish left. |
| Results page | `app/draft/[code]/results/page.tsx` | **Already N-aware**: H2H hero shows you-vs-leader + rank; H2H tab switches to horizontal-scroll columns for 3+ (:274). Verify + optional hero leaderboard. |
| Effective lineup | `lib/effective-lineup.ts` | Per-user, N-generic |

The `[team1Code, team2Code]` split and 2-column player grid in `app/draft/[code]/page.tsx` are the **two cricket nations** (always 2 per match) — legitimately 2, leave alone.

> **Revamp reconciliation (9 Jul):** the earlier plan listed the results scoreboard and winner display as build work. The revamp already shipped them N-aware, so those items are **downgraded to verify + copy**. What remains genuinely unbuilt: identity, create-form config, join cap, order reveal, undo consensus, and the team page.

---

## 3. What needs building (by area)

### A. Identity — the real ceiling `lib/users.ts`, `lib/auth.ts`
Only two login codes exist (`NISH2026`, `PUSH2026`). **Nothing can exceed 2 humans until this grows.** Cheapest correct fix for a friends app: extend the static roster to 6–8 named friends — add codes to `USERS`, plus `USER_COLORS` + `USER_LABELS` entries (3rd+ players currently fall back to gray dots + raw usernames). `isKnownUser`/`ALL_USERS` follow automatically. **No account system.**

### B. Contest config `app/draft/create/page.tsx`, `app/api/draft/route.ts`, `lib/db.ts`
- Add a **"Friends" (N)** stepper (2–6) to the create form.
- Compute `matchSquadSize` for the selected match and show it (e.g. "Pool: 30 players").
- **Live invariant enforcement**: as N / starters / backups change, block Create and show why if `N × (starters+backups) > matchSquadSize`. Auto-cap the steppers to what fits.
- Persist **`maxPlayers`** on `draft_contests` (new column; default 2 for back-compat) so join/board know the target.
- API re-validates the invariant server-side (never trust the client).

### C. Join / start `app/api/draft/[code]/join/route.ts`
- `canStart` for live = `users.length >= maxPlayers` (was `>= 2`).
- Reject the `maxPlayers+1`-th joiner (there's currently **no upper cap** — the 2-user table was the only limiter).
- Lobby "waiting for players" reflects `joined / maxPlayers`.

### D. Draft order / toss `toss/route.ts`, `CoinTossScreen` in `app/draft/[code]/page.tsx`
- N=2 → keep the coin-toss ceremony (it's good).
- N≥3 → today it *silently* random-shuffles. **Proposed:** upgrade to a visible **"draft order reveal"** (animate the shuffled order) so 3+ players see who's picking when. `toss/route.ts` currently errors unless exactly 2; generalise or bypass for N≥3.

### E. Undo consensus `app/api/draft/[code]/undo/route.ts` + banners in `page.tsx`
The single genuine **logic** redesign. Today one arbitrary opponent approves a rollback that can discard *other innocent players'* picks. **Proposed N rule:**
- Undo still rolls back to the requester's own most-recent pick (`target`).
- Approval required from **every player who has a pick with `pickNumber ≥ target`** (i.e. everyone who'd lose a pick), not just `others[0]`.
- If *no one else's* picks are affected (nobody picked after you), the undo is **instant, no handshake**.
- UI: show the set of required approvers and who's approved; execute only when all have. (`pendingUndoBy`/`Target`/`At` columns stay; may add an approvals set.)

### F. Team page — the remaining UI lift `app/draft/[code]/team/page.tsx`, `app/api/draft/[code]/team/route.ts`
- Replace the single `opponent = friends.find(u => u !== editUser)` + one "OTHER FRIEND'S TEAM" panel with a **loop over all N-1 others** (roster list, points, C/VC).
- Manual mode's "build BOTH teams" toggle → "build **any of N** teams"; `team/route.ts` write-any-user gate widens with the expanded roster.
- Seed rankings from `participants` (fall back to full roster only when needed).
- **Lower priority than before the revamp:** the *results* page now owns the N-way team comparison (H2H tab, all columns). The team page's opponent panel is mostly a pre-lock convenience — consider a compact N-preview or just leaning on the results link rather than a full N-roster rebuild here.

### G. Cosmetics / labels (low risk, do last)
- Singular "opponent" / "vs" / "waiting for opponent" copy → N-aware. Known spots: draft board `lastOppPick`; lobby threshold `participants.length < 2`; match hub `.join(" vs ")` (:284) + "Waiting for opponent to join" (:348) + "You vs …" (:350); `effective-state.ts` "Waiting for opponent/players".
- Match hub scoreline + results hero are **you-vs-leader** reductions — fine for N, but decide if a compact top-3 strip is wanted (optional).
- Verify `USER_COLORS`/`USER_LABELS` cover all roster members (done in A) — the revamp still falls back to `bg-gray-500` + raw usernames for unmapped users.

---

## 4. Phased build order

1. **Foundation** — A (identity) + B (config + `maxPlayers` column + invariant, client & server). Nothing else works without these. *Migration: add `max_players` to prod Turso before deploy.*
2. **Flow** — C (join cap on `maxPlayers`) + D (order/toss for N≥3).
3. **Undo** — E (consensus rule). Isolated; can land independently.
4. **Team UI** — F (N-opponent rosters + manual any-team).
5. **Polish** — G (labels, responsive scoreboard, colors).

Each phase is independently shippable and leaves the app working for the existing 2-player case (all new behaviour gates on `maxPlayers > 2`).

---

## 5. Open decisions (proposed defaults above — confirm before Phase 2/3)

- **Undo (E):** confirm the "all affected pickers must approve; instant if none affected" rule.
- **Order reveal (D):** confirm animated reveal for N≥3 vs. keeping the silent shuffle.

## 6. Invariants & gotchas to preserve

- `N × (starters + backups) ≤ matchSquadSize` — enforce on **both** client and server; pool only grows, so creation-time validation is durable.
- All new behaviour must **no-op for `maxPlayers = 2`** so existing/legacy contests are untouched.
- Two scoring paths still exist (lobby + results route) — any scoring-adjacent change must touch both (see `feedback_two_scoring_paths`).
- Deploy = commit + `vercel --prod` + push; migrate prod Turso (`max_players`) **before** deploying the code that reads it.
