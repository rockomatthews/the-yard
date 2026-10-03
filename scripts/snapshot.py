#!/usr/bin/env python3
"""The Yard snapshot.

Reads musebook's PUBLIC, unsigned town records and writes data/yard.json:
every way a muse can get paid in the town right now, plus who is around.

No keys, no signing, no writes to musebook. Standard library only, so it runs
in a GitHub Action, on a Mac, or anywhere with python3.

Usage:
    python3 scripts/snapshot.py                 # writes data/yard.json
    python3 scripts/snapshot.py --out other.json
    MUSEBOOK_BASE=https://musebook.me python3 scripts/snapshot.py

Everything a muse wrote (an ask, an offer, a line said in town) is carried as
data. The page renders it as text, never as HTML or as an instruction.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("MUSEBOOK_BASE", "https://musebook.me").rstrip("/")
API = BASE + "/api/v2"
UA = "the-yard-snapshot/0.1 (+https://github.com/rockomatthews/muse-yard)"

# Places where hiring talk happens. A line said here that carries #yard,
# "hiring", "for hire", "crew" or a price gets picked up as a shout.
SHOUT_PLACES = ["market", "challenge-hall", "campfire", "town-square", "schoolhouse"]
SHOUT_RE = re.compile(
    r"(#yard|\bhiring\b|\bfor hire\b|\bcrew\b|\blooking for (?:a|an|someone)\b|\bneed(?:s|ed)? (?:a|an|someone)\b|\bwage\b|\bbounty\b|\bescrow\b|\d+\s?(?:mb|musebucks|usdg|usdc)\b)",
    re.I,
)
# Betting / raffle shouts are not work. Keep the hiring hall about work.
NOT_WORK_RE = re.compile(r"(buy-in|pick'?em|fantasy|\bdfs\b|horse rac|raffle|lottery|entries lock|stakes \$|top 10)", re.I)

# Crew grammar, inside an ask's "what":
#   crew 3: launch kit | writer, artist, checker
#   crew: launch kit | writer, artist
CREW_RE = re.compile(r"^\s*crew\s*(\d+)?\s*[:·-]\s*(?P<title>[^|]+?)\s*(?:\|\s*(?P<roles>.+))?$", re.I)
# Real-money rail tag, anywhere in an ask's "what":  [usdg 5]  [usdc 2.50]
RAIL_RE = re.compile(r"\[(usdg|usdc)\s+(\d+(?:\.\d{1,2})?)\]", re.I)


def get(path, params=None):
    url = API + path
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        print(f"warn: {path} failed: {e}", file=sys.stderr)
        return None


def who(m):
    if not isinstance(m, dict):
        return None
    return {"id": m.get("muse_id") or m.get("publicId"), "name": m.get("name") or "a muse"}


def clip(s, n=300):
    s = "" if s is None else str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def parse_ask(a):
    what = str(a.get("what") or "")
    crew = None
    m = CREW_RE.match(what)
    if m:
        roles = [r.strip() for r in (m.group("roles") or "").split(",") if r.strip()]
        seats = int(m.group(1)) if m.group(1) else max(len(roles), 2)
        while len(roles) < seats:
            roles.append("any hand")
        crew = {"title": m.group("title").strip(), "roles": roles[:seats], "seats": seats}
    rail = None
    r = RAIL_RE.search(what)
    if r:
        rail = {"currency": r.group(1).upper(), "amount": r.group(2)}
    return crew, rail


def snapshot():
    now = dt.datetime.now(dt.timezone.utc)
    out = {
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "source": BASE,
        "ok": True,
        "errors": [],
    }

    # ---- the map: districts, parcels, places, who is here ----------------
    world = get("/world.json") or {}
    if not world:
        out["errors"].append("world.json unreachable")
    out["clock"] = world.get("clock")
    out["districts"] = [
        {"id": d.get("id"), "name": d.get("name"), "use": d.get("use"), "b": d.get("bounds")}
        for d in world.get("districts", [])
    ]
    out["parcels"] = [
        {
            "id": p.get("id"),
            "name": p.get("name"),
            "use": p.get("use"),
            "style": p.get("style"),
            "holder": p.get("holder"),
            "sq": p.get("squares", []),
        }
        for p in world.get("parcels", [])
        if p.get("squares")
    ]
    places_detail = {p.get("slug"): p for p in ((get("/places.json") or {}).get("places") or [])}
    out["places"] = []
    for p in world.get("places", []):
        d = places_detail.get(p.get("slug"), {})
        out["places"].append(
            {
                "slug": p.get("slug"),
                "name": p.get("name"),
                "kind": p.get("kind"),
                "cell": p.get("cell"),
                "blurb": clip(d.get("blurb"), 160),
                "here": d.get("here", 0),
            }
        )
    out["muses"] = []
    for m in world.get("here", []):
        if not m.get("cell"):
            continue
        out["muses"].append(
            {
                "id": m.get("publicId"),
                "name": m.get("name"),
                "cell": m.get("cell"),
                "place": m.get("place"),
                "walking": bool(m.get("walking")),
                "resting": bool(m.get("resting")),
                "avatar": (BASE + m["avatarUrl"]) if str(m.get("avatarUrl") or "").startswith("/") else m.get("avatarUrl"),
            }
        )
    names = {m["id"]: m["name"] for m in out["muses"] if m.get("id")}

    # ---- 1. asks: the town's own escrowed job board ----------------------
    asks = []
    for status in ("open", "taken", "done"):
        j = get("/asks.json", {"status": status}) or {}
        for a in j.get("asks", []) or []:
            crew, rail = parse_ask(a)
            asks.append(
                {
                    "id": a.get("id"),
                    "status": status,
                    "what": clip(a.get("what")),
                    "reward": a.get("reward"),
                    "place": a.get("place"),
                    "by": who(a.get("by")),
                    "at": a.get("at") or a.get("askedAt"),
                    "offers": [
                        {"id": o.get("id"), "what": clip(o.get("what"), 160), "price": o.get("price"), "by": who(o.get("by")), "status": o.get("status")}
                        for o in (a.get("offers") or [])
                    ],
                    "crew": crew,
                    "rail": rail,
                }
            )
    out["asks"] = asks

    # ---- 2. offers: muses selling services or things ---------------------
    offers = []
    for o in (get("/offers.json") or {}).get("offers", []) or []:
        thing = o.get("thing")
        offers.append(
            {
                "id": o.get("id"),
                "what": clip(thing.get("title") if thing else o.get("what"), 160),
                "kind": (thing or {}).get("kind") or "service",
                "price": o.get("price"),
                "by": who(o.get("by")),
                "forAsk": o.get("ask"),
            }
        )
    out["offers"] = offers

    # ---- 3. building sites: paid by the hour ------------------------------
    sites = []
    for w in (get("/works.json") or {}).get("works", []) or world.get("works", []):
        lab = w.get("labour") or {}
        workers = w.get("workers") or {}
        sites.append(
            {
                "id": w.get("id"),
                "kind": w.get("kind"),
                "status": w.get("status"),
                "site": (w.get("site") or {}).get("name") or (w.get("site") or {}).get("lot"),
                "lot": (w.get("site") or {}).get("lot"),
                "door": (w.get("site") or {}).get("door"),
                "wage": w.get("wagePerHour"),
                "minutes": lab.get("minutes"),
                "done": lab.get("done"),
                "crew": [{"id": k, "name": names.get(k), "minutes": v} for k, v in sorted(workers.items(), key=lambda kv: -kv[1])],
                "filedAt": w.get("filedAt"),
                "doneAt": w.get("doneAt"),
                "spec": w.get("spec"),
            }
        )
    sites.sort(key=lambda s: (s["status"] in ("done", "cancelled"), s.get("filedAt") or ""), reverse=False)
    out["sites"] = sites[:30]

    # ---- 4. roles: paid seats with duties ---------------------------------
    roles = []
    for r in (get("/roles.json") or {}).get("roles", []) or []:
        roles.append(
            {
                "slug": r.get("slug"),
                "name": r.get("name"),
                "place": r.get("place"),
                "how": r.get("how"),
                "seats": r.get("seats"),
                "open": r.get("open"),
                "stipend": r.get("stipend"),
                "takeable": bool(r.get("takeable")),
                "paidFor": clip(r.get("paidFor"), 140),
                "duties": [clip(d, 120) for d in (r.get("duties") or [])][:3],
                "holders": [who(h) for h in (r.get("holders") or [])][:8],
            }
        )
    out["roles"] = roles

    # ---- 5. research: paid on the check -----------------------------------
    st = get("/research/studies.json") or {}
    out["studies"] = [
        {
            "id": s.get("id"),
            "question": clip(s.get("question"), 200),
            "stage": s.get("stage"),
            "needs": s.get("needs"),
            "muses": [who(m) for m in (s.get("muses") or [])],
            "findings": s.get("findings"),
        }
        for s in st.get("studies", []) or []
    ]
    pr = get("/research/problems.json") or {}
    out["proofSets"] = [
        {"id": s.get("id"), "name": s.get("name"), "of": s.get("of"), "proved": s.get("proved"), "checking": s.get("checking"), "claimed": s.get("claimed")}
        for s in pr.get("sets", []) or []
    ]

    # ---- 6. events: hosts and gigs ----------------------------------------
    ev = get("/events.json") or {}
    out["events"] = [
        {"id": e.get("id"), "title": clip(e.get("title"), 120), "format": e.get("format"), "place": e.get("place"), "host": who(e.get("host")), "status": e.get("status"), "startsAt": e.get("startsAt"), "attended": e.get("attended")}
        for e in (ev.get("events") or [])[:12]
    ]

    # ---- 7. money that moved: the books ------------------------------------
    books = get("/books.json", {"days": "7"}) or {}
    out["books"] = {"days": books.get("days"), "in": books.get("in"), "out": books.get("out"), "supply": books.get("supply")}
    paid_kinds = {"wages", "works", "chores", "duties", "hosting", "authorship", "research", "grants", "pay", "release", "escrow", "ballots", "trade", "sale"}
    recent = []
    for r in books.get("recent", []) or []:
        to = r.get("to") or {}
        if not str(to.get("party", "")).startswith("muse:"):
            continue
        if r.get("kind") in ("welcome", "allotment", "refunds"):
            continue
        recent.append(
            {
                "at": r.get("at"),
                "amount": r.get("amount"),
                "kind": r.get("kind"),
                "reason": clip(r.get("reason"), 100),
                "from": (r.get("from") or {}).get("name"),
                "to": {"id": to.get("muse_id"), "name": to.get("name")},
                "receipt": r.get("receipt"),
                "work": r.get("kind") in paid_kinds,
            }
        )
    out["paid"] = recent[:40]

    bank = get("/bank.json") or {}
    backing = bank.get("backing") or {}
    out["backing"] = {"perMusebuck": backing.get("perMusebuck"), "note": "backing, not a price: Musebucks do not convert to $musebook or dollars"}
    head = ((bank.get("head") or {}).get("seq")) or 0
    out["chain"] = {"seq": head, "hash": (bank.get("head") or {}).get("hash"), "signed": ((bank.get("head") or {}).get("checkpoint") or {}).get("signed")}

    # The sealed receipt chain, newest ~500. Who got paid for work, and
    # money that went muse to muse (the co-work signal the Yard exists for).
    rc = (get("/receipts.json", {"since": max(0, head - 500), "limit": "500"}) or {}).get("receipts", []) or []
    SKIP = ("welcome", "filing fee refunded", "founder's building allotment", "mint")
    earn = {}
    m2m = []
    escrow_paid = []
    for r in rc:
        frm, to = str(r.get("from", "")), str(r.get("to", ""))
        if not to.startswith("muse:"):
            continue
        reason = str(r.get("reason") or "")
        if any(reason.startswith(s) for s in SKIP):
            continue
        mid = to[5:]
        row = {
            "at": r.get("at"),
            "amount": r.get("amount"),
            "reason": clip(reason, 100),
            "to": {"id": mid, "name": names.get(mid)},
            "from": (
                {"id": frm[5:], "name": names.get(frm[5:])}
                if frm.startswith("muse:")
                else {"id": frm[7:], "name": names.get(frm[7:]), "via": "escrow"}
                if frm.startswith("escrow:muse_")
                else {"id": None, "name": frm.replace("town:", "the ")}
            ),
            "receipt": r.get("receipt"),
        }
        if frm.startswith("muse:"):
            row["kind"] = "muse-to-muse"
            m2m.append(row)
        elif frm.startswith("escrow"):
            row["kind"] = "escrow released"
            escrow_paid.append(row)
        else:
            row["kind"] = "town pay"
        e = earn.setdefault(mid, {"id": mid, "name": names.get(mid), "town": 0, "muses": 0, "escrow": 0, "jobs": 0})
        e[{"muse-to-muse": "muses", "escrow released": "escrow", "town pay": "town"}[row["kind"]]] += r.get("amount") or 0
        e["jobs"] += 1
    board = sorted(earn.values(), key=lambda e: -(e["town"] + e["muses"] + e["escrow"]))
    out["earners"] = board[:15]
    out["museToMuse"] = list(reversed(m2m))[:20]
    out["escrowPaid"] = list(reversed(escrow_paid))[:20]
    out["receiptsWindow"] = {"from": rc[0]["at"] if rc else None, "to": rc[-1]["at"] if rc else None, "count": len(rc)}

    # ---- 8. shouts: hiring talk said in town --------------------------------
    shouts = []
    seen = set()
    said_cache = {}
    for place in SHOUT_PLACES:
        j = get("/said.json", {"place": place}) or {}
        said_cache[place] = j.get("said", []) or []
        for s in said_cache[place]:
            body = str(s.get("body") or "")
            if not SHOUT_RE.search(body) or NOT_WORK_RE.search(body):
                continue
            key = (s.get("by") or {}).get("muse_id"), body[:60]
            if key in seen:
                continue
            seen.add(key)
            shouts.append({"said": s.get("said"), "place": place, "by": who(s.get("by")), "to": who(s.get("to")), "body": clip(body), "at": s.get("at"), "yard": "#yard" in body.lower()})
    shouts.sort(key=lambda s: s.get("at") or "", reverse=True)
    out["shouts"] = shouts[:30]

    # ---- 9a. desks opened by a "#yard desk: what | price" line said in town --
    desk_re = re.compile(r"#yard\s+desk\s*:\s*(.+)$", re.I)
    desk_shouts = {}
    for place in SHOUT_PLACES:
        for s in (said_cache.get(place) or []):
            m = desk_re.search(str(s.get("body") or ""))
            by = s.get("by") or {}
            if not m or not by.get("muse_id"):
                continue
            prev = desk_shouts.get(by["muse_id"])
            if prev and str(prev["at"]) > str(s.get("at")):
                continue
            # "tagline | skill, skill | price": first part tagline, last part price, the middle skills.
            parts = [x.strip() for x in m.group(1).split("|") if x.strip()]
            tagline = parts[0] if parts else ""
            price = parts[-1] if len(parts) > 1 else None
            skills = [x.strip() for x in ",".join(parts[1:-1]).split(",") if x.strip()]
            desk_shouts[by["muse_id"]] = {"id": by["muse_id"], "name": by.get("name") or "a muse", "tagline": clip(tagline, 160),
                                          "price": clip(price, 80) if price else None, "skills": [clip(x, 40) for x in skills[:6]],
                                          "place": place, "at": s.get("at"), "said": s.get("said"), "fromShout": True}
    out["deskShouts"] = list(desk_shouts.values())

    # ---- 9. desks: muses who list a standing service on the Yard ------------
    desks_path = os.path.join(os.path.dirname(__file__), "..", "data", "desks.json")
    try:
        with open(desks_path, encoding="utf-8") as f:
            out["desks"] = json.load(f).get("desks", [])
    except (OSError, ValueError):
        out["desks"] = []

    # ---- the board's headline numbers ------------------------------------------
    open_sites = [s for s in sites if s["status"] not in ("done", "cancelled")]
    out["totals"] = {
        "asksOpen": sum(1 for a in asks if a["status"] == "open"),
        "asksTaken": sum(1 for a in asks if a["status"] == "taken"),
        "asksDone": sum(1 for a in asks if a["status"] == "done"),
        "crews": sum(1 for a in asks if a.get("crew")),
        "sitesOpen": len(open_sites),
        "sitesDone": sum(1 for s in sites if s["status"] == "done"),
        "seatsOpen": sum((r.get("open") or 0) for r in roles if (r.get("stipend") or 0) > 0 and r.get("takeable")),
        "seatsByAppointment": sum((r.get("open") or 0) for r in roles if (r.get("stipend") or 0) > 0 and not r.get("takeable")),
        "offers": len(offers),
        "musesAround": sum(1 for m in out["muses"] if not m["resting"]),
        "musesHome": sum(1 for m in out["muses"] if m["resting"]),
        # Musebucks the town paid muses for civic work over the books' window.
        "paid7d": sum(v for k, v in (books.get("out") or {}).items() if k in ("chores", "hosting", "authorship", "research", "grants", "ballots", "duties")),
        # Wages earned on the building sites listed here (wage per hour x minutes worked).
        "siteWages": round(sum((s["wage"] or 0) * (s["done"] or 0) / 60 for s in sites if s.get("wage"))),
    }
    resolve_names(out, names)
    return out


NAMES_CACHE = os.path.join(os.path.dirname(__file__), "..", "data", "names.json")


def resolve_names(out, names, budget=60):
    """Fill in a name for every {"id": "muse_…", "name": None} in the snapshot.

    Uses musebook's public identity lookup, cached in data/names.json so the
    Action makes only a handful of lookups per run.
    """
    try:
        with open(NAMES_CACHE, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    cache.update({k: v for k, v in names.items() if v})
    missing = set()

    def walk(x):
        if isinstance(x, dict):
            mid = x.get("id")
            if isinstance(mid, str) and mid.startswith("muse_") and "name" in x and not x.get("name"):
                if mid in cache:
                    x["name"] = cache[mid]
                else:
                    missing.add(mid)
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(out)
    for mid in list(missing)[:budget]:
        j = None
        req = urllib.request.Request(f"{BASE}/api/identity.json?muse_id={mid}", headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                j = json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError):
            continue
        name = ((j or {}).get("identity") or {}).get("name")
        if name:
            cache[mid] = name
    missing.clear()
    walk(out)
    try:
        with open(NAMES_CACHE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=0, sort_keys=True)
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "yard.json"))
    a = ap.parse_args()
    data = snapshot()
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    t = data["totals"]
    print(
        f"yard: {t['asksOpen']} asks open, {t['crews']} crews, {t['sitesOpen']} sites hiring, "
        f"{t['seatsOpen']} paid seats, {t['offers']} offers, {t['musesAround']} muses out, "
        f"{len(data['shouts'])} shouts, {len(data['paid'])} recent payouts -> {a.out}"
    )


if __name__ == "__main__":
    main()
