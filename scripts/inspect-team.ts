#!/usr/bin/env npx tsx
import { getDb, draftContests, draftPicks, teamSelections } from "../lib/db";
import { eq, asc } from "drizzle-orm";
import { getPlayerByKey } from "../lib/players";
import { LOCK_BUFFER } from "../lib/matches";
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function main() {
  const code = (process.argv[2] ?? "NT6GEZ").toUpperCase();
  const db = getDb();
  const [c] = await db.select().from(draftContests).where(eq(draftContests.code, code));
  const now = Math.floor(Date.now() / 1000);
  console.log("CONTEST", { id: c.id, status: c.status, matchLabel: c.matchLabel, matchDeadline: c.matchDeadline, deadlineISO: new Date(c.matchDeadline * 1000).toISOString(), nowISO: new Date(now * 1000).toISOString(), lockedByDeadline: now >= c.matchDeadline + LOCK_BUFFER, picksPerUser: c.picksPerUser, backupsPerUser: c.backupsPerUser });

  const sels = await db.select().from(teamSelections).where(eq(teamSelections.contestId, c.id));
  console.log("\nTEAM_SELECTIONS rows:", sels.length);
  for (const s of sels) {
    const arr = JSON.parse(s.selectedPlayers || "[]") as string[];
    console.log(`  user=${s.user} count=${arr.length} isLocked=${s.isLocked} C=${s.captainKey} VC=${s.viceCaptainKey}`);
    console.log(`    order: ${arr.map((k) => getPlayerByKey(k)?.displayName ?? k).join(", ")}`);
  }

  const picks = await db.select().from(draftPicks).where(eq(draftPicks.contestId, c.id)).orderBy(asc(draftPicks.pickNumber));
  console.log("\nPUSHAP PICKS (in draft order):");
  picks.filter((p) => p.pickedBy === "pushap").forEach((p, i) => {
    const pl = getPlayerByKey(p.playerKey);
    console.log(`  ${i + 1}. #${p.pickNumber} key=${p.playerKey} ${p.playerName} [${pl?.role ?? p.playerRole}]${i < c.picksPerUser ? "  (main-XI slot)" : "  (backup)"}`);
  });
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
