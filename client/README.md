# Job Search Tracker client (Cloudflare Pages)

The tracker webpage: a real, standalone HTML file (open `index.html` directly
in a browser to preview/edit it) with its CSS and client-side JS inline - no
build step, no framework, no bundler. It's a separate deployable from the API
(see [`../server/`](../server/)), served from its own origin and talking to
the API cross-origin over `fetch` with a Bearer token.

No personal data lives in this repo or in this deploy - the actual data
(company names, URLs, your notes) lives only in the server's D1 database.
This client just renders and edits whatever the API returns.

## How it finds its API

There's no build-time config baked into `index.html` - on first visit it
gates on **two** values instead of just a token: the API's URL and your
access token. Both are entered once and remembered in `localStorage`
(`tracker_api_base`, `tracker_token` - per-browser, never sent anywhere but
to the API you typed in). This keeps the client a plain static file anyone
can deploy or fork with zero configuration step, at the cost of a second
field on first login.

**You should only ever type both fields once, on your first device.** After
that, use the "🔗 Copy login link" button in the app header - it copies a
URL like `https://your-client.pages.dev/#u=<api-url>&t=<token>` to your
clipboard. Open that link on any other device/browser (AirDrop it to your
phone, paste it in a second browser) and it logs you in automatically, no
retyping. The values travel in the URL *fragment* (after `#`), which
browsers never send to any server - it's exactly as safe as what's already
sitting in `localStorage`, just shareable. The client wipes the fragment
from the visible URL immediately after consuming it, so it won't linger in
your history.

The token can't be baked into the deployed file itself the way the API URL
theoretically could (e.g. via a Pages build-time env-var substitution) -
`index.html` is served publicly and unauthenticated by Pages, so anything
in the file is visible to anyone who requests the URL, defeating the
token's purpose as an access gate. Runtime entry (once) + the login link
for every device after that is the tradeoff this makes instead.

## One-time setup

Deploy [`../server/`](../server/) first (or at least know its Worker URL) -
you'll need it for the gate screen after this deploys.

### Quick deploy (recommended)

No Node.js or `wrangler` CLI required locally - the deploy happens in
Cloudflare's own environment.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/brennadactyl/JobSearchTracker/tree/main/client)

1. Click the button, sign in to Cloudflare, accept the defaults.
2. It forks this `client/` directory into a new repo in your own GitHub and
   deploys it as a Cloudflare Pages project (via `pages_build_output_dir` in
   `wrangler.toml` - no build command, it just serves the directory as-is).
3. Your Pages URL is shown on the dashboard (something like
   `https://job-search-tracker-client.pages.dev`). Open it.
4. On the gate screen, enter your API worker's URL (from
   [`../server/README.md`](../server/README.md)'s setup) and the `API_TOKEN`
   you picked there. Click Enter - both are remembered for next time.

### Manual setup

```bat
cd client
wrangler login          REM if you haven't already
wrangler deploy
```
Prints your live URL, something like
`https://job-search-tracker-client.pages.dev`. Open it and fill in the gate
screen as in step 4 above.

## Updating after code changes

**Always deploy from `main`, never from a feature branch or worktree** -
merge/fast-forward `main` and push first, then deploy from a checkout that's
actually on `main`.

```bat
cd client
wrangler deploy
```

A client-only change (styling, a new field, a UI fix) never needs a server
redeploy. A change that depends on a new API field/route does need the
server deployed first - check [`../server/README.md`](../server/README.md)'s
API section for what the currently-deployed server actually supports before
relying on something new from it.

## Custom domain / different host

Nothing here is Pages-specific except the deploy step - `index.html` is a
plain static file. It'll work unmodified from any static host (a different
Pages project, S3 + CloudFront, GitHub Pages, a folder on any web server) -
the API's CORS response (`Access-Control-Allow-Origin: *`) allows any
origin - just deploy `index.html` there instead and skip `wrangler.toml`.
One caveat: serve it over HTTPS, not plain HTTP - browsers block an HTTPS
API's `fetch` as "mixed content" when called from a page loaded over plain
HTTP.
