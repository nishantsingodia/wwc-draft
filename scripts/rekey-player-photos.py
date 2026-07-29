#!/usr/bin/env python3
"""One-time backfill: re-key data/player-photos.json onto cricinfo-id (`ci:`) pids.

The photo map was harvested on 24 Jul 2026 keyed by the pid scheme of the day
(cricsheet 8-char hex hashes / `espn:` / `slug:`). The identity migration the next
day (7265399) moved every pid in players-raw.json to `ci:<cricinfoId>`, which
silently orphaned the whole file: `getPlayerPhoto()` is a direct
`PLAYER_PHOTOS[pid]` lookup, so after the migration only 5 of 838 players
resolved and the results page fell back to the generic avatar for everyone. The
regression was invisible because live ESPN roster photos (a separate, much
sparser map) still supplied a handful of headshots on men's matches.

`lib/pid-map.json` is the same old-pid -> `ci:` table the points path already
uses via resolvePid(), so it's the authoritative translation here too.

This is a backfill, not a permanent step: scripts/harvest-photos.ts reads pids
straight from players-raw.json, so any future harvest emits `ci:` keys already.
(Its ESPN pass does still look for `espn:`-prefixed pids, which no longer exist —
that branch is now dead and only ever covered ~7 players; Wikidata is the real
source. Left alone deliberately, out of scope for this fix.)

Idempotent: keys already in `ci:` form are passed through untouched.
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PHOTOS = ROOT / "data" / "player-photos.json"
PID_MAP = ROOT / "lib" / "pid-map.json"

photos = json.loads(PHOTOS.read_text())
pid_map = json.loads(PID_MAP.read_text())

out: dict[str, str] = {}
translated = unresolved = passthrough = 0

for key, url in photos.items():
    if key.startswith("ci:"):
        out[key] = url
        passthrough += 1
    elif key in pid_map:
        out[pid_map[key]] = url
        translated += 1
    else:
        # Keep it. A stale key is inert (nothing looks it up), and dropping it
        # would lose a harvested URL we can't cheaply re-derive.
        out[key] = url
        unresolved += 1

PHOTOS.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")

# Report real coverage against the live roster, which is the number that matters.
players = json.loads((ROOT / "data" / "players-raw.json").read_text())
with_photo = sum(1 for p in players if p.get("pid") and p["pid"] in out)
print(f"translated {translated} · already ci: {passthrough} · unresolved {unresolved}")
print(f"coverage: {with_photo}/{len(players)} players now resolve a photo")
