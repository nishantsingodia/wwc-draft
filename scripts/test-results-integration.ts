#!/usr/bin/env npx tsx
/**
 * Integration check for the BACKUP_INTELLIGENCE results path: real player data
 * (getPlayerByKey) through the engine + the actual freeze write/read-back of the
 * effective_* columns. Writes throwaway rows to a LOCAL file DB and deletes them.
 *
 *   TURSO_DATABASE_URL=file:db/draft.db npx tsx scripts/test-results-integration.ts
 *
 * Refuses to run against anything that isn't a file: DB (never prod Turso).
 */
if (!/^file:/.test(process.env.TURSO_DATABASE_URL ?? "")) {
  console.error("Refusing to run: set TURSO_DATABASE_URL=file:db/draft.db (local only).");
  process.exit(1);
}

import { eq, and } from "drizzle-orm";
import { getDb, teamSelections } from "../lib/db";
import { getAllPlayers, getPlayerByKey } from "../lib/players";
import { computeEffectiveLineup, rankingFromSelection } from "../lib/effective-lineup";

async function main() {
  const db = getDb();

  // Build a realistic 15-player ranking from two real teams (8 + 7).
  const byTeam = new Map<string, string[]>();
  for (const p of getAllPlayers()) {
    if (!byTeam.has(p.teamCode)) byTeam.set(p.teamCode, []);
    byTeam.get(p.teamCode)!.push(p.key);
  }
  const teams = [...byTeam.entries()].filter(([, ks]) => ks.length >= 8).map(([t]) => t);
  const [t1, t2] = teams;
  if (!t1 || !t2) throw new Error("need two teams with >= 8 seeded players");
  const ranking = [...byTeam.get(t1)!.slice(0, 8), ...byTeam.get(t2)!.slice(0, 7)];
  console.log(`Teams ${t1} / ${t2} · ranking of ${ranking.length}`);

  // Official XI: everyone playing EXCEPT ranking[2] and ranking[5] (two dead starters).
  const dead = new Set([ranking[2], ranking[5]]);
  const teamXIByTeam = new Map<string, Map<string, number>>();
  ranking.forEach((key, i) => {
    if (dead.has(key)) return;
    const p = getPlayerByKey(key)!;
    if (!teamXIByTeam.has(p.teamCode)) teamXIByTeam.set(p.teamCode, new Map());
    teamXIByTeam.get(p.teamCode)!.set(p.pid ?? p.displayName, i + 1); // pid-first, name fallback
  });

  const norm = rankingFromSelection(ranking, ranking[0], ranking[1]);
  const eff = computeEffectiveLineup({
    ranking: norm,
    picksPerUser: 11,
    teamXIByTeam,
    resolve: getPlayerByKey,
    inMatchTeams: [t1, t2],
    announced: true,
  });
  console.log(`Effective XI: ${eff.xi.length} · C=${eff.captainKey} VC=${eff.viceCaptainKey} · ${eff.changes.length} change(s)`);

  let pass = 0;
  let fail = 0;
  const ok = (name: string, cond: boolean) => {
    cond ? pass++ : fail++;
    console.log(`  ${cond ? "✓" : "✗"} ${name}`);
  };
  ok("dead starters dropped from XI", !eff.xi.includes(ranking[2]) && !eff.xi.includes(ranking[5]));
  ok("ranked backups slid into XI", eff.xi.includes(ranking[11]) && eff.xi.includes(ranking[12]));
  ok("XI is still 11", eff.xi.length === 11);
  ok("C/VC unchanged (both playing)", eff.captainKey === ranking[0] && eff.viceCaptainKey === ranking[1]);

  // Freeze write/read-back against the real schema columns.
  const CONTEST_ID = 990001;
  const USER = "__bi_test__";
  const where = and(eq(teamSelections.contestId, CONTEST_ID), eq(teamSelections.user, USER));
  await db.delete(teamSelections).where(where); // clean any leftover
  await db.insert(teamSelections).values({
    contestId: CONTEST_ID,
    user: USER,
    selectedPlayers: JSON.stringify(ranking),
    captainKey: ranking[0],
    viceCaptainKey: ranking[1],
    submittedAt: 1,
    isLocked: true,
  });
  const [row] = await db.select().from(teamSelections).where(where);
  await db
    .update(teamSelections)
    .set({
      effectiveLineup: JSON.stringify({ xi: eff.xi, captainKey: eff.captainKey, viceCaptainKey: eff.viceCaptainKey }),
      effectiveChanges: JSON.stringify(eff.changes),
      effectiveComputedAt: 12345,
    })
    .where(eq(teamSelections.id, row.id));
  const [after] = await db.select().from(teamSelections).where(eq(teamSelections.id, row.id));
  await db.delete(teamSelections).where(eq(teamSelections.id, row.id)); // cleanup

  const frozen = after.effectiveLineup ? JSON.parse(after.effectiveLineup) : null;
  ok("freeze: effective_computed_at written", after.effectiveComputedAt === 12345);
  ok("freeze: effective_lineup round-trips (xi=11)", !!frozen && frozen.xi?.length === 11);
  ok("freeze: effective_changes round-trips", !!after.effectiveChanges && JSON.parse(after.effectiveChanges).length === eff.changes.length);
  ok("cleanup: row removed", (await db.select().from(teamSelections).where(eq(teamSelections.id, row.id))).length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
