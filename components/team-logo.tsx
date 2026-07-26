"use client";

import { useState } from "react";
import { getTeamBrand, getTeamLogo, badgeTextColor } from "@/lib/team-brands";
import { getFlag, getTeamName } from "@/lib/players";

// One team's visual identity, used everywhere a team needs to read at a glance.
// Resolution order (best-effort, never breaks):
//   1. real harvested crest (data/team-logos.json) — plain <img>, onError → badge
//      (same trick as PlayerAvatar so a dead URL can't render broken; no next/image config)
//   2. national flag on a brand-coloured ring (nations keep their flag)
//   3. generated brand-colour badge with short initials (franchises / anything unbranded)
export default function TeamLogo({
  code,
  size = 24,
  withName = false,
  className = "",
}: {
  code: string;
  size?: number;
  withName?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const brand = getTeamBrand(code);
  const logo = getTeamLogo(code);
  const radius = Math.max(4, Math.round(size * 0.28));

  let badge: React.ReactNode;
  if (logo && !failed) {
    badge = (
      <span
        style={{ width: size, height: size, borderRadius: radius }}
        className="inline-flex items-center justify-center overflow-hidden bg-navy2 shrink-0"
      >
        {/* Scale up ~12% inside an overflow-hidden box so the crest's built-in transparent
            frame (~4-8% per side) is cropped and the logo fills the box like the badge and
            flag-ring variants. Without this, padded square crests (e.g. The Hundred's MSG/BPH)
            render visibly smaller than the box-filling badges next to them. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logo}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          style={{ width: "112%", height: "112%" }}
          className="object-contain"
        />
      </span>
    );
  } else if (isCountryFlag(getFlag(code))) {
    // Nation: flag inside a brand-coloured ring.
    badge = (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          fontSize: Math.round(size * 0.62),
          boxShadow: `inset 0 0 0 1.5px ${brand.color}`,
        }}
        className="inline-flex items-center justify-center bg-navy2 leading-none shrink-0"
        aria-hidden
      >
        {getFlag(code)}
      </span>
    );
  } else {
    // Franchise / unbranded: colour badge with initials.
    badge = (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: brand.color,
          color: badgeTextColor(brand.color),
          fontSize: Math.max(7, Math.round(size * 0.34)),
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.14)",
        }}
        className="inline-flex items-center justify-center font-extrabold tracking-tight leading-none shrink-0"
        aria-hidden
      >
        {brand.initials}
      </span>
    );
  }

  if (!withName) return <span className={className}>{badge}</span>;
  return (
    <span className={`inline-flex items-center gap-2 min-w-0 ${className}`}>
      {badge}
      <span className="font-extrabold text-cloud truncate" style={{ letterSpacing: "0.02em" }}>
        {getTeamName(code)}
      </span>
    </span>
  );
}

// A country flag emoji is built from regional-indicator symbols (🇮🇳) or a tag sequence
// (🏴󠁧󠁢󠁥󠁮󠁧󠁿 England/Scotland). Franchise "flags" are single pictographs (⚔️ 🧢 🏰) → not flags.
function isCountryFlag(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true; // regional indicator
    if (cp === 0x1f3f4) return true; // waving black flag (tag flags)
  }
  return false;
}
