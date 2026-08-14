#!/usr/bin/env npx tsx
/**
 * Repair contests whose effective XI was FROZEN SHORT.
 *
 * On 13 Aug `matchPlayerInXI` was pid-authoritative without qualification: a pid'd player
 * absent from the feed's XI map was OUT, with no name fallback. When the feed pid'd NOBODY
 * on a team, that rule read our own resolution failure as the players' absence, so
 * BACKUP_INTELLIGENCE substituted them out — and their backups too, for the same reason —
 * and FROZE the result. A CPL contest ended up fielding 5 and 7 of 11.
 *
 * `matchPlayerInXI` is fixed (ed959af), but a freeze is permanent by design: the results
 * route serves it without recomputing. So the fix has to reach the frozen rows.
 *
 * This clears `effective_*` for the affected selections. It does NOT write a lineup — the
 * results route recomputes and re-freezes through the ONE substitution engine, using the
 * corrected membership rule, exactly as it would have on the night. No second scorer, no
 * hand-picked XI, nothing discretionary: the repair restores what the engine should have
 * produced, symmetrically for every player in the contest.
 *
 * This is deliberately NOT the amendment flow. An amendment is for a human decision that
 * needs consent; this is a bug whose correct answer is computed, and applying it to one
 * side and not the other would itself be unfair.
 *
 *   npx tsx scripts/fix-frozen-short-xi.ts            # dry run, prints the diff
 *   npx tsx scripts/fix-frozen-short-xi.ts --apply    # writes
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import { eq, inArray } from "drizzle-orm";
import { getDb, draftContests, teamSelections } from "../lib/db";
import { getMatchByKey, LOCK_BUFFER } from "../lib/matches";
import { getPlayerByKey, getByTeamCode } from "../lib/players";
import { getOfficialLineup } from "../lib/official-lineup";
import { getMatchPointsForMatch } from "../lib/points";
import { getMatchDelay } from "../lib/match-delay";
import { tourRulesFor } from "../lib/tour-rules";
import { computeEffectiveLineup, rankingFromSelection } from "../lib/effective-lineup";
import { calcSelectionPoints } from "../lib/contest-scoring";

const APPLY = process.argv.includes("--apply");
// Comma-separated so a repair can be scoped to the contests actually being decided on,
// rather than sweeping every settled result the scan happens to touch.
const ONLY = process.argv.find((a) => a.startsWith("--code="))?.split("=")[1];
const CODES = ONLY ? ONLY.toUpperCase().split(",").map((x) => x.trim()) : null;

async function main() {
  const db = getDb();
  const contests = CODES
    ? await db.select().from(draftContests).where(inArray(draftContests.code, CODES))
    : await db.select().from(draftContests);

  const repair: number[] = [];

  for (const c of contests) {
    const match = getMatchByKey(c.matchKey);
    if (!match) continue;
    const sels = await db.select().from(teamSelections).where(eq(teamSelections.contestId, c.id));
    // Only frozen rows can be frozen SHORT.
    const short = sels.filter((s) => {
      if (!s.effectiveComputedAt || !s.effectiveLineup) return false;
      const xi = (JSON.parse(s.effectiveLineup) as { xi: string[] }).xi ?? [];
      const squad = (JSON.parse(s.selectedPlayers ?? "[]") as string[]).length;
      // Short only counts when the squad HAD enough people to field a full XI.
      return xi.length < c.picksPerUser && squad >= c.picksPerUser;
    });
    if (short.length === 0) continue;

    const [pointsMap, { lastXI, lineupMeta }, delay] = await Promise.all([
      getMatchPointsForMatch(match),
      getOfficialLineup(match),
      getMatchDelay(c.matchKey),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const announced = !!(
      getByTeamCode(lineupMeta, match.team1)?.announced &&
      getByTeamCode(lineupMeta, match.team2)?.announced
    );
    // Mirrors the results route's `eligible` exactly.
    const eligible =
      c.mode === "live" && now >= c.matchDeadline + delay + LOCK_BUFFER && announced;

    let grew = false;
    let shrankOrArmband = false;

    console.log(`\n${c.code}  ${c.matchKey}  ppu=${c.picksPerUser}  eligible=${eligible}`);
    if (!eligible) {
      console.log("   ⚠ not eligible to re-freeze — the route would pass through top-N instead.");
    }

    for (const s of sels) {
      const ranking = rankingFromSelection(
        JSON.parse(s.selectedPlayers ?? "[]"),
        s.captainKey,
        s.viceCaptainKey
      );
      const before = calcSelectionPoints(s, c.picksPerUser, pointsMap);
      const frozen = s.effectiveLineup
        ? (JSON.parse(s.effectiveLineup) as { xi: string[] }).xi
        : [];

      const eff = computeEffectiveLineup({
        ranking,
        picksPerUser: c.picksPerUser,
        teamXIByTeam: lastXI,
        resolve: getPlayerByKey,
        inMatchTeams: [match.team1, match.team2],
        announced: eligible,
        backupIntelligence: tourRulesFor(match).backupIntelligence,
      });
      const after = calcSelectionPoints(
        {
          ...s,
          effectiveLineup: JSON.stringify({
            xi: eff.xi,
            captainKey: eff.captainKey,
            viceCaptainKey: eff.viceCaptainKey,
          }),
          effectiveComputedAt: 1,
        },
        c.picksPerUser,
        pointsMap
      );

      const added = eff.xi.filter((k) => !frozen.includes(k));
      const removed = frozen.filter((k) => !eff.xi.includes(k));
      if (added.length > 0) grew = true;
      if (removed.length > 0) shrankOrArmband = true;
      console.log(
        `   ${s.user.padEnd(9)} XI ${frozen.length} → ${eff.xi.length}   ` +
          `${(before ?? 0).toFixed(1)} → ${(after ?? 0).toFixed(1)} pts  ` +
          `(${((after ?? 0) - (before ?? 0)) >= 0 ? "+" : ""}${((after ?? 0) - (before ?? 0)).toFixed(1)})`
      );
      if (added.length) {
        console.log(
          `      back in: ${added.map((k) => getPlayerByKey(k)?.displayName ?? k).join(", ")}`
        );
      }
      // C/VC must be reported — a re-derived armband changes the multiplier.
      const oldC = s.captainKey ? getPlayerByKey(s.captainKey)?.displayName : "—";
      const newC = eff.captainKey ? getPlayerByKey(eff.captainKey)?.displayName : "—";
      if (oldC !== newC) {
        console.log(`      captain: ${oldC} → ${newC}`);
        shrankOrArmband = true;
      }
      if (removed.length) {
        console.log(
          `      would DROP: ${removed.map((k) => getPlayerByKey(k)?.displayName ?? k).join(", ")}`
        );
      }
    }

    // Repair ONLY where recomputation puts players BACK IN. That is the signature of this
    // bug: an XI that shrank because we could not resolve people. If recomputation would
    // REMOVE someone, or move the armband, that is a different question with a different
    // answer — possibly the same failure in reverse — and it must not ride along on a
    // blanket repair. Those are printed and skipped for a human to look at.
    if (grew && !shrankOrArmband) repair.push(c.id);
    else if (shrankOrArmband) {
      console.log("   ⚠ SKIPPED — recomputation would remove a player or move the armband.");
      console.log("     That is not the frozen-short bug; decide it deliberately, not in bulk.");
    } else {
      console.log("   · no change — leaving the settled freeze alone.");
    }
  }

  if (repair.length === 0) {
    console.log("\nNothing frozen short. No change needed.");
    return;
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — ${repair.length} contest(s) would be repaired. Re-run with --apply.`);
    return;
  }

  await db
    .update(teamSelections)
    .set({ effectiveLineup: null, effectiveChanges: null, effectiveComputedAt: null })
    .where(inArray(teamSelections.contestId, repair));
  console.log(
    `\n✓ Cleared the stale freeze on ${repair.length} contest(s). The results route ` +
      `recomputes and re-freezes on the next read.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
