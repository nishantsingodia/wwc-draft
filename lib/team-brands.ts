// Team visual identity — the single source for the <TeamLogo> component.
//
// Two layers, mirroring the player-photos pattern (data/player-photos.json):
//   1. data/team-brands.json — HAND-AUTHORED, always present: a brand colour + short
//      initials for every code in data/team-codes.json. This is the guaranteed fallback,
//      so every team renders as an intentional coloured badge even with no real logo.
//   2. data/team-logos.json — OPTIONAL, harvested from ESPN (scripts/harvest-team-logos.ts):
//      code -> real crest URL. A miss just falls back to the badge.
//
// getFlag (lib/players.ts) stays the emoji source for national teams — TeamLogo overlays
// the flag on a coloured ring for nations, and shows the initials badge for franchises.
import teamBrands from "@/data/team-brands.json";
import teamLogos from "@/data/team-logos.json";

const BRANDS = teamBrands as Record<string, { color: string; initials: string }>;
const LOGOS = teamLogos as Record<string, string>;

export type TeamBrand = { color: string; initials: string };

// Deterministic fallback for a code we haven't branded yet: a neutral navy badge with the
// first 3 chars of the code (national variants strip their M/O/W prefix first so a stray
// code still reads sensibly). Never throws — every code gets *something*.
export function getTeamBrand(code: string): TeamBrand {
  const hit = BRANDS[code];
  if (hit) return hit;
  const base = code.replace(/^(M|O|W|MT|WT|LPL)/, "") || code;
  return { color: "#1a2f56", initials: base.slice(0, 3).toUpperCase() };
}

// Real harvested logo URL for a code, or null → the UI shows the badge.
export function getTeamLogo(code: string): string | null {
  return LOGOS[code] ?? null;
}

// Readable text colour (black/white) for a given badge background, via relative luminance.
// Light badges (gold/yellow) get black text; everything else white.
export function badgeTextColor(hex: string): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.5 ? "#0a1628" : "#ffffff";
}
