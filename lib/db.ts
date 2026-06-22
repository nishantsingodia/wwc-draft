import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// --- Schema ---

export const draftContests = sqliteTable("draft_contests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  matchKey: text("match_key").notNull(),
  matchLabel: text("match_label").notNull(),
  matchDeadline: integer("match_deadline").notNull(),
  picksPerUser: integer("picks_per_user").notNull().default(11),
  backupsPerUser: integer("backups_per_user").notNull().default(4),
  mode: text("mode", { enum: ["live", "manual"] }).notNull().default("live"),
  status: text("status", {
    enum: ["WAITING", "DRAFTING", "TEAM_SELECT", "LOCKED", "COMPLETED"],
  })
    .notNull()
    .default("WAITING"),
  draftOrder: text("draft_order"), // JSON: ["nishant","pushap"]
  pickCount: integer("pick_count").notNull().default(0),
  // Pending undo request (single-flight): a player asked to roll the draft back
  // to their own last pick. The other player must approve before it executes,
  // because the rollback discards every pick from `pendingUndoTarget` onward —
  // including any the opponent made after. Null when no undo is pending.
  pendingUndoBy: text("pending_undo_by"),
  pendingUndoTarget: integer("pending_undo_target"), // discard all picks with pick_number >= this
  pendingUndoAt: integer("pending_undo_at"), // unix secs; used for TTL expiry
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

// A pending undo older than this (seconds) is treated as expired, so an
// unresponsive opponent can never permanently freeze the draft. This is a
// HUMAN approval handshake ("hey, approve my undo") — keep it generous; 3 min
// expired before players could coordinate. Either party can clear it instantly
// (requester Cancel / opponent Reject), so a long window carries no real freeze
// risk.
export const UNDO_TTL_SECONDS = 1800; // 30 min

export const draftPicks = sqliteTable(
  "draft_picks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contestId: integer("contest_id").notNull(),
    pickedBy: text("picked_by").notNull(),
    playerKey: text("player_key").notNull(),
    playerName: text("player_name").notNull(),
    playerRole: text("player_role").notNull(),
    playerTeam: text("player_team").notNull(),
    pickNumber: integer("pick_number").notNull(),
    pickedAt: integer("picked_at").notNull(),
  },
  (t) => [uniqueIndex("draft_picks_contest_player").on(t.contestId, t.playerKey)]
);

export const teamSelections = sqliteTable(
  "team_selections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contestId: integer("contest_id").notNull(),
    user: text("user").notNull(),
    selectedPlayers: text("selected_players").notNull().default("[]"), // JSON array of player_keys
    captainKey: text("captain_key"),
    viceCaptainKey: text("vice_captain_key"),
    submittedAt: integer("submitted_at"),
    isLocked: integer("is_locked", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("team_selections_contest_user").on(t.contestId, t.user)]
);

// Joined participants (track who has joined a contest)
export const contestParticipants = sqliteTable(
  "contest_participants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contestId: integer("contest_id").notNull(),
    user: text("user").notNull(),
    joinedAt: integer("joined_at").notNull(),
  },
  (t) => [uniqueIndex("participants_contest_user").on(t.contestId, t.user)]
);

// --- Client ---

let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (_db) return _db;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) throw new Error("TURSO_DATABASE_URL is not set");

  const client = createClient({
    url,
    authToken: authToken ?? undefined,
  });

  _db = drizzle(client);
  return _db;
}

export type DraftContest = typeof draftContests.$inferSelect;
export type DraftPick = typeof draftPicks.$inferSelect;
export type TeamSelection = typeof teamSelections.$inferSelect;
