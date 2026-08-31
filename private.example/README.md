# Private data folder - expected layout

This repo (the "tooling") never contains personal data. Everything specific to
a person - resumes, their per-track notes, search logs, their tracker
credential - lives in a separate folder that is **not** part of this git repo
(see `.gitignore` -> `/private/`). Their leads, applications, page config and
the search config itself live in the Cloudflare D1 database once `../server/`
is deployed, keyed by their user id - not in this folder.

**Recommended: let Claude fill this folder in.** Point it at
`../.claude/skills/job-search-setup/` with a resume in hand - it provisions the
account, creates the folder, and generates everything below. The rest of this
doc describes the result, for reference or for authoring it by hand instead.

Point the scripts at this folder via `-DataDir`, or set it once as an
environment variable:

```bat
setx JOB_SEARCH_DATA_DIR "C:\path\to\your\private\data"
```

If you don't set one, `scripts\run-search.ps1` and `scripts\setup-scheduler.ps1`
default to a `private\` folder next to this repo (gitignored, safe to keep
there if you'd rather not manage a separate location).

## Required structure

**One folder per person, named by their user id** - the GUID that
`POST /api/users` returned when their account was created. One machine can run
several people's searches this way, and nothing in one person's folder says
anything about anyone else's:

```
private/
  <user-id>/
    tracker.json                  {"url": "...", "token": "..."} - their own API URL and session token
    docs/
      tracked_<key>_postings.md   per-track notes: fit reasoning, target companies,
                                  fetch-reliability findings. The search edits this
                                  as it runs, which is why it's a file and not config.
    resumes/
      <their resume files>.docx
    reference/
      <resume text extract, historical tracker xlsx, etc.>
    logs/                         created automatically by run-search.ps1
  <another-user-id>/
    ...
```

`<key>` is a lowercase-hyphenated slug per track (e.g. `engineering`,
`data-science`) - the same value used as the tracker's `search` field and the
`-Task` argument to `run-search.ps1`. Keys only have to be unique per person:
two people can both have a `SWE`.

### tracker.json

Each person's own credential, which is why it lives beside their data rather
than in a machine-wide environment variable - an environment variable can only
hold one person's token.

```json
{ "url": "https://your-api-worker.your-subdomain.workers.dev", "token": "<their session token>" }
```

Mint the token once with `POST /api/login` and a `"label"` of
`"scheduled-search"` (see `../server/README.md`), so it can be revoked on its
own without disturbing whatever browsers they're signed in on. **Their
password never goes in this file, or anywhere else on disk** - it's only ever
typed into the webpage's sign-in.

A machine set up before multi-user support - no per-user folders, `docs/` and
`resumes/` directly in the data dir, `TRACKER_URL`/`TRACKER_API_TOKEN` in the
environment - still works: both scripts fall back to that layout when they
find no `<user-id>/tracker.json`.

## No prompt files

Earlier versions kept the daily search prompt as `scheduled-tasks/<key>.md`
here, one hand-maintained file per track. Those are gone. The prompt is now
composed by the worker from that track's config in D1 and fetched at run time
(`GET /api/prompt/<key>` - see `../server/src/prompt.js`), which is what lets
one machine run several people's searches without holding several people's
search config, and what keeps the API's own calling convention defined in one
place rather than copied into every prompt file.

To change what a search does - target companies, the role line, the fit
filter, which resume it reads, what time it runs - change that track's config
(`POST /api/config`, or re-run the setup skill). To see exactly what a search
will run:

```
curl -s "$TRACKER_URL/api/prompt/<key>" -H "Authorization: Bearer <their token>"
```

## Moving to a new machine

This private folder isn't distributed via GitHub. Copy it yourself - a zip
transfer, a private cloud-synced folder, an external drive, or a separate
*private* git remote if you want version history for it too. Then, on the new
machine: clone this repo, put the private folder wherever you like, and set
`JOB_SEARCH_DATA_DIR` (or pass `-DataDir`). The credentials travel with the
folder in each person's `tracker.json`; the tracker and its data are already
deployed centrally on Cloudflare, not per-machine.
