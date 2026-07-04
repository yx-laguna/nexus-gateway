# Agoda smart hotel search — hosting & deploy notes

## What was added

- `agoda-api.ts` — client for the Agoda Affiliate Long Tail Search API (city search + hotel-list search).
- `agoda-db.ts` — read-only SQLite lookup for hotel address/geo/description enrichment.
- `agoda-city-lookup.ts` — resolves free-text destinations ("Bangkok") to Agoda `city_id`s.
- `agoda-search.ts` — orchestrates: resolve city → live API search → enrich from SQLite → Kimi ranks top 3.
- `agent.ts` — `runTools()`'s hotel branch now also calls `smartSearchHotels()` in parallel with the
  existing Trip.com/Agoda ACP mint (unchanged). `buildReply()` shows the 3 real, ranked hotels
  (grounded in live prices — no more LLM-guessed hotel names) and only reveals the specific,
  hotel-tagged Agoda `landingURL` once `purchase_ready` is true.
- `scripts/build-agoda-db.py` — rebuilds the SQLite file from a fresh CSV export whenever Agoda
  sends you an updated one.

## Data files — NOT in git

Two files the code needs at runtime are deliberately **not** committed (see `.gitignore`):

| File | Size | Purpose |
|---|---|---|
| `agoda_hotels.sqlite` | ~390MB | Built from `Agoda_Hotels_EN.csv` (1.25M rows) — see below. |
| `agoda_city_lookup.json` | ~4.3MB | City name → Agoda `city_id` map (50,677 cities). Already existed in the project. |

The finished `agoda_hotels.sqlite` (already built from your CSV) is sitting at
`OntopofLagunaMCP/agoda_hotels.sqlite`, ready to copy to Render — you don't need to re-run the
build script unless Agoda sends you a new CSV later.

## Hosting choice: persistent disk on the existing web service (not a separate DB)

You picked this over a managed Postgres instance — cheaper and simpler for a read-mostly lookup
table. Render persistent disks are **$0.25/GB/month**, prorated to the second. A 5GB disk
(comfortably covers the ~394MB of data plus headroom) runs about **$1.25/month**, on top of the
Starter compute plan `nexus-gateway-1` is already on.

`render.yaml` now declares:

```yaml
disk:
  name: agoda-data
  mountPath: /var/data
  sizeGB: 5
```

Render disks persist across deploys and restarts — they're only wiped if you delete the disk
itself. One caveat: a persistent disk pins the service to a single instance (no horizontal
autoscaling), which is already the case here (`numInstances: 1`).

## One-time setup steps

1. **Deploy the `render.yaml` change** (push this branch, or update the service in the Render
   dashboard directly) so Render provisions the disk at `/var/data` on `nexus-gateway-1`.

2. **Copy the two data files onto the disk.** Render exposes SSH access per service
   (`srv-d92e0228qa3s73d89sb0@ssh.singapore.render.com` for `nexus-gateway-1` — visible in the
   dashboard). From your own machine (not from here — this needs your SSH key):

   ```bash
   scp OntopofLagunaMCP/agoda_hotels.sqlite \
       srv-d92e0228qa3s73d89sb0@ssh.singapore.render.com:/var/data/agoda_hotels.sqlite

   scp OntopofLagunaMCP/agoda_city_lookup.json \
       srv-d92e0228qa3s73d89sb0@ssh.singapore.render.com:/var/data/agoda_city_lookup.json
   ```

   (Render's SSH docs: https://render.com/docs/ssh — if `scp` to that address doesn't work
   directly, `render ssh nexus-gateway-1` via the Render CLI then a local `cat file | ssh ... "cat > path"`
   works too.)

3. **Set the two secret env vars** in the Render dashboard for `nexus-gateway-1` (they're marked
   `sync: false` in `render.yaml` so they won't be committed):
   - `AGODA_SITE_ID` = `1961841`
   - `AGODA_API_KEY` = (the key you shared — rotate it if it's ever posted anywhere public again)

4. **Redeploy/restart** the service so it picks up the new env vars and mounts the disk.

5. **Verify**: check the logs for `[agoda-db] opened /var/data/agoda_hotels.sqlite` and
   `[agoda-city] loaded 50677 city keys` on boot. Ask the bot about a hotel with real dates
   ("hotel in Bangkok, Aug 12-14") and confirm the reply shows real hotel names/prices rather
   than the old LLM-guessed ones.

## Local development

Copy (or symlink) the two data files into the repo root, then point `.env` at them:

```
AGODA_DB_PATH=./agoda_hotels.sqlite
AGODA_CITY_LOOKUP_PATH=./agoda_city_lookup.json
AGODA_SITE_ID=1961841
AGODA_API_KEY=...
```

## Things I noticed but deliberately left alone

- **Pre-existing `tsc --noEmit` errors** in `acp.ts` and `bot.ts` (a handful of `Error`→`Record`
  casts, and an `Update` cast in the webhook handler) predate this change and don't block
  deploys — `npm start` runs `tsx` directly, which doesn't type-check. Flagging in case you want
  to clean them up separately; I didn't touch those files.
- **The hotel branch always fires the Trip.com/Agoda ACP mint regardless of `purchase_ready`**
  (unlike every other category, which respects the gate). That's existing behavior I left as-is —
  wasn't sure if it's intentional pre-warming or an oversight, so flagging rather than "fixing"
  it silently. The new Agoda smart-search landing URL *does* respect the `purchase_ready` gate.

## Not built yet (phase 2, per your plan)

InvolveAsia deeplink affiliate integration — you said this is next-phase work. No scaffolding was
added for it so it doesn't clutter this change; happy to start on it whenever you're ready.

## 2026-07-04: better-sqlite3 → node:sqlite (fixed native binding failure)

Real deploy logs showed `[agoda-db] unavailable ... Could not locate the bindings file`, meaning
Stage A (local search) never ran — every hotel reply was silently falling back to Step 1's
LLM-guessed names, with none of the distance/`(est.)`/rating markers. Root cause: Render's Node
version is **26.4.0** (picked automatically because `package.json` only said `>=20`), and
`better-sqlite3`'s bundled C++ addon failed to compile against it —

```
./src/objects/statement.lzz:322:81: error: 'const class v8::PropertyCallbackInfo<v8::Value>' has no member named 'This'
./src/better_sqlite3.lzz:68:34: error: 'class v8::Context' has no member named 'GetIsolate'
./src/util/binder.lzz:40:37: error: 'class v8::Object' has no member named 'GetPrototype'
```

Node 26's V8 removed those APIs. There's also no prebuilt binary for Node 26 yet, so it fell back
to source compile — which failed — and because the build script (`"build": "echo 'build ok'"`)
doesn't propagate `npm install`'s exit code, Render reported "Build successful" anyway and deployed
a broken artifact.

**Fix:** replaced `better-sqlite3` with Node's built-in `node:sqlite` module (`DatabaseSync`) in
`agoda-db.ts`. It's shipped inside Node itself (RC/stable since v25.7.0, well within our Node
26.4.0), so there's nothing to compile and no bindings file to locate — this failure mode is gone
for good. Also removed the `better-sqlite3`/`@types/better-sqlite3` deps from `package.json` and
tightened `engines.node` to `>=22.5.0` (the version `node:sqlite` first shipped in) so a future
downgrade can't silently break this again. Verified: `tsc --noEmit` still shows the same 9
pre-existing, unrelated errors — nothing new from this change.
