# Job Search Tracker API (Cloudflare Worker + D1)

The API-only backend: a small JSON API over a real SQL database (Cloudflare
D1, which is SQLite), so the headless search CLI can update it with a `curl`
call and concurrent writes (a search syncing new leads while you're editing a
status) don't race and silently clobber each other - each row is its own
database record with its own atomic writes, not one big JSON blob.

This worker serves **no HTML** - the tracker webpage is a separate deployable
at [`../client/`](../client/), served from its own origin (typically
Cloudflare Pages) and talking to this API cross-origin (CORS is on by
default, see `src/api.js`). Server and client are versioned, deployed, and
updated independently - a client redeploy never needs a server redeploy and
vice versa, as long as both are compatible with the API described below.

No personal data lives in this repo - the actual data (company names, URLs,
your notes) lives only in D1 once deployed.

## Code layout

- `src/index.js` - routing only (which path/method maps to which handler),
  no logic of its own. Also owns the CORS preflight (`OPTIONS`) response.
- `src/api.js` - the D1-backed API handlers (`/api/data`, `/api/leads`,
  `/api/screened`, `/api/runs`, `/api/update`, `/api/delete-application`, `/api/config`),
  their shared helpers, and `CORS_HEADERS` (applied to every response via
  the shared `json()` helper).
- `migrations/0001_schema.sql` - the entire D1 schema in one file, see below.

## One-time setup

You need to do the account creation and login yourself - not something that
can be done on your behalf.

### Quick deploy (recommended)

No Node.js or `wrangler` CLI required locally - the build/deploy happens in
Cloudflare's own environment.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/brennadactyl/JobSearchTracker/tree/main/server)

1. Click the button, sign in to Cloudflare (creates a free account if you
   don't have one), and accept the defaults on the setup page it shows you.
2. It forks this `server/` directory into a new repo in your own GitHub, and
   reads `wrangler.toml` to auto-provision a D1 database for you (filling in
   the `database_id` for you - nothing to paste in by hand). `package.json`'s
   `deploy` script (`wrangler d1 migrations apply DB --remote && wrangler
   deploy`) runs the schema migrations and deploys in one step.
3. It lands you on your new Worker's dashboard. Go to **Settings → Variables
   and Secrets** and add a secret named `API_TOKEN` - any long random value
   you pick (a password generator, or `-join ((48..57)+(97..122)|Get-Random
   -Count 40|%{[char]$_})` in PowerShell, works fine). This is done through
   the dashboard UI, no CLI needed.
4. Your Worker's URL is shown on that same dashboard page (something like
   `https://job-search-tracker.<your-subdomain>.workers.dev`). You'll need it
   for two places: the client's own gate screen (see
   [`../client/README.md`](../client/README.md)), and as an environment
   variable on every machine that runs searches:
   ```bat
   setx TRACKER_API_TOKEN "the-secret-value-you-picked"
   setx TRACKER_URL "https://job-search-tracker.<your-subdomain>.workers.dev"
   ```
   Open a new terminal afterward.
5. Now deploy the client - see [`../client/README.md`](../client/README.md).
   It's a separate one-click deploy; this worker alone has no webpage.

### Manual setup (alternative, or for updating an existing deployment)

