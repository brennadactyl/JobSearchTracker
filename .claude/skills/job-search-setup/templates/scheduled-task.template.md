# Scheduled task: {{TRACK_LABEL}} - {{ROLE_SEARCH_LINE}}
# Schedule: {{SCHEDULE_TIME}} local (headless, via Windows Task Scheduler + scripts\run-search.ps1)
# Track key in the tracker data: {{TRACK_KEY}}
# ---------------------------------------------------------------------------

{{SIBLING_TRACKS_NOTE}}Do the following:

1. Read `docs/tracked_{{TRACK_KEY}}_postings.md` - candidate profile, target companies, verification requirement, the found table, and the "Removed / went dead" list (don't re-add those unless re-verified live). Follow its numbered process.
2. Read the resume: `{{RESUME_PATH}}`{{RESUME_FALLBACK}} - {{CANDIDATE_BLURB}}
3. Search target companies' careers sites (web search as backup) for current {{ROLE_SEARCH_LINE}}. Companies: {{TARGET_COMPANIES}}. Also run the doc's broader-discovery step.
4. MANDATORY VERIFICATION: fetch every candidate URL directly and confirm it renders an actual job description (real title, responsibilities/qualifications - not a landing page, 404, "job not found," a loading placeholder, or a listing/index page that merely contains the title text). A search-snippet URL is a lead, not a finding, until opened and confirmed. If a site won't reveal real content, skip that company today rather than report something unverified.
5. {{GEO_SCOPE_LINE}}
6. Write accurate location strings - the tracker derives priority from them automatically, so precision matters. {{LOCATION_GUIDANCE}} There is no priority field to set - just get the location text right.
6b. While the posting is open, also capture - only when it's stated plainly, never inferred or guessed - the team/org named for the role (`team`), the stated work arrangement (`setup`, e.g. "Remote", "Hybrid - 3 days/week onsite", "Onsite"), and any posted compensation range (`comp`, e.g. "$180,000-$230,000/yr"; many US states disclose this by law). Leave any of these as an empty string when the posting doesn't say. These land in the tracker's per-lead "Details" panel alongside referral/resume/next-action fields you fill in by hand - this search never touches those.
7. Compare against the URLs already in the doc. Identify ONLY postings that are genuinely new AND verified live{{SCOPE_CLAUSE}}{{FIT_CLAUSE}}.
8. Rewrite `docs/tracked_{{TRACK_KEY}}_postings.md` in full: keep existing rows and the dead-link list, append new verified postings with today's date and "Verified live <date>", move anything re-checked and found dead into "Removed / went dead". This doc is the durable source of truth for postings.
9. SYNC NEW POSTINGS TO THE LIVE TRACKER WEBPAGE. If there are zero new verified postings from step 7, skip this step entirely - do not call the API. Otherwise, build a JSON array of only today's new postings and POST it with curl:

   ```
   curl -s -X POST "$TRACKER_URL/api/leads" \
     -H "Authorization: Bearer $TRACKER_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"leads":[{"search":"{{TRACK_KEY}}","company":"...","title":"...","location":"...","url":"...","found":"YYYY-MM-DD","verified":"YYYY-MM-DD","fit":"...","team":"...","setup":"...","comp":"..."}]}'
   ```

   Every object's `"search"` must be `"{{TRACK_KEY}}"`. `found` and `verified` are
   today's date. `team`, `setup`, and `comp` are the step-6b fields - omit
   the key entirely (don't send an empty string) for any of them the posting
   didn't state. `TRACKER_URL` and `TRACKER_API_TOKEN` are environment
   variables - just run the curl command above directly and let normal shell
   expansion fill them in; don't spend a step checking whether they're set
   first (e.g. `printenv`, `echo $TRACKER_URL`) - that's a separate command
   from curl and may not be pre-approved in this environment, so it can stall
   the run for nothing. If curl's response makes clear a variable was empty
   (e.g. the URL resolves to nothing, or the request is obviously malformed),
   say so in your report. Check the curl response: a JSON body with an
   `"added"` count means it worked; anything else (including no response, a
   non-2xx status, or an `"error"` field) means it failed - report that
   plainly, the doc update from step 8 still stands regardless.
10. Report: if there are new verified postings, list each (company, title, location, URL) as "New today - verified live", and say whether the webpage sync succeeded. If none, say so plainly - don't pad.

Never add an unverified link to any output.
