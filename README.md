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
  run-search.ps1              runs one track for one person (fetches its prompt from the API)
  setup-scheduler.ps1          registers every person's tracks as daily Windows Scheduled Tasks
  seed-demo-user.ps1           creates the demo account and fills it with invented postings
  demo-user.json               that invented data - the only fabricated content in this repo
  backup-tracker.ps1           exports the whole database to a dated .sql file + an off-machine mirror
  archive-backups.ps1          copies those exports into an archive this account can't modify (runs as SYSTEM)
  protect-backups.ps1          one-time elevated setup that creates that archive and its task
  verify-backups.ps1           proves the archive really refuses writes, from an unelevated shell
server/                        API only - Cloudflare Worker + D1, no HTML served
  src/index.js                  entry point: session resolution, CORS preflight, dispatch
  src/routes/                   one module per resource; index.js is the route table
  src/http.js                   every response the worker builds + CORS headers
  src/validate.js               the checks more than one route makes
  src/auth.js                   passwords, session tokens, who a token belongs to
  src/db.js                     all D1 access for a person's own data
  src/prompt.js                 composes each track's daily search prompt from its config
  migrations/                   the D1 schema, applied via `wrangler d1 migrations apply`
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
   **Settings → Variables and Secrets**, add a secret named `ADMIN_TOKEN`
   with any long random value you pick (no CLI needed to set it). This isn't
   a login - it's the operator credential that creates accounts, since there
   is no sign-up page. Then create your own account with it:
   ```bash
   curl -s -X POST "https://job-search-tracker.<your-subdomain>.workers.dev/api/users" \
     -H "Authorization: Bearer <the ADMIN_TOKEN you just set>" \
     -H "Content-Type: application/json" \
     -d '{"name":"Your Name","password":"a-long-password-you-pick"}'
   ```
   Keep the `id` it returns - that's your user id, and step 4 puts your
   search data under it.

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

   Now open the client's URL and sign in with the name and password from the
   account you created above. It remembers you in that browser until you log
   out.

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
   It discovers each person by their `private\<user-id>\tracker.json` and
   asks their account what tracks it has - nothing to tell it about how many
   you have, or how many people share the machine.
6. **Test one run before trusting the schedule** - the previous step prints
   the exact command for whichever tracks it just registered, e.g.:
   ```bat
   schtasks /Run /TN JobSearch-ab266b6c-Engineering
   ```
   Check `private\<user-id>\logs\<track>.log` for what happened, then reload the
   tracker page: that track's tab should now show when it last ran and what
   it found. Until a track's first run reports in it reads "No run recorded
   yet", which is also what you'll see on a brand-new install.

