# Tracked Job Postings — Daily Search Baseline ({{TRACK_TITLE}})

This doc is the running knowledge base for the daily "{{SEARCH_GOAL_SENTENCE}}" search - candidate profile, target companies, scope rules, and per-company fetch-reliability notes.{{SIBLING_DOCS_NOTE}}

**Posting data lives in the tracker DB, not this doc.** The "found" list (what's already tracked) and the "screened" list (what's been looked at and rejected) are both fetched from the tracker each run - see step 1b of the daily prompt (composed by the tracker - `GET /api/prompt/{{TRACK_KEY}}`). This doc holds only the knowledge that has no DB equivalent.

Each run should:
1. Fetch the tracker's current leads AND screened data (step 1b of the daily prompt: `GET /api/dedup/{{TRACK_KEY}}` → `leads[]`, `screened[]`) to see what's already found or already ruled out (compare by URL). Not `/api/data`: that returns every field of every row across every track, which is far larger and grows every day.
2. Re-search the target companies below for {{ROLE_SEARCH_LINE}} matching the Candidate Profile below.
3. **Also run a broader discovery search beyond the fixed target list**: search generally for other companies currently hiring for these roles, plus targeted searches on companies with a strong fit not on the core list (see "Expanded net" below for ones tried so far; add more each run). Apply the same mandatory verification - a new company is not exempt. If an expanded-net company yields a strong verified fit more than once, consider promoting it to the core list.
4. **MANDATORY: fetch every candidate URL directly and confirm it renders an actual job description (title, responsibilities, etc.) before including it anywhere** - in the tracker or the summary to the user. A URL surfaced only by a search-engine snippet is a lead, not a finding, until opened and confirmed. Many "found" links turn out closed/expired/wrong even when freshly searched - check every single one, every run, including previously-tracked ones (they close later). Watch for search snippets that resolve to a listing/index page instead of the individual posting - that does not count as verified, even if the title text matches.
5. Identify postings that are genuinely new - URL not already in `leads[]` or `screened[]` from step 1 - and verified live. Match on the posting, not the string: the same job often turns up under a URL that differs by a `?gh_jid=` suffix, a slug, or a tracking param. The tracker collapses those itself on the way in, so a duplicate you miss is dropped rather than stored, and the response tells you how many it collapsed.
6. **Sync new verified postings to the tracker** via `POST /api/leads` (step 9 of the daily prompt). The tracker DB is the durable source of truth for postings; this doc doesn't keep its own copy.
6b. **Record rejected candidates too.** For any URL checked this run that's genuinely new but does NOT qualify (dead-on-arrival, out of scope, wrong level, duplicate), `POST /api/screened` with a one-line `reason` (step 9b of the daily prompt) instead of writing a doc bullet. That's what lets tomorrow's run skip re-verifying it.
7. **Update the live tracker** (a self-hosted Cloudflare Worker API + D1, see `../../server/README.md`, plus a separate Pages client - see `../../client/README.md`). Sync is done via `curl POST $TRACKER_URL/api/leads` / `/api/screened` with a Bearer token from `$TRACKER_API_TOKEN`, from the daily prompt (`GET /api/prompt/{{TRACK_KEY}}`) - see that for the exact procedure. If there's nothing new either way, skip the relevant call. If the required environment variables aren't readable in the current session, say so and skip rather than guessing.
8. If a previously-tracked lead is confirmed dead on a later check, **never delete or move it yourself** - report it and let the tracker decide. Report by URL, not by id, in one call listing every posting confirmed dead (`POST /api/delist`; procedure is step 8 of the daily prompt), whatever `status` each lead is in. Report the ones you re-checked and found **still live** in the same step (`POST /api/verified`) - that is the only thing that writes a lead's "confirmed live" date, and it matters because a dead posting is now removed from the board rather than flagged, so a lead still showing is presumed live. Only report a posting dead when you actually confirmed it: a timeout, a blocked domain, a 403/429, truncated content or a JS shell that renders nothing all mean *unknown*, and an unknown belongs in neither list - leave the lead alone and note the tooling problem. The delist report cannot be undone.


