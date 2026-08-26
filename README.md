# Job Search Tracker

Tooling for running a daily, verified job search through Claude Code: three
tracked searches (software engineering, technical program management,
consumer product management), each updating a durable baseline doc and a
live tracker page.

**This repo contains no personal data.** Resumes, candidate profile, target
companies, and search results live in a separate local "private" folder —
see [private.example/README.md](private.example/README.md) for the expected
layout. That separation is what makes this repo safe to keep on GitHub (public
or private) and to reuse across machines.

## Contents

```
scripts/
  run-search.ps1         runs one search (engineering | technical-pm | product)
  setup-scheduler.ps1     registers all three as daily Windows Scheduled Tasks
tracker/
  template.html            generic tracker-page template (no personal data);
                            the private data dir's tracker/data.json is merged
                            into this at publish time
private.example/
  README.md                expected layout for your own private data folder
```

## Setup on any machine

1. **Clone this repo.**
2. **Install prerequisites:**
   - [Node.js](https://nodejs.org) (LTS)
   - `npm install -g @anthropic-ai/claude-code`
   - Authenticate for headless use: `claude setup-token`, then
     `setx CLAUDE_CODE_OAUTH_TOKEN "<token it gives you>"` (open a new
     terminal afterward so the variable takes effect)
3. **Get your private data folder onto the machine** — see
   [private.example/README.md](private.example/README.md). Point at it with
   `setx JOB_SEARCH_DATA_DIR "C:\path\to\private"`, or just place it at
   `private\` next to this repo (already gitignored).
4. **Register the scheduled tasks:**
   ```powershell
   .\scripts\setup-scheduler.ps1
   ```
5. **Test one run before trusting the schedule:**
   ```bat
   schtasks /Run /TN JobSearch-Engineering
   ```
   Running it once interactively also pre-approves any tool permissions
   (web search, Artifact publish) so the unattended daily run doesn't stall
   on a permission prompt with nobody there to answer it.

Tasks run daily while you're logged in — no stored Windows password required.
If the machine is off or you're logged out at the scheduled time, that run is
skipped (not queued/retried).

## Running a search manually

```powershell
.\scripts\run-search.ps1 -Task engineering
```

## The live tracker

Each search reads and republishes a live Claude Artifact page (URL lives in
your private `scheduled-tasks/*.md` prompts, not in this repo). The page keeps
its entire state — leads plus your Status/Notes edits — in one embedded JSON
blob, so every update must read the current page, merge new rows in without
touching existing `status`/`notes`/`applications`, and republish in place
(never as a new artifact). `tracker/template.html` here is the page shell that
gets the merged JSON substituted in for `__APPDATA__`.

## Things worth not relearning

**Verification is the whole game.** Every candidate URL must be fetched and
confirmed to render a real job description — title plus
responsibilities/qualifications. A search-engine snippet is a lead, not a
finding. Watch especially for URLs that resolve to a company's *listing
index* rather than the individual posting — the title text matches, so it
looks right, and it isn't.

**Fetch reliability varies by company and drifts week to week.** Your private
`docs/` files keep per-company notes; re-verify rather than trusting them
blindly.

**Never force a publish.** If the artifact refuses a publish because a newer
version was saved from inside the page, that's your own edits living there.
Read, merge, republish — don't overwrite.

**Scheduled tasks only run while you're logged in.** For true run-when-closed
scheduling you'd need the machine to stay logged in (Task Scheduler can be
configured to run whether logged on or not, but that requires storing your
Windows password in the task — a bigger tradeoff, not set up here by default).
