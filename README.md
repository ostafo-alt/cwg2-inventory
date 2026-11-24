# CWG Department Inventory (`cwg2-inventory`)

A small stock tracker served at **https://cwg.echowrought.com/inventory**, as its own Cloudflare Worker.
Each bin has a QR code. Someone scans it, lands on `/inventory/<bin-id>`, and types how many they're
taking (or restocking). The count lives in the **`cwg2-yolo` D1 database**, so every phone and the
dashboard see the same live number.

It follows the same pattern as the admin panel: one Worker that strips its `/inventory` path prefix. It
adds two tables of its own (`inv_bins`, `inv_log`) to `cwg2-yolo`, created automatically on first request
— there is **nothing to migrate**.

## What's here

```
wrangler.jsonc        Worker + routes + D1 binding (set the database_id — see below)
package.json
src/worker.js         prefix handling, schema bootstrap, JSON API, HTML templating
public/index.html     the manager dashboard (add bins, QR codes, print sheet, activity log)
public/bin.html       the scan page people hit from the QR (mobile-first)
public/static/qr.js   vendored QR-code generator (MIT, Kazuhiko Arase)
test/harness.mjs      end-to-end test of worker.js against a local SQLite D1 shim
scripts/build-preview.mjs   builds the browser-only preview in preview/
```

## Deploy (run these on your Cloudflare account)

I can't deploy to your Cloudflare account from here, so these are yours to run — same flow as your other
CWG Workers:

```bash
cd cwg2-inventory
npm install

# 1. Point it at the cwg2-yolo database:
npx wrangler d1 create cwg2-yolo   # only if it doesn't exist yet
npx wrangler d1 info cwg2-yolo     # copy the database_id it prints
#    → paste that id into wrangler.jsonc  ("database_id": "…")

# 2. Deploy:
npx wrangler deploy
```

That's it. The routes in `wrangler.jsonc` claim `cwg.echowrought.com/inventory` and `/inventory/*`
(routes win over the homepage's Custom Domain, exactly like `/leaderboard` and `/admin_panel`). The
first request creates the `inv_bins` and `inv_log` tables in `cwg2-yolo`.

Then open **https://cwg.echowrought.com/inventory**:
1. **+ Add bin** — give it a short Bin ID (e.g. `A12`), the item name, and the current quantity. Optional:
   unit, low-stock threshold, shelf location, notes.
2. Click **QR** on the bin to see its code, or **Print QR codes** to print a sheet of all of them. Stick
   them on the bins.
3. Done. People scan, enter what they take, and the number updates for everyone.

## Access

Per your choice, it's **fully open**: anyone with the link can scan, take, restock, add bins, and reset
counts. There's no login. If you ever want to lock down *managing* while keeping *scanning* open, it's a
small change — gate the three mutating endpoints (`POST /api/bin`, `/api/take`, `/api/delete`) on a header
checked against a Worker secret (`npx wrangler secret put INVENTORY_PIN`) and prompt for it on the
dashboard. Scanning/taking can stay open or require the same PIN — your call. Say the word and I'll add it.

## API (all under `/inventory` in production)

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/bins` | all bins (dashboard) |
| GET  | `/api/bin?id=` | one bin (scan page) |
| POST | `/api/bin` | create/update a bin (upsert; omitting `quantity` on edit keeps the current count) |
| POST | `/api/take` | apply a change `{id, delta, who?, note?}` — `delta` < 0 take, > 0 restock; refuses to go below 0 |
| POST | `/api/delete` | remove a bin `{id}` |
| GET  | `/api/log?id=&limit=` | recent activity (all bins, or one) |

## Test

```bash
node --no-warnings test/harness.mjs      # 27 checks, no network needed
```

Runs the real `src/worker.js` against an in-memory SQLite D1 shim: routing, prefix-strip, schema
bootstrap, the non-negative take guard, restock, logging, and dev-mode (no-prefix) paths.
