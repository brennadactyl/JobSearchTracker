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

One deployed client always talks to one server - the API URL is a
**deploy-time setting**, not something a visitor types in (there's no field
for it on the gate; only the token is a runtime, per-visitor value).

`public/index.html` reads it from `local-config.js` - **gitignored, never
committed**, same treatment as this repo's private job data (an API URL
isn't a secret the way the token is, but it's still *your* deployment's own
detail, not something that belongs in the tracked template other installers
fork from). **Required, not optional:** without it, the gate shows "This
deployment has no API URL configured" instead of a way to sign in.

```bat
cd client\public
copy local-config.example.js local-config.js
```
Edit the copy, set `LOCAL_API_BASE` to your `../server/` deploy's URL, then
deploy (`wrangler deploy` from `client/` - it uploads whatever's on disk,
`local-config.js` included, regardless of it not being in git).

Once entered, the token is remembered in `localStorage` (`tracker_token` -
per-browser, never sent anywhere but to `LOCAL_API_BASE`), so a second
device/browser needs the same one-time entry.

## One-time setup

Deploy [`../server/`](../server/) first - you'll need its Worker URL for
`local-config.js` below, and the client won't work without it.

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
4. **Required:** in your forked repo, create `public/local-config.js`
   (copy `public/local-config.example.js`) with your own API worker's URL
   from [`../server/README.md`](../server/README.md)'s setup, then redeploy
   (`wrangler deploy` from `client/`, or push and let your fork's own CI
   redeploy it if you set that up) - see "How it finds its API" above. Skip
   this and the deployed page shows "This deployment has no API URL
   configured" instead of a sign-in screen.
5. Open the client and enter your server's `API_TOKEN`. Click Enter - it's
   remembered in this browser for next time.

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
