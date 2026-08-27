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

**The tracker is a plain webpage** (a Cloudflare Worker + D1, see
[worker/README.md](worker/README.md)), not a Claude-specific artifact - so the
whole pipeline runs through the standalone `claude` CLI with no desktop app or
special tooling required. Search results reach the page via a `curl` POST to
a small API; every edit is one D1 row write, not a shared blob, so a headless
sync and a browser edit landing at the same moment can't clobber each other.
Track labels, the page title, and which locations count as top-priority are
config the webpage stores itself (`/api/config`), not anything baked into the
code - one deployed Worker works for anyone's tracks.

## Architecture

![Architecture diagram: Task Scheduler fires the headless Claude CLI daily, once per configured track, which reads and writes the local private/ folder, searches and verifies career sites, and posts new leads to a Cloudflare Worker. The Worker reads and writes a D1 database and serves the same data to the browser. Tooling code syncs separately with GitHub, never touching the private data.](docs/architecture.svg)

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
worker/
  src/index.js                  routing
  src/api.js                    D1-backed API handlers
  src/page.html                 the tracker webpage itself
  migrations/                   D1 schema, applied via `wrangler d1 migrations apply`
  wrangler.toml                  deploy config
  package.json                   lets the Deploy to Cloudflare button chain migrations + deploy
  README.md                      one-time deploy instructions
private.example/
  README.md                    expected layout for your own private data folder
```

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
3. **Deploy the tracker webpage** (once - not per machine):

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/brennadactyl/JobSearchTracker/tree/main/worker)

   Click it, sign in to Cloudflare (creates a free account if you don't have
   one), and accept the defaults - it forks the Worker code into your own
   GitHub, provisions the D1 database, and deploys, all in Cloudflare's own
   build environment. You'll land on your new Worker's dashboard; from
   **Settings → Variables and Secrets**, add a secret named `API_TOKEN` with
   any long random value you pick (this is the token the searches and the
   webpage both authenticate with - no CLI needed to set it). Then set it,
   plus your Worker's URL, on every machine that runs searches:
   ```bat
   setx TRACKER_URL "https://job-search-tracker.<your-subdomain>.workers.dev"
   setx TRACKER_API_TOKEN "<the secret value you just picked>"
   ```
   (Prefer the CLI, or need to re-run migrations after a schema change later?
   [worker/README.md](worker/README.md) documents the manual `wrangler`-based
   path too - same end result.)
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
   Check `private\logs\<track>.log` for what happened.

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

**Headless runs use a scoped tool allowlist**, not full permission bypass -
see `scripts/run-search.ps1`. If a search prompt ever needs a new capability,
add it there deliberately rather than reaching for `--dangerously-skip-permissions`.
