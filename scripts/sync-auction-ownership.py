#!/usr/bin/env python3
"""
Bridge the LOCAL auction app's ownership into the draft app as a static snapshot.

The auction app (cricket-auction-helper) is a local-only better-sqlite3 database — not
deployed and unreachable from this app's Vercel/Turso runtime. So we can't live-query it.
Instead this script reads the auction DB on the machine and writes a per-tour ownership
snapshot bundled into the draft app (data/auction-ownership.json), keyed by the SAME stable
pid the draft uses (ci:<cricinfoId>). Re-run it whenever an auction changes, then redeploy.

Snapshot shape:
  { "ci:<id>": { "<tour>": [ {"no": 1, "short": "Ni", "name": "Nishant", "isMe": true}, ... ] } }
where `no` is the auction's serial WITHIN that tour (1 = first auction with sales, by id).

Usage:  python3 scripts/sync-auction-ownership.py
"""
import sqlite3, json, os, sys

AUCTION_DB = "/Users/nishant-singodia/cricket-auction-helper/db/cricket-auction.db"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "auction-ownership.json")
# Only these tours are bridged (the ones the draft app runs). Free-text auction labels.
TOURS = ("The Hundred Men 2026", "The Hundred Women 2026", "LPL 2026")

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

snapshot = {}        # pid -> tour -> [ owner entry ]
owned = 0
for aid, tour in auctions:
    no = serial[aid]
    rows = con.execute(
        """SELECT p.cricinfo_id, part.short_name, part.name, part.is_me
           FROM auction_pool ap
           JOIN auction_participants part ON ap.sold_to_participant = part.id
           JOIN players p ON ap.player_id = p.id
           WHERE ap.auction_id = ? AND ap.status = 'SOLD'""",
        (aid,),
    ).fetchall()
    for cid, short, name, is_me in rows:
        if not cid:
            continue  # no cricinfo id → can't join to the draft's pid; skip (best-effort)
        pid = f"ci:{cid}"
        snapshot.setdefault(pid, {}).setdefault(tour, []).append(
            {"no": no, "short": short, "name": name, "isMe": bool(is_me)}
        )
        owned += 1

con.close()

with open(OUT, "w") as f:
    json.dump(snapshot, f, indent=0)
    f.write("\n")

print(f"✓ wrote {os.path.relpath(OUT)} — {len(snapshot)} players, {owned} ownership rows")
for tour in TOURS:
    aucs = [f"#{aid}→{serial[aid]}" for aid, t in auctions if t == tour]
    print(f"   {tour}: auctions {', '.join(aucs) or '(none with sales)'}")
