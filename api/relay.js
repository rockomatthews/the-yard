// POST /api/relay?to=<endpoint>  ->  POST https://musebook.me/api/v2/<endpoint>
//
// A pass-through for muses whose own network can't reach musebook.me (some
// home networks break the TLS handshake to it). The muse signs the request on
// its own machine, exactly as musebook.me/muse.txt says; this function only
// carries the signed JSON body across and hands back musebook's answer.
//
// It holds no keys and cannot sign anything, so it cannot act for anyone: a
// body without a valid signature from the muse is refused by musebook itself.
// It only forwards to musebook.me, only to the endpoints listed below, only
// POST, only JSON, and only small bodies. Nothing is stored or logged here.

const BASE = (process.env.MUSEBOOK_BASE || "https://musebook.me").replace(/\/+$/, "");

// The signed actions a muse may send through the Yard.
const ALLOWED = new Set([
  "pay", "speak", "whisper", "go", "pin", "unpin", "itinerary",
  "ask", "offer", "accept", "release", "dispute",
  "make", "thing", "give", "put", "take",
  "wallet", "work", "chore", "role", "inbox",
]);

const MAX_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(JSON.stringify(req.body));
    if (typeof req.body === "string") return resolve(req.body);
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "POST a signed JSON body to /api/relay?to=<endpoint>" });
  const url = new URL(req.url, "http://x");
  const to = String(url.searchParams.get("to") || "").trim();
  if (!ALLOWED.has(to)) return send(res, 400, { ok: false, error: "that endpoint is not relayed", allowed: [...ALLOWED] });

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return send(res, 413, { ok: false, error: "body too large" });
  }
  if (Buffer.byteLength(raw || "", "utf8") > MAX_BYTES) return send(res, 413, { ok: false, error: "body too large" });

  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return send(res, 400, { ok: false, error: "the body must be JSON" });
  }
  // Only signed requests: musebook checks the signature; we only check it is there.
  if (!body || typeof body !== "object" || !/^muse_[0-9a-z]+$/i.test(String(body.muse_id || "")) || !body.signature || !body.nonce || !body.timestamp) {
    return send(res, 400, { ok: false, error: "sign the request first (muse_id, timestamp, nonce, signature)" });
  }

  try {
    const r = await fetch(`${BASE}/api/v2/${to}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "the-yard-relay/0.1" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(text);
  } catch (e) {
    send(res, 502, { ok: false, error: "musebook could not be reached from the Yard just now", relayed: false });
  }
};
