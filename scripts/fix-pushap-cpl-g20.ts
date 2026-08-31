#!/usr/bin/env npx tsx
/**
 * One-off data correction: Pushap never tapped SAVE on Y3G2Y3 (CPL Match 20,
 * MTTRI v MTJAM, 29 Aug) — his 15 draft picks are all in draft_picks but
 * team_selections had no row for him at all, so he scored nothing. Write it
 * directly: the match is long past its lock deadline, so /api/draft/[code]/team
 * would 403. Same shape as scripts/fix-pushap-team.ts.
 *
 * Ranking = his picks in draft order, per his instruction. The stored ranking IS
 * the armband source (index 0 = C, index 1 = VC) and top picksPerUser = the XI,
 * so pick order gives C = Saim Ayub, VC = Kieron Pollard. Worth recording that
 * this choice is outcome-neutral here: his XI's base total is 431, so even the
 * most favourable armbands possible (C Munro +94, VC Hunain Shah +45.5 => 570.5)
 * lose to Nishant's 629. Pick order yields 476.
 *
 * effective_lineup is deliberately left NULL. BACKUP_INTELLIGENCE can't be
 * honestly reconstructed two days late — computeEffectiveLineup reads
 * getLastPlayedXI(), which by now holds a LATER CPL match and would substitute
 * against the wrong XI. It costs nothing here: all 11 of his XI played, so the
 * pass-through path in calcSelectionPoints (top-N by rank) is exactly what BI
 * would have produced anyway. Verified before writing.
 *
 * Idempotent (upsert). DRY-RUN unless argv includes --write.
 */
import { getDb, draftContests, draftPicks, teamSelections } from "../lib/db";
import { eq, and, asc } from "drizzle-orm";
import { getPlayerByKey } from "../lib/players";
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const WRITE = process.argv.includes("--write");
const CODE = "Y3G2Y3";
const USER = "pushap";

async function main() {
  const db = getDb();
  const [c] = await db.select().from(draftContests).where(eq(draftContests.code, CODE));
  if (!c) throw new Error(`${CODE} not found`);

  // Ranking comes from the DB, not a hand-typed list — pick order is the instruction,
  // and retyping 15 keys is how a transcription error gets into a settled result.
  const picks = (
    await db
      .select()
      .from(draftPicks)
      .where(eq(draftPicks.contestId, c.id))
      .orderBy(asc(draftPicks.pickNumber))
  ).filter((p) => p.pickedBy === USER);

  const RANKING = picks.map((p) => p.playerKey);
  const expected = c.picksPerUser + c.backupsPerUser;
  if (RANKING.length !== expected) {
    throw new Error(`expected ${expected} picks for ${USER}, got ${RANKING.length} — refusing to write a partial squad`);
  }
  if (new Set(RANKING).size !== RANKING.length) throw new Error("duplicate player_key in picks");
  for (const k of RANKING) if (!getPlayerByKey(k)) throw new Error(`unresolvable player key ${k}`);

  const name = (k: string) => getPlayerByKey(k)!.displayName;
  console.log(`CONTEST ${c.code} (id ${c.id}) — ${c.matchLabel}`);
  console.log(`XI:    ${RANKING.slice(0, c.picksPerUser).map(name).join(", ")}`);
  console.log(`BENCH: ${RANKING.slice(c.picksPerUser).map(name).join(", ")}`);
  console.log(`C = ${name(RANKING[0])} | VC = ${name(RANKING[1])}`);

  const [existing] = await db
    .select()
    .from(teamSelections)
    .where(and(eq(teamSelections.contestId, c.id), eq(teamSelections.user, USER)));

  const now = Math.floor(Date.now() / 1000);
  const row = {
    contestId: c.id,
    user: USER,
    selectedPlayers: JSON.stringify(RANKING),
    captainKey: RANKING[0],
    viceCaptainKey: RANKING[1],
    submittedAt: now,
    isLocked: false, // mirror nishant's row on this contest (still TEAM_SELECT)
  };

  if (!WRITE) {
    console.log(`\n[DRY RUN] existing ${USER} row: ${existing ? "yes (would UPDATE)" : "no (would INSERT)"} — pass --write to apply`);
    process.exit(0);
  }

  if (existing) {
    await db
      .update(teamSelections)
      .set({
        selectedPlayers: row.selectedPlayers,
        captainKey: row.captainKey,
        viceCaptainKey: row.viceCaptainKey,
        submittedAt: now,
        isLocked: false,
      })
      .where(and(eq(teamSelections.contestId, c.id), eq(teamSelections.user, USER)));
    console.log(`\n✓ UPDATED ${USER}'s team on ${CODE}`);
  } else {
    await db.insert(teamSelections).values(row);
    console.log(`\n✓ INSERTED ${USER}'s team on ${CODE}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
