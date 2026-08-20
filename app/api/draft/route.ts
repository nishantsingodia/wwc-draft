import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb, draftContests, contestParticipants } from "@/lib/db";
import { generateCode } from "@/lib/generate-code";
import { getMatchByKey } from "@/lib/matches";
import { getFullSquadByTeams } from "@/lib/players";
import { MAX_ROSTER, isKnownUser } from "@/lib/users";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  let username: string;
  try {
    username = await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { matchKey, picksPerUser, backupsPerUser, mode, maxPlayers, drafters } =
    await request.json();

  const match = getMatchByKey(matchKey);
  if (!match) {
    return NextResponse.json({ error: "Invalid match" }, { status: 400 });
  }

  // Coerce carefully. `Number(x) || default` turns a legit 0 into the default
  // (`0 || 4 === 4`), which silently gave every "0 backups" draft 4 backups —
  // the live draft then kept asking for backup picks. A finite + range check
  // honours 0 backups.
  const ppuNum = Number(picksPerUser);
  const bpuNum = Number(backupsPerUser);
  const mpNum = Number(maxPlayers);
  const resolvedPicks = Number.isFinite(ppuNum) && ppuNum >= 1 ? Math.floor(ppuNum) : 11;
  const resolvedBackups = Number.isFinite(bpuNum) && bpuNum >= 0 ? Math.floor(bpuNum) : 4;
  // Clamp drafters to [2, roster size]. Default 2 = the legacy head-to-head draft.
  const clampedMax =
    Number.isFinite(mpNum) && mpNum >= 2 ? Math.min(MAX_ROSTER, Math.floor(mpNum)) : 2;

  // WHICH friends are playing — manual mode only. Nobody joins a manual draft, so the
  // creator names them here and we seat them all up front; a live draft's roster is
  // whoever turns up with their own login code, and seating them from a client payload
  // would put people in a contest they never opted into.
  //
  // Never trust the list: every name must be on the roster, duplicates collapse, and the
  // creator is always in it (the client locks their own toggle, but the API is the one
  // that has to hold). maxPlayers then FOLLOWS the roster rather than being sent
  // alongside it, so the seat count and the seated people can't disagree.
  let seatedUsers: string[] = [username];
  let resolvedMax = clampedMax;
  if (mode === "manual") {
    if (drafters !== undefined) {
      if (!Array.isArray(drafters) || drafters.some((u) => typeof u !== "string")) {
        return NextResponse.json({ error: "Invalid drafters" }, { status: 400 });
      }
      const unknown = (drafters as string[]).filter((u) => !isKnownUser(u));
      if (unknown.length > 0) {
        return NextResponse.json(
          { error: `Not on the roster: ${unknown.join(", ")}` },
          { status: 400 }
        );
      }
      seatedUsers = [...new Set([username, ...(drafters as string[])])];
      if (seatedUsers.length < 2) {
        return NextResponse.json(
          { error: "Pick at least one friend to draft against." },
          { status: 400 }
        );
      }
      resolvedMax = Math.min(MAX_ROSTER, seatedUsers.length);
    }
  }

  // The pool invariant — a live *exclusive* draft can't deal more unique players
  // than the two squads hold. Validate server-side too (never trust the client);
  // getFullSquadByTeams is the same deterministic count the create form shows, so
  // the two agree. Manual mode is non-exclusive, so it's exempt.
  const poolSize = getFullSquadByTeams(match.team1, match.team2).length;
  const needed = resolvedMax * (resolvedPicks + resolvedBackups);
  if (mode !== "manual" && needed > poolSize) {
    return NextResponse.json(
      {
        error: `This match's pool has ${poolSize} players — ${resolvedMax} drafters × ${
          resolvedPicks + resolvedBackups
        } picks needs ${needed}. Reduce picks or drafters.`,
      },
      { status: 400 }
    );
  }

  const code = generateCode();
  const now = Math.floor(Date.now() / 1000);

  try {
    const db = getDb();
    await db.insert(draftContests).values({
      code,
      matchKey: match.key,
      matchLabel: match.label,
      matchDeadline: match.deadlineTs,
      picksPerUser: resolvedPicks,
      backupsPerUser: resolvedBackups,
      maxPlayers: resolvedMax,
      mode: mode === "manual" ? "manual" : "live",
      status: "WAITING",
      draftOrder: null,
      pickCount: 0,
      createdBy: username,
      createdAt: now,
    });

    // Seat everyone immediately so the draft appears in their lobby. For a live draft that's
    // just the creator (the rest join themselves); for a manual draft it's every friend named
    // above, which is what makes the draft visible to all of them from the moment it exists
    // rather than only once their team has been entered.
    const [contest] = await db
      .select()
      .from(draftContests)
      .where(eq(draftContests.code, code));
    if (contest) {
      for (const user of seatedUsers) {
        try {
          await db.insert(contestParticipants).values({
            contestId: contest.id,
            user,
            joinedAt: now,
          });
        } catch {
          // Unique constraint — already seated, fine
        }
      }
    }

    return NextResponse.json({ code, matchLabel: match.label });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }
}
