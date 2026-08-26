# Private data folder - expected layout

This repo (the "tooling") never contains personal data. Everything specific to
you - resumes, candidate profile, target companies, search results - lives in
a separate folder that is **not** part of this git repo (see `.gitignore` ->
`/private/`). The live tracker webpage's data lives in Cloudflare KV once you
deploy `../worker/` - not in this folder either.

Point the scripts at it via `-DataDir`, or set it once as an environment
variable:

```bat
setx JOB_SEARCH_DATA_DIR "C:\path\to\your\private\data"
```

If you don't set one, `scripts\run-search.ps1` and `scripts\setup-scheduler.ps1`
default to a `private\` folder next to this repo (gitignored, safe to keep
there if you'd rather not manage a separate location).

## Required structure

```
private/
  docs/
    tracked_job_postings.md    candidate profile, target companies, found postings - SWE
    tracked_pm_postings.md     same, for technical PM roles
    tracked_cpm_postings.md    same, for consumer PM roles
  resumes/
    <your resume files>.docx
  reference/
    <resume text extract, historical tracker xlsx, etc.>
  scheduled-tasks/
    engineering.md              the filled-in daily prompt for the SWE search
    technical-pm.md             same, for technical PM
    product.md                  same, for consumer PM
  logs/                         created automatically by run-search.ps1
```

`scheduled-tasks/*.md` are the actual prompts run each day - they're personal
(they reference your name, resume paths, and target companies), which is why
they live here rather than in the repo. Each one syncs new postings to the
tracker webpage over HTTP (`curl` + a bearer token) - see `../worker/README.md`
for deploying that webpage and getting `TRACKER_URL` / `TRACKER_API_TOKEN`.

## Moving to a new machine

This private folder isn't distributed via GitHub. Copy it yourself - a
zip transfer, a private cloud-synced folder, an external drive, or a separate
*private* git remote if you want version history for it too. Then, on the new
machine: clone this repo, put the private folder wherever you like, set
`JOB_SEARCH_DATA_DIR` (or pass `-DataDir`) to point at it, and set
`TRACKER_URL` / `TRACKER_API_TOKEN` (same values as any other machine - the
webpage and its data are already deployed centrally on Cloudflare, not
per-machine).
