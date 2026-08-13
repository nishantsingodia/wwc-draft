#!/usr/bin/env python3
"""
Bridge the LOCAL auction app's ownership into the draft app as a static snapshot.

The auction app (cricket-auction-helper) is a local-only better-sqlite3 database — not
deployed and unreachable from this app's Vercel/Turso runtime. So we can't live-query it.
Instead this script reads the auction DB on the machine and writes a per-tour ownership
snapshot bundled into the draft app (data/auction-ownership.json), keyed by the SAME stable
pid the draft uses (ci:<cricinfoId>). Re-run it whenever an auction changes, then redeploy.

Snapshot shape:
  { "byPid": { "ci:<id>": { "<tour>": [ {"no": 1, "short": "Ni", "name": "Nishant", "isMe": true} ] } },
    "byName": { "<tour>": { "<normalised name>": "ci:<id>", "si:<surname>|<initial>": "ci:<id>" } } }
where `no` is the auction's serial WITHIN that tour (1 = first auction with sales, by id).

`byName` is the FALLBACK index: the scorecard resolves its own pid from ESPN via the points
registry, and for a tour whose squads were never anchored in the registry (CPL) that pid is
often null or a different cricinfo id than the auction's, so the pid join alone misses real
owners. Only two safe keys are emitted — the exact normalised name and surname + first
initial ("SD Hope" ↔ "Shai Hope") — and any key claimed by two different players in the same
tour is DROPPED, so an ambiguous name shows no tag rather than the wrong owner. Deliberately
NOT the full fuzzy ladder: its "surname unique in candidate set" rule would map Kamil Pooran
onto Nicholas Pooran.

Usage:  python3 scripts/sync-auction-ownership.py
"""
import sqlite3, json, os, sys, re, unicodedata


def norm_name(s: str) -> str:
    """Same normalisation as cricket-identity's normName (NFKD, strip diacritics/punct)."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", "", s.lower())).strip()


def name_keys(display: str):
    """The two safe lookup keys for a name: exact normalised, and surname + first initial."""
    n = norm_name(display)
    if not n:
        return []
    parts = n.split(" ")
    keys = [n]
    if len(parts) > 1 and parts[0]:
        keys.append(f"si:{parts[-1]}|{parts[0][0]}")
    return keys

AUCTION_DB = "/Users/nishant-singodia/cricket-auction-helper/db/cricket-auction.db"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "auction-ownership.json")
# Only these tours are bridged (the ones the draft app runs). Free-text auction labels.
TOURS = ("The Hundred Men 2026", "The Hundred Women 2026", "LPL 2026", "CPL 2026")

if not os.path.exists(AUCTION_DB):
    sys.exit(f"Auction DB not found at {AUCTION_DB} — run this on the machine that has it.")

con = sqlite3.connect(f"file:{AUCTION_DB}?mode=ro", uri=True)

# Auctions in the target tours that actually have sales, ordered by id → serial per tour.
auctions = con.execute(
    f"""SELECT a.id, a.tournament_name
        FROM auctions a
        WHERE a.tournament_name IN ({','.join('?' * len(TOURS))})
          AND EXISTS (SELECT 1 FROM auction_pool ap WHERE ap.auction_id = a.id AND ap.status='SOLD')
        ORDER BY a.id""",
    TOURS,
).fetchall()

serial = {}          # auction_id -> serial no within its tour
per_tour_count = {}
for aid, tour in auctions:
    per_tour_count[tour] = per_tour_count.get(tour, 0) + 1
    serial[aid] = per_tour_count[tour]

by_pid = {}          # pid -> tour -> [ owner entry ]
name_claims = {}     # tour -> key -> set(pid)  (a key claimed by 2 pids is ambiguous → dropped)
owned = 0
for aid, tour in auctions:
    no = serial[aid]
    rows = con.execute(
        """SELECT p.cricinfo_id, p.name, part.short_name, part.name, part.is_me
           FROM auction_pool ap
           JOIN auction_participants part ON ap.sold_to_participant = part.id
           JOIN players p ON ap.player_id = p.id
           WHERE ap.auction_id = ? AND ap.status = 'SOLD'""",
        (aid,),
    ).fetchall()
    for cid, player_name, short, name, is_me in rows:
        if not cid:
            continue  # no cricinfo id → can't join to the draft's pid; skip (best-effort)
        pid = f"ci:{cid}"
        by_pid.setdefault(pid, {}).setdefault(tour, []).append(
            {"no": no, "short": short, "name": name, "isMe": bool(is_me)}
        )
        for key in name_keys(player_name):
            name_claims.setdefault(tour, {}).setdefault(key, set()).add(pid)
        owned += 1

con.close()

by_name = {}
dropped = 0
for tour, keys in name_claims.items():
    for key, pids in keys.items():
        if len(pids) == 1:
            by_name.setdefault(tour, {})[key] = next(iter(pids))
        else:
            dropped += 1  # same key, two players → ambiguous, no tag beats a wrong tag

with open(OUT, "w") as f:
    json.dump({"byPid": by_pid, "byName": by_name}, f, indent=0)
    f.write("\n")

print(f"✓ wrote {os.path.relpath(OUT)} — {len(by_pid)} players, {owned} ownership rows")
print(f"   name-fallback keys: {sum(len(v) for v in by_name.values())} ({dropped} ambiguous, dropped)")
for tour in TOURS:
    aucs = [f"#{aid}→{serial[aid]}" for aid, t in auctions if t == tour]
    print(f"   {tour}: auctions {', '.join(aucs) or '(none with sales)'}")
