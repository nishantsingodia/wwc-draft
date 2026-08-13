#!/usr/bin/env npx tsx
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/nishant-singodia/wwc-draft", ".env.local") });
import { getDb, draftContests, teamSelections } from "../lib/db";

async function main() {
  const db = getDb();
  const contests = await db.select().from(draftContests);
  const sels = await db.select().from(teamSelections);
  console.log("contests", contests.length, "selections", sels.length);
  const now = Math.floor(Date.now() / 1000);
  const started = contests.filter((c) => c.matchDeadline <= now);
  console.log("started contests", started.length);
  const byMatch = new Map<string, number>();
  for (const c of started) byMatch.set(c.matchKey, (byMatch.get(c.matchKey) ?? 0) + 1);
  console.log([...byMatch.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
  const selByContest = new Map<number, number>();
  for (const s of sels) selByContest.set(s.contestId, (selByContest.get(s.contestId) ?? 0) + 1);
  console.log("CPL contests:", contests.filter((c) => c.matchKey.startsWith("CPL")).map((c) => `${c.code}/${c.matchKey}/${c.mode}/${c.status}/ppu=${c.picksPerUser}/sels=${selByContest.get(c.id) ?? 0}`).join("\n"));
}
main().then(() => process.exit(0));
