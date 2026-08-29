# Job Search Tracker

Tooling for running a daily, verified job search entirely headless: any
number of tracked searches you define (e.g. software engineering, product
management, data science - whatever roles you're after), each updating a
durable baseline doc and syncing new postings to a live tracker webpage.

**Set up your own copy with an AI's help, not by hand-authoring config
files.** See [Setup](#setup-on-any-machine) below - the
[job-search-setup](.claude/skills/job-search-setup/) Claude Code skill reads
your resume(s), asks what roles/companies/locations you're after, and
generates everything else.

**This repo contains no personal data.** Resumes, candidate profile, target
companies, and search results live in a separate local "private" folder -
see [private.example/README.md](private.example/README.md) for the expected
layout. That separation is what makes this repo safe to keep on GitHub (public
or private) and to reuse across machines.

**The tracker is a plain webpage backed by an API, deployed as two
independent pieces** - a static client ([client/README.md](client/README.md),
a Cloudflare Worker serving static assets) and a Cloudflare Worker + D1 API
([server/README.md](server/README.md)), talking to each other cross-origin
over CORS. Neither is a Claude-specific artifact - the whole pipeline runs
through the standalone `claude` CLI with no desktop app or special tooling
required. Search results reach the tracker via a `curl` POST to the API;
every edit is one D1 row write, not a shared blob, so a headless sync and a
browser edit landing at the same moment can't clobber each other. Every tab
the page draws, its label, the page title, and which locations count as
top-priority are config the API stores itself (`/api/config`), not anything
baked into the client - one deployed client + server pair works for anyone's
tracks, and either half can be redeployed/updated independently of the other.
Each track also records when its search last ran (`/api/runs`), surfaced on
its tab and on the Overview: a search that finds nothing writes nothing, so
without that record a search that quietly stopped firing looks exactly like a
genuine zero-result day.

## Architecture

![Architecture diagram: Task Scheduler fires the headless Claude CLI daily, once per configured track, which reads and writes the local private/ folder, searches and verifies career sites, and posts new leads to server/'s Cloudflare Worker API. That API reads and writes a D1 database and answers the browser's cross-origin API calls; a separate static-assets Worker deployment, client/, serves the browser the tracker page itself.](docs/architecture.svg)

Full write-up with a reference table of routes and schedules:
[docs/architecture.html](docs/architecture.html) (open locally in a browser -
GitHub shows source for `.html` files rather than rendering them).

## Contents

```
.claude-plugin/plugin.json    lets this repo be installed as a Claude Code plugin (see Setup)
.claude/skills/
  job-search-setup/           AI-assisted onboarding - see Setup below
docs/
  architecture.svg           the diagram above
  architecture.html           full architecture write-up (open in a browser)
scripts/
  run-search.ps1              runs one track (any key with a matching scheduled-tasks/<key>.md)
  setup-scheduler.ps1          registers every track it finds as a daily Windows Scheduled Task
server/                        API only - Cloudflare Worker + D1, no HTML served
  src/index.js                  routing + CORS preflight
  src/api.js                    D1-backed API handlers + CORS headers
  migrations/0001_schema.sql    the whole D1 schema, applied via `wrangler d1 migrations apply`
  wrangler.toml                  deploy config
  package.json                   lets the Deploy to Cloudflare button chain migrations + deploy
  README.md                      one-time deploy instructions + API reference
client/                        the tracker webpage - static, no build step
  public/index.html             standalone HTML+CSS+JS, calls server/'s API cross-origin (only public/ is served)
  wrangler.toml                  deploy config (Worker serving public/ as static assets)
  package.json                   lets the Deploy to Cloudflare button deploy it
  README.md                      one-time deploy instructions
private.example/
  README.md                    expected layout for your own private data folder
```

`server/` and `client/` are deployed and versioned independently - a client
UI change never requires redeploying the API, and vice versa, as long as
both stay compatible (see `server/README.md`'s API section for what's
currently supported).

## Setup on any machine

No Node.js, no git, and no `wrangler` CLI required for any of this - see the
note after each step if you'd rather do it the traditional way instead.

1. **Install Claude Code**:
   ```powershell
   irm https://claude.ai/install.ps1 | iex
   ```
   Then authenticate for headless use: `claude setup-token`, then
   `setx CLAUDE_CODE_OAUTH_TOKEN "<token it gives you>"` (open a new
   terminal afterward so the variable takes effect).
2. **Get this tooling onto your machine** - inside a Claude Code session:
   ```
   /plugin marketplace add brennadactyl/JobSearchTracker
   /plugin install job-search-tracker@JobSearchTracker
   ```
   Claude Code fetches everything itself - no `git clone` needed. (If you'd
   rather have an editable local copy - e.g. to change the code - `git clone`
   still works exactly as before; everything below is the same either way.)
3. **Deploy the tracker** (once - not per machine). Two separate one-click
   deploys, server first:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/brennadactyl/JobSearchTracker/tree/main/server)

   Click it, sign in to Cloudflare (creates a free account if you don't have
   one), and accept the defaults - it forks the API code into your own
   GitHub, provisions the D1 database, and deploys, all in Cloudflare's own
   build environment. You'll land on your new Worker's dashboard; from
   **Settings → Variables and Secrets**, add a secret named `API_TOKEN` with
   any long random value you pick (this is the token the searches and the
   client both authenticate with - no CLI needed to set it). Then set it,
   plus your Worker's URL, on every machine that runs searches:
   ```bat
   setx TRACKER_URL "https://job-search-tracker.<your-subdomain>.workers.dev"
   setx TRACKER_API_TOKEN "<the secret value you just picked>"
   ```

   Then the client:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/brennadactyl/JobSearchTracker/tree/main/client)

   Same flow - it forks the client into your own GitHub and deploys it as a
   Worker serving a static page.

   **Then one required step before it will work:** in your fork, create
   `client/public/local-config.js` (copy `local-config.example.js`) with your
   API Worker's URL from the previous step, and redeploy. The API URL is a
   deploy-time setting, not something a visitor types in - there's no field
   for it on the sign-in screen. Skip this and the page just says "This
   deployment has no API URL configured". See
   [client/README.md](client/README.md).

   Now open the client's URL. It asks only for the `API_TOKEN` you picked
   above, and remembers it in that browser.

   **The page will be empty at this point, and that's correct** - no track
   tabs, just Overview and Applications. A fresh database ships with no
   tracks, no title and no location rules of its own; step 4 is what fills
   them in. (Nothing here is pre-seeded with anyone else's job search.)

   (Prefer the CLI, or need to apply a schema change later?
   [server/README.md](server/README.md) and [client/README.md](client/README.md)
   document the manual `wrangler`-based path too - same end result.)
4. **Set up your private data folder** - either:
   - **With Claude's help (recommended):** put your resume(s) somewhere
     Claude can read them, then ask it to run the
     [job-search-setup](.claude/skills/job-search-setup/) skill. It'll ask
     what tracks/companies/locations you want and generate everything in
     step 5 below for you, then run that step itself.
   - **By hand:** see [private.example/README.md](private.example/README.md)
     for the exact files to author yourself.

   Either way, point at the resulting folder with
   `setx JOB_SEARCH_DATA_DIR "C:\path\to\private"`, or just place it at
   `private\` next to this repo (already gitignored).
5. **Register the scheduled tasks** (the setup skill does this for you; run
   it yourself if you set up by hand or are adding a track):
   ```powershell
   .\scripts\setup-scheduler.ps1
   ```
   It discovers every track from `private\scheduled-tasks\*.md` itself -
   nothing to tell it about how many you have.
6. **Test one run before trusting the schedule** - the previous step prints
   the exact command for whichever tracks it just registered, e.g.:
   ```bat
   schtasks /Run /TN JobSearch-Engineering
   ```
   Check `private\logs\<track>.log` for what happened, then reload the
   tracker page: that track's tab should now show when it last ran and what
   it found. Until a track's first run reports in it reads "No run recorded
   yet", which is also what you'll see on a brand-new install.

Tasks run daily while you're logged in - no stored Windows password required.
If the machine is off or you're logged out at the scheduled time, that run is
skipped (not queued/retried). The webpage itself, unlike the tasks, is always
up - it's hosted on Cloudflare, independent of any machine being on.

## Running a search manually

```powershell
.\scripts\run-search.ps1 -Task <track key>
```

`<track key>` is whatever you named a track when setting it up (matches a
`private\scheduled-tasks\<key>.md` file) - e.g. `engineering`.

## Things worth not relearning

**Verification is the whole game.** Every candidate URL must be fetched and
confirmed to render a real job description - title plus
responsibilities/qualifications. A search-engine snippet is a lead, not a
finding. Watch especially for URLs that resolve to a company's *listing
index* rather than the individual posting - the title text matches, so it
looks right, and it isn't.

**Fetch reliability varies by company and drifts week to week.** Your
`private/docs/` files (not this repo's top-level `docs/`, which is just the
architecture write-up) keep per-company notes; re-verify rather than trusting
them blindly.

**Scheduled tasks only run while you're logged in.** For true run-when-closed
scheduling you'd need the machine to stay logged in (Task Scheduler can be
configured to run whether logged on or not, but that requires storing your
Windows password in the task - a bigger tradeoff, not set up here by default).

**A search that finds nothing and a search that stopped running look
identical, so the page tracks the difference explicitly.** Every run reports
in when it finishes - including runs that found nothing - and each track's
tab shows when it last ran and what it did. A track whose search hasn't
reported in over 36 hours gets an amber dot on its tab; one whose last run
reported an error gets a red one. If you see either, check the scheduled task
and `private\logs\<track>.log` rather than reading a quiet tab as a quiet
job market. Tune the threshold with `stale_run_hours` via `/api/config` if a
track is scheduled less often than daily - a weekly search left at 36 hours
would warn nearly all week.

**Headless runs use a scoped tool allowlist**, not full permission bypass -
see `scripts/run-search.ps1`. If a search prompt ever needs a new capability,
add it there deliberately rather than reaching for `--dangerously-skip-permissions`.

**A cross-cutting convention changed in one track's doc silently drifts out
of sync in the others.** Each `private/docs/tracked_<key>_postings.md` is
self-contained - nothing at runtime cross-checks it against its siblings.
If you change something that's supposed to apply to every track (how leads
sync to the tracker, the fetch-efficiency rule, the fit-filter philosophy),
update every existing track's doc to match, not just the one you're actively
iterating on. This has actually happened: one track's doc got updated when
the tracker migrated off an old hosting mechanism, its siblings didn't, and
a later scheduled run confidently tried to publish through the retired
mechanism - it had no way to know the convention had moved on. The
`job-search-setup` skill's templates are the shared source of truth for a
*new* track; there's nothing equivalent that reconciles existing tracks
against each other, so that's on whoever makes the cross-cutting change.
