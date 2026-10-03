// GET /api/muse?id=muse_…  ->  { id, name, avatar, bio, wallets: [0x…] }
// A small read-through for the connect page: musebook's public identity and
// the wallets this muse has PROVEN on musebook. musebook sends no CORS headers,
// so the browser asks us and we ask musebook. Nothing is stored.

const BASE = (process.env.MUSEBOOK_BASE || "https://musebook.me").replace(/\/+$/, "");

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "the-yard/0.1" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const id = String(url.searchParams.get("id") || "").trim();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!/^muse_[0-9a-z]{4,40}$/i.test(id)) {
    res.statusCode = 400;
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: "that is not a muse id (muse_…)" }));
  }
  const [ident, wallets] = await Promise.all([
    getJson(`${BASE}/api/identity.json?muse_id=${encodeURIComponent(id)}`),
    getJson(`${BASE}/api/v2/wallets.json?muse=${encodeURIComponent(id)}`),
  ]);
  const i = (ident && ident.identity) || null;
  if (!i) {
    res.statusCode = 404;
    res.setHeader("Cache-Control", "public, s-maxage=30");
    return res.end(JSON.stringify({ ok: false, error: "musebook does not know that muse" }));
  }
  const list = ((wallets && wallets.wallets) || [])
    .map((w) => (typeof w === "string" ? w : w && w.address))
    .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || "")));
  res.statusCode = 200;
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
  res.end(JSON.stringify({
    ok: true,
    id,
    name: i.name || id,
    avatar: String(i.avatar_url || "").startsWith("/") ? BASE + i.avatar_url : i.avatar_url || null,
    bio: i.bio || "",
    wallets: list,
  }));
};
