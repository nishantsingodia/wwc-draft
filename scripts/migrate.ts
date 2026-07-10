#!/usr/bin/env npx tsx
/**
 * Run this once to create the tables in Turso:
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npx tsx scripts/migrate.ts
 *
 * For local dev with a file-based SQLite (no Turso account yet), set:
 *   TURSO_DATABASE_URL=file:db/draft.db
 */
import { createClient } from "@libsql/client";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const url = process.env.TURSO_DATABASE_URL ?? "file:db/draft.db";
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient({ url, authToken: authToken ?? undefined });

const DDL = [
  `CREATE TABLE IF NOT EXISTS draft_contests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    match_key TEXT NOT NULL,
    match_label TEXT NOT NULL,
    match_deadline INTEGER NOT NULL,
    picks_per_user INTEGER NOT NULL DEFAULT 11,
    backups_per_user INTEGER NOT NULL DEFAULT 4,
    mode TEXT NOT NULL DEFAULT 'live',
    status TEXT NOT NULL DEFAULT 'WAITING',
    draft_order TEXT,
    pick_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS draft_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contest_id INTEGER NOT NULL,
    picked_by TEXT NOT NULL,
    player_key TEXT NOT NULL,
    player_name TEXT NOT NULL,
    player_role TEXT NOT NULL,
    player_team TEXT NOT NULL,
    pick_number INTEGER NOT NULL,
    picked_at INTEGER NOT NULL,
    UNIQUE(contest_id, player_key)
  )`,
  `CREATE TABLE IF NOT EXISTS team_selections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contest_id INTEGER NOT NULL,
    user TEXT NOT NULL,
    selected_players TEXT NOT NULL DEFAULT '[]',
    captain_key TEXT,
    vice_captain_key TEXT,
    submitted_at INTEGER,
    is_locked INTEGER NOT NULL DEFAULT 0,
    effective_lineup TEXT,
    effective_changes TEXT,
    effective_computed_at INTEGER,
    UNIQUE(contest_id, user)
  )`,
  `CREATE TABLE IF NOT EXISTS contest_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contest_id INTEGER NOT NULL,
    user TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    UNIQUE(contest_id, user)
  )`,
  // Server-side autopick queue (one ordered player_key list per contest+user).
  // Additive; existing contests simply have no queue rows until a user saves one.
  `CREATE TABLE IF NOT EXISTS draft_queues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contest_id INTEGER NOT NULL,
    user TEXT NOT NULL,
    player_keys TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    UNIQUE(contest_id, user)
  )`,
];

// SQLite has no `ADD COLUMN IF NOT EXISTS`, so check the table shape first.
async function addColumnIfMissing(table: string, column: string, definition: string) {
  const info = await client.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some((r) => r.name === column);
  if (exists) {
    console.log(`• ${table}.${column} already exists`);
    return;
  }
  await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`✓ added ${table}.${column}`);
}

async function migrate() {
  console.log("Connecting to:", url);
  for (const sql of DDL) {
    await client.execute(sql);
    console.log("✓", sql.slice(0, 60).trim() + "...");
  }

  // N-player drafts: how many drafters a contest is for (2–6). Additive, safe on
  // existing rows — DEFAULT 2 makes every prior contest a 2-player draft, i.e. no
  // behaviour change until a creator picks a higher number.
  await addColumnIfMissing("draft_contests", "max_players", "INTEGER NOT NULL DEFAULT 2");

  // Undo feature: pending-undo columns on draft_contests (additive, safe on
  // existing rows — all default to NULL = no undo pending).
  await addColumnIfMissing("draft_contests", "pending_undo_by", "TEXT");
  await addColumnIfMissing("draft_contests", "pending_undo_target", "INTEGER");
  await addColumnIfMissing("draft_contests", "pending_undo_at", "INTEGER");
  // N-player undo consensus: usernames who approved the pending undo (JSON array).
  await addColumnIfMissing("draft_contests", "pending_undo_approvals", "TEXT");

  // Turn serialization: a (contest, pick_number) can be filled exactly once, so
  // concurrent autopick/pick races can never double-fill or mis-attribute a turn.
  // Safe to add only if no existing duplicates — verified via check-pick-dupes.ts.
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS draft_picks_contest_picknum ON draft_picks(contest_id, pick_number)"
  );
  console.log("✓ unique index draft_picks_contest_picknum");

  // BACKUP_INTELLIGENCE: frozen effective lineup + change log on team_selections,
  // computed once post-lock when lineups are announced (additive, NULL on existing
  // rows = not yet computed).
  await addColumnIfMissing("team_selections", "effective_lineup", "TEXT");
  await addColumnIfMissing("team_selections", "effective_changes", "TEXT");
  await addColumnIfMissing("team_selections", "effective_computed_at", "INTEGER");

  console.log("Migration complete.");
  client.close();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
