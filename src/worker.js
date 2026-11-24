// CWG Department Inventory (cwg2-inventory): a small stock tracker as its own Cloudflare Worker.
//
// People scan a QR code on a bin, land on /inventory/<bin-id>, and enter how many they are taking
// (or restocking). The count lives in the cwg2-yolo D1 database (binding DB), so every scanner and the
// dashboard see the same live number.
//
// Served at https://cwg.echowrought.com/inventory/ (shared domain: homepage at the root, leaderboard at
// /leaderboard, admin panel at /admin_panel). The /inventory prefix is stripped below, so the routes here
// are the same as at the root under local `wrangler dev`. There is no workers.dev address.
//
//   GET  /                     dashboard (public/index.html): manage bins, QR codes, activity log
//   GET  /<bin-id>             scan page (public/bin.html): live count + take / restock
//   GET  /static/qr.js         vendored QR-code library (MIT)
//   GET  /api/bins             all bins (for the dashboard)
//   GET  /api/bin?id=          one bin's current state (for the scan page)
//   POST /api/bin              create or update a bin (open — no login, per the owner's choice)
//   POST /api/take             apply a change: {id, delta, who?, note?}  (delta < 0 take, > 0 restock)
//   POST /api/delete           remove a bin: {id}
//   GET  /api/log?id=&limit=   recent activity (all bins, or one)
//
// ACCESS: fully open by design — anyone with the link can scan, take, and manage. To add a shared PIN
// later, gate the mutating endpoints (POST /api/bin, /api/take, /api/delete) on a header checked against
// a Worker secret; nothing else needs to change.

const BASE_PATH = "/inventory";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });

const BIN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---- redirect prefixing (mirrors the admin panel) --------------------------
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
function withBase(response, url, base) {
  const loc = response.headers.get("Location");
  if (!base || !loc) return response;
  let target;
  try { target = new URL(loc, url); } catch { return response; }
  const sameSite = target.hostname === url.hostname || LOCAL_HOSTS.has(target.hostname) || !/^[a-z][a-z0-9+.-]*:/i.test(loc);
  if (!sameSite || target.pathname === base || target.pathname.startsWith(base + "/")) return response;
  const to = /^[a-z][a-z0-9+.-]*:/i.test(loc)
    ? `${target.origin}${base}${target.pathname}${target.search}${target.hash}`
    : `${base}${target.pathname}${target.search}${target.hash}`;
  const r = new Response(response.body, response);
  r.headers.set("Location", to);
  return r;
}

export default {
  async fetch(request, env, ctx) {
    const original = new URL(request.url);
    let base = "";
    if (original.pathname === BASE_PATH || original.pathname.startsWith(BASE_PATH + "/")) {
      base = BASE_PATH;
      const inner = new URL(original);
      inner.pathname = original.pathname.slice(BASE_PATH.length) || "/";
      request = new Request(inner, request);
    }
    const url = new URL(request.url);
    return withBase(await route(request, env, url, base), url, base);
  },
};

async function route(request, env, url, base) {
  try {
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      await ensureSchema(env);
      return await api(request, env, url);
    }

    // Vendored static files (only /static/* — bin ids never contain a slash).
    if (path.startsWith("/static/")) return env.ASSETS.fetch(request);

    if (path === "/" || path === "/index.html") return serveHtml(env, url, "/index.html", base, "");

    // Files with an extension that aren't under /static/ (e.g. /favicon.ico): nothing to serve.
    if (/\.[A-Za-z0-9]+$/.test(path)) return new Response(null, { status: 204 });

    // Anything else is a bin id: /A12  ->  the scan page for bin "A12".
    const binId = decodeURIComponent(path.slice(1));
    return serveHtml(env, url, "/bin.html", base, BIN_ID_RE.test(binId) ? binId : "");
  } catch (e) {
    console.error(e);
    if (e instanceof SyntaxError) return json({ error: "Request format not recognised." }, 400);
    return json({ error: "Server error." }, 500);
  }
}

