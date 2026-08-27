# Tracked Job Postings — Daily Search Baseline ({{TRACK_TITLE}})

This doc is the running baseline for the daily "{{SEARCH_GOAL_SENTENCE}}" search.{{SIBLING_DOCS_NOTE}}

Each run should:
1. Read this doc to see what's already been found (compare by URL).
2. Re-search the target companies below for {{ROLE_SEARCH_LINE}} matching the Candidate Profile below.
3. **Also run a broader discovery search beyond the fixed target list**: search generally for other companies currently hiring for these roles, plus targeted searches on companies with a strong fit not on the core list (see "Expanded net" below for ones tried so far; add more each run). Apply the same mandatory verification - a new company is not exempt. If an expanded-net company yields a strong verified fit more than once, consider promoting it to the core list.
4. **MANDATORY: fetch every candidate URL directly and confirm it renders an actual job description (title, responsibilities, etc.) before including it anywhere** - in this doc, the tracker, or the summary to the user. A URL surfaced only by a search-engine snippet is a lead, not a finding, until opened and confirmed. Many "found" links turn out closed/expired/wrong even when freshly searched - check every single one, every run, including previously verified ones (they close later). Watch for search snippets that resolve to a listing/index page instead of the individual posting - that does not count as verified, even if the title text matches.
5. Report only postings whose URL is NOT already listed below as new findings.
6. Append genuinely new (and verified-live) postings to the table below with today's date and a "Verified live <date>" note, and rewrite this doc in full so the baseline stays current. This doc is the durable source of truth for postings.
7. **Update the live tracker webpage** (a self-hosted Cloudflare Worker + D1 - see `../../worker/README.md`). Sync is done via `curl POST $TRACKER_URL/api/leads` with a Bearer token from `$TRACKER_API_TOKEN`, from the scheduled-task prompt (`scheduled-tasks/{{TRACK_KEY}}.md`) - see that file for the exact procedure. If there are no new verified postings, skip the sync. If the required environment variables aren't readable in the current session, say so and skip rather than guessing.
8. If a previously-listed posting is confirmed dead on a later check, move it to the "Removed / went dead" list below **only if its tracker status is still `"New"`** - if the installer has moved it to any other status (Applied, Interviewing, Rejected, etc.), leave it in the found table instead and just note the posting is no longer live; they still need to track what they applied to regardless of whether the listing itself survives. (Fetching current status from the tracker is step 1b of `scheduled-tasks/{{TRACK_KEY}}.md` - see that file for the exact procedure.) If a posting couldn't be re-verified due to a fetch/tooling problem (timeout, blocked domain, truncated content) rather than a confirmed 404/closed page, leave it in the found table and note the tooling issue instead - don't treat "couldn't check" as "dead."


## Fetch efficiency (apply on every run)

Don't re-spend a full verification attempt rediscovering a **domain-wide fetch block** that's already confirmed - that's different from a specific posting closing, which is real signal and always worth checking. The distinction: if *every* URL tried at a domain fails the *same way* regardless of which posting (robots.txt block, blanket 403/429, a JS-rendered shell with no static content ever, metadata-only, or systematic truncation), that's a tooling wall, not news. If specific postings turn out closed/404 while others at the same domain verify fine, that's normal churn - keep checking those in full.

Once a domain-wide block has shown up on 2+ separate run-dates (track it in the Reliability notes below as it happens), stop spending a fresh attempt confirming it: use a known working fallback if one exists (a different subdomain, an ATS mirror), or skip that domain for the run entirely if none exists, noting in the addendum that it was skipped on cadence grounds rather than re-tested. Re-attempt a skipped domain at most about once a week, or immediately if a specific new posting surfaces there via search that looks like a strong fit - a concrete new lead always earns one verification attempt even at an otherwise-blocked domain.

## Scope rules (apply on every run)

{{GEO_SCOPE_PARAGRAPH}}

**Location strings drive priority - write them precisely.** The tracker classifies each row automatically from its `location` text (see `priority_locations` in the tracker's `/api/config` - this table must stay consistent with whatever was configured there); there is no priority field to set. Always include city and state (or region) where known, and use an explicit remote phrasing when a role is remote.

| Tier | Matches | Shown as |
|---|---|---|
{{LOCATION_TIER_ROWS}}
| Standard | any other{{SCOPE_ADJECTIVE}} location | no stripe |

**Postings removed as out of scope** - do not re-add:
*(none yet - entries land here as runs exclude postings)*

## Candidate Profile (from {{RESUME_FILENAME}})
{{CANDIDATE_PROFILE_PARAGRAPH}}

Best-fit roles: {{BEST_FIT_SENTENCE}}

**Fit philosophy (apply when filtering):** it's fine - expected, even - for a posting to state a qualification not literally met on paper. Treat a stated requirement as a signal to weigh against the demonstrated background above, not an automatic bar: if there's a credible substitute case for what the role actually needs, it's a finding, not a screen-out. This applies as much to a *category of role* as to a specific requirement line - don't let "my resume doesn't document this" quietly become "exclude this whole role type," even if that exclusion started out written down somewhere as a caveat. A resume is written for a specific audience and routinely omits adjacent experience that would make a real stretch case; a gap on paper is not the same claim as a gap in ability. Reserve exclusion for an actual, verifiable mismatch - a skill, language, location, or level the posting requires and the candidate genuinely doesn't have - not a role category the resume happens not to emphasize. When in doubt, list it and let the person searching decide, rather than pre-filtering it out of view.

## Target Companies
**Core:** {{TARGET_COMPANIES_CORE}}.
**Expanded net (tried so far):** *(none yet - grows as broader-discovery searches turn up repeat hits)*

Reliability notes per company (will drift - always re-verify):
*(none yet - notes accumulate here as runs discover which sites fetch reliably)*

## Postings Found (all verified live as of the date shown)

| Date Found | Company | Title | Location | URL | Verified |
|---|---|---|---|---|---|
*(none yet - the first run populates this table)*
