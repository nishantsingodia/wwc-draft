import { getDb, matchDelays } from "@/lib/db";

// Manual rain/delay override, per match_key. `extra_seconds` is ADDED to a match's
// deadline everywhere the deadline gates team-lock / "Live" / scoring, so a delayed
// toss doesn't prematurely lock teams or start scoring. See lib/db.ts matchDelays.
//
// Reads are cached for a few seconds (every server render / route hit would otherwise
// hit Turso); writes bust the cache so a "+30 min" tap takes effect on the next poll.

const TTL_MS = 5_000;
let _cache: { at: number; map: Map<string, number> } | null = null;

// Sanity bound so a fat-fingered value can't push a match absurdly far out. Generous
// (a washed-out session can span hours) but finite. A reset (0) is always allowed.
export const MAX_DELAY_SECONDS = 8 * 3600;

export async function getAllMatchDelays(): Promise<Map<string, number>> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.map;
  try {
    const rows = await getDb().select().from(matchDelays);
    const map = new Map<string, number>(rows.map((r) => [r.matchKey, r.extraSeconds]));
    _cache = { at: Date.now(), map };
    return map;
  } catch {
    // DB unavailable — degrade to "no delay" rather than break every page that reads it.
    return _cache?.map ?? new Map();
  }
}

export async function getMatchDelay(matchKey: string): Promise<number> {
  return (await getAllMatchDelays()).get(matchKey) ?? 0;
}

// Add `seconds` to a match's delay (clamped to [0, MAX]). Returns the new total.
export async function addMatchDelay(
  matchKey: string,
  seconds: number,
  user: string
): Promise<number> {
  const current = await getMatchDelay(matchKey);
  const next = Math.max(0, Math.min(MAX_DELAY_SECONDS, current + seconds));
  await upsert(matchKey, next, user);
  return next;
}

// Set the delay to an exact value (used for reset → 0). Returns the value set.
export async function setMatchDelay(
  matchKey: string,
  seconds: number,
  user: string
): Promise<number> {
  const next = Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.round(seconds)));
  await upsert(matchKey, next, user);
  return next;
}

async function upsert(matchKey: string, extraSeconds: number, user: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(matchDelays)
    .values({ matchKey, extraSeconds, updatedAt: now, updatedBy: user })
    .onConflictDoUpdate({
      target: matchDelays.matchKey,
      set: { extraSeconds, updatedAt: now, updatedBy: user },
    });
  _cache = null; // next read reflects the write immediately
}