## Fetch efficiency (apply on every run)

Don't re-spend a full verification attempt rediscovering a **domain-wide fetch block** that's already confirmed - that's different from a specific posting closing, which is real signal and always worth checking. The distinction: if *every* URL tried at a domain fails the *same way* regardless of which posting (robots.txt block, blanket 403/429, a JS-rendered shell with no static content ever, metadata-only, or systematic truncation), that's a tooling wall, not news. If specific postings turn out closed/404 while others at the same domain verify fine, that's normal churn - keep checking those in full.

Once a domain-wide block has shown up on 2+ separate run-dates (track it in the Reliability notes below as it happens), stop spending a fresh attempt confirming it: use a known working fallback if one exists (a different subdomain, an ATS mirror), or skip that domain for the run entirely if none exists, noting in the addendum that it was skipped on cadence grounds rather than re-tested. Re-attempt a skipped domain at most about once a week, or immediately if a specific new posting surfaces there via search that looks like a strong fit - a concrete new lead always earns one verification attempt even at an otherwise-blocked domain.

## Company coverage (apply on every run, once this search has a coverage list)

A company list long enough to be worth having is usually longer than one run
can verify properly, and covering all of it every night is what makes a run
shallow. If this search has been seeded with a coverage list, the daily prompt
carries two extra steps for it - 1c picks which companies this run covers
(cheap JSON boards every run, then the least-recently-swept, capped), and 9d
records what was attempted. Follow them.

**That state lives in the tracker, not this doc** - same reason posting data
does. `GET /api/coverage/{{TRACK_KEY}}` is the list with each company's
last-attempted date; `POST /api/coverage` stamps it. Don't keep a parallel
table here: what belongs in this doc is which companies are worth searching
(Target Companies below) and what is known about fetching each one (Fetch
efficiency above). A confirmed board endpoint belongs in both - here as the
URL shape, and as `board` on the coverage row, so a run that draws that company
knows it can be had in one fetch.

## Scope rules (apply on every run)

{{GEO_SCOPE_PARAGRAPH}}

**Location strings drive priority - write them precisely.** The tracker classifies each row automatically from its `location` text (see `priority_locations` in the tracker's `/api/config` - this table must stay consistent with whatever was configured there); there is no priority field to set. Always include city and state (or region) where known, and use an explicit remote phrasing when a role is remote.

| Tier | Matches | Shown as |
|---|---|---|
{{LOCATION_TIER_ROWS}}
| Standard | any other{{SCOPE_ADJECTIVE}} location | no stripe |

Out-of-scope candidates get recorded via `POST /api/screened` (step 6b above), not a list here.

## Candidate Profile (from {{RESUME_FILENAME}})
{{CANDIDATE_PROFILE_PARAGRAPH}}

Best-fit roles: {{BEST_FIT_SENTENCE}}

**Fit philosophy (apply when filtering):** it's fine - expected, even - for a posting to state a qualification not literally met on paper. Treat a stated requirement as a signal to weigh against the demonstrated background above, not an automatic bar: if there's a credible substitute case for what the role actually needs, it's a finding, not a screen-out. This applies as much to a *category of role* as to a specific requirement line - don't let "my resume doesn't document this" quietly become "exclude this whole role type," even if that exclusion started out written down somewhere as a caveat. A resume is written for a specific audience and routinely omits adjacent experience that would make a real stretch case; a gap on paper is not the same claim as a gap in ability. Reserve exclusion for an actual, verifiable mismatch - a skill, language, location, or level the posting requires and the candidate genuinely doesn't have - not a role category the resume happens not to emphasize. When in doubt, list it and let the person searching decide, rather than pre-filtering it out of view.

## Target Companies
**Core:** {{TARGET_COMPANIES_CORE}}.
**Expanded net (tried so far):** *(none yet - grows as broader-discovery searches turn up repeat hits)*

Reliability notes per company (will drift - always re-verify):
*(none yet - notes accumulate here as runs discover which sites fetch reliably)*
