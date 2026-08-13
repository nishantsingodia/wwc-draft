import raw from "@/data/auction-ownership.json";
import { ROSTER, getUserHex } from "@/lib/users";
import { normName } from "@/lib/fuzzy-name-match";

// Auction ownership snapshot bridged from the local auction app (see
// scripts/sync-auction-ownership.py). `byPid` is keyed by the stable pid (ci:<cricinfoId>) →
// tour → the friends who bought that player in each auction of the tour. `no` is the auction's
// serial within the tour (1 = first auction with sales), so the UI can show "Ni1", "Pu2".
// `byName` is the fallback index (tour → name key → pid) for scorecard rows whose ESPN-resolved
// pid is null or a different cricinfo id than the auction's — see the resolver below.
type Owner = { no: number; short: string; name: string; isMe: boolean };
const SNAP = raw as {
  byPid: Record<string, Record<string, Owner[]>>;
  byName: Record<string, Record<string, string>>;
};
const DATA = SNAP.byPid;
const NAMES = SNAP.byName;

// Map an auction owner's full name (e.g. "Nishant") back to the roster's hex colour, so the
// auction tags read in the SAME friend colours as everywhere else in the app.
const LABEL_TO_USER = new Map(ROSTER.map((m) => [m.label.toLowerCase(), m.username]));

// CPL's franchise codes are ALSO "MT…"-prefixed (the men's namespace), so they collide with
// The Hundred Men's prefix below and must be matched explicitly, BEFORE it.
const CPL_CODES = new Set(["MTANT", "MTBAR", "MTGUY", "MTJAM", "MTSTK", "MTSTL", "MTTRI"]);

// Which auction tour a match belongs to, from its (namespaced) team code. Only the
// bridged tours resolve; everything else returns null (no auction tags shown).
export function tourForTeamCode(code: string): string | null {
  if (CPL_CODES.has(code)) return "CPL 2026";
  if (code.startsWith("MT")) return "The Hundred Men 2026";
  if (code.startsWith("WT")) return "The Hundred Women 2026";
  if (code.startsWith("LPL")) return "LPL 2026";
  return null;
}

export type AuctionOwner = { no: number; short: string; isMe: boolean; hex: string };

// Resolve a scorecard row to the pid the snapshot is keyed by. The pid comes first — it's the
// stable join. But a scorecard's pid is resolved from ESPN via the points registry, and a tour
// whose squads were never anchored there (CPL: no registry tour, so `resolveEspnPid` returns
// null for over half the card) or whose registry cricinfo id differs from the auction DB's
// (the Shai Hope / Kyle Hope merge) would silently show no tag for a player who WAS bought.
// So fall back to the snapshot's per-tour name index: exact normalised name, then surname +
// first initial ("SD Hope" in the auction ↔ "Shai Hope" on the card). Keys claimed by two
// players in the same tour were dropped at sync time, so ambiguity shows no tag.
function resolveOwnerPid(
  pid: string | null | undefined,
  tour: string,
  name: string | null | undefined
): string | null {
  if (pid && DATA[pid]?.[tour]) return pid;
  const keys = NAMES[tour];
  if (!keys || !name) return null;
  const n = normName(name);
  if (!n) return null;
  const exact = keys[n];
  if (exact) return exact;
  const parts = n.split(" ");
  if (parts.length < 2) return null;
  return keys[`si:${parts[parts.length - 1]}|${parts[0][0]}`] ?? null;
}

// The friends who own a player in the given tour's auctions, ordered by auction serial.
// Empty when the player/tour isn't in the snapshot (best-effort — a miss just shows no tag).
export function auctionOwnersFor(
  pid: string | null | undefined,
  tour: string | null,
  name?: string | null
): AuctionOwner[] {
  if (!tour) return [];
  const key = resolveOwnerPid(pid, tour, name);
  if (!key) return [];
  const byTour = DATA[key];
  if (!byTour) return [];
  const list = byTour[tour] ?? [];
  return list
    .map((o) => {
      const user = LABEL_TO_USER.get(o.name.toLowerCase());
      return { no: o.no, short: o.short, isMe: o.isMe, hex: user ? getUserHex(user) : "#9aa6c0" };
    })
    .sort((a, b) => a.no - b.no);
}
