# Job Search Tracker webpage (Cloudflare Worker)

Replaces the old Claude Artifact tracker. Same idea (a page showing leads
across three tracks, with editable status/notes), but it's a plain hosted
webpage now, so the headless search CLI can update it with a `curl` call -
no Claude-specific tooling required, and it's reachable from anywhere,
independent of any machine being on.

No personal data lives in this folder or in KV's *schema* - the actual data
(company names, URLs, your notes) lives only in Cloudflare's KV store once
deployed, not in this git repo.

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
   This opens a browser to authorize the CLI against your account.

3. **Create the KV namespace** that stores the tracker data:
   ```bat
   cd worker
   wrangler kv namespace create TRACKER_KV
   ```
   It prints an `id`. Paste it into `wrangler.toml`, replacing
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

4. **Set the access token.** This is the shared secret both the page and the
   headless CLI use to read/write your data - pick a long random value
   yourself (don't reuse a real password). One way to generate one:
   ```powershell
   -join ((48..57)+(97..122)|Get-Random -Count 40|%{[char]$_})
   ```
   Then:
   ```bat
   wrangler secret put API_TOKEN
   ```
   and paste the value when prompted. Wrangler stores it directly in
   Cloudflare - it isn't written to any file here.

5. **Deploy:**
   ```bat
   wrangler deploy
   ```
   Prints your live URL, something like
   `https://job-search-tracker.<your-subdomain>.workers.dev`.

6. **Set the token locally** so the headless search scripts can use it too:
   ```bat
   setx TRACKER_API_TOKEN "the-same-token-from-step-4"
   setx TRACKER_URL "https://job-search-tracker.<your-subdomain>.workers.dev"
   ```
   Open a new terminal afterward.

7. **Visit the URL in a browser**, enter the same token when prompted - it's
   saved in that browser's local storage from then on.

## Updating the page after code changes

```bat
cd worker
wrangler deploy
```

Data in KV is untouched by redeploys - only the code changes.

## API (used by the search scripts, see ../private.example/README.md)

- `GET /api/data` - Bearer token required - returns `{ updated, leads[], applications[] }`
- `POST /api/leads` - Bearer token required - body `{ "leads": [ {search, company, title, location, url, found, verified, fit} ] }` - appends only leads not already present for the same `(search, url)` pair; never touches existing status/notes.
- `POST /api/update` - Bearer token required - body `{ "type": "lead", "id": "...", "status": "...", "notes": "..." }` or `{ "type": "application", ... }`
