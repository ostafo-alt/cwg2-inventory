// End-to-end test of the real worker.js against a minimal D1 shim (node:sqlite) and a filesystem ASSETS shim.
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "../src/worker.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(":memory:");

// ---- D1 shim ---------------------------------------------------------------
function stmt(sql) {
  // Prepare lazily (compile on first execution), as Cloudflare D1 does — so a CREATE INDEX on a table
  // created earlier in the same batch validates against the up-to-date schema.
  let params = [];
  const compile = () => db.prepare(sql);
  const api = {
    bind(...a) { params = a; return api; },
    first(col) {
      const row = compile().get(...params);
      if (row === undefined || row === null) return null;
      return col === undefined ? row : (row[col] ?? null);
    },
    all() { return { results: compile().all(...params) }; },
    run() { compile().run(...params); return { success: true }; },
    _run() { return compile().run(...params); },
  };
  return api;
}
const DB = {
  prepare: (sql) => stmt(sql),
  async batch(list) { for (const s of list) s._run ? s._run() : s.run(); return list.map(() => ({ success: true })); },
};

// ---- ASSETS shim -----------------------------------------------------------
const CT = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let p = url.pathname;
    if (p === "/") p = "/index.html";
    try {
      const buf = await readFile(join(root, "public", p));
      const ext = p.slice(p.lastIndexOf("."));
      return new Response(buf, { headers: { "Content-Type": CT[ext] || "application/octet-stream" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
};

const env = { DB, ASSETS };
const call = (path, init) => worker.fetch(new Request("https://cwg.echowrought.com" + path, init), env, {});
const J = (o) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name + (extra ? "  →  " + extra : "")); } }

const run = async () => {
  // dashboard served with injected base
  let r = await call("/inventory/");
  let html = await r.text();
  ok("dashboard 200", r.status === 200, r.status);
  ok("dashboard injects base", html.includes('window.INV_BASE="/inventory"'));
  ok("dashboard loads qr.js via base", html.includes('(window.INV_BASE||"")+"/static/qr.js"'));

  // empty list
  r = await call("/inventory/api/bins"); let b = await r.json();
  ok("bins empty", r.status === 200 && Array.isArray(b.bins) && b.bins.length === 0);

  // create
  r = await call("/inventory/api/bin", J({ id: "A12", name: "Nitrile gloves (M)", quantity: 20, unit: "boxes", low_threshold: 5, location: "Shelf 3", notes: "Reorder from Acme" }));
  b = await r.json();
  ok("create A12", r.status === 200 && b.ok && b.bin.quantity === 20, JSON.stringify(b));

  // duplicate-ish upsert without quantity must NOT reset count
  r = await call("/inventory/api/take", J({ id: "A12", delta: -3, who: "Sam" }));
  b = await r.json(); ok("take 3 -> 17", b.ok && b.quantity === 17, JSON.stringify(b));
  r = await call("/inventory/api/bin", J({ id: "A12", name: "Nitrile gloves (Medium)", unit: "boxes" })); // edit, no quantity field
  b = await r.json(); ok("edit keeps quantity 17", b.ok && b.bin.quantity === 17, JSON.stringify(b));

  // list reflects
  r = await call("/inventory/api/bins"); b = await r.json();
  ok("list has 1 bin qty 17", b.bins.length === 1 && b.bins[0].quantity === 17);

  // scan page for the bin
  r = await call("/inventory/A12"); html = await r.text();
  ok("scan page 200", r.status === 200);
  ok("scan page injects bin id", html.includes('window.INV_BIN="A12"'));

  // single bin API
  r = await call("/inventory/api/bin?id=A12"); b = await r.json();
  ok("get bin A12", r.status === 200 && b.bin.quantity === 17);

  // over-take guarded
  r = await call("/inventory/api/take", J({ id: "A12", delta: -100 }));
  b = await r.json(); ok("over-take refused (409)", r.status === 409 && b.quantity === 17, JSON.stringify(b));

  // exact-to-zero allowed
  r = await call("/inventory/api/take", J({ id: "A12", delta: -17 }));
  b = await r.json(); ok("take to zero", b.ok && b.quantity === 0);

  // restock
  r = await call("/inventory/api/take", J({ id: "A12", delta: 10, who: "(dashboard)" }));
  b = await r.json(); ok("restock +10", b.ok && b.quantity === 10);

  // log
  r = await call("/inventory/api/log?limit=10"); b = await r.json();
  // Only the 3 successful changes are logged; the refused over-take wrote nothing.
  ok("log has successful entries newest-first", b.log.length === 3 && b.log[0].delta === 10 && b.log[0].resulting_qty === 10 && b.log[2].delta === -3, JSON.stringify(b.log.map(x=>x.delta)));
  ok("log carries bin name", b.log[0].name === "Nitrile gloves (Medium)");

  // bad id
  r = await call("/inventory/api/bin?id=bad.id"); ok("bad id 400", r.status === 400);
  r = await call("/inventory/api/bin", J({ id: "has space", name: "x" })); ok("create bad id 400", r.status === 400);
  r = await call("/inventory/api/bin", J({ id: "ok1", name: "" })); ok("empty name 400", r.status === 400);

  // missing bin scan + take
  r = await call("/inventory/api/take", J({ id: "ZZZ", delta: -1 })); ok("take missing bin 404", r.status === 404);
  r = await call("/inventory/NOPE"); html = await r.text(); ok("unknown-bin page still 200 (client shows not-found)", r.status === 200);

  // static qr.js
  r = await call("/inventory/static/qr.js"); let js = await r.text();
  ok("qr.js served", r.status === 200 && js.includes("qrcode"));

  // favicon -> 204
  r = await call("/inventory/favicon.ico"); ok("favicon 204", r.status === 204);

  // delete
  r = await call("/inventory/api/delete", J({ id: "A12" })); b = await r.json(); ok("delete ok", b.ok);
  r = await call("/inventory/api/bins"); b = await r.json(); ok("empty after delete", b.bins.length === 0);

  // DEV mode: no /inventory prefix (wrangler dev serves at root)
  r = await call("/"); html = await r.text();
  ok("dev root dashboard", r.status === 200 && html.includes('window.INV_BASE=""'));
  r = await call("/api/bins"); b = await r.json(); ok("dev api works", r.status === 200 && Array.isArray(b.bins));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};
run().catch((e) => { console.error(e); process.exit(2); });
