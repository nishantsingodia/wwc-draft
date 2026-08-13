#!/usr/bin/env npx tsx
/**
 * One-off data correction: Pushap's GBUME5 (Match 5: IND v ENG) team never saved
 * (same client bug as NT6GEZ). Write it directly — the match is live / past its lock
 * deadline, so the normal /team route would 403. Order is exactly as the user gave it;
 * C = Abhishek Sharma, VC = Sam Curran (set via explicit columns, not list position).
 * Mirrors Nishant's row (isLocked=false, contest still TEAM_SELECT). Idempotent (upsert).
 * DRY-RUN unless argv includes --write.
 */
import { getDb, draftContests, teamSelections } from "../lib/db";
import { eq, and } from "drizzle-orm";
import { getPlayerByKey } from "../lib/players";
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const WRITE = process.argv.includes("--write");
const CODE = "GBUME5";
const CAPTAIN = "10146"; // Abhishek Sharma
const VICE = "10181"; // Sam Curran

// XI in the exact order the user supplied (11 picks, 0 backups for this contest).
const RANKING = [
  "10146", // Abhishek Sharma      (C)
  "10149", // Shreyas Iyer
  "10181", // Sam Curran           (VC)
  "10158", // Suryansh Shedge
  "10176", // Phil Salt
  "10178", // Harry Brook
  "10182", // Liam Dawson
  "10156", // Prince Yadav
  "10184", // Adil Rashid
  "10153", // Axar Patel
  "10157", // Vaibhav Sooryavanshi
];

async function main() {
  const db = getDb();
  const [c] = await db.select().from(draftContests).where(eq(draftContests.code, CODE));
  if (!c) throw new Error(`${CODE} not found`);

  // Sanity: every key resolves; count matches the contest; armbands are inside the XI.
  for (const k of RANKING) if (!getPlayerByKey(k)) throw new Error(`bad key ${k}`);
  if (RANKING.length !== c.picksPerUser + c.backupsPerUser)
    throw new Error(`RANKING has ${RANKING.length}, contest wants ${c.picksPerUser}+${c.backupsPerUser}`);
  if (!RANKING.includes(CAPTAIN) || !RANKING.includes(VICE)) throw new Error("C/VC not in RANKING");

  console.log("CONTEST:", { id: c.id, status: c.status, matchLabel: c.matchLabel, picksPerUser: c.picksPerUser, backupsPerUser: c.backupsPerUser });
  console.log("XI:", RANKING.slice(0, c.picksPerUser).map((k) => getPlayerByKey(k)!.displayName).join(", "));
  if (c.backupsPerUser > 0)
    console.log("BENCH:", RANKING.slice(c.picksPerUser).map((k) => getPlayerByKey(k)!.displayName).join(", "));
  console.log("C =", getPlayerByKey(CAPTAIN)!.displayName, "| VC =", getPlayerByKey(VICE)!.displayName);

  const [existing] = await db.select().from(teamSelections).where(and(eq(teamSelections.contestId, c.id), eq(teamSelections.user, "pushap")));
  const now = Math.floor(Date.now() / 1000);
  const row = {
    contestId: c.id,
    user: "pushap",
    selectedPlayers: JSON.stringify(RANKING),
    captainKey: CAPTAIN,
    viceCaptainKey: VICE,
    submittedAt: now,
    isLocked: false, // mirror Nishant's row (contest still TEAM_SELECT)
  };

  if (!WRITE) { console.log(`\n[DRY RUN] existing pushap row: ${existing ? "yes (would UPDATE)" : "no (would INSERT)"} — pass --write to apply`); process.exit(0); }

  if (existing) {
    await db.update(teamSelections).set({ selectedPlayers: row.selectedPlayers, captainKey: CAPTAIN, viceCaptainKey: VICE, submittedAt: now, isLocked: false }).where(and(eq(teamSelections.contestId, c.id), eq(teamSelections.user, "pushap")));
    console.log("\n✓ UPDATED pushap's team");
  } else {
    await db.insert(teamSelections).values(row);
    console.log("\n✓ INSERTED pushap's team");
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