// ---- HTML templating -------------------------------------------------------
// Serve an HTML asset with the base path and (for the scan page) the bin id injected, so the client
// can build correct API/QR URLs whether it runs at /inventory/ in production or at / under wrangler dev.
async function serveHtml(env, url, file, base, binId) {
  const res = await env.ASSETS.fetch(new Request(`${url.origin}${file}`));
  if (!res.ok) return res;
  let html = await res.text();
  const inject = `<script>window.INV_BASE=${JSON.stringify(base)};window.INV_BIN=${JSON.stringify(binId)};</script>`;
  html = html.replace("</head>", inject + "</head>");
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---- schema ----------------------------------------------------------------
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS inv_bins (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           quantity INTEGER NOT NULL DEFAULT 0,
           unit TEXT,
           low_threshold INTEGER,
           location TEXT,
           notes TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         )`
      ),
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS inv_log (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           bin_id TEXT NOT NULL,
           delta INTEGER NOT NULL,
           resulting_qty INTEGER NOT NULL,
           who TEXT,
           note TEXT,
           at INTEGER NOT NULL
         )`
      ),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS inv_log_at ON inv_log (at)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS inv_log_bin ON inv_log (bin_id, at)`),
    ]).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---- API -------------------------------------------------------------------
const nowSec = () => Math.floor(Date.now() / 1000);
const intOrNull = (v) => (v === null || v === undefined || v === "" ? null : Math.trunc(Number(v)));
const clampStr = (v, n) => (v === null || v === undefined ? null : String(v).trim().slice(0, n) || null);

async function api(request, env, url) {
  const p = url.pathname;
  const method = request.method;

  if (method === "GET" && p === "/api/bins") {
    const { results } = await env.DB.prepare(
      `SELECT id, name, quantity, unit, low_threshold, location, notes, updated_at
         FROM inv_bins ORDER BY name COLLATE NOCASE, id`
    ).all();
    return json({ bins: results || [] });
  }

  if (method === "GET" && p === "/api/bin") {
    const id = (url.searchParams.get("id") || "").trim();
    if (!BIN_ID_RE.test(id)) return json({ error: "bad id" }, 400);
    const bin = await env.DB.prepare(
      `SELECT id, name, quantity, unit, low_threshold, location, notes, updated_at
         FROM inv_bins WHERE id = ?`
    ).bind(id).first();
    if (!bin) return json({ error: "not found" }, 404);
    return json({ bin });
  }

  if (method === "GET" && p === "/api/log") {
    const id = (url.searchParams.get("id") || "").trim();
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "40", 10) || 40, 1), 200);
    let rows;
    if (id) {
      if (!BIN_ID_RE.test(id)) return json({ error: "bad id" }, 400);
      rows = await env.DB.prepare(
        `SELECT l.id, l.bin_id, l.delta, l.resulting_qty, l.who, l.note, l.at, b.name
           FROM inv_log l LEFT JOIN inv_bins b ON b.id = l.bin_id
          WHERE l.bin_id = ? ORDER BY l.at DESC, l.id DESC LIMIT ?`
      ).bind(id, limit).all();
    } else {
      rows = await env.DB.prepare(
        `SELECT l.id, l.bin_id, l.delta, l.resulting_qty, l.who, l.note, l.at, b.name
           FROM inv_log l LEFT JOIN inv_bins b ON b.id = l.bin_id
          ORDER BY l.at DESC, l.id DESC LIMIT ?`
      ).bind(limit).all();
    }
    return json({ log: rows.results || [] });
  }

  if (method === "POST" && p === "/api/bin") {
    const b = await request.json();
    const id = (b.id || "").trim();
    if (!BIN_ID_RE.test(id)) return json({ error: "Bin ID must be 1–64 characters: letters, numbers, dashes or underscores (no spaces or dots)." }, 400);
    const name = clampStr(b.name, 120);
    if (!name) return json({ error: "An item name is required." }, 400);
    const quantity = Math.max(0, intOrNull(b.quantity) ?? 0);
    const unit = clampStr(b.unit, 24);
    const low = intOrNull(b.low_threshold);
    const location = clampStr(b.location, 120);
    const notes = clampStr(b.notes, 500);
    const t = nowSec();
    // Upsert, but never silently reset quantity on edit unless a quantity was explicitly provided.
    const existing = await env.DB.prepare(`SELECT id FROM inv_bins WHERE id = ?`).bind(id).first();
    const hasQty = b.quantity !== undefined && b.quantity !== null && b.quantity !== "";
    if (existing) {
      await env.DB.prepare(
        `UPDATE inv_bins SET name=?, unit=?, low_threshold=?, location=?, notes=?, updated_at=?` +
        (hasQty ? `, quantity=?` : ``) + ` WHERE id=?`
      ).bind(...(hasQty
        ? [name, unit, low, location, notes, t, quantity, id]
        : [name, unit, low, location, notes, t, id])).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO inv_bins (id, name, quantity, unit, low_threshold, location, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(id, name, quantity, unit, low, location, notes, t, t).run();
    }
    const bin = await env.DB.prepare(
      `SELECT id, name, quantity, unit, low_threshold, location, notes, updated_at FROM inv_bins WHERE id = ?`
    ).bind(id).first();
    return json({ ok: true, bin });
  }

  if (method === "POST" && p === "/api/take") {
    const b = await request.json();
    const id = (b.id || "").trim();
    if (!BIN_ID_RE.test(id)) return json({ error: "bad id" }, 400);
    const delta = intOrNull(b.delta);
    if (!delta || !Number.isFinite(delta)) return json({ error: "Enter a quantity." }, 400);
    const who = clampStr(b.who, 60);
    const note = clampStr(b.note, 200);
    const t = nowSec();
    // Atomic, non-negative guard: the UPDATE only applies if it won't drive the count below zero.
    const newQty = await env.DB.prepare(
      `UPDATE inv_bins SET quantity = quantity + ?1, updated_at = ?2
         WHERE id = ?3 AND quantity + ?1 >= 0
       RETURNING quantity`
    ).bind(delta, t, id).first("quantity");
    if (newQty === null || newQty === undefined) {
      const cur = await env.DB.prepare(`SELECT quantity FROM inv_bins WHERE id = ?`).bind(id).first("quantity");
      if (cur === null || cur === undefined) return json({ error: "That bin doesn't exist." }, 404);
      return json({ error: `Only ${cur} left in this bin.`, quantity: cur }, 409);
    }
    await env.DB.prepare(
      `INSERT INTO inv_log (bin_id, delta, resulting_qty, who, note, at) VALUES (?,?,?,?,?,?)`
    ).bind(id, delta, newQty, who, note, t).run();
    return json({ ok: true, quantity: newQty, delta });
  }

  if (method === "POST" && p === "/api/delete") {
    const b = await request.json();
    const id = (b.id || "").trim();
    if (!BIN_ID_RE.test(id)) return json({ error: "bad id" }, 400);
    await env.DB.prepare(`DELETE FROM inv_bins WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  }

  return json({ error: "Not found." }, 404);
}
