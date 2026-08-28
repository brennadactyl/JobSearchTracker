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

`public/index.html` reads its `DEFAULT_API_BASE` from `local-config.js` -
**gitignored, never committed**, same treatment as this repo's private job
data (an API URL isn't a secret the way the token is, but it's still *your*
deployment's own detail, not something that belongs in the tracked template
other installers fork from). No `local-config.js` present - a fresh fork,
before you've created one - and `DEFAULT_API_BASE` is `""`, so the gate asks
for both the API URL and the token, exactly as it should for someone who
hasn't set anything up yet.

Create your own copy to skip retyping the URL every visit:
```bat
cd client\public
copy local-config.example.js local-config.js
```
Edit the copy, set `LOCAL_API_BASE` to your `../server/` deploy's URL, then
redeploy (`wrangler deploy` from `client/` - it uploads whatever's on disk,
`local-config.js` included, regardless of it not being in git).

You can also just click "Change API URL" on the gate screen instead, without
touching any file - either way, once entered, both the API URL and the token
are remembered in `localStorage` (`tracker_api_base`, `tracker_token` -
per-browser, never sent anywhere but to the API you typed in), so a second
device/browser needs the same one-time entry, the same as the token does.

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
4. **Recommended:** in your forked repo, create `public/local-config.js`
   (copy `public/local-config.example.js`) with your own API worker's URL
   from [`../server/README.md`](../server/README.md)'s setup, then redeploy
   (`wrangler deploy` from `client/`, or push and let your fork's own CI
   redeploy it if you set that up). This is what makes the gate ask for only
   a token, not both fields - see "How it finds its API" above.
   - If you skip this, the gate will ask for both the API URL and the token
     on first visit - still works, just one more field to fill in once (or
     click "Change API URL" there instead of creating the file at all).
5. Open the client and enter your server's `API_TOKEN`. Click Enter - both
   it and the API URL (if you typed one) are remembered in this browser for
   next time.

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