1. **Create a free Cloudflare account** at https://dash.cloudflare.com/sign-up
   (if you don't have one already).

2. **Install Wrangler** (Cloudflare's CLI) and log in:
   ```bat
   npm install -g wrangler
   wrangler login
   ```

3. **Create the D1 database:**
   ```bat
   cd server
   wrangler d1 create job-search-tracker-db
   ```
   It prints a `database_id`. Paste it into `wrangler.toml`, replacing
   `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

4. **Apply the schema:**
   ```bat
   wrangler d1 migrations apply job-search-tracker-db --remote
   ```
   One file, one pass - it creates every table and seeds nothing. Your tracks,
   page title and priority locations are set later via `/api/config` (the
   `job-search-setup` skill does it), so the page is deliberately empty until
   then rather than pre-filled with someone else's job search.

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

8. **Deploy the client** - see [`../client/README.md`](../client/README.md).

## Updating after code changes

**Always deploy from `main`, never from a feature branch or worktree** -
merge/fast-forward `main` and push first, then deploy from a checkout that's
actually on `main`. `wrangler deploy` and `wrangler d1 migrations apply
--remote` both push whatever's on disk live regardless of git branch, so
deploying from a branch leaves the live Worker running code that isn't in
`main`'s history.

```bat
cd server
wrangler deploy
```

The whole schema lives in one file, `migrations/0001_schema.sql`, which
creates every table a fresh database needs in a single pass and seeds
nothing. It replaced a seven-file migration history that had accumulated
around one bad early migration - since there has only ever been one
deployment, no database needed those files to reach the current state, and
collapsing them fixed a real bug that had made setting up a fresh database
impossible. Anything that consulted the old numbered files (`0004_add_lead_delisted.sql`
and friends, referenced from code comments) now points here.

Schema changes from here are still tracked migrations - Wrangler records
which files have run, so `apply` is always safe to re-run, executing only
what it hasn't seen. To add one:
```bat
cd server
wrangler d1 migrations create job-search-tracker-db <short-name>
```
Edit the generated file - using real `ALTER TABLE` statements - then apply it
the same way as step 4 above:
```bat
wrangler d1 migrations apply job-search-tracker-db --remote
```

**Do not add a column by editing `0001_schema.sql`.** Against any database
that has already run it, an edit there does nothing at all: Wrangler skips
files it has already applied, and `CREATE TABLE IF NOT EXISTS` is a no-op
against a table that exists, so the column silently never appears while the
file claims otherwise. That exact trap is what produced the history this file
replaced.

A schema/API change only requires redeploying `server/` - `client/` doesn't
need a redeploy unless it also needs to use the new field/route. Keep the API
additive (new optional fields, new routes) where you can, so old clients
don't break against a newer server; note any breaking change clearly in the
commit and in this README's API section below.

## API (used by the search scripts, see ../private.example/README.md, and by the client, see ../client/)

- `GET /api/data` - Bearer token required - returns `{ updated, leads[], applications[], screened[] }`
- `POST /api/leads` - Bearer token required - body `{ "leads": [ {search, company, title, location, url, found, verified, fit, team, setup, comp} ] }` - appends only leads not already present for the same `(search, url)` pair (DB-enforced, atomic); never touches existing status/notes. `team`/`setup`/`comp` are optional (omit rather than send empty) and only meaningful when the posting states them - other Details fields (referral, resume, lastContact, nextAction*, link) are accepted too but are user-entered only, never sent by the search scripts.
- `POST /api/screened` - Bearer token required - body `{ "screened": [ {search, url, company, title, location, reason, date} ] }` - records a posting the search looked at and decided NOT to add as a lead (dead-on-arrival, outside the US, wrong level/role-type, duplicate), so the next run's dedup check (against `GET /api/data`'s `screened[]`) skips it without re-verifying. Same `(search, url)`-deduped, atomic append as `/api/leads`; `date` defaults to today if omitted. No read-back/UI for this list today - it exists purely so scheduled runs don't re-spend a verification attempt on something already ruled out.
- `POST /api/runs` - Bearer token required - body `{ "search": "SWE", "status": "ok"|"error", "leadsAdded": 0, "screenedAdded": 0, "delisted": 0, "on": "YYYY-MM-DD", "note": "..." }` - records that one track's scheduled search just finished, as one row per track in `search_runs`. **Called at the end of every run, including runs that found nothing** - that's the whole point: a run that finds nothing writes no leads, no screened rows and no `meta.updated` bump, so without this a search that quietly stopped firing is indistinguishable from a genuine zero-result day. `on` is the caller's *local* date (the worker only knows UTC, and a morning run is already the next UTC day); `status: "error"` marks a run that couldn't do its job, which the client surfaces as a warning. 404s on a `search` that isn't a configured track rather than creating a row no tab will ever show.
- `POST /api/update` - Bearer token required - body `{ "type": "lead", "id": ..., "status": "...", "notes": "...", "delistedOn": "..." }` or `{ "type": "application", ... }`. `delistedOn` is set by the scheduled searches (a `YYYY-MM-DD` when a previously-live posting is confirmed taken down, or `""` to clear it if later found live again) - kept separate from `status` so a lead can be, say, "Applied" and delisted at the same time without either field overwriting the other. All fields are optional per call (only what's passed gets updated).
- `POST /api/delete-application` - Bearer token required - body `{ "id": ... }` - removes one application row (leads are never deleted, only re-statused)
- `GET /api/config` - Bearer token required - returns `{ tracks: [{key, label, full_description, sort_order, last_run}], settings: {display_title, overview_label, applications_label, stale_run_hours, priority_locations} }` - the per-installer config the client renders its tabs/title/geo-priority labels from, instead of a baked-in TRACKS object. Every tab the page draws comes from here: one row per track, plus `overview_label`/`applications_label` for the two built-in tabs. Each track's `last_run` is its `search_runs` row (`{at, on, status, leads_added, screened_added, delisted, note}`; all-empty means never recorded). `stale_run_hours` (default 36) is how old a run can be before the client flags that track as stale. `priority_locations` is an ordered list of `{tier: "p-high"|"p-med", label, anyOf: [...], allOf?: [...]}` rules (substring match against the lowercased location, first match wins).
- `POST /api/config` - Bearer token required - body `{ tracks?, display_title?, overview_label?, applications_label?, stale_run_hours?, priority_locations? }` - sets any of the above. `tracks`, if present, replaces the whole track list (existing leads/applications keep their `search` value even if its track is removed - they just lose their tab, they're never deleted) and keeps `search_runs` 1:1 with it: a new track gains a "never ran" row, a removed track loses its row, and re-posting an unchanged list leaves existing run history intact.
- `OPTIONS *` - CORS preflight for any route above - no auth, returns `204` + `CORS_HEADERS`. Every real response (including error responses) carries `CORS_HEADERS` too (`Access-Control-Allow-Origin: *` - the Bearer token, not origin, is the actual access boundary for this self-hosted, single-installer-per-deployment API).
