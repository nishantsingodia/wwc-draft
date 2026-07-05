#!/usr/bin/env npx tsx
// Inspect a contest's picks/queues in whatever DB TURSO_DATABASE_URL points at.
//   npx tsx scripts/inspect-contest.ts NT6GEZ
import { getDb, draftContests, draftPicks, draftQueues, contestParticipants } from "../lib/db";
import { eq, asc } from "drizzle-orm";
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function main() {
  const code = (process.argv[2] ?? "NT6GEZ").toUpperCase();
  const db = getDb();
  const [c] = await db.select().from(draftContests).where(eq(draftContests.code, code));
  if (!c) { console.log("no contest", code); process.exit(0); }
  console.log("CONTEST", { id: c.id, code: c.code, status: c.status, pickCount: c.pickCount, order: c.draftOrder, picksPerUser: c.picksPerUser, backupsPerUser: c.backupsPerUser, pendingUndoBy: c.pendingUndoBy, pendingUndoTarget: c.pendingUndoTarget });

  const parts = await db.select().from(contestParticipants).where(eq(contestParticipants.contestId, c.id));
  console.log("PARTICIPANTS", parts.map((p) => p.user));

  const picks = await db.select().from(draftPicks).where(eq(draftPicks.contestId, c.id)).orderBy(asc(draftPicks.pickNumber));
  console.log(`\nPICKS (${picks.length} rows):`);
  const byNum = new Map<number, number>();
  const byUser: Record<string, number> = {};
  for (const p of picks) {
    byNum.set(p.pickNumber, (byNum.get(p.pickNumber) ?? 0) + 1);
    byUser[p.pickedBy] = (byUser[p.pickedBy] ?? 0) + 1;
    console.log(`  #${p.pickNumber}  ${p.pickedBy.padEnd(10)} ${p.playerName}`);
  }
  console.log("\nCOUNT BY USER:", byUser);
  const dupNums = [...byNum.entries()].filter(([, n]) => n > 1);
  console.log("DUPLICATE pick_numbers:", dupNums.length ? dupNums : "none");

  const order = JSON.parse(c.draftOrder ?? "[]") as string[];
  const wrongOwner = picks.filter((p) => order.length === 2 && order[(p.pickNumber - 1) % 2] !== p.pickedBy);
  console.log("PICKS OWNED BY WRONG PLAYER (per pick_number):", wrongOwner.map((p) => `#${p.pickNumber} ${p.pickedBy}`));

  const queues = await db.select().from(draftQueues).where(eq(draftQueues.contestId, c.id));
  console.log("\nQUEUES:", queues.map((q) => ({ user: q.user, keys: JSON.parse(q.playerKeys).length })));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
