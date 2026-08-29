---
name: job-search-setup
description: Onboards an installer of this job-search tracker (or adds a track to an existing install) - reads their resume(s), asks about desired role tracks/target companies/locations, generates the per-track daily-search prompt and baseline doc, configures the tracker webpage's title/tracks/priority-locations via /api/config, and registers the scheduled tasks. Use when a user wants to set up this repo for themselves, or add/change a tracked search.
---

# Job search setup

This repo's tooling (`scripts/`, `server/`, `client/`) is generic - it has no
opinion on whose job search this is, how many tracks they want, or what
locations matter to them. The personal parts live entirely in one private
data folder (see `../../../private.example/README.md` for the expected
layout) and in the tracker API's D1-backed config (see
`../../../server/README.md`'s `/api/config` section). This skill is what
fills those in conversationally, instead of the installer hand-authoring
prompt files and JSON.

Runs the same way for a brand-new install (no `scheduled-tasks/` yet) and for
adding one more track to an existing install - check what's already there
(step 1) and only ask about what's missing. Also runs the same way whether
this repo got here via `git clone` or via `/plugin install` - the one place
that differs is step 7 (registering scheduled tasks), which needs to know
which one it is.

## One identifier per track

Pick **one lowercase-hyphenated slug per track** (e.g. `engineering`,
`data-science`, `technical-pm`) and use it as *all four* of: the
`scheduled-tasks/<key>.md` filename, the `docs/tracked_<key>_postings.md`
filename, the D1 `tracks.key` / `search` value sent to `/api/leads`, and the
`-Task` value passed to `run-search.ps1`. (This repo's own first three
tracks predate this skill and split that into two different values - `SWE`/
`TPM`/`CPM` for the tracker vs. `engineering`/`technical-pm`/`product` for
the files - purely for historical reasons. Don't replicate that split for
new tracks; one slug is simpler and there's no reason left not to.)

## Steps

### 1. Establish the data dir and see what already exists

- Data dir is `$JOB_SEARCH_DATA_DIR` if set, else `private/` next to this
  repo (create it with `docs/`, `resumes/`, `reference/`, `scheduled-tasks/`
  subfolders if it doesn't exist yet).
- List `<data dir>/scheduled-tasks/*.md` - each file's basename is an
  existing track's key. If any exist, this is an "add a track" run for
  whatever tracks are missing; don't touch the existing files.
- Check `TRACKER_URL` and `TRACKER_API_TOKEN` are set (needed for step 6 and
  for the daily searches themselves - see `../../../server/README.md` if
  they still need to deploy the API, and `../../../client/README.md` for the
  webpage). If missing, keep going (steps 2-5 don't need
  them) but tell the installer they'll need to set those and re-run step 6
  before the searches can sync anywhere.

### 2. Get the resume(s)

- Ask the installer to place their resume file(s) in `<data dir>/resumes/`
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

Once per setup (applies to every track, new and existing):
- **Geographic scope** - the hard filter on what's in-scope at all (e.g. "US
  only", "UK and EU", "no restriction"). This becomes each track's step-5
  exclusion rule (`{{GEO_SCOPE_LINE}}` / `{{GEO_SCOPE_PARAGRAPH}}`) - if "no
  restriction", drop that rule's exclusionary language rather than leaving a
  filter that excludes nothing.
- **Priority locations** - one or two tiers of locations that should sort to
  the top within that scope (e.g. "Seattle metro, or remote in the US" as
  top tier, "Portland" as medium). This becomes both the `priority_locations`
  config pushed in step 6 *and* the location-tier table in every track's doc
  (step 4) - keep them in sync; a search-runner writing location text that
  doesn't match the configured tiers is exactly the bug this skill exists to
  avoid.
- **Display title** for the tracker page (e.g. "Jordan's Job Search").

### 4. Generate the files

For each new track, fill `templates/scheduled-task.template.md` and
`templates/tracked-postings.template.md` (read them first - they're
commented with what each placeholder means via their surrounding prose) and
write the results to `<data dir>/scheduled-tasks/<key>.md` and
`<data dir>/docs/tracked_<key>_postings.md`. Notes on specific placeholders:

- `{{SCHEDULE_TIME}}` is informational only (the real schedule comes from
  `setup-scheduler.ps1` in step 7) - pick a plausible value, e.g. stagger
  new tracks 30 minutes apart starting from the next free half-hour after
  existing tracks.
- `{{SIBLING_TRACKS_NOTE}}` / `{{SIBLING_DOCS_NOTE}}`: when there's more than
  one track total (existing + new), a sentence naming the others and saying
  not to merge them (see this repo's own `private.example` for the tone);
  empty string when this is the only track.
- `{{SCOPE_CLAUSE}}` (used inline in step 7 of the scheduled-task template):
  something like `" AND US-based"`, or empty string for "no restriction".
- `{{FIT_CLAUSE}}`: the optional track-specific fit caveat from step 3,
  phrased as `" AND a real fit (...)"`, or empty string.
- `{{LOCATION_TIER_ROWS}}`: one Markdown table row per priority tier, e.g.
  `| Top | Seattle, Bellevue, ... - or remote within scope | teal stripe +
  "Seattle area" / "Remote US" tag, sorted to the top of its tab |`.
- If a target file already exists (re-running for a track that's already
  set up), ask before overwriting - these docs accumulate real search
  history run over run, not something to regenerate casually.

### 5. Confirm with the installer

Show the generated file(s) (or a summary if long) before moving on -
cheaper to fix a wrong target company or location tier now than after it's
pushed live and scheduled.

### 6. Push config to the tracker API

**GET `/api/config` first and merge** - `POST /api/config`'s `tracks` field
*replaces the whole track list* (see `../../../server/README.md`); posting
only the new track(s) would delete every existing one. So:

```
curl -s "$TRACKER_URL/api/config" -H "Authorization: Bearer $TRACKER_API_TOKEN"
```

Take its `tracks` array, add/update entries for the track(s) from this run
(`key`, `label`, `full_description` = the role search line or a short
description, `sort_order` = next available index), and POST the full merged
list back along with `display_title` and `priority_locations` (only include
`display_title`/`priority_locations` if this run is setting or changing
them - omitting a field leaves it as-is):

```
curl -s -X POST "$TRACKER_URL/api/config" \
  -H "Authorization: Bearer $TRACKER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tracks":[...merged list...],"display_title":"...","priority_locations":[...]}'
```

`priority_locations` is an ordered list of `{tier: "p-high"|"p-med", label,
anyOf: [...substrings], allOf?: [...substrings]}` - first match wins,
`anyOf` needs at least one substring present in the (lowercased) location
text, `allOf` (optional) needs all of them present too (used for something
like "remote AND a US indicator", not just "remote" alone).

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

If `TRACKER_URL`/`TRACKER_API_TOKEN` aren't set, skip this step and tell the
installer to come back to it (re-running this skill is fine, or they can run
the curls above by hand) once they've deployed the webpage and set those
environment variables.

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

Either way, `setup-scheduler.ps1` discovers every `scheduled-tasks/*.md`
file itself - nothing to pass it about which tracks exist. It will warn
about any prerequisite that's still missing (the `claude` CLI,
`CLAUDE_CODE_OAUTH_TOKEN`, `TRACKER_URL`/`TRACKER_API_TOKEN`) rather than
fail outright, so it's safe to run even mid-setup.

Re-run this step (the copy + `setup-scheduler.ps1`) any time after a plugin
update, so the stable copy and the registered tasks stay current.

### 8. Offer a test run

Suggest running one new track immediately rather than waiting for its
scheduled time:

```powershell
scripts\run-search.ps1 -Task <key>
```

Then check `<data dir>\logs\<key>.log` for what happened, and confirm the
new track's tab shows up on the tracker webpage.
