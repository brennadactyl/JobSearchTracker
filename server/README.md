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

One deployment holds **any number of people's job searches**. Every row
carries a `user_id`, and every request is scoped to whoever's token made it,
so two people share a worker and a database while seeing entirely separate
tracks, leads, applications, page titles and location rules.

## Code layout

- `src/index.js` - routing only (which path/method maps to which handler),
  no logic of its own. Resolves the caller's session once, up front, and
  hands every handler a `Db` already scoped to that person. Also owns the
  CORS preflight (`OPTIONS`) response.
- `src/auth.js` - passwords (PBKDF2 via Web Crypto), session tokens, and
  looking a bearer token up to a user. The only file that touches either.
- `src/api.js` - the request handlers: parsing, validation, and response
  shaping, plus `CORS_HEADERS` (applied to every response via the shared
  `json()` helper). No D1 access of its own.
- `src/db.js` - all D1 access for a person's own data. Every instance is
  bound to one user id at construction, so no query can forget to filter.
- `src/prompt.js` - composes a track's daily search prompt from its config.
- `verify-local.mjs` - the cross-user isolation checks, run against a local
  `wrangler dev`. `verify-migration.mjs` - what `0002` does to a database that
  already has data. See [Verifying](#verifying-a-change) below.
- `migrations/` - `0001_schema.sql` creates every table; `0002_multi_user.sql`
  adds accounts and gives every table an owner. See below.

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
   and Secrets** and add a secret named `ADMIN_TOKEN` - any long random value
   you pick (a password generator, or `-join ((48..57)+(97..122)|Get-Random
   -Count 40|%{[char]$_})` in PowerShell, works fine). This is done through
   the dashboard UI, no CLI needed. It is **not** a login: it's the operator
   credential that creates accounts and resets passwords, nothing else.
4. Your Worker's URL is shown on that same dashboard page (something like
   `https://job-search-tracker.<your-subdomain>.workers.dev`). You'll need it
   for the client (see [`../client/README.md`](../client/README.md)) and in
   each person's `tracker.json` on whatever machine runs their searches.
