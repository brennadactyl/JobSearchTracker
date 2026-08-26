# Job Search Tracker webpage (Cloudflare Worker + D1)

A plain hosted webpage backed by a real SQL database (Cloudflare D1, which is
SQLite), so the headless search CLI can update it with a `curl` call and
concurrent writes (a search syncing new leads while you're editing a status)
don't race and silently clobber each other - each row is its own database
record with its own atomic writes, not one big JSON blob.

No personal data lives in this repo - the actual data (company names, URLs,
your notes) lives only in D1 once deployed.

## Code layout

- `src/index.js` - Worker entry point: routing only (which path/method maps
  to which handler), no logic of its own.
- `src/api.js` - the D1-backed API handlers (`/api/data`, `/api/leads`,
  `/api/update`, `/api/delete-application`, `/api/config`) and their shared helpers.
- `src/page.html` - the tracker webpage: a real, standalone HTML file (open
  it directly in a browser to preview/edit it) with its CSS and client-side
  JS inline. `index.js` imports it as plain text (see the `[[rules]]` entry
  in `wrangler.toml`) and serves it verbatim for `GET /`.
- `migrations/` - D1 schema, see below.

## One-time setup

You need to do the account creation and login yourself - not something that
can be done on your behalf.

1. **Create a free Cloudflare account** at https://dash.cloudflare.com/sign-up
   (if you don't have one already).

2. **Install Wrangler** (Cloudflare's CLI) and log in:
   ```bat
   npm install -g wrangler
   wrangler login
   ```

3. **Create the D1 database:**
   ```bat
   cd worker
   wrangler d1 create job-search-tracker-db
   ```
   It prints a `database_id`. Paste it into `wrangler.toml`, replacing
   `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

4. **Apply the schema:**
   ```bat
   wrangler d1 migrations apply job-search-tracker-db --remote
   ```

5. **Set the access token** (skip if you already have one from an earlier
   setup - it carries over). Pick a long random value yourself:
   ```powershell
   -join ((48..57)+(97..122)|Get-Random -Count 40|%{[char]$_})
   ```
   Then:
   ```bat
   wrangler secret put API_TOKEN
   ```

6. **Deploy:**
   ```bat
   wrangler deploy
   ```
   Prints your live URL, something like
   `https://job-search-tracker.<your-subdomain>.workers.dev`.

7. **Set the token and URL locally** so the headless search scripts can use
   them:
   ```bat
   setx TRACKER_API_TOKEN "the-token-from-step-5"
   setx TRACKER_URL "https://job-search-tracker.<your-subdomain>.workers.dev"
   ```
   Open a new terminal afterward.

## Updating the page after code changes

```bat
cd worker
wrangler deploy
```

Schema changes are tracked migrations in `worker/migrations/` (Wrangler
records which ones have run, so `apply` is always safe to re-run - it only
executes files it hasn't seen). To add a schema change:
```bat
cd worker
wrangler d1 migrations create job-search-tracker-db <short-name>
```
Edit the generated file, then apply it the same way as step 4 above:
```bat
wrangler d1 migrations apply job-search-tracker-db --remote
```

## API (used by the search scripts, see ../private.example/README.md)

- `GET /api/data` - Bearer token required - returns `{ updated, leads[], applications[] }`
- `POST /api/leads` - Bearer token required - body `{ "leads": [ {search, company, title, location, url, found, verified, fit, team, setup, comp} ] }` - appends only leads not already present for the same `(search, url)` pair (DB-enforced, atomic); never touches existing status/notes. `team`/`setup`/`comp` are optional (omit rather than send empty) and only meaningful when the posting states them - other Details fields (referral, resume, lastContact, nextAction*, link) are accepted too but are user-entered only, never sent by the search scripts.
- `POST /api/update` - Bearer token required - body `{ "type": "lead", "id": ..., "status": "...", "notes": "..." }` or `{ "type": "application", ... }`
- `POST /api/delete-application` - Bearer token required - body `{ "id": ... }` - removes one application row (leads are never deleted, only re-statused)
- `GET /api/config` - Bearer token required - returns `{ tracks: [{key, label, full_description, sort_order}], settings: {display_title, priority_locations} }` - the per-installer config the page renders its tabs/title/geo-priority labels from, instead of a baked-in TRACKS object. `priority_locations` is an ordered list of `{tier: "p-high"|"p-med", label, anyOf: [...], allOf?: [...]}` rules (substring match against the lowercased location, first match wins).
- `POST /api/config` - Bearer token required - body `{ tracks?, display_title?, priority_locations? }` - sets any of the above. `tracks`, if present, replaces the whole track list (existing leads/applications keep their `search` value even if its track is removed - they just lose their tab, they're never deleted).
