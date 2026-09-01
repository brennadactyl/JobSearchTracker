---
name: job-search-setup
description: Onboards a person into this job-search tracker (or adds a track to an existing one) - provisions their account, reads their resume(s), asks about desired role tracks/target companies/locations, writes their per-track baseline doc, posts their search config and page config to /api/config, and registers their scheduled tasks. Use when someone wants to set up this repo for themselves, add a second person to an existing deployment, or add/change a tracked search.
---

# Job search setup

This repo's tooling (`scripts/`, `server/`, `client/`) is generic - it has no
opinion on whose job search this is, how many tracks they want, or what
locations matter to them. Almost all of the personal part lives in the
tracker API's D1-backed config, keyed by user id (see
`../../../server/README.md`'s `/api/config` section); what's left on disk is
resumes, the per-track notes doc the search edits as it runs, and logs (see
`../../../private.example/README.md`). This skill is what fills those in
conversationally, instead of hand-authoring JSON.

One deployment holds any number of people. Run this the same way for the
first person, for a second person joining an existing deployment, and for
adding one more track to someone who already has some - check what's already
there (step 1) and only ask about what's missing. It also runs the same way
whether this repo got here via `git clone` or via `/plugin install` - the one
place that differs is step 7 (registering scheduled tasks), which needs to
know which one it is.

## One identifier per track

Pick **one lowercase-hyphenated slug per track** (e.g. `engineering`,
`data-science`, `technical-pm`) and use it as *all three* of: the
`docs/tracked_<key>_postings.md` filename, the D1 `tracks.key` / `search`
value sent to `/api/leads`, and the `-Task` value passed to
`run-search.ps1`. Track keys only have to be unique per person - two people
can both have a `SWE`, and their leads, tabs and run history stay separate.
(This repo's own first three tracks predate this skill and split that into
two different values - `SWE`/`TPM`/`CPM` for the tracker vs.
`engineering`/`technical-pm`/`product` for the files - purely for historical
reasons. Don't replicate that split for new tracks; one slug is simpler and
there's no reason left not to.)

## Steps

### 1. Establish who this is, and see what already exists

One deployment can hold several people's job searches, each keyed by a GUID
user id. So the first question is *whose* search this is.

- Data dir is `$JOB_SEARCH_DATA_DIR` if set, else `private/` next to this
  repo. Inside it, each person has their own folder named by their user id,
  holding `docs/`, `resumes/`, `reference/`, `logs/` and `tracker.json`.
- **Existing person?** Ask for their name and find their folder (their id is
  in `tracker.json`, or `GET /api/me` with their token returns it). Read
  `GET /api/config` with their token - the tracks it returns are what they
  already have, so this is an "add a track" run for whatever's missing.
- **New person?** They need an account before anything else can be stored
  against them. That takes the deployment's `ADMIN_TOKEN` (a worker secret -
  whoever runs the Cloudflare account has it):

  ```
  curl -s -X POST "$TRACKER_URL/api/users" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"Their Name","password":"<a long password they choose>"}'
  ```

  It returns their `id`. Create `<data dir>/<id>/` with `docs/`, `resumes/`,
  `reference/` subfolders, then mint the long-lived token their scheduled
  searches will use and write it alongside:

  ```
  curl -s -X POST "$TRACKER_URL/api/login" -H "Content-Type: application/json" \
    -d '{"name":"Their Name","password":"<the password>","label":"scheduled-search"}'
  ```

  Write `{"url": "<tracker url>", "token": "<the token it returned>"}` to
  `<data dir>/<id>/tracker.json`. Never put the password in that file, or
  anywhere else on disk - it's only ever typed into the webpage's sign-in.
