/**
 * Backfill drafters who have a team on a contest but no contest_participants row.
 *
 * Manual mode has no join step — one person enters both XIs — and until this was fixed the
 * team-write route never seated the friend it wrote for (see app/api/draft/[code]/team/route.ts).
 * The lobby is participant-scoped, so those teams went invisible: absent from the other
 * drafter's lobby entirely, and missing from the creator's match card, killing the
 * head-to-head. The team_selections row was always there and the results page scored it —
 * this only repairs what the lobby can see.
 *
 * Idempotent: re-running finds nothing once the gap is closed. Run with --apply to write;
 * without it, this is a dry run.
 *
 *   npx tsx scripts/fix-orphan-participants.ts            # dry run
 *   npx tsx scripts/fix-orphan-participants.ts --apply
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import { getDb, draftContests, teamSelections, contestParticipants } from "@/lib/db";
import { eq, and } from "drizzle-orm";

const apply = process.argv.includes("--apply");

async function main() {
  const db = getDb();

  const selections = await db
    .select({
      contestId: teamSelections.contestId,
      user: teamSelections.user,
      submittedAt: teamSelections.submittedAt,
      code: draftContests.code,
      mode: draftContests.mode,
      matchKey: draftContests.matchKey,
    })
    .from(teamSelections)
    .innerJoin(draftContests, eq(draftContests.id, teamSelections.contestId));

  const seated = new Set(
    (await db
      .select({ contestId: contestParticipants.contestId, user: contestParticipants.user })
      .from(contestParticipants)).map((p) => `${p.contestId}:${p.user}`)
  );

  const orphans = selections.filter((s) => !seated.has(`${s.contestId}:${s.user}`));

  if (orphans.length === 0) {
    console.log("No orphaned selections — every drafter with a team is seated.");
    return;
  }

  console.log(`${orphans.length} drafter(s) with a team but no participant row:`);
  for (const o of orphans) {
    console.log(`  ${o.code} (${o.mode}, ${o.matchKey}) — ${o.user}`);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to seat them.");
    return;
  }

  for (const o of orphans) {
    // joined_at = when their team was entered; that IS when they became a drafter here.
    await db.insert(contestParticipants).values({
      contestId: o.contestId,
      user: o.user,
      joinedAt: o.submittedAt ?? Math.floor(Date.now() / 1000),
    });
    console.log(`  seated ${o.user} on ${o.code}`);
  }

  // Verify, rather than trust the inserts.
  for (const o of orphans) {
    const [row] = await db
      .select()
      .from(contestParticipants)
      .where(
        and(eq(contestParticipants.contestId, o.contestId), eq(contestParticipants.user, o.user))
      );
    if (!row) throw new Error(`FAILED to seat ${o.user} on ${o.code}`);
  }
  console.log(`\nSeated ${orphans.length} drafter(s), all verified.`);
}

main();
