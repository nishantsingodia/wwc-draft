#!/usr/bin/env npx tsx
/**
 * Reproduces the "both players quick-pick 10 each" corruption and proves the fix.
 *
 *   rm -f db/conc.db && TURSO_DATABASE_URL=file:db/conc.db npx tsx scripts/test-concurrency.ts buggy
 *   rm -f db/conc.db && TURSO_DATABASE_URL=file:db/conc.db npx tsx scripts/test-concurrency.ts fixed
 *
 * "buggy" builds draft_picks WITHOUT the UNIQUE(contest_id, pick_number) index
 * (prod before this change); "fixed" adds it. Both then run the SAME storm:
 * both players have a 10-deep queue and we fire the server cascade AND each
 * player's client-fallback pick concurrently, many times over — exactly what
 * happens when two tabs both quick-pick and poll every 2s.
 */
import { createClient } from "@libsql/client";
import { getDb, draftContests, draftPicks, draftQueues, contestParticipants } from "../lib/db";
import { resolveAutopicks } from "../lib/autopick";
import { currentPicker, isDraftComplete } from "../lib/snake-draft";
import { getAllPlayers, getPlayerByKey } from "../lib/players";
import { eq, asc } from "drizzle-orm";
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const MODE = (process.argv[2] ?? "fixed") as "buggy" | "fixed";
const URL = process.env.TURSO_DATABASE_URL!;

// Mimics the pick route's core (the path a client-fallback autopick takes).
async function clientPick(cid: number, user: string, poolKeys: string[]) {
  const db = getDb();
  const [c] = await db.select().from(draftContests).where(eq(draftContests.id, cid));
  if (!c || c.status !== "DRAFTING") return;
  const order = JSON.parse(c.draftOrder ?? "[]") as string[];
  if (currentPicker(order, c.pickCount) !== user) return;
  const taken = new Set((await db.select({ k: draftPicks.playerKey }).from(draftPicks).where(eq(draftPicks.contestId, cid))).map((r) => r.k));
  const key = poolKeys.find((k) => !taken.has(k));
  if (!key) return;
  const p = getPlayerByKey(key)!;
  const newPickCount = c.pickCount + 1;
  const done = isDraftComplete(order, newPickCount, c.picksPerUser, c.backupsPerUser);
  try {
    await db.batch([
      db.insert(draftPicks).values({ contestId: cid, pickedBy: user, playerKey: p.key, playerName: p.displayName, playerRole: p.role, playerTeam: p.teamCode, pickNumber: newPickCount, pickedAt: 1000 }),
      db.update(draftContests).set({ pickCount: newPickCount, status: done ? "TEAM_SELECT" : "DRAFTING" }).where(eq(draftContests.id, cid)),
    ]);
  } catch { /* lost the race — fine */ }
}

