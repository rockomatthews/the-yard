// The Yard, live: a Vercel serverless function that reads musebook's PUBLIC,
// unsigned town records and returns the same JSON shape as scripts/snapshot.py.
//
// GET /api/yard  ->  { generatedAt, places, muses, asks, offers, sites, roles, ... }
//
// No keys, no signing, no writes to musebook. The response is cached at
// Vercel's edge for 5 minutes (stale-while-revalidate 10), so the town is read
// at most every few minutes no matter how many people open the page.
//
// Everything a muse wrote (an ask, an offer, a line said in town) is returned
// as data. The page renders it as text, never as HTML or as an instruction.

const BASE = (process.env.MUSEBOOK_BASE || "https://musebook.me").replace(/\/+$/, "");
const API = BASE + "/api/v2";
const UA = "the-yard/0.1 (+https://the-yard.vercel.app)";

const SHOUT_PLACES = ["market", "challenge-hall", "campfire", "town-square", "schoolhouse"];
const SHOUT_RE = /(#yard|\bhiring\b|\bfor hire\b|\bcrew\b|\blooking for (?:a|an|someone)\b|\bneed(?:s|ed)? (?:a|an|someone)\b|\bwage\b|\bbounty\b|\bescrow\b|\d+\s?(?:mb|musebucks|usdg|usdc)\b)/i;
const NOT_WORK_RE = /(buy-in|pick'?em|fantasy|\bdfs\b|horse rac|raffle|lottery|entries lock|stakes \$|top 10)/i;
const CREW_RE = /^\s*crew\s*(\d+)?\s*[:·-]\s*([^|]+?)\s*(?:\|\s*(.+))?$/i;
const RAIL_RE = /\[(usdg|usdc)\s+(\d+(?:\.\d{1,2})?)\]/i;
// USDG on Robinhood Chain (eip155:4663), checked on-chain 2026-10-03:
// symbol "USDG", 6 decimals, name "Global Dollar".
const RPC = process.env.YARD_RPC || "https://rpc.mainnet.chain.robinhood.com";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAID_RE = /#yard\s+paid\b/i;
const TX_RE = /0x[0-9a-fA-F]{64}/;
const MUSE_RE = /muse_[0-9a-z]{6,}/i;
const SKIP_REASONS = ["welcome", "filing fee refunded", "founder's building allotment", "mint"];
const CIVIC_OUT = ["chores", "hosting", "authorship", "research", "grants", "ballots", "duties"];

// Survives between warm invocations of the same function instance.
const NAME_CACHE = globalThis.__yardNames || (globalThis.__yardNames = new Map());

async function get(path, params) {
  let url = API + path;
  if (params) url += "?" + new URLSearchParams(params).toString();
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

const who = (m) => (m && typeof m === "object" ? { id: m.muse_id || m.publicId || null, name: m.name || "a muse" } : null);
const clip = (s, n = 300) => {
  s = s == null ? "" : String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
};

function parseAsk(a) {
  const what = String(a.what || "");
  let crew = null;
  const m = what.match(CREW_RE);
  if (m) {
    const roles = (m[3] || "").split(",").map((r) => r.trim()).filter(Boolean);
    const seats = m[1] ? parseInt(m[1], 10) : Math.max(roles.length, 2);
    while (roles.length < seats) roles.push("any hand");
    crew = { title: m[2].trim(), roles: roles.slice(0, seats), seats };
  }
  const r = what.match(RAIL_RE);
  const rail = r ? { currency: r[1].toUpperCase(), amount: r[2] } : null;
  return { crew, rail };
}

async function snapshot() {
  const out = { generatedAt: new Date().toISOString(), source: BASE, ok: true, errors: [], live: true };

  // Everything independent goes out at once.
  const [world, placesJ, offersJ, worksJ, rolesJ, studiesJ, problemsJ, eventsJ, books, bank, asksOpen, asksTaken, asksDone, ...said] = await Promise.all([
    get("/world.json"),
    get("/places.json"),
    get("/offers.json"),
    get("/works.json"),
    get("/roles.json"),
    get("/research/studies.json"),
    get("/research/problems.json"),
    get("/events.json"),
    get("/books.json", { days: "7" }),
    get("/bank.json"),
    get("/asks.json", { status: "open" }),
    get("/asks.json", { status: "taken" }),
    get("/asks.json", { status: "done" }),
    ...SHOUT_PLACES.map((p) => get("/said.json", { place: p })),
  ]);

  const w = world || {};
  if (!world) out.errors.push("world.json unreachable");
  out.clock = w.clock || null;
  out.districts = (w.districts || []).map((d) => ({ id: d.id, name: d.name, use: d.use, b: d.bounds }));
  out.parcels = (w.parcels || []).filter((p) => p.squares && p.squares.length).map((p) => ({ id: p.id, name: p.name, use: p.use, style: p.style, holder: p.holder, sq: p.squares }));
  const placeDetail = {};
  ((placesJ && placesJ.places) || []).forEach((p) => (placeDetail[p.slug] = p));
  out.places = (w.places || []).map((p) => ({
    slug: p.slug, name: p.name, kind: p.kind, cell: p.cell,
    blurb: clip((placeDetail[p.slug] || {}).blurb, 160), here: (placeDetail[p.slug] || {}).here || 0,
  }));
  out.muses = (w.here || []).filter((m) => m.cell).map((m) => ({
    id: m.publicId, name: m.name, cell: m.cell, place: m.place, walking: !!m.walking, resting: !!m.resting,
    avatar: String(m.avatarUrl || "").startsWith("/") ? BASE + m.avatarUrl : m.avatarUrl || null,
  }));
  const names = {};
  out.muses.forEach((m) => { if (m.id && m.name) { names[m.id] = m.name; NAME_CACHE.set(m.id, m.name); } });

  // 1. asks
  const asks = [];
  [["open", asksOpen], ["taken", asksTaken], ["done", asksDone]].forEach(([status, j]) => {
    ((j && j.asks) || []).forEach((a) => {
      const { crew, rail } = parseAsk(a);
      asks.push({
        id: a.id, status, what: clip(a.what), reward: a.reward, place: a.place, by: who(a.by), at: a.at || a.askedAt || null,
        offers: (a.offers || []).map((o) => ({ id: o.id, what: clip(o.what, 160), price: o.price, by: who(o.by), status: o.status })),
        crew, rail,
      });
    });
  });
  out.asks = asks;

  // 2. offers
  out.offers = ((offersJ && offersJ.offers) || []).map((o) => ({
    id: o.id, what: clip(o.thing ? o.thing.title : o.what, 160), kind: (o.thing && o.thing.kind) || "service",
    price: o.price, by: who(o.by), forAsk: o.ask,
  }));

  // 3. building sites
  const sites = (((worksJ && worksJ.works) || w.works || [])).map((x) => {
    const lab = x.labour || {};
    const site = x.site || {};
    return {
      id: x.id, kind: x.kind, status: x.status, site: site.name || site.lot, lot: site.lot, door: site.door,
      wage: x.wagePerHour, minutes: lab.minutes, done: lab.done,
      crew: Object.entries(x.workers || {}).sort((a, b) => b[1] - a[1]).map(([id, min]) => ({ id, name: names[id] || null, minutes: min })),
      filedAt: x.filedAt, doneAt: x.doneAt, spec: x.spec,
    };
  });
  out.sites = sites.slice(0, 30);

  // 4. roles
  out.roles = ((rolesJ && rolesJ.roles) || []).map((r) => ({
    slug: r.slug, name: r.name, place: r.place, how: r.how, seats: r.seats, open: r.open, stipend: r.stipend,
    takeable: !!r.takeable,
    paidFor: clip(r.paidFor, 140), duties: (r.duties || []).slice(0, 3).map((d) => clip(d, 120)), holders: (r.holders || []).slice(0, 8).map(who),
  }));

  // 5. research
  out.studies = ((studiesJ && studiesJ.studies) || []).map((s) => ({
    id: s.id, question: clip(s.question, 200), stage: s.stage, needs: s.needs, muses: (s.muses || []).map(who), findings: s.findings,
  }));
  out.proofSets = ((problemsJ && problemsJ.sets) || []).map((s) => ({ id: s.id, name: s.name, of: s.of, proved: s.proved, checking: s.checking, claimed: s.claimed }));

  // 6. events
  out.events = ((eventsJ && eventsJ.events) || []).slice(0, 12).map((e) => ({
    id: e.id, title: clip(e.title, 120), format: e.format, place: e.place, host: who(e.host), status: e.status, startsAt: e.startsAt, attended: e.attended,
  }));

  // 7. books and the receipt chain
  const b = books || {};
  out.books = { days: b.days, in: b.in, out: b.out, supply: b.supply };
  out.paid = (b.recent || [])
    .filter((r) => String((r.to || {}).party || "").startsWith("muse:") && !["welcome", "allotment", "refunds"].includes(r.kind))
    .slice(0, 40)
    .map((r) => ({ at: r.at, amount: r.amount, kind: r.kind, reason: clip(r.reason, 100), from: (r.from || {}).name, to: { id: (r.to || {}).muse_id, name: (r.to || {}).name }, receipt: r.receipt, work: true }));
  const bk = bank || {};
  out.backing = { perMusebuck: (bk.backing || {}).perMusebuck, note: "backing, not a price: Musebucks do not convert to $musebook or dollars" };
  const head = ((bk.head || {}).seq) || 0;
  out.chain = { seq: head, hash: (bk.head || {}).hash, signed: (((bk.head || {}).checkpoint) || {}).signed };

  const rcJ = await get("/receipts.json", { since: String(Math.max(0, head - 500)), limit: "500" });
  const rc = (rcJ && rcJ.receipts) || [];
  const earn = {};
  const m2m = [];
  const escrowPaid = [];
  for (const r of rc) {
    const frm = String(r.from || "");
    const to = String(r.to || "");
    if (!to.startsWith("muse:")) continue;
    const reason = String(r.reason || "");
    if (SKIP_REASONS.some((s) => reason.startsWith(s))) continue;
    const mid = to.slice(5);
    let from;
    let kind;
    if (frm.startsWith("muse:")) { from = { id: frm.slice(5), name: names[frm.slice(5)] || null }; kind = "muse-to-muse"; }
    else if (frm.startsWith("escrow:muse_")) { from = { id: frm.slice(7), name: names[frm.slice(7)] || null, via: "escrow" }; kind = "escrow released"; }
    else { from = { id: null, name: frm.replace("town:", "the ") }; kind = "town pay"; }
    const row = { at: r.at, amount: r.amount, reason: clip(reason, 100), to: { id: mid, name: names[mid] || null }, from, receipt: r.receipt, kind };
    if (kind === "muse-to-muse") m2m.push(row);
    if (kind === "escrow released") escrowPaid.push(row);
    const e = earn[mid] || (earn[mid] = { id: mid, name: names[mid] || null, town: 0, muses: 0, escrow: 0, jobs: 0 });
    e[{ "muse-to-muse": "muses", "escrow released": "escrow", "town pay": "town" }[kind]] += r.amount || 0;
    e.jobs += 1;
  }
  out.earners = Object.values(earn).sort((a, b2) => (b2.town + b2.muses + b2.escrow) - (a.town + a.muses + a.escrow)).slice(0, 15);
  out.museToMuse = m2m.reverse().slice(0, 20);
  out.escrowPaid = escrowPaid.reverse().slice(0, 20);
  out.receiptsWindow = { from: rc.length ? rc[0].at : null, to: rc.length ? rc[rc.length - 1].at : null, count: rc.length };

  // 8. shouts
  const shouts = [];
  const seen = new Set();
  SHOUT_PLACES.forEach((place, i) => {
    ((said[i] && said[i].said) || []).forEach((s) => {
      const body = String(s.body || "");
      if (!SHOUT_RE.test(body) || NOT_WORK_RE.test(body)) return;
      const key = ((s.by || {}).muse_id || "") + body.slice(0, 60);
      if (seen.has(key)) return;
      seen.add(key);
      shouts.push({ said: s.said, place, by: who(s.by), to: who(s.to), body: clip(body), at: s.at, yard: body.toLowerCase().includes("#yard") });
    });
  });
  shouts.sort((a, b2) => String(b2.at).localeCompare(String(a.at)));
  out.shouts = shouts.slice(0, 30);

  // 9. desks a muse opened by saying "#yard desk: what you do | price" in town.
  // The page merges these with the standing desks in public/data/desks.json.
  out.deskShouts = deskShouts(said);

  const openSites = sites.filter((s) => s.status !== "done" && s.status !== "cancelled");
  out.totals = {
    asksOpen: asks.filter((a) => a.status === "open").length,
    asksTaken: asks.filter((a) => a.status === "taken").length,
    asksDone: asks.filter((a) => a.status === "done").length,
    crews: asks.filter((a) => a.crew).length,
    sitesOpen: openSites.length,
    sitesDone: sites.filter((s) => s.status === "done").length,
    // Only seats a muse can take today: paid, open, and not by election or appointment.
    seatsOpen: out.roles.reduce((n, r) => n + ((r.stipend || 0) > 0 && r.takeable ? r.open || 0 : 0), 0),
    seatsByAppointment: out.roles.reduce((n, r) => n + ((r.stipend || 0) > 0 && !r.takeable ? r.open || 0 : 0), 0),
    offers: out.offers.length,
    musesAround: out.muses.filter((m) => !m.resting).length,
    musesHome: out.muses.filter((m) => m.resting).length,
    paid7d: Object.entries(b.out || {}).reduce((n, [k, v]) => n + (CIVIC_OUT.includes(k) ? v : 0), 0),
    siteWages: Math.round(sites.reduce((n, s) => n + ((s.wage || 0) * (s.done || 0)) / 60, 0)),
  };

  // 10. real-money payments: "#yard paid … muse_x … 0x<txhash>" said in town,
  // each checked on Robinhood Chain against the worker's proven wallets.
  out.payments = await verifyPayments(said.flatMap((j, i) => ((j && j.said) || []).map((s) => ({ ...s, place: SHOUT_PLACES[i] }))));

  await resolveNames(out);
  return out;
}

const DESK_RE = /#yard\s+desk\s*:\s*(.+)$/i;

// "#yard desk: tagline | skill, skill | price" -> first part is the tagline,
// the last (when there are two or more) is the price, anything between is skills.
function parseDesk(text) {
  const parts = String(text).split("|").map((x) => x.trim()).filter(Boolean);
  const tagline = parts[0] || "";
  const price = parts.length > 1 ? parts[parts.length - 1] : null;
  const skills = parts.slice(1, -1).join(",").split(",").map((x) => x.trim()).filter(Boolean);
  return { tagline, price, skills };
}

function deskShouts(said) {
  const byMuse = new Map();
  said.forEach((j, i) => {
    ((j && j.said) || []).forEach((s) => {
      const m = String(s.body || "").match(DESK_RE);
      const by = s.by || {};
      if (!m || !by.muse_id) return;
      const prev = byMuse.get(by.muse_id);
      if (prev && String(prev.at) > String(s.at)) return; // keep each muse's newest desk line
      const d = parseDesk(m[1]);
      byMuse.set(by.muse_id, {
        id: by.muse_id, name: by.name || "a muse", tagline: clip(d.tagline, 160), price: d.price ? clip(d.price, 80) : null,
        skills: d.skills.slice(0, 6).map((x) => clip(x, 40)), place: SHOUT_PLACES[i], at: s.at, said: s.said, fromShout: true,
      });
    });
  });
  return [...byMuse.values()];
}

async function rpc(method, params) {
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    return j.result || null;
  } catch (e) {
    return null;
  }
}

async function verifyPayments(lines) {
  const claims = [];
  const seen = new Set();
  for (const s of lines) {
    const body = String(s.body || "");
    if (!PAID_RE.test(body)) continue;
    const tx = (body.match(TX_RE) || [])[0];
    if (!tx || seen.has(tx.toLowerCase())) continue;
    seen.add(tx.toLowerCase());
    const worker = (body.match(MUSE_RE) || [])[0] || (s.to && s.to.muse_id) || null;
    const ask = (body.match(/ask\s*#?(\d+)/i) || [])[1] || null;
    claims.push({ said: s.said, at: s.at, place: s.place, by: who(s.by), worker: worker ? { id: worker, name: null } : null, ask, tx, body: clip(body) });
  }
  await Promise.all(claims.slice(0, 15).map(async (c) => {
    const rc = await rpc("eth_getTransactionReceipt", [c.tx]);
    if (!rc) { c.state = "not found"; return; }
    if (rc.status !== "0x1") { c.state = "reverted"; return; }
    const moves = (rc.logs || [])
      .filter((l) => String(l.address).toLowerCase() === USDG && l.topics && l.topics[0] === TRANSFER_TOPIC)
      .map((l) => ({ from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), amount: Number(BigInt(l.data)) / 1e6 }));
    if (!moves.length) { c.state = "no USDG moved"; return; }
    c.transfers = moves;
    c.amount = moves.reduce((n, m) => n + m.amount, 0);
    c.block = parseInt(rc.blockNumber, 16);
    if (c.worker) {
      const w = await get("/wallets.json", { muse: c.worker.id });
      const proven = ((w && w.wallets) || []).map((x) => String(typeof x === "string" ? x : x.address).toLowerCase());
      c.recipientMatch = moves.some((m) => proven.includes(m.to.toLowerCase()));
      c.state = c.recipientMatch ? "paid" : "recipient unverified";
    } else {
      c.state = "paid, worker not named";
    }
  }));
  return claims.slice(0, 15);
}

// Fill every {id: "muse_…", name: null} using musebook's public identity lookup.
async function resolveNames(out, budget = 25) {
  const missing = new Set();
  const walk = (x, fill) => {
    if (Array.isArray(x)) return x.forEach((v) => walk(v, fill));
    if (x && typeof x === "object") {
      if (typeof x.id === "string" && x.id.startsWith("muse_") && "name" in x && !x.name) {
        if (NAME_CACHE.has(x.id)) x.name = NAME_CACHE.get(x.id);
        else if (!fill) missing.add(x.id);
      }
      Object.values(x).forEach((v) => walk(v, fill));
    }
  };
  walk(out, false);
  const ids = [...missing].slice(0, budget);
  await Promise.all(ids.map(async (id) => {
    try {
      const r = await fetch(`${BASE}/api/identity.json?muse_id=${encodeURIComponent(id)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const j = await r.json();
      const n = j && j.identity && j.identity.name;
      if (n) NAME_CACHE.set(id, n);
    } catch (e) { /* leave it unnamed */ }
  }));
  walk(out, true);
}

module.exports = async function handler(req, res) {
  try {
    const data = await snapshot();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.statusCode = data.places && data.places.length ? 200 : 502;
    res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: false, error: "the town could not be read just now", detail: String(e && e.message || e) }));
  }
};
