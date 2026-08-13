#!/usr/bin/env npx tsx
// One-off: Match 15 (CK v JK) & Match 19 (CK v GG) real start is 19:30 IST, not 15:00.
// matches.json is fixed (commit 992d339); existing contests froze match_deadline at
// 15:00 → fix them too (match_deadline is denormalized per contest at creation).
import { getDb, draftContests } from "../lib/db";
import { eq } from "drizzle-orm";
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const FIXES = [
  { key: "M_LPL_CKvJK_0728", newIso: "2026-07-28T19:30:00+05:30" },
  { key: "M_LPL_CKvGG_0801", newIso: "2026-08-01T19:30:00+05:30" },
];
const APPLY = process.argv.includes("--apply");

async function main() {
  const db = getDb();
  for (const f of FIXES) {
    const newDeadline = Math.floor(new Date(f.newIso).getTime() / 1000);
    const rows = await db.select().from(draftContests).where(eq(draftContests.matchKey, f.key));
    console.log(`\n${f.key}: ${rows.length} contest(s). New deadline ${newDeadline} (${new Date(newDeadline * 1000).toISOString()})`);
    for (const c of rows) {
      console.log(`  code=${c.code} status=${c.status} old_deadline=${c.matchDeadline} (${new Date(c.matchDeadline * 1000).toISOString()})`);
    }
    if (APPLY) {
      for (const c of rows) {
        await db.update(draftContests).set({ matchDeadline: newDeadline }).where(eq(draftContests.id, c.id));
        console.log(`  UPDATED code=${c.code} -> ${newDeadline}`);
      }
    }
  }
  console.log(APPLY ? "\nDone." : "\nDRY RUN — pass --apply to update.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