7. **Set up backups** - see [Backups](#backups) below. One elevated command,
   and it's the step you won't think to do until you need it: nothing above
   this line leaves a copy of your data anywhere but Cloudflare.

Tasks run daily while you're logged in - no stored Windows password required.
If the machine is off or you're logged out at the scheduled time, that run is
skipped (not queued/retried). The webpage itself, unlike the tasks, is always
up - it's hosted on Cloudflare, independent of any machine being on.

## Running a search manually

```powershell
.\scripts\run-search.ps1 -Task <track key> -User <user id>
```

`<track key>` is whatever you named a track when setting it up - e.g.
`engineering`. `<user id>` is the GUID whose folder under `private\` holds
that person's resumes and credentials; omit it only on a single-user machine
set up before per-user folders existed.

To see exactly what that run will do, without running it:

```bash
curl -s "$TRACKER_URL/api/prompt/<track key>" -H "Authorization: Bearer <their token>"
```

## Adding another person

One deployment holds any number of job searches, each with its own tracks,
leads, page title and location rules, and its own sign-in. To add someone:

1. Create their account with the `ADMIN_TOKEN` (same `POST /api/users` call
   as step 3 of Setup above). It returns their user id.
2. Run the [job-search-setup](.claude/skills/job-search-setup/) skill for
   them - it makes `private\<their id>\`, mints the token their scheduled
   runs use, reads their resume, asks about their tracks and locations,
   posts their config, and registers their scheduled tasks without touching
   anyone else's.

They sign in on the same tracker URL with their own name and password.
Their searches run on whichever machine holds their folder, under that
machine's Claude account - so stagger everyone's `schedule_time`, since each
run takes several minutes and they share one CLI.

Note what this does and doesn't protect: the API keeps each person's data
strictly separate, but whoever administers the Cloudflare account can read
any of it directly in D1. This is for people who are fine with that.

## The demo account

A tracker with real data in it is a bad thing to show anyone. A job search is
a document about where someone works, where they'd rather work, what they've
been rejected from and what they expect to be paid, and none of that stops
being true because the screen share is short. So there is a third kind of
account here, alongside the real ones: a demo, whose every row is invented.

```powershell
.\scripts\seed-demo-user.ps1 -AdminToken <the ADMIN_TOKEN>
```

That creates an account called `Demo`, fills it from
[`scripts/demo-user.json`](scripts/demo-user.json), and prints the password to
sign in with (pass `-Password` to choose a memorable one instead). It writes
everything through the ordinary HTTP API, so the demo can only ever be in a
state a real search could have produced - and running it is a live end-to-end
check that those routes still work.

**The data is invented, not anonymised.** Northwind Systems and Kestrel
Analytics are not companies, and every posting URL is under `example.com`,
which IANA reserves for documentation and which can never resolve to a real
job posting. Nothing in it can be mistaken for a record of a real company's
hiring, and no link in it leads anywhere. It's the one place in this repo with
fabricated content, which is why it's a single readable file rather than rows
scattered through a script.

It covers most of what there is to show: three tracks including a `fed_by`
pair (one search filling two tabs), leads across every status and every
location tier, twenty screened postings, and nine applications walked through
the pipeline from "To Apply" to an offer. The dates are stored as day offsets
rather than calendar dates, so it always reads as a search that's been running
for the last three weeks - re-run with `-Force` to move it forward to today.

**It has no scheduled search, and can't acquire one.** It gets no
`private\<user id>\` folder, and `setup-scheduler.ps1` finds people by scanning
for `<data dir>\*\tracker.json` - so an account with no folder is invisible to
it. Its tracks carry no `schedule_time` for the same reason, and its
`stale_run_hours` is set to a year, because the staleness warning reports a
search that has stopped firing and this account never had one to stop. You can
still fetch `GET /api/prompt/engineering` for it to show what a composed daily
prompt looks like; it just refers to resume and notes files that only a real
account would have on disk.

`-Force` is needed to re-seed an account that already holds data, since
application rows are the one thing nothing dedups. Before it deletes any of
them it checks that every lead on the account is an `example.com` URL and
refuses outright if one isn't - so pointing it at a real person's account by
mistake costs nothing.

## Backups

Cloudflare's own answer for D1 is [Time
Travel](https://developers.cloudflare.com/d1/reference/time-travel/) -
point-in-time recovery over the last 30 days, on by default, no setup. It is
genuinely good at the thing it does: undoing a bad write. It is no help at all
for the two cases worth planning for, because the recovery mechanism lives
inside the thing being lost. `wrangler d1 delete` takes the database *and* its
Time Travel history in one step, and if the Cloudflare account goes, both go
with it.

So the only real safety net is a copy of the data somewhere else, and a copy
that whatever went wrong can't also delete. Three pieces, in order of how much
they're worth:

| | where | who can destroy it |
|---|---|---|
| working copy | `private\backups\` | anything running as you |
| archive | `%ProgramData%\JobSearchTracker\backups\` | only an elevated process |
| off-machine | OneDrive (or `JOB_SEARCH_BACKUP_MIRROR`) | deletable locally, but recoverable from the service's own trash |

`backup-tracker.ps1` writes the first and third every night. It exports to a
temp file and checks it before letting it count as a backup - right size, has
tables, has rows, not dramatically smaller than yesterday's - because an export
that succeeds and returns nothing is the failure that would otherwise go
unnoticed for months. It never deletes anything; at roughly 800 KB a day,
retention isn't worth a script that removes backups unattended.

`archive-backups.ps1` copies new exports into the second. That folder is owned
by Administrators and grants everyone else read-only, so an unelevated process -
which is what a scheduled task, a script, or an AI agent actually is - can read
the backups but cannot write, rename, truncate or delete them. Filling a folder
like that needs a writer you aren't, hence a task running as SYSTEM.

Set it up once, from an **Administrator** PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\VibeCoding\scripts\protect-backups.ps1"
```

(The `-ExecutionPolicy Bypass` isn't optional theatre: this machine leaves the
policy Undefined, which means Restricted for an interactive shell, so calling
the script by path just fails. The scheduled tasks pass the same flag. Spawning
a child process this way inherits the elevation and changes no policy setting.)

That creates the archive, sets its ownership and permissions, installs its own
copy of the archiver inside it (a task running as SYSTEM must never execute a
script you can edit - that turns the task into free administrator access), and
registers both daily tasks: the export at 03:15 as you, the archive at 03:45 as
SYSTEM. Re-run it after changing `archive-backups.ps1`.

Neither task name matches `JobSearch-*`, which is what `setup-scheduler.ps1`
sweeps for stale search tasks - a backup job silently unregistered by the next
scheduler run is exactly the failure you'd only find out about when you needed
it. The export runs under the same Interactive logon as the searches, so like
them it only fires while you're logged in; the archive runs as SYSTEM and
doesn't care.

Then check it from an ordinary, **unelevated** window - a permission scheme that
quietly stopped applying looks exactly like one that works:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\VibeCoding\scripts\verify-backups.ps1"
```

It makes real attempts to overwrite, rename and delete an archived backup, to
edit the script SYSTEM runs, and to grant itself the permissions back - all of
which must be refused. Safe to run: every archived file also exists in the
working folder and the mirror, so even a probe that unexpectedly succeeded
costs nothing.

To restore, feed a `.sql` file back with `wrangler d1 execute <db> --remote
--file <backup.sql>` - see `server/README.md`, which covers doing that against
a database with live data in it.

**What this does and doesn't cover.** It guarantees the data survives: if the
database is deleted, the rows are still on disk and in OneDrive, in a form that
restores. It does not prevent the deletion. That capability comes from
wrangler's stored credential, and no file permission touches it - the
`.claude/hooks/block-remote-d1-writes.mjs` PreToolUse hook refuses the obvious
commands, but a hook is a config file, not a boundary, and something determined
could call the Cloudflare API directly. The protection worth having is the one
that makes the loss recoverable.

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
