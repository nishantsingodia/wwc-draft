#!/usr/bin/env npx tsx
// Find any (contest_id, pick_number) duplicates across ALL contests — these would
// block a UNIQUE index and indicate the concurrency corruption persisted.
import { getDb, draftPicks, draftContests } from "../lib/db";
import { asc, eq } from "drizzle-orm";
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function main() {
  const db = getDb();
  const rows = await db.select().from(draftPicks).orderBy(asc(draftPicks.contestId), asc(draftPicks.pickNumber));
  const seen = new Map<string, number>();
  const dupes: string[] = [];
  for (const r of rows) {
    const key = `${r.contestId}:${r.pickNumber}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, n] of seen) if (n > 1) dupes.push(`${key} ×${n}`);
  console.log("total pick rows:", rows.length);
  console.log("duplicate (contest_id, pick_number):", dupes.length ? dupes : "NONE — safe to add unique index");

  // Also flag any contest whose per-user counts break the 2-player alternation
  // invariant (|count(order[0]) - count(order[1])| > 1), among live drafts.
  const contests = await db.select().from(draftContests);
  for (const c of contests) {
    if (c.status !== "DRAFTING" && c.status !== "TEAM_SELECT") continue;
    const order = JSON.parse(c.draftOrder ?? "[]") as string[];
    if (order.length !== 2) continue;
    const ps = rows.filter((r) => r.contestId === c.id);
    const a = ps.filter((r) => r.pickedBy === order[0]).length;
    const b = ps.filter((r) => r.pickedBy === order[1]).length;
    if (Math.abs(a - b) > 1 || b > a) {
      console.log(`⚠ INVARIANT BROKEN ${c.code}: ${order[0]}=${a} ${order[1]}=${b} (status ${c.status})`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