- If you don't have `TRACKER_URL`, or the deployment doesn't exist yet, keep
  going (steps 2-5 don't need it) but tell the installer they'll need
  `../../../server/README.md`'s setup done and step 6 re-run before the
  searches can sync anywhere.

### 2. Get the resume(s)

- Ask the installer to place their resume file(s) in `<data dir>/<user id>/resumes/`
  if they haven't already (any format - `.docx`, `.pdf`, `.txt`).
- Read it. Plain text/Markdown: read directly. PDF: use the Read tool
  (supports PDF). `.docx`: use the `docx` skill to extract text, or ask the
  installer for a plain-text copy if that's not available in this
  environment. If nothing readable is present, ask the installer to paste
  their key experience/skills directly in chat instead of blocking on a
  file.
- From it, draft a **candidate profile paragraph** (experience level, most
  recent roles in brief, core skills, location) and a **best-fit roles
  sentence**. Show both to the installer and revise from their feedback
  before using them in step 4 - don't guess silently on anything that
  reads as a stretch.

### 3. Ask about tracks and location scope

For each desired track, get from the installer (infer a first draft from
the resume where reasonable, then confirm):
- **Label** (e.g. "Engineering") and the **key** slug (suggest one from the
  label; confirm it doesn't collide with an existing track from step 1).
- **Role search line**: the actual titles/seniority to search for (e.g.
  "Senior/Staff Software Engineer, Backend Engineer, or Distributed Systems
  roles").
- **Target companies**: a starter list is fine - the doc's "Expanded net"
  section is where the daily search grows the list over time.
- Any **track-specific fit caveat** worth calling out (e.g. a PM track that
  should exclude non-technical PM roles) - optional. Keep this scoped to an
  actual, verifiable mismatch (a skill, language, location, or level the
  installer genuinely doesn't have), not a list of qualifications or role
  categories to require verbatim - the template already defaults every track
  to weighing a stated requirement against the candidate profile rather than
  auto-disqualifying on it (see its "Fit philosophy" section). Watch for this
  same mistake at the category level, not just the requirement level: "the
  resume doesn't document experimentation ownership" is not the same claim as
  "exclude experimentation-flavored roles," and it's an easy one to write
  down as a caveat without noticing the substitution. This matters most for a
  track that's a real stretch from the installer's resume (a title/domain
  pivot, not a lateral match) - that's exactly where an overly literal fit
  caveat quietly screens out real, well-fitting opportunities before the
  installer ever sees them.

- **Is this a second search, or a second tab on the same search?** Two tracks
  usually mean two different searches, each with its own daily run. But a
  split by level or kind of role ("EM of engineers" vs "EM of managers /
  Director") often searches the *same* boards with the *same* resume and
  differs only in which tab a posting lands in - one search, two tabs. For
  that, set the second track's `fed_by` to the first's key and leave the rest
  of its search config empty; each track's `full_description` doubles as the
  rule for what belongs in that tab, so write both as a real description of
  the roles. Ask which way it is rather than assuming.

Once per setup (applies to every track, new and existing):
- **Geographic scope** - the hard filter on what's in-scope at all (e.g. "US
  only", "UK and EU", "no restriction"). This becomes the `geo_scope_line`
  setting, written as a full paragraph with worked examples of what's
  excluded. If "no restriction", leave it empty rather than writing a filter
  that excludes nothing.
- **Priority locations** - one or two tiers of locations that should sort to
  the top within that scope (e.g. "Seattle metro, or remote in the US" as
  top tier, "Portland" as medium). This becomes both the `priority_locations`
  config pushed in step 6 *and* the location-tier table in every track's doc
  (step 4) - keep them in sync; a search-runner writing location text that
  doesn't match the configured tiers is exactly the bug this skill exists to
  avoid.
- **Display title** for the tracker page (e.g. "Jordan's Job Search").

### 4. Write the per-track doc, and draft the track's config

There is no prompt file to generate any more. The daily prompt is composed by
the worker from the track's config in D1 (see
`../../../server/src/prompt.js`), so this step produces *config*, posted in
step 6 - plus one real file:

- Fill `templates/tracked-postings.template.md` (read it first - it's
  commented with what each placeholder means) and write it to
  `<data dir>/<user id>/docs/tracked_<key>_postings.md`. This one stays a
  file because the search itself edits it: it accumulates fetch-reliability
  notes run over run. If it already exists, ask before overwriting - it holds
  real history, not something to regenerate casually.
- `{{LOCATION_TIER_ROWS}}`: one Markdown table row per priority tier, e.g.
  `| Top | Seattle, Bellevue, ... - or remote within scope | teal stripe +
  "Seattle area" / "Remote US" tag, sorted to the top of its tab |`. Keep
  these in step with the `priority_locations` you'll post in step 6.

Then draft the track's config fields for step 6. Most of them are **prose
the prompt uses verbatim**, not keywords the worker expands - write them as
the finished sentence you want the search to read:

- `role_search_line` - the titles/seniority to search for, as it will appear
  mid-sentence ("Senior/Staff Software Engineer, Backend Engineer, or
  Distributed Systems roles").
- `target_companies` - a JSON array of names, joined with commas into the
  prompt. Pass a plain string instead when the list has structure worth
  keeping ("gaming first (...), then creator platforms (...), then the
  expanded net in the doc") - it's used as written.
- `search_note` - anything qualifying that company list. This is where "none
  of these are industry-only searches, surface any matching role at them"
  goes.
- `resume_line` - the whole "read the resume" instruction: which file, any
  fallback file (**say so explicitly if the primary is a `.docx`** - a
  headless run often can't read those), and how this track frames that
  resume. Each track frames the same resume differently; that framing lives
  here, not in a shared setting.
- `fit_clause` / `fit_disqualifier` - a short requirement and its mirror in
  the disqualified list ("a real fit (...)" / "poor fit"). Both empty when
  the track has no fit filter beyond the role line.
- `fit_filter_step` - only for a track that's a genuine pivot, where fit is
  the hard part and one clause won't carry it. Set, it becomes a whole
  screening step of its own before the capture step. Keep it to verifiable
  mismatches (a skill, level, or region they genuinely don't have) - see the
  warning in step 3 about over-literal fit caveats.
- `doc_file` / `doc_summary` - the doc you just wrote, and what it contains.
- `doc_update_line`, `report_line`, `leads_note`, `screened_examples` - only
  when the defaults won't do. Leave them empty otherwise; the composed prompt
  has sensible generic versions.
- `schedule_time` - `HH:mm` local. This *is* the schedule now (step 7 reads
  it), so stagger it: 30 minutes after the last existing track across all
  users on that machine, since they share one CLI. Leave it empty on a track
  with `fed_by` set - that tab has no run of its own.
- `fed_by` - only for a track that's a second tab on a sibling's search rather
  than a search of its own (see step 3). `GET /api/prompt/<fed key>` refuses to
  compose a prompt for one; the feeding track's prompt is the whole search.

Once per person, the settings half (`geo_scope_line`, `scope_clause`,
`scope_disqualifier`, `location_guidance`, `footer_note`, `pronouns`) - also
verbatim prose. Write `geo_scope_line` and `location_guidance` as full
paragraphs with worked examples ("a role that is only London, Bangalore,
... is excluded"; `"Remote (U.S.)"` vs `"USA - Remote"`), not one-word
scopes. The generic fallbacks are deliberately weak; the examples are what
make these actually filter.

### 5. Confirm with the installer

Show the doc you wrote and the config you drafted (or a summary if long)
before moving on - cheaper to fix a wrong target company or location tier now
than after it's pushed live and scheduled.

After step 6 has posted it, fetch the composed prompt and show them that too:

```
curl -s "$TRACKER_URL/api/prompt/<key>" -H "Authorization: Bearer $USER_TOKEN"
```

This is the actual text their search will run every morning, assembled from
what you just posted. It's the fastest way to catch a `resume_line` naming a
file that isn't there, a fit filter that reads harsher than intended, or a
geo scope that says nothing.

### 6. Push config to the tracker API

**GET `/api/config` first and merge** - `POST /api/config`'s `tracks` field
*replaces the whole track list* (see `../../../server/README.md`); posting
only the new track(s) would delete every existing one. So:

```
curl -s "$TRACKER_URL/api/config" -H "Authorization: Bearer $USER_TOKEN"
```

The token decides whose config this is, so use *that person's* token
throughout - there's no user id in the request. Take its `tracks` array,
add/update entries for the track(s) from this run (`key`, `label`,
`full_description` = the role search line or a short description,
`sort_order` = next available index, plus the search-config fields drafted in
step 4), and POST the full merged list back along with `display_title` and
`priority_locations` (only include `display_title`/`priority_locations` if
this run is setting or changing them - omitting a field leaves it as-is):

```
curl -s -X POST "$TRACKER_URL/api/config" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tracks":[...merged list...],"display_title":"...","priority_locations":[...]}'
```

`priority_locations` is an ordered list of `{tier: "p-high"|"p-med", label,
anyOf: [...substrings], allOf?: [...substrings]}` - first match wins,
`anyOf` needs at least one substring present in the (lowercased) location
text, `allOf` (optional) needs all of them present too (used for something
like "remote AND a US indicator", not just "remote" alone).

`excluded_companies` is a JSON array of companies this person will not work
for at all - plain names, or a catch-all phrase like "any other company X owns
or leads". The prompt renders it into a single never-search sentence, so an
exclusion is an append to a list rather than a sentence hand-written into some
track's prose (which is how the first two ended up in two different fields).

Send the prose settings from step 4 in the same call: `geo_scope_line`,
`scope_clause`, `scope_disqualifier`, `location_guidance`, `footer_note`,
`pronouns`. They're per person, so a second person's settings never disturb
the first's.

Three further optional settings, only worth sending if the installer wants
something other than the defaults: `overview_label` and `applications_label`
rename the two built-in tabs (default "Overview" / "Applications"), and
`stale_run_hours` (default 36) sets how long a track's scheduled search can
go without reporting a run before the page flags that tab as stale. Raise it
for a search scheduled less often than daily - a weekly search left at 36
would show a warning nearly all week.

Posting `tracks` also creates each new track's `search_runs` row, so its tab
shows "No run recorded yet" until its first scheduled run reports in. That's
expected on a fresh setup, not a problem to chase.

**Seed the track's company coverage** if its company list is long enough that
one run can't verify all of it properly - roughly a dozen companies and up.
Without this the search sweeps the whole list every night, which sounds
thorough and isn't: everything gets skimmed. Registering the companies turns
on a rotation (the composed prompt gains steps 1c and 9d for any track that
has coverage rows - it's gated on the rows existing, so there's no flag to
set):

```
curl -s -X POST "$TRACKER_URL/api/coverage" \
  -H "Authorization: Bearer $USER_TOKEN" -H "Content-Type: application/json" \
  -d '{"search":"<key>","on":"","swept":[{"company":"Acme","board":"greenhouse"},{"company":"Globex"}]}'
```

`on: ""` means "register these, nobody has swept them" - it creates the rows
without stamping a date, which is what makes them sort first so the early runs
work through the whole list before re-covering anything. Never seed with
today's date: that claims a sweep that didn't happen and starts the rotation
with no idea what it has actually seen. `board` is the JSON-board kind where
one is already known (`greenhouse`, `ashby`, `lever`, `workday cxs`); those
companies cost one fetch for discovery *and* verification, so they're covered
every run rather than rotated. Leave it empty where you don't know - a run
fills it in when it finds one. Seed against the track that *runs* the search:
a `fed_by` tab shares its feeder's coverage list, it doesn't get one of its
own.

If there's no deployment to post to yet, skip this step and tell the
installer to come back to it (re-running this skill is fine, or they can run
the curls above by hand) once they've deployed the API and the webpage.

### 7. Register the scheduled tasks

**If this repo was installed as a Claude Code plugin** (`$env:CLAUDE_PLUGIN_ROOT`
is set), copy its `scripts/` folder to `<data dir>\scripts\` first (overwrite
- keep it current with the plugin's version), and run
`setup-scheduler.ps1` from *that* copy, not from `$env:CLAUDE_PLUGIN_ROOT`
directly:

```powershell
Copy-Item "$env:CLAUDE_PLUGIN_ROOT\scripts" "<data dir>\scripts" -Recurse -Force
& "<data dir>\scripts\setup-scheduler.ps1" -DataDir "<data dir>"
```

This matters because `${CLAUDE_PLUGIN_ROOT}` points at a cache directory that
gets replaced (old versions cleaned up after ~14 days) whenever the plugin
updates. A scheduled task registered against that path directly would break
silently on the next plugin update; one registered against the stable copy
in the data dir doesn't.

**If this repo was `git clone`d instead** (`$env:CLAUDE_PLUGIN_ROOT` is
unset), just run `scripts/setup-scheduler.ps1` from the repo root (or with
`-DataDir` pointing at a non-default data dir) - no copy needed, the clone
itself is already a stable location.

Either way, `setup-scheduler.ps1` discovers people by their
`<data dir>\<user id>\tracker.json` and asks each one's account what tracks
it has - nothing to pass it about which tracks exist. Add `-User <user id>`
to set up only this person; without it, it processes everyone on the
machine, which is also fine (its cleanup only ever touches the people it
processed). It warns about any missing prerequisite (the `claude` CLI,
`CLAUDE_CODE_OAUTH_TOKEN`, unreadable config) rather than failing outright,
so it's safe to run mid-setup.

Note the schedule now comes from each track's `schedule_time` in D1, not from
this script - so a time change is a config post, not a re-registration. When
a machine runs more than one person's searches, stagger across all of them:
they share one CLI and one Claude account (the machine owner's), and each run
takes several minutes.

Re-run this step (the copy + `setup-scheduler.ps1`) any time after a plugin
update, so the stable copy and the registered tasks stay current.

### 8. Offer a test run

Suggest running one new track immediately rather than waiting for its
scheduled time:

```powershell
scripts\run-search.ps1 -Task <key> -User <user id>
```

Then check `<data dir>\<user id>\logs\<key>.log` for what happened, and confirm on the
tracker webpage that the new track's tab shows up *and* now reports when it
last ran. A tab still reading "No run recorded yet" after a completed run
means the prompt's step 9c (`POST /api/runs`) didn't land - worth chasing,
since that record is the only thing that will later distinguish a quiet day
from a search that stopped firing.

If this was a brand-new install, this is also the point where the page stops
being empty: it had no tracks at all until step 6 posted the config.
