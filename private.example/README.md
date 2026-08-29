# Private data folder - expected layout

This repo (the "tooling") never contains personal data. Everything specific to
you - resumes, candidate profile, target companies, search results - lives in
a separate folder that is **not** part of this git repo (see `.gitignore` ->
`/private/`). The live tracker's own data (leads, applications, track
config) lives in its Cloudflare D1 database once you deploy `../server/` -
not in this folder either.

**Recommended: let Claude fill this folder in for you.** Point it at
`../.claude/skills/job-search-setup/` with your resume(s) in hand - it reads
them, asks what tracks/companies/locations you want, and generates everything
below. The rest of this doc describes the result, for reference or for
authoring it by hand instead.

Point the scripts at this folder via `-DataDir`, or set it once as an
environment variable:

```bat
setx JOB_SEARCH_DATA_DIR "C:\path\to\your\private\data"
```

If you don't set one, `scripts\run-search.ps1` and `scripts\setup-scheduler.ps1`
default to a `private\` folder next to this repo (gitignored, safe to keep
there if you'd rather not manage a separate location).

## Required structure

One track = one `scheduled-tasks/<key>.md` + one `docs/tracked_<key>_postings.md`,
where `<key>` is a lowercase-hyphenated slug you pick (e.g. `engineering`,
`data-science`) - it's also the value used as the tracker's `search` field and
the `-Task` argument to `run-search.ps1`. Have as many tracks as you want, not
a fixed number:

```
private/
  docs/
    tracked_<key>_postings.md   candidate profile, target companies, fetch-reliability notes - one per track (found/screened postings live in the tracker DB, not here)
  resumes/
    <your resume files>.docx
  reference/
    <resume text extract, historical tracker xlsx, etc.>
  scheduled-tasks/
    <key>.md                    the filled-in daily prompt for that track - one per track
  logs/                         created automatically by run-search.ps1
```

(This repo's own example tracks use `engineering` / `technical-pm` / `product`
as keys, with `docs/tracked_job_postings.md` / `tracked_pm_postings.md` /
`tracked_cpm_postings.md` as their doc filenames - those doc names predate the
one-key-for-everything convention above; a fresh track's doc should just be
`tracked_<key>_postings.md`, matching its scheduled-task file.)

`scheduled-tasks/*.md` are the actual prompts run each day - they're personal
(they reference your name, resume paths, and target companies), which is why
they live here rather than in the repo. Each one syncs new postings to the
tracker API over HTTP (`curl` + a bearer token) - see `../server/README.md`
for deploying that API and getting `TRACKER_URL` / `TRACKER_API_TOKEN`. (The
webpage itself is a separate deployable, `../client/` - the search scripts
never talk to it directly, only to the API.)

Each prompt also ends by POSTing to `/api/runs` to record that it ran, and
that step is unconditional - it fires even on a day that found nothing. Keep
it if you edit a prompt by hand: it's the only thing that distinguishes a
genuinely quiet day from a search that stopped running, since a run finding
nothing otherwise writes nothing anywhere. The generated prompts include it
already (step 9c); a prompt authored by hand without it leaves that track's
tab stuck reading "No run recorded yet" forever.

## Moving to a new machine

This private folder isn't distributed via GitHub. Copy it yourself - a
zip transfer, a private cloud-synced folder, an external drive, or a separate
*private* git remote if you want version history for it too. Then, on the new
machine: clone this repo, put the private folder wherever you like, set
`JOB_SEARCH_DATA_DIR` (or pass `-DataDir`) to point at it, and set
`TRACKER_URL` / `TRACKER_API_TOKEN` (same values as any other machine - the
tracker (client + API) and its data are already deployed centrally on
Cloudflare, not per-machine).
