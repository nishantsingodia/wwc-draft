// Registry-backed identity resolver for ESPN lineup entries.
//
// ESPN's live lineup gives an athlete id + a (sometimes differently-romanized) name. Our
// players carry a stable registry pid (a cricsheet hash, `espn:<id>`, or `slug:<name>`). To
// mark "is this player in the announced XI" by IDENTITY rather than a fuzzy name gamble, we
// resolve each ESPN athlete back to its registry pid: by ESPN id first (exact), then by the
// registry's known alias spellings. This is what lets a player whose pid ISN'T an espn id —
// e.g. `slug:kaushini-nuthyangana` (no espn id) or any `cricsheet_id` player — match the live
// ESPN XI even when ESPN's spelling differs from our display name.
//
// Mirror of wwc-points-bot/registry/players.json — re-copy after re-running build_registry.py
// (same mirror discipline as cricket-auction-helper's src/lib/registry/).

import registry from "./registry-players.json";
import { normName } from "./fuzzy-name-match";

type RegEntry = { aliases?: string[]; espn_id?: string | number | null };
const players = (registry as { players: Record<string, RegEntry> }).players;

const espnId2Pid = new Map<string, string>();
const alias2Pid = new Map<string, string>();
for (const [pid, e] of Object.entries(players)) {
  if (e.espn_id !== null && e.espn_id !== undefined && e.espn_id !== "") {
    espnId2Pid.set(String(e.espn_id), pid);
  }
  for (const a of e.aliases ?? []) {
    const k = normName(a);
    // The registry guarantees one pid per alias (0 collisions), but guard anyway.
    if (k && !alias2Pid.has(k)) alias2Pid.set(k, pid);
  }
}

// ESPN athlete (id + name) -> our stable registry pid, or null if the registry doesn't know
// this player yet (caller then falls back to fuzzy name as before).
export function resolveEspnPid(
  espnId: string | number | null | undefined,
  name: string
): string | null {
  if (espnId !== null && espnId !== undefined) {
    const byId = espnId2Pid.get(String(espnId));
    if (byId) return byId;
  }
  return alias2Pid.get(normName(name)) ?? null;
}
