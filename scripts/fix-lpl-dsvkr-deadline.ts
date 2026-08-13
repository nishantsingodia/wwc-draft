#!/usr/bin/env npx tsx
// One-off: DS v KR (M_LPL_DSvKR_0721) real start is 19:30 IST, not 15:00.
// matches.json is fixed; existing contests froze match_deadline at 15:00 → fix them too.
import { getDb, draftContests } from "../lib/db";
import { eq } from "drizzle-orm";
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const MATCH_KEY = "M_LPL_DSvKR_0721";
const NEW_DEADLINE = Math.floor(new Date("2026-07-21T19:30:00+05:30").getTime() / 1000);
const APPLY = process.argv.includes("--apply");

async function main() {
  const db = getDb();
  const rows = await db.select().from(draftContests).where(eq(draftContests.matchKey, MATCH_KEY));
  console.log(`Contests for ${MATCH_KEY}: ${rows.length}`);
  console.log(`New deadline: ${NEW_DEADLINE} (${new Date(NEW_DEADLINE * 1000).toISOString()})`);
  for (const c of rows) {
    console.log(`  code=${c.code} status=${c.status} old_deadline=${c.matchDeadline} (${new Date(c.matchDeadline * 1000).toISOString()})`);
  }
  if (!APPLY) {
    console.log("\nDRY RUN — pass --apply to update.");
    return;
  }
  for (const c of rows) {
    await db.update(draftContests).set({ matchDeadline: NEW_DEADLINE }).where(eq(draftContests.id, c.id));
    console.log(`  UPDATED code=${c.code} -> ${NEW_DEADLINE}`);
  }
  console.log("Done.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
