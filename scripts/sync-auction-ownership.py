#!/usr/bin/env python3
"""
Bridge the auction app's ownership into the draft app as a static snapshot.

The auction app (cricket-auction-helper) can't be live-queried from this app's Vercel/Turso
runtime, so we bundle a per-tour ownership snapshot (data/auction-ownership.json) keyed by the
SAME stable pid the draft uses (ci:<cricinfoId>). Re-run whenever an auction changes, then
redeploy — nothing picks it up until the draft is rebuilt.

⚠️ READ THE AUCTION STATE FROM THE CLOUD, NOT THE LOCAL DB. The auctions are run from the
phone against Turso, and `db/cricket-auction.db` is only as fresh as the last
`scripts/turso-pull.sh`. Syncing from that file silently shipped a snapshot missing an entire
84-player auction and 43 later sales of another (CPL, 15 Aug 2026) — no error, just absent
tags. So auction state (auctions / participants / sold rows) comes from the deployed app's
read-only API, which reads Turso directly. The LOCAL db is still used, read-only, for
REFERENCE data — `players.cricinfo_id`, whose master is the laptop (see turso-pull.sh) — and
the script prints a local-vs-cloud drift line per auction so staleness is never invisible.

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

A player the auction DB has no cricinfo id for (a CPL breakout with no cricsheet record, or a
pool row added straight in the cloud) gets a synthetic `auc:<normalised name>` identity so
their ownership still ships. Nothing on a scorecard ever equals that key, so it is reachable
only through byName — it can add a tag, never mis-claim a pid.

Usage:  python3 scripts/sync-auction-ownership.py
        AUCTION_API_BASE=http://localhost:3000 python3 scripts/sync-auction-ownership.py
"""
import sqlite3, json, os, sys, re, unicodedata, urllib.request, urllib.error

API_BASE = os.environ.get("AUCTION_API_BASE", "https://cricket-auction-helper.vercel.app")
AUCTION_DB = "/Users/nishant-singodia/cricket-auction-helper/db/cricket-auction.db"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "auction-ownership.json")
# Only these tours are bridged (the ones the draft app runs). Free-text auction labels.
TOURS = ("The Hundred Men 2026", "The Hundred Women 2026", "LPL 2026", "CPL 2026")


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


def api(path: str):
    req = urllib.request.Request(
        f"{API_BASE}{path}", headers={"User-Agent": "wwc-draft-sync-auction-ownership"}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.URLError as e:
        sys.exit(f"Auction API unreachable ({API_BASE}{path}): {e}\nStart it locally with AUCTION_API_BASE, or check the deployment.")


if not os.path.exists(AUCTION_DB):
    sys.exit(f"Auction DB not found at {AUCTION_DB} — needed for cricinfo ids; run this on the laptop.")
con = sqlite3.connect(f"file:{AUCTION_DB}?mode=ro", uri=True)
cricinfo_by_player = {
    pid: cid for pid, cid in con.execute("SELECT id, cricinfo_id FROM players") if cid
}
local_sold = {
    aid: n
    for aid, n in con.execute(
        """SELECT a.id, (SELECT COUNT(*) FROM auction_pool ap
                         WHERE ap.auction_id = a.id AND ap.status = 'SOLD')
           FROM auctions a"""
    )
}
con.close()

# Auctions in the target tours that actually have sales, ordered by id → serial per tour.
auctions = [
    a
    for a in sorted(api("/api/auctions")["auctions"], key=lambda a: a["id"])
    if a["tournament_name"] in TOURS and a["sold_players"] > 0
]

serial = {}          # auction_id -> serial no within its tour
per_tour_count = {}
for a in auctions:
    tour = a["tournament_name"]
    per_tour_count[tour] = per_tour_count.get(tour, 0) + 1
    serial[a["id"]] = per_tour_count[tour]

by_pid = {}          # pid -> tour -> [ owner entry ]
name_claims = {}     # tour -> key -> set(pid)  (a key claimed by 2 pids is ambiguous → dropped)
owned = 0
no_ci = 0
drift = []
for a in auctions:
    aid, tour, no = a["id"], a["tournament_name"], serial[a["id"]]
    detail = api(f"/api/auction/{aid}")
    parts = {p["id"]: p for p in detail["participants"]}
    sold = [r for r in detail["pool"] if r.get("status") == "SOLD" and r.get("sold_to_participant")]
    if local_sold.get(aid) != len(sold):
        drift.append(f"#{aid} {a['name']}: local DB has {local_sold.get(aid, 'no such auction')}, cloud has {len(sold)}")
    for r in sold:
        cid = cricinfo_by_player.get(r["player_id"])
        # Prefer the announced/display name (what a scorecard prints); keep the cricsheet
        # spelling as a second lookup key.
        display = r.get("name") or ""
        pid = f"ci:{cid}" if cid else f"auc:{norm_name(display)}"
        if not cid:
            no_ci += 1
        part = parts.get(r["sold_to_participant"])
        if not part:
            continue
        by_pid.setdefault(pid, {}).setdefault(tour, []).append(
            {"no": no, "short": part["short_name"], "name": part["name"], "isMe": bool(part["is_me"])}
        )
        for nm in {display, r.get("cricsheet_name") or ""}:
            for key in name_keys(nm):
                name_claims.setdefault(tour, {}).setdefault(key, set()).add(pid)
        owned += 1

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

print(f"✓ wrote {os.path.relpath(OUT)} from {API_BASE} — {len(by_pid)} players, {owned} ownership rows")
print(f"   name-fallback keys: {sum(len(v) for v in by_name.values())} ({dropped} ambiguous, dropped)")
print(f"   {no_ci} sold rows had no cricinfo id → synthetic auc:<name> identity (name-only tags)")
for tour in TOURS:
    aucs = [f"#{a['id']}→{serial[a['id']]} ({a['sold_players']} sold)" for a in auctions if a["tournament_name"] == tour]
    print(f"   {tour}: {', '.join(aucs) or '(none with sales)'}")
if drift:
    print("\n⚠️  local db/cricket-auction.db is STALE vs the cloud (run scripts/turso-pull.sh in the auction repo):")
    for d in drift:
        print(f"     {d}")
