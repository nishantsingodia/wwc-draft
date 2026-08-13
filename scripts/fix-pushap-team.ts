#!/usr/bin/env npx tsx
/**
 * One-off data correction: Pushap's NT6GEZ team never saved (client bug). Write
 * it directly (the match is past its lock deadline, so the normal /team route
 * would 403). Ranking = his 11 main draft picks (top = the XI) + his 4 backups,
 * C = Ashleigh Gardner, VC = Danni Wyatt-Hodge. Idempotent (upsert). DRY-RUN
 * unless argv includes --write.
 */
import { getDb, draftContests, teamSelections } from "../lib/db";
import { eq, and } from "drizzle-orm";
import { getPlayerByKey } from "../lib/players";
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const WRITE = process.argv.includes("--write");

// Ranking (index 0 = Captain, 1 = Vice-Captain). Top 11 = XI, last 4 = backups.
const RANKING = [
  "1132", // Ashleigh Gardner  (C)
  "836",  // Danni Wyatt-Hodge (VC)
  "2594", // Sophie Molineux
  "2488", // Charlie Dean
  "2482", // Annabel Sutherland
  "842",  // Sophie Ecclestone
  "2480", // Georgia Voll
  "7308", // Kim Garth
  "2481", // Phoebe Litchfield
  "838",  // Heather Knight
  "7309", // Lucy Hamilton
  // --- backups (below the XI line) ---
  "2484", // Grace Harris
  "854",  // Megan Schutt
  "3821", // Lauren Filer
  "7310", // Tilly Corteen-Coleman
];

async function main() {
  const db = getDb();
  const [c] = await db.select().from(draftContests).where(eq(draftContests.code, "NT6GEZ"));
  if (!c) throw new Error("NT6GEZ not found");

  // Sanity: every key resolves and the two armbands are the intended players.
  for (const k of RANKING) if (!getPlayerByKey(k)) throw new Error(`bad key ${k}`);
  console.log("XI:", RANKING.slice(0, c.picksPerUser).map((k) => getPlayerByKey(k)!.displayName).join(", "));
  console.log("BENCH:", RANKING.slice(c.picksPerUser).map((k) => getPlayerByKey(k)!.displayName).join(", "));
  console.log("C =", getPlayerByKey(RANKING[0])!.displayName, "| VC =", getPlayerByKey(RANKING[1])!.displayName);

  const [existing] = await db.select().from(teamSelections).where(and(eq(teamSelections.contestId, c.id), eq(teamSelections.user, "pushap")));
  const now = Math.floor(Date.now() / 1000);
  const row = {
    contestId: c.id,
    user: "pushap",
    selectedPlayers: JSON.stringify(RANKING),
    captainKey: RANKING[0],
    viceCaptainKey: RANKING[1],
    submittedAt: now,
    isLocked: false, // mirror Nishant's row (contest still TEAM_SELECT)
  };

  if (!WRITE) { console.log(`\n[DRY RUN] existing pushap row: ${existing ? "yes (would UPDATE)" : "no (would INSERT)"} — pass --write to apply`); process.exit(0); }

  if (existing) {
    await db.update(teamSelections).set({ selectedPlayers: row.selectedPlayers, captainKey: row.captainKey, viceCaptainKey: row.viceCaptainKey, submittedAt: now, isLocked: false }).where(and(eq(teamSelections.contestId, c.id), eq(teamSelections.user, "pushap")));
    console.log("\n✓ UPDATED pushap's team");
  } else {
    await db.insert(teamSelections).values(row);
    console.log("\n✓ INSERTED pushap's team");
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
