#!/usr/bin/env npx tsx
// TEMP: DB-only slice — how many selections lack a frozen effective lineup?
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/nishant-singodia/wwc-draft", ".env.local") });
import { getDb, draftContests, teamSelections } from "../lib/db";

async function main() {
  const db = getDb();
  const contests = await db.select().from(draftContests);
  const sels = await db.select().from(teamSelections);
  const cById = new Map(contests.map((c) => [c.id, c]));
  let frozen = 0, notFrozen = 0;
  const nf: string[] = [];
  for (const s of sels) {
    const c = cById.get(s.contestId);
    if (!c) continue;
    if (s.effectiveComputedAt && s.effectiveLineup) frozen++;
    else { notFrozen++; nf.push(`${c.code}/${c.matchKey}/${c.mode}/ppu=${c.picksPerUser}/bpu=${c.backupsPerUser}/${s.user}`); }
  }
  console.log("frozen", frozen, "NOT frozen", notFrozen);
  console.log(nf.join("\n"));
}
main().then(() => process.exit(0));
