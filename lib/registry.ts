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
import { normName, fuzzyMatchName } from "./fuzzy-name-match";

type RegEntry = {
  aliases?: string[];
  espn_id?: string | number | null;
  // alternate ESPNcricinfo profile ids (key_cricinfo_2/_3) — the SAME person under a duplicate
  // ESPN page (e.g. Abhishek Sharma 1070183 + 1131614). Index them so a live roster reporting
  // the alternate id still resolves to the one canonical pid instead of forking.
  cricinfo_alt?: (string | number)[];
};
const players = (registry as { players: Record<string, RegEntry> }).players;

const espnId2Pid = new Map<string, string>();
const alias2Pid = new Map<string, string>();
for (const [pid, e] of Object.entries(players)) {
  if (e.espn_id !== null && e.espn_id !== undefined && e.espn_id !== "") {
    espnId2Pid.set(String(e.espn_id), pid);
  }
  for (const alt of e.cricinfo_alt ?? []) {
    if (alt !== null && alt !== undefined && alt !== "") {
      const k = String(alt);
      if (!espnId2Pid.has(k)) espnId2Pid.set(k, pid);
    }
  }
  for (const a of e.aliases ?? []) {
    const k = normName(a);
    // The registry guarantees one pid per alias (0 collisions), but guard anyway.
    if (k && !alias2Pid.has(k)) alias2Pid.set(k, pid);
  }
}
// Candidate list for the shared fuzzy matcher (all known alias spellings, normalized once).
const aliasKeys = [...alias2Pid.keys()];

// ESPN athlete (id + name) -> our stable registry pid, or null if the registry doesn't know
// this player yet (caller then falls back to fuzzy name as before).
export function resolveEspnPid(
  espnId: string | number | null | undefined,
  name: string
): string | null {
  if (espnId !== null && espnId !== undefined) {
    const byId = espnId2Pid.get(String(espnId));
    if (byId) return byId;
    // CONSTRUCT IT. ESPN's athlete.id IS the cricinfo id, so `ci:<athlete.id>` is the pid by
    // definition — no lookup, no name, nothing to be ambiguous about. The registry lookup above
    // still runs FIRST because it is the only thing that resolves an ALTERNATE ESPN profile
    // (cricinfo_alt _2/_3) back to the player's canonical id; this is purely its fallback.
    //
    // Why it matters: a DEBUTANT cannot be in the mirror — his id does not exist until ESPN
    // publishes him — and the mirror also goes stale whenever build_registry is run by hand. Both
    // used to drop straight through to fuzzy NAME matching, which is the one route this project
    // forbids for identity, and a null from it made matchPlayerInXI judge a player who PLAYED as
    // not-in-XI. That is how a CPL contest's XI shrank from 11 to 5 and scored 286 v 645.
    // Constructing the id removes the dependence on both the mirror and the name entirely.
    const s = String(espnId).trim();
    if (/^[1-9][0-9]*$/.test(s)) return `ci:${s}`;
  }
  // Exact normalized alias first (fast, unambiguous)…
  const exact = alias2Pid.get(normName(name));
  if (exact) return exact;
  // …then the SHARED cricket-identity fuzzy matcher (surname+initial, hyphen, prefix) — the
  // same algorithm the points join uses. It returns null on ambiguity, so it won't gamble a
  // namesake. This catches ESPN spellings the registry doesn't carry verbatim.
  const m = fuzzyMatchName(name, aliasKeys);
  return m ? (alias2Pid.get(m) ?? null) : null;
}
