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

// ── Team-hued player-name colours (readable on the dark ink ground) ─────────────
// We colour a player's NAME by their team so the two sides read apart without any
// per-player logo. Brand colours are often too dark to read as text (ENG navy), and two
// teams can share a hue (IND vs ENG are both blue) — so we lighten each brand hue for
// contrast AND, for the two teams in a match, force their hues apart if they clash.

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mm = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) => Math.round((v + mm) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Distinct, readable name colours for the (usually two) teams in a match. Keyed by code.
// If two teams' hues are too close to tell apart (IND/ENG blue), the later one is rotated.
export function teamColorMap(codes: string[]): Map<string, string> {
  const uniq = [...new Set(codes)];
  const out = new Map<string, string>();
  const hues: number[] = [];
  for (const code of uniq) {
    let { h } = hexToHsl(getTeamBrand(code).color);
    if (hues.some((prev) => hueDist(prev, h) < 45)) h = (h + 70) % 360;
    hues.push(h);
    out.set(code, hslToHex(h, 0.7, 0.68));
  }
  return out;
}
