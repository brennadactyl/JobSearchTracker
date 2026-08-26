# Job Search Tracker webpage (Cloudflare Worker + D1)

A plain hosted webpage backed by a real SQL database (Cloudflare D1, which is
SQLite), so the headless search CLI can update it with a `curl` call and
concurrent writes (a search syncing new leads while you're editing a status)
don't race and silently clobber each other - each row is its own database
record with its own atomic writes, not one big JSON blob.

No personal data lives in this repo - the actual data (company names, URLs,
your notes) lives only in D1 once deployed.

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
   wrangler d1 execute job-search-tracker-db --remote --file=./schema.sql
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

## Migrating from the earlier KV version

If you deployed the original KV-backed version first, your data is sitting
in KV, not D1, until you migrate it:

```bat
curl -s "%TRACKER_URL%/api/migrate-from-kv" -H "Authorization: Bearer %TRACKER_API_TOKEN%"
```

Prints something like `{"migrated":{"leads":41,"applications":0},"sourceHad":{...}}`.
Safe to call more than once (it skips leads already present by `(search, url)`,
though re-running would duplicate `applications` rows since those don't have
a natural unique key - only call it again if you're sure it didn't fully run
the first time).

Once you've confirmed the tracker webpage shows everything correctly, clean
up the now-unused KV binding:
1. Delete the `[[kv_namespaces]]` block from `wrangler.toml`
2. Delete the `handleMigrateFromKv` function and its route in `src/index.js`
3. `wrangler deploy` again

(Not done automatically here so you can verify the migration first.)

## Updating the page after code changes

```bat
cd worker
wrangler deploy
```

Schema changes need a separate `wrangler d1 execute ... --file=./schema.sql`
run (write any migration as a new `ALTER TABLE` / `CREATE TABLE IF NOT EXISTS`
statement rather than editing schema.sql's existing statements, since those
won't re-run against already-created tables).

## API (used by the search scripts, see ../private.example/README.md)

- `GET /api/data` - Bearer token required - returns `{ updated, leads[], applications[] }`
- `POST /api/leads` - Bearer token required - body `{ "leads": [ {search, company, title, location, url, found, verified, fit} ] }` - appends only leads not already present for the same `(search, url)` pair (DB-enforced, atomic); never touches existing status/notes.
- `POST /api/update` - Bearer token required - body `{ "type": "lead", "id": ..., "status": "...", "notes": "..." }` or `{ "type": "application", ... }`
