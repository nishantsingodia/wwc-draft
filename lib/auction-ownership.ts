import raw from "@/data/auction-ownership.json";
import { ROSTER, getUserHex } from "@/lib/users";

// Auction ownership snapshot bridged from the local auction app (see
// scripts/sync-auction-ownership.py). Keyed by the stable pid (ci:<cricinfoId>) → tour →
// the friends who bought that player in each auction of the tour. `no` is the auction's
// serial within the tour (1 = first auction with sales), so the UI can show "Ni1", "Pu2".
type Owner = { no: number; short: string; name: string; isMe: boolean };
const DATA = raw as Record<string, Record<string, Owner[]>>;

// Map an auction owner's full name (e.g. "Nishant") back to the roster's hex colour, so the
// auction tags read in the SAME friend colours as everywhere else in the app.
const LABEL_TO_USER = new Map(ROSTER.map((m) => [m.label.toLowerCase(), m.username]));

// Which auction tour a match belongs to, from its (namespaced) team code. Only the three
// bridged tours resolve; everything else returns null (no auction tags shown).
export function tourForTeamCode(code: string): string | null {
  if (code.startsWith("MT")) return "The Hundred Men 2026";
  if (code.startsWith("WT")) return "The Hundred Women 2026";
  if (code.startsWith("LPL")) return "LPL 2026";
  return null;
}

export type AuctionOwner = { no: number; short: string; isMe: boolean; hex: string };

// The friends who own a player in the given tour's auctions, ordered by auction serial.
// Empty when the pid/tour isn't in the snapshot (best-effort — a miss just shows no tag).
export function auctionOwnersFor(
  pid: string | null | undefined,
  tour: string | null
): AuctionOwner[] {
  if (!pid || !tour) return [];
  const byTour = DATA[pid];
  if (!byTour) return [];
  const list = byTour[tour] ?? [];
  return list
    .map((o) => {
      const user = LABEL_TO_USER.get(o.name.toLowerCase());
      return { no: o.no, short: o.short, isMe: o.isMe, hex: user ? getUserHex(user) : "#9aa6c0" };
    })
    .sort((a, b) => a.no - b.no);
}