async function main() {
  // Build a fresh schema. draft_picks gets the pick_number unique index ONLY in fixed mode.
  const raw = createClient({ url: URL });
  await raw.execute("DROP TABLE IF EXISTS draft_contests");
  await raw.execute("DROP TABLE IF EXISTS draft_picks");
  await raw.execute("DROP TABLE IF EXISTS draft_queues");
  await raw.execute("DROP TABLE IF EXISTS contest_participants");
  await raw.execute(`CREATE TABLE draft_contests (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, match_key TEXT NOT NULL, match_label TEXT NOT NULL, match_deadline INTEGER NOT NULL, picks_per_user INTEGER NOT NULL DEFAULT 11, backups_per_user INTEGER NOT NULL DEFAULT 4, mode TEXT NOT NULL DEFAULT 'live', status TEXT NOT NULL DEFAULT 'WAITING', draft_order TEXT, pick_count INTEGER NOT NULL DEFAULT 0, pending_undo_by TEXT, pending_undo_target INTEGER, pending_undo_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  await raw.execute(`CREATE TABLE draft_picks (id INTEGER PRIMARY KEY AUTOINCREMENT, contest_id INTEGER NOT NULL, picked_by TEXT NOT NULL, player_key TEXT NOT NULL, player_name TEXT NOT NULL, player_role TEXT NOT NULL, player_team TEXT NOT NULL, pick_number INTEGER NOT NULL, picked_at INTEGER NOT NULL, UNIQUE(contest_id, player_key))`);
  await raw.execute(`CREATE TABLE draft_queues (id INTEGER PRIMARY KEY AUTOINCREMENT, contest_id INTEGER NOT NULL, user TEXT NOT NULL, player_keys TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL, UNIQUE(contest_id, user))`);
  await raw.execute(`CREATE TABLE contest_participants (id INTEGER PRIMARY KEY AUTOINCREMENT, contest_id INTEGER NOT NULL, user TEXT NOT NULL, joined_at INTEGER NOT NULL, UNIQUE(contest_id, user))`);
  if (MODE === "fixed") {
    await raw.execute("CREATE UNIQUE INDEX draft_picks_contest_picknum ON draft_picks(contest_id, pick_number)");
  }

  const db = getDb();
  const players = getAllPlayers();
  // 20 distinct players: first 10 → pushap's queue, next 10 → nishant's.
  const pushapPool = players.slice(0, 10).map((p) => p.key);
  const nishantPool = players.slice(10, 20).map((p) => p.key);

  const [c] = await db.insert(draftContests).values({
    code: "CONC01", matchKey: "T", matchLabel: "T", matchDeadline: 9e9,
    picksPerUser: 10, backupsPerUser: 0, status: "DRAFTING",
    draftOrder: JSON.stringify(["pushap", "nishant"]), pickCount: 0,
    createdBy: "pushap", createdAt: 1000,
  }).returning();
  const cid = c.id;
  await db.insert(contestParticipants).values([
    { contestId: cid, user: "pushap", joinedAt: 1000 },
    { contestId: cid, user: "nishant", joinedAt: 1000 },
  ]);
  await db.insert(draftQueues).values([
    { contestId: cid, user: "pushap", playerKeys: JSON.stringify(pushapPool), updatedAt: 1000 },
    { contestId: cid, user: "nishant", playerKeys: JSON.stringify(nishantPool), updatedAt: 1000 },
  ]);

  // THE STORM: fire the server cascade + both clients' fallback picks concurrently,
  // in overlapping waves, until the draft completes. This is two tabs quick-picking.
  for (let wave = 0; wave < 25; wave++) {
    await Promise.all([
      resolveAutopicks(cid),
      resolveAutopicks(cid),
      clientPick(cid, "pushap", pushapPool),
      clientPick(cid, "nishant", nishantPool),
      clientPick(cid, "pushap", pushapPool),
      clientPick(cid, "nishant", nishantPool),
    ]);
    const [cc] = await db.select().from(draftContests).where(eq(draftContests.id, cid));
    if (cc.status === "TEAM_SELECT") break;
  }

  // ---- Invariant checks --------------------------------------------------
  const [cc] = await db.select().from(draftContests).where(eq(draftContests.id, cid));
  const picks = await db.select().from(draftPicks).where(eq(draftPicks.contestId, cid)).orderBy(asc(draftPicks.pickNumber));
  const order = JSON.parse(cc.draftOrder ?? "[]") as string[];
  const numCount = new Map<number, number>();
  const userCount: Record<string, number> = {};
  let wrongOwner = 0;
  for (const p of picks) {
    numCount.set(p.pickNumber, (numCount.get(p.pickNumber) ?? 0) + 1);
    userCount[p.pickedBy] = (userCount[p.pickedBy] ?? 0) + 1;
    if (order[(p.pickNumber - 1) % 2] !== p.pickedBy) wrongOwner++;
  }
  const dups = [...numCount.entries()].filter(([, n]) => n > 1);
  const total = picks.length;
  const a = userCount[order[0]] ?? 0;
  const b = userCount[order[1]] ?? 0;

  const ok =
    total === 20 &&
    dups.length === 0 &&
    wrongOwner === 0 &&
    a === 10 && b === 10 &&
    cc.pickCount === 20;

  console.log(`\n===== MODE: ${MODE} =====`);
  console.log(`total picks: ${total} (want 20)`);
  console.log(`pickCount:   ${cc.pickCount} (want 20)`);
  console.log(`duplicate pick_numbers: ${dups.length ? JSON.stringify(dups) : "none"}`);
  console.log(`wrong-owner rows: ${wrongOwner}`);
  console.log(`counts: ${order[0]}=${a} ${order[1]}=${b} (want 10/10, first >= second)`);
  console.log(ok ? "✅ INVARIANT HOLDS" : "❌ CORRUPTED (system fucked up)");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