5. **Create your account** - see [Accounts](#accounts) below. A fresh database
   has none, and there is no sign-up page.
6. Now deploy the client - see [`../client/README.md`](../client/README.md).
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
   Every table, no seed data, and no accounts. Your tracks, page title and
   priority locations are set later via `/api/config` (the `job-search-setup`
   skill does it), so the page is deliberately empty until then rather than
   pre-filled with someone else's job search.

5. **Set the admin token.** This creates accounts and resets passwords; it is
   not a login and nothing else accepts it. Pick a long random value:
   ```powershell
   -join ((48..57)+(97..122)|Get-Random -Count 40|%{[char]$_})
   ```
   Then:
   ```bat
   wrangler secret put ADMIN_TOKEN
   ```

6. **Deploy:**
   ```bat
   wrangler deploy
   ```
   Prints your live URL, something like
   `https://job-search-tracker.<your-subdomain>.workers.dev`.

7. **Create your account** and mint the token your scheduled searches will
   use - see [Accounts](#accounts) below.

8. **Deploy the client** - see [`../client/README.md`](../client/README.md).

## Accounts

There is no sign-up page, and deliberately so: this is a handful of people
who know each other, not a service. Accounts are created by whoever operates
the deployment, using the `ADMIN_TOKEN` secret.

**Create someone (or reset their password)** - same call either way, because
nothing else in the system can hash a password:

```bash
curl -s -X POST "$TRACKER_URL/api/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Their Name","password":"a-long-password-they-pick"}'
```

Returns `{"id": "<guid>", "name": "...", "created": true|false}`. The id is
what every row of theirs is keyed by; it never changes, so a password reset
or a rename leaves their data alone. Passwords must be at least 12
characters - `/api/login` has no rate limiting in front of it, so length is
the whole defence (see [Security](#security-notes)).

**Sign in** - the webpage does this for them. Do it by hand once per machine
that runs their searches, to mint the long-lived token for the scheduled
runs:

```bash
curl -s -X POST "$TRACKER_URL/api/login" -H "Content-Type: application/json" \
  -d '{"name":"Their Name","password":"...","label":"scheduled-search"}'
```

Returns `{"token": "...", "user": {...}}`. Put that token, with the worker
URL, in `<data dir>/<their id>/tracker.json` (see
[`../private.example/README.md`](../private.example/README.md)). The password
itself never goes on disk.

**Revoke one credential.** `label` is why sessions are worth having: a
browser signing out kills only its own token, and you can drop a leaked
scheduled-search token without disturbing anyone's browser.

```bash
wrangler d1 execute job-search-tracker-db --remote \
  --command "DELETE FROM sessions WHERE user_id = '<guid>' AND label = 'scheduled-search'"
```

**See who exists, and what they hold.** `sessions.id` is a SHA-256 of the
token, not the token, so this (and a `d1 export`) shows what exists without
handing out anything usable:

```bash
wrangler d1 execute job-search-tracker-db --remote \
  --command "SELECT u.name, s.label, s.created_at FROM users u LEFT JOIN sessions s ON s.user_id = u.id ORDER BY u.name"
```

Sessions have no expiry and nothing prunes them, so a person who signs in
from a lot of browsers accumulates rows. Harmless, but that's the query to
notice it with, and a `DELETE FROM sessions WHERE user_id = '<guid>'` signs
that person out everywhere.

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

### Migrating an existing deployment to multi-user

`0002_multi_user.sql` gives every table an owner and replaces the old shared
`API_TOKEN` with accounts.

> **The window between migrating and deploying is not safe, and it fails
> quietly.** Once the migration has run, the *old* Worker code is talking to
> the *new* schema, and its writes don't work: `INSERT OR IGNORE` into `leads`
> and `screened` no longer matches the new UNIQUE constraint, so it inserts
> nothing and returns `{"added": 0}` - a success-shaped response a scheduled
> search will happily report a clean run on, having thrown away everything it
> found that morning. `/api/runs` and any status edit 500 outright, and an
> application added by hand lands with an empty `user_id` and is invisible
> afterwards. So: **disable the scheduled tasks first, and do steps 2-5 back
> to back**, outside every track's `schedule_time`.

1. **Back up first.** `wrangler d1 export job-search-tracker-db --remote
   --output backup.sql`. Then stop the searches for the duration:
   ```powershell
   Get-ScheduledTask -TaskName "JobSearch-*" | Disable-ScheduledTask
   ```
2. `wrangler d1 migrations apply job-search-tracker-db --remote` - creates
   `users`/`sessions` and assigns every existing row to one account named
   `owner`, with login disabled (SQL can't hash a password).
3. `wrangler secret put ADMIN_TOKEN` - a fresh value, not the old `API_TOKEN`.
4. Keep the running searches authenticating by turning the token they already
   have into a session. `sessions.id` holds the SHA-256 of a token, not the
   token, so insert the hash:
   ```powershell
   $t = "<the current API_TOKEN value>"
   $h = [Convert]::ToBase64String([System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t)))
   wrangler d1 execute job-search-tracker-db --remote --command "INSERT INTO sessions (id, user_id, created_at, label) VALUES ('$h', 'ab266b6c-00cc-45d1-92ac-cdad412c1558', date('now'), 'legacy scheduled search')"
   ```
   Nothing on the search machine changes - it keeps sending the same token -
   and the credential stays revocable by deleting that one row later.
5. `wrangler deploy`, then deploy the client. **Leave the tasks disabled** -
   they have nothing to run yet. The migration copies no search config, so
   until step 8 each track exists for the webpage but not for searching.
   `/api/prompt` returns a 409 for a track in that state rather than
   composing a prompt out of its generic fallbacks, so a run started early
   fails loudly instead of searching for nothing in particular and reporting
   success - but there's no reason to make it fail at all.
6. Give the account a real name and password. **The two names must match** -
   `POST /api/users` with a name that doesn't match an existing account
   creates a new empty one rather than setting the password on this one.
   (Case doesn't matter: `users.name` is `COLLATE NOCASE`.)
   ```bash
   wrangler d1 execute job-search-tracker-db --remote \
     --command "UPDATE users SET name = 'Your Name' WHERE name = 'owner'"
   curl -s -X POST "$TRACKER_URL/api/users" -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" -d '{"name":"Your Name","password":"..."}'
   ```
   Check it returned `"created": false`. If it says `true`, the names didn't
   match and you now have a second, empty account - delete it and retry.
   Then sign in on the webpage.
7. Delete the old `API_TOKEN` secret - its value now works only as that
   session row.
8. Move each track's search config into D1 and retire the prompt files. Post
   the config (the `job-search-setup` skill does this), then **diff before
   deleting anything**: `curl -s "$TRACKER_URL/api/prompt/<key>" -H
   "Authorization: Bearer <token>"` against the `.md` it replaces. Expect
   only wording normalizations; anything else means config is missing.
9. Move the data folder to `private\<user-id>\`, write its `tracker.json`
   (see [`../private.example/README.md`](../private.example/README.md)), then
   re-register the schedule and re-enable it:
   ```powershell
   .\scripts\setup-scheduler.ps1
   Get-ScheduledTask -TaskName "JobSearch-*" | Enable-ScheduledTask
   ```
   **Then unregister the old, pre-migration tasks.** They're named
   `JobSearch-<Track>` where the new ones are `JobSearch-<user>-<Track>`, so
   nothing replaces them and nothing cleans them up - left alone, each track
   would run twice a day, once through each task:
   ```powershell
   Get-ScheduledTask -TaskName "JobSearch-*" |
     Where-Object { $_.TaskName -notmatch '^JobSearch-.+-' } |
     Unregister-ScheduledTask -Confirm:$false
   ```
10. Confirm a real run works end to end before trusting the schedule:
    `.\scripts\run-search.ps1 -Task <key> -User <user-id>`, then check the log
    and that the track's tab reports the run.

**If it goes wrong**, the recovery is the step-1 export: `wrangler d1 execute
job-search-tracker-db --remote --file backup.sql` against a database you've
dropped the tables from, or re-create the D1 and import there. There is no
down-migration - `0002` drops and recreates five tables, and a partially
applied run is not something to unpick by hand.

### The schema files

The base schema lives in one file, `migrations/0001_schema.sql`, which
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

Every route except the three marked otherwise needs `Authorization: Bearer
<session token>`, and every one of them is **scoped to whoever that token
belongs to**. There is no user id in any request: another person's lead id,
application id or track key simply doesn't resolve, and comes back as a 404.

### Auth

- `POST /api/login` - **no auth** - body `{ name, password, label? }` -> `{ token, user: { id, name } }`, or `401` for both a wrong password and an unknown name (told apart, they'd enumerate who has an account). `label` records what the token is for (`"browser"`, `"scheduled-search"`) so it can be revoked by purpose later; defaults to `"browser"`. Tokens don't expire - the shared token they replaced didn't either, and a headless search that had to re-authenticate on a schedule would be a new failure mode for no gain.
- `POST /api/logout` - revokes **only the token that made the request**, so signing out of a browser leaves the scheduled search's credential alone.
- `POST /api/users` - **`ADMIN_TOKEN` as the Bearer, not a session** - body `{ name, password }` -> creates an account with a fresh GUID, or sets an existing name's password (`201` vs `200`, `{id, name, created}`). Doubles as password reset because nothing else can run PBKDF2. Minimum 12 characters. See [Accounts](#accounts).
- `GET /api/me` -> `{ id, name }` - who this token belongs to.

### Data

- `GET /api/data` - returns `{ user, updated, leads[], applications[], screened[], tracks[], settings }` - everything the page renders, for this person only. `user` is `{id, name}`, so the page can say whose search it's showing.
- `POST /api/leads` - body `{ "leads": [ {search, company, title, location, url, found, verified, fit, team, setup, comp} ] }` - appends only leads not already present for the same `(user, search, url)` triple (DB-enforced, atomic); never touches existing status/notes. Two people tracking the same posting are two independent rows. `team`/`setup`/`comp` are optional (omit rather than send empty) and only meaningful when the posting states them - other Details fields (referral, resume, lastContact, nextAction*, link) are accepted too but are user-entered only, never sent by the search scripts.
- `POST /api/screened` - body `{ "screened": [ {search, url, company, title, location, reason, date} ] }` - records a posting the search looked at and decided NOT to add as a lead (dead-on-arrival, out of scope, wrong level, duplicate), so the next run's dedup check skips it without re-verifying. Same `(user, search, url)`-deduped, atomic append as `/api/leads`; `date` defaults to today.
- `POST /api/runs` - body `{ "search": "SWE", "status": "ok"|"error", "leadsAdded": 0, "screenedAdded": 0, "delisted": 0, "on": "YYYY-MM-DD", "note": "..." }` - records that one track's scheduled search just finished. **Called at the end of every run, including runs that found nothing** - that's the whole point: a run that finds nothing writes no leads, no screened rows and no `updated` bump, so without this a search that quietly stopped firing is indistinguishable from a genuine zero-result day. `on` is the caller's *local* date (the worker only knows UTC, and a morning run is already the next UTC day); `status: "error"` marks a run that couldn't do its job, which the client surfaces as a warning. 404s on a `search` that isn't one of *this person's* configured tracks.
- `POST /api/update` - body `{ "type": "lead", "id": ..., "status": "...", "notes": "...", "delistedOn": "..." }` or `{ "type": "application", ... }`. `delistedOn` is set by the scheduled searches (a `YYYY-MM-DD` when a previously-live posting is confirmed taken down, or `""` to clear it if later found live again) - kept separate from `status` so a lead can be, say, "Applied" and delisted at the same time without either field overwriting the other. The row is never deleted: dedup still needs it, and a later run has to be able to recognise the posting to clear `delistedOn` if it comes back. The client hides a delisted lead from its track tab (there's nothing left to apply to) *unless* it's already "Applied" - that one has moved to the Applications tab, where the application is what's tracked, and delisting doesn't change anything about it. All fields are optional per call.
- `POST /api/leads/:id/status` - body `{ status }` - validates against `LEAD_STATUS`; if the new status is "Applied", atomically also creates the matching application row unless one already exists.
- `POST /api/applications/:id/status` - body `{ status }` - validates against `APP_STATUS`; stamps the matching Stage history date if that column is still empty.
- `POST /api/delete-application` - body `{ "id": ... }` - removes one application row (leads are never deleted, only re-statused).

### Config and prompts

- `GET /api/config` -> `{ tracks: [{key, label, full_description, sort_order, last_run, ...search config}], settings }` - this person's config: the track tabs, labels, display title, priority-location rules and staleness threshold the client renders from, plus the per-track search config and prose settings the prompt is composed from. Each track's `last_run` is its `search_runs` row (`{at, on, status, leads_added, screened_added, delisted, note}`; all-empty means never recorded).
- `POST /api/config` - body `{ tracks?, display_title?, overview_label?, applications_label?, stale_run_hours?, priority_locations?, excluded_companies?, geo_scope_line?, scope_clause?, scope_disqualifier?, location_guidance?, footer_note?, pronouns? }`. `tracks`, if present, **replaces this person's whole track list** (existing leads keep their `search` value even if its track is removed - they just lose their tab, they're never deleted) and keeps `search_runs` 1:1 with it. It never touches anyone else's tracks. Each track entry may carry its search config: `role_search_line`, `target_companies` (array, or a string when the list has prose structure), `search_note`, `resume_line`, `fit_clause`, `fit_disqualifier`, `fit_filter_step`, `leads_note`, `doc_file`, `doc_summary`, `doc_update_line`, `intro_note`, `report_line`, `screened_examples`, `schedule_time`.
- `excluded_companies` (in the POST above) is a list of companies this person will not work for at all - plain names, or a catch-all phrase ("any other company X owns or leads"). The composed prompt renders it into a single never-search sentence, so adding an exclusion is an append to a list rather than a sentence hand-written into a track's prose - which is how the first two ended up in two different fields, discovered only by accident.
- `GET /api/dedup/:key` -> `{ leads: [{id, url, status}], screened: [url, ...] }` - the smallest thing a scheduled run needs to know what it has already found or ruled out, for one track. This exists because the runs were using `/api/data` for it, which returns every field of every row across every track: 398KB to use 22KB of, with screened rows accumulating ~150/day. That lands in the run's context every night and grows without bound, so the failure mode was a run eventually truncating its own dedup list and re-adding postings it had already screened. 404s on an unknown key rather than returning empty arrays - empty is exactly what a mistyped key would produce, and a run that believes it has seen nothing re-adds everything.
- `GET /api/prompt/:key` -> **`text/plain`** - the daily search prompt for that track, composed from the config above (see `src/prompt.js`). This is what `run-search.ps1` pipes into the CLI, and the fastest way to check what a search will actually do. 404s on a key this person doesn't have.
- `OPTIONS *` - CORS preflight for any route above - no auth, returns `204` + `CORS_HEADERS`. Every real response (including error responses) carries `CORS_HEADERS` too (`Access-Control-Allow-Origin: *` - the session token, not the origin, is the access boundary, and it is never a cookie, so there's nothing here for a hostile origin to ride on).

### Config fields are mostly prose, on purpose

Most of the per-track config is the finished sentence the prompt uses, not a
keyword the worker expands into one. That's a decision the migration forced:
the hand-maintained prompt files these replaced had drifted from the template
that generated them, and the drift carried real weight - a resume line naming
a `.txt` fallback because the machine can't read `.docx`, a sentence widening
a company list beyond its apparent industry, worked examples of what counts
as out of scope. Reducing those to keywords and regenerating the sentences
lost them silently. Only the fields the app itself reads (`key`, `label`,
`sort_order`, `schedule_time`, `target_companies`) are structured.

## Verifying a change

There's no CI and no test suite, but there is one property worth checking
before every deploy: **two people's data cannot reach each other.**
`verify-local.mjs` is 40 checks of exactly that - one user trying to read and
write another's leads, applications, tracks, runs and prompts by id, and
getting a 404 each time - plus the auth behaviour around it (password reset,
indistinguishable login failures, per-token revocation).

```bash
cd server
wrangler d1 migrations apply job-search-tracker-db --local
echo ADMIN_TOKEN=local-admin-token-for-testing > .dev.vars
wrangler dev --local --port 8787          # in another terminal
node verify-local.mjs
```

Run it against a **local** database - it creates users and writes freely.
It expects one with no accounts yet; re-running against the same local
database is fine.

If you change anything in `db.js`, run this. A missing `AND user_id = ?`
fails nothing, breaks no page, and silently serves someone else's job search.

The migration gets its own check, because `verify-local.mjs` only ever sees a
database the migration built from empty - it would not notice `0002` losing a
column, dropping rows, or resetting AUTOINCREMENT on a database that already
had data. `verify-migration.mjs` seeds a throwaway in-process SQLite database
with pre-migration rows, applies both migration files, and checks what came
out the other side. No wrangler, no dev worker, nothing to clean up:

```bash
cd server
node verify-migration.mjs
```

## Security notes

- **`/api/login` has no rate limiting.** A guessable password is brute-forcible
  over the internet in a way the old 32-byte shared token wasn't. PBKDF2 at
  100k iterations makes each attempt cost real worker CPU - which is also its
  own small denial-of-service surface - and the 12-character minimum is the
  rest of the defence. A per-name attempt throttle is a sensible follow-up.
- **Isolation is app-level, not privacy from the operator.** Whoever holds
  the Cloudflare account can read every user's rows directly in D1. This is
  for people who are fine with that; it is not a multi-tenant SaaS boundary.
- **Tokens never expire.** Revoke by deleting the `sessions` row (see
  [Accounts](#accounts)). Losing a laptop means revoking its session, not
  rotating one secret shared by every machine and person - which is what the
  old model would have required.
