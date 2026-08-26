# Job Search Tracker

Tooling for running a daily, verified job search entirely headless: three
tracked searches (software engineering, technical program management,
consumer product management), each updating a durable baseline doc and
syncing new postings to a live tracker webpage.

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

## Architecture

![Architecture diagram: Task Scheduler fires the headless Claude CLI three times daily, which reads and writes the local private/ folder, searches and verifies career sites, and posts new leads to a Cloudflare Worker. The Worker reads and writes a D1 database and serves the same data to the browser. Tooling code syncs separately with GitHub, never touching the private data.](docs/architecture.svg)

Full write-up with a reference table of routes and schedules:
[docs/architecture.html](docs/architecture.html) (open locally in a browser -
GitHub shows source for `.html` files rather than rendering them).

## Contents

```
docs/
  architecture.svg           the diagram above
  architecture.html           full architecture write-up (open in a browser)
scripts/
  run-search.ps1              runs one search (engineering | technical-pm | product)
  setup-scheduler.ps1          registers all three as daily Windows Scheduled Tasks
worker/
  src/index.js                  routing
  src/api.js                    D1-backed API handlers
  src/page.html                 the tracker webpage itself
  migrations/                   D1 schema, applied via `wrangler d1 migrations apply`
  wrangler.toml                  deploy config
  README.md                      one-time deploy instructions
private.example/
  README.md                    expected layout for your own private data folder
```

## Setup on any machine

1. **Clone this repo.**
2. **Install prerequisites:**
   - [Node.js](https://nodejs.org) (LTS)
   - `npm install -g @anthropic-ai/claude-code`
   - Authenticate for headless use: `claude setup-token`, then
     `setx CLAUDE_CODE_OAUTH_TOKEN "<token it gives you>"` (open a new
     terminal afterward so the variable takes effect)
3. **Deploy the tracker webpage** (once - not per machine): follow
   [worker/README.md](worker/README.md). You'll end up with a URL and a
   token; set them on every machine that runs searches:
   ```bat
   setx TRACKER_URL "https://job-search-tracker.<your-subdomain>.workers.dev"
   setx TRACKER_API_TOKEN "<the token you chose during worker setup>"
   ```
4. **Get your private data folder onto the machine** - see
   [private.example/README.md](private.example/README.md). Point at it with
   `setx JOB_SEARCH_DATA_DIR "C:\path\to\private"`, or just place it at
   `private\` next to this repo (already gitignored).
5. **Register the scheduled tasks:**
   ```powershell
   .\scripts\setup-scheduler.ps1
   ```
6. **Test one run before trusting the schedule:**
   ```bat
   schtasks /Run /TN JobSearch-Engineering
   ```
   Check `private\logs\engineering.log` for what happened.

Tasks run daily while you're logged in - no stored Windows password required.
If the machine is off or you're logged out at the scheduled time, that run is
skipped (not queued/retried). The webpage itself, unlike the tasks, is always
up - it's hosted on Cloudflare, independent of any machine being on.

## Running a search manually

```powershell
.\scripts\run-search.ps1 -Task engineering
```

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
