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

**The tracker is a plain webpage** (a Cloudflare Worker + KV, see
[worker/README.md](worker/README.md)), not a Claude-specific artifact - so the
whole pipeline runs through the standalone `claude` CLI with no desktop app or
special tooling required. Search results reach the page via a `curl` POST to
a small API; that's it.

## Contents

```
scripts/
  run-search.ps1          runs one search (engineering | technical-pm | product)
  setup-scheduler.ps1      registers all three as daily Windows Scheduled Tasks
worker/
  src/index.js              the tracker webpage + API (Cloudflare Worker)
  wrangler.toml               deploy config
  README.md                   one-time deploy instructions
private.example/
  README.md                  expected layout for your own private data folder
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

**Fetch reliability varies by company and drifts week to week.** Your private
`docs/` files keep per-company notes; re-verify rather than trusting them
blindly.

**Scheduled tasks only run while you're logged in.** For true run-when-closed
scheduling you'd need the machine to stay logged in (Task Scheduler can be
configured to run whether logged on or not, but that requires storing your
Windows password in the task - a bigger tradeoff, not set up here by default).

**Headless runs use a scoped tool allowlist**, not full permission bypass -
see `scripts/run-search.ps1`. If a search prompt ever needs a new capability,
add it there deliberately rather than reaching for `--dangerously-skip-permissions`.
