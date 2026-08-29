# Scheduled task: {{TRACK_LABEL}} - {{ROLE_SEARCH_LINE}}
# Schedule: {{SCHEDULE_TIME}} local (headless, via Windows Task Scheduler + scripts\run-search.ps1)
# Track key in the tracker data: {{TRACK_KEY}}
# ---------------------------------------------------------------------------

{{SIBLING_TRACKS_NOTE}}Do the following:

1. Read `docs/tracked_{{TRACK_KEY}}_postings.md` - candidate profile, target companies, verification requirement, and per-company fetch-reliability notes. Follow its numbered process. The doc doesn't keep a found-postings table or a screened/dead-link list of its own - dedup data comes from step 1b instead.
1b. Fetch the tracker's current data: `curl -s "$TRACKER_URL/api/data" -H "Authorization: Bearer $TRACKER_API_TOKEN"`. This returns `leads[]` (postings already tracked - keep each one's `url` and `status` on hand for step 8, it's how you tell a stale lead nobody's touched from one the installer has already applied to) and `screened[]` (postings already looked at and rejected - keep each one's `url` on hand for step 7, so you don't re-verify the same dead/out-of-scope candidate every run).
2. Read the resume: `{{RESUME_PATH}}`{{RESUME_FALLBACK}} - {{CANDIDATE_BLURB}}
3. Search target companies' careers sites (web search as backup) for current {{ROLE_SEARCH_LINE}}. Companies: {{TARGET_COMPANIES}}. Also run the doc's broader-discovery step.
4. MANDATORY VERIFICATION: fetch every candidate URL directly and confirm it renders an actual job description (real title, responsibilities/qualifications - not a landing page, 404, "job not found," a loading placeholder, or a listing/index page that merely contains the title text). A search-snippet URL is a lead, not a finding, until opened and confirmed. If a site won't reveal real content, skip that company today rather than report something unverified.
5. {{GEO_SCOPE_LINE}}
6. Write accurate location strings - the tracker derives priority from them automatically, so precision matters. {{LOCATION_GUIDANCE}} There is no priority field to set - just get the location text right.
6b. While the posting is open, also capture - only when it's stated plainly, never inferred or guessed - the team/org named for the role (`team`), the stated work arrangement (`setup`, e.g. "Remote", "Hybrid - 3 days/week onsite", "Onsite"), and any posted compensation range (`comp`, e.g. "$180,000-$230,000/yr"; many US states disclose this by law). Leave any of these as an empty string when the posting doesn't say. These land in the tracker's per-lead "Details" panel alongside referral/resume/next-action fields you fill in by hand - this search never touches those.
7. Compare candidate URLs against `leads[]` and `screened[]` from step 1b (not a doc table). Sort each candidate into: (a) already tracked or already screened - skip it; (b) genuinely new, verified live{{SCOPE_CLAUSE}}{{FIT_CLAUSE}} - a finding, goes to step 9; (c) genuinely new but disqualified (dead-on-arrival, out of scope, wrong level, duplicate of an existing lead) - goes to step 9b instead of being dropped silently.
8. For a previously-tracked lead (from step 1b's `leads[]`) confirmed dead on this check, **never remove or move it** - it stays a lead. Use the step-1b tracker data (match by `url`) to call `POST /api/update` marking it delisted:
   ```
   curl -s -X POST "$TRACKER_URL/api/update" \
     -H "Authorization: Bearer $TRACKER_API_TOKEN" -H "Content-Type: application/json" \
     -d '{"type":"lead","id":<its id>,"delistedOn":"<today YYYY-MM-DD>"}'
   ```
   This is independent of `status` (Applied, Interviewing, etc. are untouched) - the installer still needs to track what they applied to regardless of whether the listing survives. If a posting previously marked delisted is found live again, clear it the same way with `"delistedOn":""`. If the tracker's unreachable, skip the API call and note it in your report - don't guess an id.
8b. If you learned something about fetch reliability worth keeping - a newly-blocked domain, a working URL-format fix, a company worth promoting from "expanded net" to "core" - update the relevant section of `docs/tracked_{{TRACK_KEY}}_postings.md`. Do not add a found-postings table or a screened/dead-link list back to the doc; those live in the tracker only.
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
   plainly, the delisting update from step 8 still stands regardless.
9b. RECORD SCREENED-OUT CANDIDATES. If there are zero disqualified-but-new candidates from step 7, skip this step. Otherwise, POST them so tomorrow's run doesn't re-verify them:

   ```
   curl -s -X POST "$TRACKER_URL/api/screened" \
     -H "Authorization: Bearer $TRACKER_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"screened":[{"search":"{{TRACK_KEY}}","url":"...","company":"...","title":"...","location":"...","reason":"..."}]}'
   ```

   `"search"` must be `"{{TRACK_KEY}}"`. `reason` is a short, specific, human-readable explanation (e.g. "outside scope: London, UK", "404 - closed", "duplicate of req 7829580003", "below target level") - this is what makes the entry useful later, don't leave it vague. Same success/failure check as step 9 (an `"added"` count means it worked).
9c. RECORD THE RUN. **Do this every single run, without exception - including runs that found nothing, runs where every candidate was screened out, and runs where steps 8/9/9b were skipped or failed.** This is the one step with no "skip it if there's nothing to report" clause, and the reason is that a run finding nothing writes nothing anywhere else: no leads, no screened rows, no delistings. Without this call, a search that silently stopped running (expired token, disabled scheduled task, machine asleep) looks identical on the tracker webpage to a genuine zero-result day, and can go unnoticed for weeks.

   ```
   curl -s -X POST "$TRACKER_URL/api/runs" \
     -H "Authorization: Bearer $TRACKER_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"search":"{{TRACK_KEY}}","status":"ok","leadsAdded":0,"screenedAdded":0,"delisted":0,"on":"<today YYYY-MM-DD>","note":"..."}'
   ```

   `"search"` must be `"{{TRACK_KEY}}"`. `leadsAdded` / `screenedAdded` are
   the `"added"` counts the step-9 and step-9b calls actually returned (0 if
   that step was skipped); `delisted` is how many leads step 8 marked dead.
   `on` is today's **local** date - the server can't derive it, and without
   it a morning run records tomorrow's date. `note` is one short line
   summarising the run for the webpage (e.g. "no new postings; 34 screened
   out").

   Send `"status":"error"` instead of `"ok"` if the run couldn't do its job
   properly - the tracker was unreachable, search/fetch tooling failed
   broadly enough that the zero result isn't trustworthy, or a required file
   was missing - and put the reason in `note`. A wrongly-cheerful "ok" is
   worse than no record at all: it's what stops the webpage from flagging a
   search that has quietly broken.

   A `404` with `"unknown track"` means the track key here and the tracker's
   configured tracks have drifted apart - report that plainly, it means this
   track's findings have nowhere to land.
10. Report: if there are new verified postings, list each (company, title, location, URL) as "New today - verified live", and say whether the webpage sync succeeded. Mention the screened-out count too, if any. Say whether the step-9c run record was accepted. If nothing new either way, say so plainly - don't pad.

Never add an unverified link to any output.
