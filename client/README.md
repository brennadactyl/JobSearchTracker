# Job Search Tracker client (Cloudflare Workers, static assets)

The tracker webpage: a real, standalone HTML file
([`public/index.html`](public/index.html) - open it directly in a browser to
preview/edit it) with its CSS and client-side JS inline - no build step, no
framework, no bundler. It's a separate deployable from the API (see
[`../server/`](../server/)), served from its own origin and talking to the
API cross-origin over `fetch` with a Bearer token.

No personal data lives in this repo - the actual data (company names, URLs,
your notes) lives only in the server's D1 database. This client just renders
and edits whatever the API returns.

**Only `public/` is served.** `README.md`, `package.json`, and
`wrangler.toml` sit *outside* `public/` on purpose - a Workers static-assets
deploy publishes literally everything under its configured `directory` with
no exceptions, so anything that isn't meant to be a public file on the live
URL has to live outside that directory, not be filtered out of it.

## How it finds its API

`public/index.html` hardcodes this deployment's own API URL as
`DEFAULT_API_BASE` (a plain JS constant near the top of the `<script>` block -
safe to bake in, since an API URL isn't a secret the way the token is). So
day to day, the gate screen only ever asks for **the token** - exactly like
before this was split into two deployables.

The API URL field only shows up when there's no default to fall back on
(e.g. a fresh fork where `DEFAULT_API_BASE` has been cleared to `""`), or if
you click "Change API URL" to point this same deployed client at a different
backend. Both values, once entered, are remembered in `localStorage`
(`tracker_api_base`, `tracker_token` - per-browser, never sent anywhere but
to the API you typed in).

**For a second device/browser, you shouldn't need to type the token either.**
Use the "🔗 Copy login link" button in the app header - it copies a URL like
`https://your-client.../#u=<api-url>&t=<token>` to your clipboard. Open that
link on any other device/browser (AirDrop it to your phone, paste it in a
second browser) and it logs you in automatically. The values travel in the
URL *fragment* (after `#`), which browsers never send to any server - it's
exactly as safe as what's already sitting in `localStorage`, just shareable.
The client wipes the fragment from the visible URL immediately after
consuming it, so it won't linger in your history.

The token can't be baked in as `DEFAULT_API_BASE` is, the way a future
version of this client for a different backend might do for the URL -
`public/index.html` is served publicly and unauthenticated, so anything in
the file is visible to anyone who requests it, defeating the token's purpose
as an access gate.

## One-time setup

Deploy [`../server/`](../server/) first (or at least know its Worker URL) -
you'll need it either to set `DEFAULT_API_BASE` below, or for the gate screen
if you leave it blank.

### Quick deploy (recommended)

No Node.js or `wrangler` CLI required locally - the deploy happens in
Cloudflare's own environment.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/brennadactyl/JobSearchTracker/tree/main/client)

1. Click the button, sign in to Cloudflare, accept the defaults.
2. It forks this `client/` directory into a new repo in your own GitHub and
   deploys it as a Worker whose only content is the `public/` directory (via
   `[assets]` in `wrangler.toml` - no build command, it just serves the
   directory as-is).
3. Your client's URL is shown on the dashboard (something like
   `https://job-search-tracker-client.<your-subdomain>.workers.dev`). Open
   it.
4. **Recommended:** in your forked repo, edit `public/index.html` and set
   `DEFAULT_API_BASE` (search for it near the top of the `<script>` block) to
   your own API worker's URL from [`../server/README.md`](../server/README.md)'s
   setup, then redeploy (`wrangler deploy` from `client/`, or push and let
   your fork's own CI redeploy it if you set that up). This is what makes the
   gate ask for only a token, not both fields.
   - If you skip this, the gate will ask for both the API URL and the token
     on first visit - still works, just one more field to fill in once.
5. Open the client and enter the `API_TOKEN` you picked when deploying the
   server. Click Enter - it's remembered for next time. See "Copy login
   link" above for reusing it on another device.

### Manual setup

```bat
cd client
wrangler login          REM if you haven't already
wrangler deploy
```
Prints your live URL, something like
`https://job-search-tracker-client.<your-subdomain>.workers.dev`. Open it and
fill in the gate screen as in step 5 above (and consider step 4 too).

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

Nothing here is specific to Cloudflare's asset-hosting except the deploy
step - `public/index.html` is a plain static file. It'll work unmodified from
any static host (a different Workers/Pages project, S3 + CloudFront, GitHub
Pages, a folder on any web server) - the API's CORS response
(`Access-Control-Allow-Origin: *`) allows any origin - just deploy
`public/index.html` there instead and skip `wrangler.toml`. One caveat: serve
it over HTTPS, not plain HTTP - browsers block an HTTPS API's `fetch` as
"mixed content" when called from a page loaded over plain HTTP.
