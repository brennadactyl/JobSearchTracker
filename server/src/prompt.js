/**
 * Composes one track's daily search prompt from its D1 config, served by
 * GET /api/prompt/:key and run by scripts/run-search.ps1.
 *
 * This replaces the per-track prompt files that used to live in each
 * installer's private data folder (and the skill template that generated
 * them). Two reasons it moved here:
 *
 * 1. Steps 1b/8/9/9b/9c are this API's own calling convention. They were
 *    byte-identical across every hand-maintained copy, and a copy that
 *    silently lacked 9c was a real, documented failure mode - the run record
 *    is the only thing that distinguishes "searched, found nothing" from
 *    "stopped running weeks ago". They now have exactly one definition, in
 *    the same repo as the routes they call.
 * 2. A search is now defined by (user_id, track key) in the database, not by
 *    a file on one particular machine, which is what lets one machine run
 *    several people's searches - and what lets a search be reconfigured
 *    without touching that machine at all.
 *
 * ---- Why so much of this is stored prose rather than structured fields.
 * The live prompts had drifted from the template that generated them, and the
 * drift was load-bearing: a resume line naming a text fallback the machine
 * genuinely depends on (it can't read .docx), a sentence widening a company
 * list beyond its apparent industry, doc filenames predating the current
 * naming convention, worked examples of what counts as out-of-scope. Store a
 * keyword and regenerate the sentence, and all of that is silently gone. So
 * only the fields the *app* reads are structured (key, label, sort_order,
 * schedule_time, target_companies); everything only the model reads is kept
 * verbatim and interpolated as-is. See docs/multi-user-plan.md's appendix.
 */

// Subject pronoun for the sentences that refer to the person whose search this
// is. Defaults to they/them for anyone who hasn't set one - which is also the
// right answer for a name the server has no other information about.
const PRONOUNS = {
  "she/her": { subj: "she", obj: "her", poss: "her" },
  "he/him": { subj: "he", obj: "him", poss: "his" },
  "they/them": { subj: "they", obj: "them", poss: "their" },
};

// "a, b, and c" - the phrasing the live step 7 uses at both three and four
// items, which is why this isn't a plain join.
function joinAnd(parts) {
  const p = parts.filter(Boolean);
  if (p.length <= 1) return p[0] || "";
  return p.slice(0, -1).join(", ") + ", and " + p[p.length - 1];
}

const DEFAULT_LOCATION_GUIDANCE =
  "Write accurate location strings - the tracker derives priority from them " +
  "automatically, so precision matters. There is no priority field to set - " +
  "just get the location text right.";

const DEFAULT_SCREENED_EXAMPLES =
  '"outside scope: London, UK", "404 - closed", "duplicate of req 7829580003", "below target level"';

const DEFAULT_REPORT_LINE =
  'Report: if there are new verified postings, list each (company, title, ' +
  'location, URL) as "New today - verified live", and say whether the webpage ' +
  "sync succeeded. Mention the screened-out count too, if any. Say whether the " +
  "step-9c run record was accepted. If nothing new either way, say so plainly - " +
  "don't pad.";

/**
 * @param {{user: {id: string, name: string}, track: import("./db.js").Track, settings: import("./db.js").Settings, feeds?: import("./db.js").Track[]}} args
 * @param {import("./db.js").Track[]} [args.feeds] tracks whose `fed_by` names
 *   this one - tabs this run also fills. See migrations/0003_branched_tracks.sql.
 * @returns {string} the full prompt text
 */
export function buildSearchPrompt({ user, track, settings, feeds, coverage }) {
  const name = user.name;
  const pn = PRONOUNS[settings.pronouns] || PRONOUNS["they/them"];
  const key = track.key;

  // The other tabs this one run fills. A branched search - one set of
  // companies, one resume, results split by level rather than by search - is
  // the case this exists for: running it twice would re-fetch the same job
  // boards to sort the same postings differently. Empty for an ordinary
  // single-tab track, and every branch below collapses back to the text it had
  // before this existed when it is.
  const fed = (Array.isArray(feeds) ? feeds : []).filter((t) => t && t.key && t.key !== key);
  const multi = fed.length > 0;
  const allKeys = [key, ...fed.map((t) => t.key)];
  // What belongs in each tab, for the filing step. That's what a tab's
  // subtitle already is, so it does double duty rather than earning a field of
  // its own - which also means the two can't drift apart.
  const branchOf = (t) => t.full_description || t.label;

  const doc = track.doc_file || `docs/tracked_${key}_postings.md`;
  const docSummary =
    track.doc_summary ||
    "candidate profile, target companies, verification requirement, and per-company fetch-reliability notes";
  // Runs straight into "Do the following:" as one paragraph, the way the
  // hand-written prompts did - a track's "this is not the sibling searches,
  // don't merge them" note reads as preamble, not as a heading.
  const intro = track.intro_note ? `${track.intro_note} ` : "";
  // An extra clause on step 9's "search must be X" sentence, for a track where
  // one of the optional lead fields isn't optional (CPM's `fit`, which is the
  // whole question for a pivot search).
  const leadsNote = track.leads_note ? `, and ${track.leads_note}` : "";

  // A track can insert a whole screening step of its own before the capture
  // step - which pushes the capture step from 6b to 6c. The number has to be
  // computed rather than written down, because step 9 refers back to it by
  // name ("the step-6b fields"), and a cross-reference that says 6b while the
  // step is numbered 6c is worse than no cross-reference at all.
  const fitFilterStep = track.fit_filter_step ? `6b. ${track.fit_filter_step}\n` : "";
  const captureNum = track.fit_filter_step ? "6c" : "6b";

  const docUpdateLine =
    track.doc_update_line ||
    'If you learned something about fetch reliability worth keeping - a ' +
      'newly-blocked domain, a working URL-format fix, a company worth ' +
      'promoting from "expanded net" to "core" - update the relevant section ' +
      `of \`${doc}\`. Do not add a found-postings table or a screened/dead-link ` +
      "list back to the doc; those live in the tracker only.";

  let companies = "";
  try {
    const parsed = JSON.parse(track.target_companies || "[]");
    companies = Array.isArray(parsed) ? parsed.join(", ") : String(track.target_companies || "");
  } catch {
    // Stored by hand as a plain string rather than JSON - use it as written
    // rather than losing the whole company list to a parse error.
    companies = String(track.target_companies || "");
  }
  const searchNote = track.search_note ? ` ${track.search_note}` : "";

  // Companies this person won't work for, rendered from a list rather than
  // written into each track's prose. The prose version drifted immediately:
  // one exclusion ended up inside target_companies and the next inside
  // search_note, so answering "is this company excluded?" meant grepping two
  // free-text fields and knowing which one to look in. A list is a lookup, and
  // adding one is an append. Entries can be a plain name or a catch-all phrase
  // ("any other company X owns or leads"), so the sentence reads either way.
  const excluded = Array.isArray(settings.excluded_companies)
    ? settings.excluded_companies.filter((c) => typeof c === "string" && c.trim())
    : [];
  const exclusionNote = excluded.length
    ? ` Don't spend the run's time on ${joinAnd(excluded)} - permanently excluded from this search, including via broader discovery. Skip a hit there rather than verifying it, and don't post one to \`/api/screened\`: an exclusion isn't a candidate that was considered and ruled out, so it earns no row. The tracker drops them on the way in regardless - this is here to save you the fetch, not to be the thing enforcing it.`
    : "";

  const resumeLine = track.resume_line || "Read the resume.";
  const roleLine = track.role_search_line || "roles matching the resume";

  // What makes a candidate a finding, and the mirror list of what disqualifies
  // one. Both are assembled from parts so a track with no fit filter and no
  // geographic scope reads naturally instead of leaving empty clauses behind.
  const findingIs = joinAnd([
    "genuinely new",
    "verified live",
    settings.scope_clause,
    track.fit_clause,
  ]);
  const disqualified = [
    "dead-on-arrival",
    settings.scope_disqualifier,
    track.fit_disqualifier,
    "wrong level",
    "duplicate of an existing lead",
  ]
    .filter(Boolean)
    .join(", ");

  const geoStep = settings.geo_scope_line
    ? settings.geo_scope_line
    : "No geographic restriction is configured for this search - don't exclude a posting on location alone.";
  // Unlike the others, this one can't be emptied into nothing: it's a whole
  // numbered step, and the generic version still earns its place even with no
  // priority locations set, because the tracker derives a lead's priority from
  // the location text either way.
  const locationGuidance = settings.location_guidance || DEFAULT_LOCATION_GUIDANCE;
  const screenedExamples = track.screened_examples || DEFAULT_SCREENED_EXAMPLES;
  const report = track.report_line || DEFAULT_REPORT_LINE;
  const footer = settings.footer_note ? ` ${settings.footer_note}` : "";

  // ---- The multi-tab pieces. Every one of them is the empty string when this
  // run fills a single tab, so an ordinary track's prompt is unchanged.
  const alsoFills = multi
    ? `\n# Also fills: ${fed.map((t) => `${t.key} (${t.label})`).join(", ")} - one search, ${allKeys.length} tabs`
    : "";
  const dedupNote = multi
    ? ` This run fills ${allKeys.length} tabs, so fetch this once per key - ${allKeys
        .map((k) => `\`/api/dedup/${k}\``)
        .join(", ")} - and treat the results as one combined already-seen set. A posting already tracked under either key is not new, whichever tab today's run would file it under.`
    : "";
  // Slots in after the sorting step, because it only applies to what sorting
  // has already decided is a finding - a screened-out posting needs no tab.
  //
  // The tie-break used to be "file it under `key`", the feeding track. That
  // reads as a reasonable default right up until you notice `key` is whichever
  // tab happens to own the scheduled search, not a general-purpose one - here
  // it's the narrowest tab on the board. A run filed a Senior SWE role at an
  // insurance company under Eng - Gaming and said so in its own note: it read
  // as swe-tech-or-swe-industry, and the rule turned a tab it had already
  // ruled out into the answer. Breaking the tie *among the tabs it does read
  // as* keeps everything the rule was for - one deterministic answer, no
  // second verification pass - and drops the part that put an insurer in the
  // games tab. First-in-the-list is the deterministic part: `[track, ...fed]`
  // is sort_order, which is the tab order on the page.
  const filingStep = multi
    ? `7b. FILE EACH FINDING UNDER THE RIGHT TAB. This one search fills ${allKeys.length} tabs, and every finding from step 7 belongs to exactly one of them:\n${[track, ...fed]
        .map((t) => `   - \`${t.key}\` (${t.label}): ${branchOf(t)}`)
        .join("\n")}\n   Decide from what the posting and the company actually are, reading the tab descriptions above as written - not from a job title alone, which means different things at different companies. \`${doc}\` is where any finer rule for this particular split lives; follow it. If a posting genuinely reads more than one way after checking, file it under whichever of *those* tabs comes first in the list above, and name those ones in your report. The tie is only ever between the tabs it actually reads as: a tab you have already ruled out is never the answer, and that includes \`${key}\` - that's the tab that happens to own this search, which is not a reason for a posting to show up in it. Don't spend a second verification pass on the question: the posting is already verified, this only decides which tab shows it. The answer is the \`"search"\` value in step 9.\n`
    : "";
  const searchValueRule = multi
    ? `is the key step 7b filed that posting under - ${allKeys
        .map((k) => `\`"${k}"\``)
        .join(" or ")}. One POST can carry rows for different tabs, so send them all in a single call`
    : `must be \`"${key}"\``;
  // Step 8's two reports take one "search" each, and for a multi-tab run that
  // raises the obvious question of which tab a dead posting from a fed tab
  // gets reported under. The answer is "this run's own key, always": the
  // tracker matches a reported url against every lead this person has, whatever
  // tab holds it (see db.getLeadsForUrlMatch). Worth saying out loud, because
  // the alternative a run would otherwise invent - one call per tab, splitting
  // the urls by which dedup response they came from - is exactly the id-and-tab
  // bookkeeping taking urls was meant to stop.
  const delistTabNote = multi
    ? ` \`"search"\` is this run's own key, \`"${key}"\`, in both calls - including for a posting tracked in one of the other tabs this run fills. The tracker matches across every tab, so one call each covers all ${allKeys.length}.`
    : "";
  // There used to be a sentence here telling a multi-tab run to file every
  // screened row under the feeding track regardless of which tab the posting
  // would have gone in. The server does that itself now - handleAddScreened
  // rewrites `search` to the track that owns the search - so the sentence was
  // asking the model to reproduce a rule it cannot get wrong any more, which
  // is the kind of prose this whole change is about deleting.
  // Steps 1c and 9d appear only once a track has company_sweeps rows. Gating
  // on the data rather than on a config flag keeps this off for every track
  // that hasn't been seeded, and turns it on for one that has, with nothing to
  // remember to set - see migrations/0005_company_sweeps.sql.
  const rotates = Number(coverage) > 0;
  const coverageStep = rotates
    ? `1c. Get this run's companies: \`curl -s "$TRACKER_URL/api/coverage/${key}" -H "Authorization: Bearer $TRACKER_API_TOKEN"\`. The server picks them, capped at what one run can actually verify, and returns \`{companies: [{company, last_swept, board, note, position}], total, batch, cursor}\`. The rotation is a fixed list with a cursor: you get the next \`batch\` from \`cursor\`, and \`cursor\` of \`total\` is how far through the cycle this search has read. **Cover exactly these, all of them**, and don't reach past them into the rest of the list in step 3: that list is longer than one run can do properly, and the failure mode isn't a company going uncovered for a day, it's every company being skimmed. They come back round - the cursor wraps, so everything is reached once per cycle before anything is reached twice. \`board\` is a JSON endpoint already confirmed for that company (\`greenhouse\`, \`ashby\`, \`workday cxs\`, ...); it makes a company cheap to cover, not privileged - use it where it's there. The cap is about *this* list: step 3b sends you outside it on purpose, and anything broader discovery turns up is covered as well, whether or not it is in this list. "Don't reach past them" means don't help yourself to the rest of the rotation early - it is not a reason to skip 3b.
`
    : "";
  const sweepStep = rotates
    ? `9d. RECORD WHAT YOU COVERED. POST every company this run actually attempted:

   \`\`\`
   curl -s -X POST "$TRACKER_URL/api/coverage" \
     -H "Authorization: Bearer $TRACKER_API_TOKEN" -H "Content-Type: application/json" \
     -d '{"search":"${key}","on":"<today YYYY-MM-DD>","swept":[{"company":"...","board":"greenhouse","note":""}]}'
   \`\`\`

   This is the rotation's only memory. A run that covers companies without
   recording them leaves tomorrow's run covering the same ones, and the tail of
   the list never gets searched at all. Record a company you attempted and
   *couldn't* fetch too, with the reason in \`note\` - the date tracks when a
   company was last attempted, not when it last worked, or a blocked domain
   comes back to the front of the queue every single run.

9e. REPLACE THE COMPANIES YOU COULDN'T READ. Count the ones in tonight's slice
   you got nothing usable out of - the domain refused the fetch, every job id
   404'd, the board only filters client-side, the page was an empty JS shell,
   or the doc's fetch-efficiency rule already had it down as a wall so you
   skipped it without fetching. Not the ones you read fine that had nothing
   matching: those are ordinary covered sweeps and by far the common case.

   If that count is more than zero, **fetch step 1c again** - the same
   \`GET /api/coverage/${key}\` call, unchanged - and cover that many companies
   from what comes back. Then POST those with step 9d and repeat until nothing
   in a slice was unreadable, or until you have spent the effort a run should.
   This is a replacement for wasted work, not a licence to run all night.

   The companies you get will be new ones. The rotation is a fixed list with a
   cursor, and step 9d moved the cursor past everything you just reported, so
   fetching again reads further along rather than round again. You do not have
   to filter anything out or tell the call what day it is.

   The order matters: record first, then fetch. The cursor only moves when a
   sweep is recorded, so fetching first would hand you the same companies
   again - and a run that died in between would have taken work nothing says
   it attempted.

   Why this is a second call rather than something step 9d hands back: reading
   the list changes nothing and can be repeated safely, while recording a sweep
   is the only thing that marks work as done. Keeping them apart means a run
   that dies at any point has either recorded what it actually did or recorded
   nothing, and never sits holding companies the rotation believes are covered.

   The wall itself is not your decision here. Whether a domain is worth
   retrying, and what workaround exists, is the doc's job - it holds the
   URL-format fixes and ATS mirrors that a flag never could. Keep writing those
   up in \`note\` and in step 8b.

   Send \`board\` whenever
   you confirm one (\`greenhouse\`, \`ashby\`, \`lever\`, \`workday cxs\`, ...): that is
   what moves a company into the every-run tier. A company not already in the
   list is created by this call, so one that broader discovery turned up joins
   the rotation here. \`on\` is today's local date, same as step 9c.
`
    : "";

  // Step 9c used to carry the largest and most error-prone block of text in
  // this whole prompt: a per-branch explanation of how to split the run's own
  // counts across the tabs it fills, and a rule that a multi-tab run must post
  // one record per tab. It was not followed. On 2026-09-01 the live `SWE` run
  // reported a combined 97 leads against a tab that holds 89 in total, and the
  // three tabs it feeds recorded nothing at all on a morning one of them took
  // 133 leads - reading, on the page, as searches that had never run.
  //
  // Both jobs now belong to the server: POST /api/runs derives all three
  // counts from the rows that actually landed and writes a record for each fed
  // tab itself (see routes/runs.js's handleRecordRun). What's left in 9c is
  // only what the run alone knows - which track it is, whether it worked, its
  // local date, and a sentence for the page. The route still accepts
  // leadsAdded/screenedAdded/delisted and ignores them, so a run that fetched
  // this prompt before the change and is still going records correctly too.
  const runFanoutNote = multi
    ? `\n   This one call covers every tab this run fills: the tracker writes a run
   record for each of the others (${fed
     .map((t) => `\`${t.key}\``)
     .join(", ")}) as well, counted from
   the rows that actually landed in that tab. Don't post a second call per tab.\n`
    : "";

  return `# Scheduled task: ${track.label} - ${track.full_description}
# Schedule: ${track.schedule_time || "unscheduled"} local (headless, via Windows Task Scheduler + scripts\\run-search.ps1)
# Track key in the tracker data: ${key}${alsoFills}
# ---------------------------------------------------------------------------

${intro}Do the following:

1. Read \`${doc}\` - ${docSummary}. Follow its numbered process. The doc doesn't keep a found-postings table or a screened/dead-link list of its own - dedup data comes from step 1b instead.
1b. Fetch what this track has already seen: \`curl -s "$TRACKER_URL/api/dedup/${key}" -H "Authorization: Bearer $TRACKER_API_TOKEN"\`. Scoped to this track and deliberately minimal. It returns \`leads[]\` as \`{id, url, status}\` - postings already tracked; keep each \`url\` on hand for step 8, which reports back by url, and each \`status\` for context in your report (that's how you tell a stale lead nobody's touched from one ${name} has already applied to). You don't need to carry the \`id\` anywhere: nothing you post back is keyed by it. Then \`screened[]\` as a plain list of urls already looked at and rejected, which is what stops you re-verifying the same dead or out-of-scope candidate every run. Don't fetch \`/api/data\` for this: it returns every field of every row across every track, which is far larger and grows every day.${dedupNote}
${coverageStep}2. ${resumeLine}
3. Search ${rotates ? "the step-1c companies" : "target companies"}' careers sites (web search as backup) for current ${roleLine}. ${rotates ? "Step 1c is the list for today, drawn from" : "Companies"}: ${companies}.${searchNote}${exclusionNote}
3b. NOW LOOK OUTSIDE THAT LIST. Step 3 is the companies already known to be worth checking; this step is how that list ever grows, and it is not optional. Search for ${roleLine} at companies **not named anywhere above** - including outside tech entirely: travel, insurance, hotels, food service, grocery and retail, healthcare systems, logistics, banking, utilities, manufacturing. All of them run real engineering orgs and all of them are easy to miss when the named list reads as big tech. Rotate through a couple of verticals per run rather than attempting all of them.

   Every candidate this turns up faces the same mandatory verification in step 4 - a company being new is not a reason to trust a search snippet about it.

   **A company you find here joins the rotation in step 9d, or tonight is the last time it is ever looked at.** POST it with the others as soon as it yields a verified posting, whether that posting became a lead or was screened: either way you have established the company is worth a look. The rotation is the only list a future run reads. Writing a name into the doc's prose instead does nothing, and this is not hypothetical - this search ran for eight days with a broader-discovery step in its doc, added nothing to its rotation, and by day six was finding nothing at all, because everything its original companies had open was already tracked or screened.

   Say in your step-10 report how many companies outside the list you tried and what came of them, even when the answer is none and nothing. A run that quietly skips this looks exactly like a run where the market was quiet, which is the confusion the whole tracker exists to prevent.
4. MANDATORY VERIFICATION: fetch every candidate URL directly and confirm it renders an actual job description (real title, responsibilities/qualifications - not a landing page, 404, "job not found," a loading placeholder, or a listing/index page that merely contains the title text). A search-snippet URL is a lead, not a finding, until opened and confirmed. If a site won't reveal real content, skip that company today rather than report something unverified.

   **Before you write a domain off as a wall, check what the HTML actually carried.** Three things survive on a page whose body renders client-side, and each is the page stating something rather than you inferring it: a \`JobPosting\` block in \`<script type="application/ld+json">\` (Ashby, Greenhouse, Lever, Workday and iCIMS all emit one - \`title\`, \`hiringOrganization\`, \`jobLocation\`, \`employmentType\`, \`baseSalary\`, usually the whole description); \`og:title\` / \`og:description\` meta tags; and the \`<title>\` tag. A JSON-LD \`JobPosting\` carrying a real description **is** the job description rendering - the same document in machine-readable form - so verify from it rather than calling the posting unconfirmable. A \`<title>\` naming no role ("Careers", "Job Board") states nothing, and an \`ItemList\` is a listing page, not a posting.

   **And tell a truncated page apart from an empty one.** A fetch that returned a megabyte of navigation and got cut off before the description is a size problem, not a block - the content is there, and the workaround for that domain (a reader-proxy, an ATS JSON endpoint, a different URL format) is what \`${doc}\`'s fetch-reliability notes are for. Recording "truncated" as "blocked" is how a company that is perfectly readable ends up skipped for weeks: it happened to Google Careers, whose job pages are ~1.3MB of mostly nav and served the location and the pay range in plain HTML the whole time.
5. ${geoStep}
6. ${locationGuidance}
${fitFilterStep}${captureNum}. While the posting is open, also capture - only when it's stated plainly, never inferred or guessed - the team/org named for the role (\`team\`), the stated work arrangement (\`setup\`, e.g. "Remote", "Hybrid - 3 days/week onsite", "Onsite"), and any posted compensation range (\`comp\`, e.g. "$180,000-$230,000/yr"; many US states disclose this by law). Leave any of these as an empty string when the posting doesn't say. These land in the tracker's per-lead "Details" panel alongside referral/resume/next-action fields that are ${name}'s alone to fill in by hand - this search never touches those.
7. Compare candidate URLs against \`leads[]\` and \`screened[]\` from step 1b (not a doc table). Sort each candidate into: (a) already tracked or already screened - skip it; (b) ${findingIs} - a finding, goes to step 9; (c) genuinely new but disqualified (${disqualified}) - goes to step 9b instead of being dropped silently.
${filingStep}8. REPORT WHAT THE RE-CHECK OF ALREADY-TRACKED LEADS FOUND. For the postings from step 1b's \`leads[]\` that you re-checked tonight, **never delete or move anything yourself** - report what you saw and let the tracker decide what to do with it. Both reports below are by \`url\`: send whichever URL you actually opened, and don't try to match it against step 1b's spelling first - the tracker matches on posting identity, so a \`?gh_jid=\` suffix, a tracking param, or a missing slug still finds the right lead. No ids anywhere.${delistTabNote}

   **The ones you opened and confirmed still live** - one call listing all of them:

   \`\`\`
   curl -s -X POST "$TRACKER_URL/api/verified" \\
     -H "Authorization: Bearer $TRACKER_API_TOKEN" -H "Content-Type: application/json" \\
     -d '{"search":"${key}","on":"<today YYYY-MM-DD>","urls":["...","..."]}'
   \`\`\`

   This is the only thing in the whole system that writes a lead's "Confirmed live" date. Without it that date stays frozen at the day the posting was found, and there is no way to tell a lead re-checked last night from one nobody has looked at in two months - which matters precisely because a dead posting is now deleted rather than flagged, so a lead still sitting in a tab is presumed live and this is the only measure of how old that presumption is. It never deletes or changes anything else, so there is nothing to be careful about here beyond being honest about which ones you actually opened. Skip the call only if you re-checked nothing at all. The response is \`{"stamped":N,"unmatched":N,"unmatchedUrls":[...]}\`.

   **The ones you confirmed dead** - again one call listing all of them, not one call per posting:

   \`\`\`
   curl -s -X POST "$TRACKER_URL/api/delist" \\
     -H "Authorization: Bearer $TRACKER_API_TOKEN" -H "Content-Type: application/json" \\
     -d '{"search":"${key}","on":"<today YYYY-MM-DD>","urls":["...","..."]}'
   \`\`\`

   Don't post these to \`/api/screened\` as well - this one call is the whole report. List a dead posting the same way whatever \`status\` its lead is in; the tracker knows which ones to leave alone (${name}'s applied-to leads are kept - what matters there is the application, not whether the listing survived). The response is \`{"removed":N,"kept":N,"unmatched":N,"unmatchedUrls":[...]}\`: \`removed\` is how many came off ${pn.poss} board, \`kept\` is how many were applied-to leads the tracker held on to - both are the tracker working as intended, not something to retry or work around. Neither is a number you need to carry anywhere: step 9c asks for no counts. \`on\` is today's local date in both calls, and \`/api/delist\` refuses anything that isn't a real \`YYYY-MM-DD\` with a 400, since a value that isn't a date isn't a report of anything.

   **There is no undoing the delist report.** A removed lead's row is gone and its URL is in \`screened[]\` from then on, so step 7 skips that URL for good: if the posting turns out to be live after all, no future run puts it back.

   **Only put a posting in the \`/api/delist\` list if you have actually confirmed it dead** - a page that loads and says the role is closed or filled, or a genuine 404. Not being able to check is not the same as dead: a fetch timeout, a blocked domain, a 403/429, truncated content, or a JS shell that renders nothing all mean *unknown*, and an unknown belongs in **neither** list - it leaves the lead exactly as it is while you note the tooling problem in your report. Reporting a live posting as dead is not a mistake that shows up later as a wrong date on a row - it takes a real opening off ${pn.poss} board. When in doubt, leave it out of both lists and say so.

   A url coming back in \`unmatchedUrls\` from either call means you believe you're tracking something the tracker has no lead for - report that plainly rather than retrying it. If the tracker's unreachable, skip both calls and note that in your report.
8b. ${docUpdateLine}
9. SYNC NEW POSTINGS TO THE LIVE TRACKER WEBPAGE. If there are zero new verified postings from step 7, skip this step entirely - do not call the API. Otherwise, build a JSON array of only today's new postings and POST it with curl:

   \`\`\`
   curl -s -X POST "$TRACKER_URL/api/leads" \\
     -H "Authorization: Bearer $TRACKER_API_TOKEN" \\
     -H "Content-Type: application/json" \\
     -d '{"on":"<today YYYY-MM-DD>","leads":[{"search":"${key}","company":"...","title":"...","location":"...","url":"...","fit":"...","team":"...","setup":"...","comp":"..."}]}'
   \`\`\`

   Every object's \`"search"\` ${searchValueRule}${leadsNote}. \`on\` is today's
   **local** date, sent once for the whole call - the server stamps \`found\` and
   \`verified\` from it, so don't repeat a date on each posting. It is the same
   date steps 9b and 9c send, and step 9c counts a day's new leads by it.
   \`team\`, \`setup\`, and \`comp\` are the step-${captureNum} fields - omit
   the key entirely (don't send an empty string) for any of them the posting
   didn't state. \`TRACKER_URL\` and \`TRACKER_API_TOKEN\` are environment
   variables - just run the curl command above directly and let normal shell
   expansion fill them in; don't spend a step checking whether they're set
   first (e.g. \`printenv\`, \`echo $TRACKER_URL\`) - that's a separate command
   from curl and may not be pre-approved in this environment, so it can stall
   the run for nothing. If curl's response makes clear a variable was empty
   (e.g. the URL resolves to nothing, or the request is obviously malformed),
   say so in your report. Check the curl response: a JSON body with an
   \`"added"\` count means it worked; anything else (including no response, a
   non-2xx status, or an \`"error"\` field) means it failed - report that
   plainly, the delisting reports from step 8 still stand regardless.
9b. RECORD SCREENED-OUT CANDIDATES. If there are zero disqualified-but-new candidates from step 7, skip this step. Otherwise, POST them so tomorrow's run doesn't re-verify them:

   \`\`\`
   curl -s -X POST "$TRACKER_URL/api/screened" \\
     -H "Authorization: Bearer $TRACKER_API_TOKEN" \\
     -H "Content-Type: application/json" \\
     -d '{"search":"${key}","on":"<today YYYY-MM-DD>","screened":[{"search":"${key}","url":"...","company":"...","title":"...","location":"...","reason":"..."}]}'
   \`\`\`

   \`"search"\` must be \`"${key}"\`. \`on\` is today's **local** date, the same one steps 9 and 9c send, and it is not optional: it is the date these rows are stamped with, and step 9c counts a day's screened rows by it. Leave it out and the server falls back to its own UTC date, which for an evening run is already tomorrow - the rows land fine and then the run records having screened nothing. \`reason\` is a short, specific, human-readable explanation (e.g. ${screenedExamples}) - this is what makes the entry useful later, don't leave it vague. Same success/failure check as step 9 (an \`"added"\` count means it worked).
9c. RECORD THE RUN. **Do this every single run, without exception - including runs that found nothing, runs where every candidate was screened out, and runs where steps 8/9/9b were skipped or failed.** This is the one step with no "skip it if there's nothing to report" clause, and the reason is that a run finding nothing writes nothing anywhere else: no leads, no screened rows, no delistings. Without this call, a search that silently stopped running (expired token, disabled scheduled task, machine asleep) looks identical on the tracker webpage to a genuine zero-result day, and can go unnoticed for weeks.

   \`\`\`
   curl -s -X POST "$TRACKER_URL/api/runs" \\
     -H "Authorization: Bearer $TRACKER_API_TOKEN" -H "Content-Type: application/json" \\
     -d '{"search":"${key}","status":"ok","on":"<today YYYY-MM-DD>","note":"..."}'
   \`\`\`

   Those four fields are the whole call. \`"search"\` is \`"${key}"\`. \`on\` is
   today's **local** date - the server can't derive it, and without it a
   morning run records tomorrow's date. \`note\` is one short line summarising
   the run for the webpage (e.g. "no new postings; 34 screened out").
${runFanoutNote}
   Don't send counts, and don't tally any. The tracker derives \`leadsAdded\`,
   \`screenedAdded\` and \`delisted\` itself from what steps 8, 9 and 9b actually
   wrote${multi ? ", per tab and from that tab's own rows" : ""}, so there is nothing here to add up and nothing that can be
   added up wrong. Counts sent anyway are ignored rather than refused.

   Send \`"status":"error"\` instead of \`"ok"\` if the run couldn't do its job
   properly - the tracker was unreachable, search/fetch tooling failed broadly
   enough that the zero result isn't trustworthy, or a required file was
   missing - and put the reason in \`note\`. A wrongly-cheerful "ok" is worse
   than no record at all: it's what stops the webpage from flagging a search
   that has quietly broken.

   A \`404\` with \`"unknown track"\` means the track key here and the tracker's
   configured tracks have drifted apart - report that plainly, it means this
   track's findings have nowhere to land.
${sweepStep}10. ${report}

Never add an unverified link to any output.${footer}
`;
}

/**
 * The nightly fill for applications added as nothing but a URL.
 *
 * A second prompt in this file rather than a step bolted onto a track's
 * search, because it is not a search: it has no companies, no fit rule, no
 * geographic scope, and nothing it does depends on which track a person is
 * running. Folding it into the track prompts would also mean every track
 * running it - one queue, several runs racing to read the same postings.
 *
 * Served as the reserved key `_applications` under GET /api/prompt (see
 * routes/index.js) and run by scripts/run-fill.ps1 as a single nightly task
 * for the whole machine.
 *
 * ---- Why this one prompt covers everybody.
 * It is one job, not one job per person: the work is "read the postings behind
 * the applications that still have a gap", and whose they are changes nothing
 * about how it is done. A task per account would mean N headless CLI runs a
 * night, nearly all of them starting up only to find an empty queue.
 *
 * ---- Why the reading fans out to subagents.
 * Pulling the rows is one cheap query per account; reading the postings behind
 * them is the slow part, and every posting is independent of every other. So
 * the run gathers the whole list first and then dispatches a subagent per
 * posting, in batches, rather than walking the list serially. The split is also
 * a boundary worth having: a subagent gets one URL and no token, no account and
 * no row id, so it cannot write anywhere or confuse one person's row with
 * another's. Every write stays in the main turn, with the right account's
 * token.
 *
 * The database is still only ever read one account at a time, and that is not
 * a compromise - it is what lets this exist without a cross-user route. Every
 * route stays session-scoped exactly as it is for the search runs (see
 * db.js's constructor), and the runner hands the model one bearer token per
 * account in the environment. So this text is written for "each account you
 * were given" and takes no user: it is identical for everyone, and the wrapper
 * scripts/run-fill.ps1 puts in front of it is what says how many accounts
 * there are tonight and which variable holds each one's token.
 *
 * ---- Why there is no run record for this one.
 * Every search records itself to /api/runs because a search that finds nothing
 * writes nothing, so a search that quietly stopped firing looks identical to a
 * quiet night. The stakes here are lower by design: this fills in fields the
 * person can always type themselves, on rows that are already in front of them
 * on the Applications tab, and it is deliberately invisible while it works. A
 * run record would be a status readout for a thing with no status - the
 * evidence that it stopped is a row that stayed blank, and the fix for that
 * row is the same either way.
 *
 * @returns {string} the full prompt text - the same for every caller
 */
export function buildAutofillPrompt() {
  return `# Scheduled task: fill in applications added by URL
# Schedule: nightly (headless, via Windows Task Scheduler + scripts\\run-fill.ps1)
# ---------------------------------------------------------------------------

People log an application on the tracker page by pasting the job posting's URL
and nothing else. Your whole job is to open those postings and write down what
they say, so that nobody has to copy company, title and location off a page by
hand. You are not searching for anything tonight, and you are not judging
whether any of these are a good fit - they have already been applied to.

None of this is visible on anyone's tracker page while it happens, and each
posting is read once and never again. So the standard you are held to is not
"did it look like it worked" - it is that whatever you write down is what the
posting actually said.

The one exception, and the only thing here anybody ever reads: a posting you
report as unreadable shows the reason you gave, on that row. See step 3.

**This run covers every account on this machine.** The note above this prompt
says how many there are and which environment variable holds each one's token
(\`$TRACKER_TOKEN_1\`, \`$TRACKER_TOKEN_2\`, ...). Do steps 1-3 once per account,
finishing one before starting the next. Ids are per account and mean different
rows in different accounts, so never carry an id from one account's queue into
another's report - that is the one mistake here that would write a posting's
details onto somebody else's application.

Do the following, for each account in turn:

1. GET THAT ACCOUNT'S QUEUE - the same call for each, with that account's token:

   \`\`\`
   curl -s "$TRACKER_URL/api/applications/pending" -H "Authorization: Bearer $TRACKER_TOKEN_1"
   \`\`\`

   It returns \`{"applications":[{"id":123,"link":"https://..."}]}\` - every
   application whose posting hasn't been read yet, with the URL to read and
   nothing else. The tracker decides what is on this list; don't go looking for
   other applications to fill in, and don't skip one because its URL looks
   unpromising.
   \`TRACKER_URL\` and the token variables are environment variables; run the
   curl as written and let the shell expand them rather than spending a step
   checking whether they're set, and never print or echo a token.

   **An empty list is the normal answer.** Most accounts on most nights have
   nothing waiting. Say so in one line and move to the next account; when every
   account is empty that is the whole run, and it is not a problem to
   investigate.

   Collect every account's list before going on to step 2, keeping each row's
   account alongside its \`id\` and \`link\`. Step 2 reads them all together.

2. FAN THE READING OUT. Postings are slow to fetch and completely independent
   of each other, so **dispatch one subagent per posting and let them run in
   parallel** rather than opening them one after another yourself. Send them in
   batches of about ten so a long queue doesn't spawn dozens of agents at once,
   and wait for each batch before sending the next.

   Give each subagent exactly one URL and this brief, near enough word for
   word - it is the whole of what makes the result trustworthy, and a subagent
   only knows what you tell it:

   > Fetch this URL and report what the job posting *states*, as JSON with
   > these keys, omitting any key the page does not state plainly:
   > \`company\` (the employer's name as the posting gives it), \`title\` (the
   > role title), \`location\` (as posted - "Seattle, WA", "Remote (U.S.)",
   > "London, UK"), \`team\` (the team or org named for the role), \`setup\`
   > (the stated work arrangement - "Remote", "Hybrid - 3 days/week onsite",
   > "Onsite"), \`comp\` (any posted compensation range -
   > "$180,000-$230,000/yr").
   >
   > **Never infer, complete or tidy up any of these.** Not the company from
   > the domain name, not the location from an office you know the company
   > has, not a title from the URL slug. This is somebody's record of a job
   > they really applied to, and a plausible guess in it is worse than a blank
   > field: a blank field is visibly still to be filled in, while a wrong
   > company reads as fact forever. Omit a key entirely rather than returning
   > an empty string or a placeholder.
   >
   > Read the page itself. Don't web-search for the role to fill in what the
   > posting didn't say.
   >
   > **A body that needs JavaScript is not an unreadable page.** Modern job
   > boards render the description client-side but still ship the facts in the
   > HTML you already have, and that is the page stating them, not you guessing:
   >
   > - a \`JobPosting\` block in \`<script type="application/ld+json">\` -
   >   \`title\`, \`hiringOrganization\`, \`jobLocation\` / \`locationName\`,
   >   \`employmentType\`, \`baseSalary\`. Check for this first on any board that
   >   looks empty; Ashby, Greenhouse, Lever and Workday all emit one.
   > - \`og:title\` / \`og:description\` meta tags.
   > - the \`<title>\` tag, which on these boards is usually
   >   "Role Title @ Company" or "Role Title - Company".
   >
   > A \`<title>\` that names no role - "Careers", "Jobs at Acme", "Job Board" -
   > states nothing; don't read a role out of it. But one that plainly gives
   > the role and the employer has given you \`title\` and \`company\`.
   >
   > **A closed posting is still a posting.** "This job has been closed", "no
   > longer accepting applications", an expired-listing banner - if the page
   > still says what the role was, report it exactly as you would a live one.
   > Whether the listing outlived the application is beside the point here:
   > this is the record of a job somebody already applied to, not a check on
   > whether it is still open. Say it was closed in \`note\`, and fill in
   > everything the page still states. Only a closed page that has stopped
   > showing the details is a \`failed\`.
   >
   > **Partial is wanted.** Return every key you could establish, whatever you
   > could not - two fields beat none, and a field the person doesn't have to
   > type is worth having on its own. When you got some of it but not all,
   > add a \`"note"\` key saying in one short sentence what you couldn't read
   > and why, alongside the fields: e.g.
   > \`{"company":"...","title":"...","note":"the description needs JavaScript,
   > so only the page metadata was readable - no location or pay stated there"}\`.
   >
   > Use \`{"failed":"<short, specific reason in plain words>"}\` **only when you
   > established nothing at all** - it 404s, the posting has been taken down or
   > filled, it is behind a login wall or a CAPTCHA, the domain refused the
   > fetch, or the HTML carried no metadata either.
   >
   > **\`note\` and \`failed\` are both shown to the person whose application it
   > is**, on that row, so write them for them: say what you actually hit. Not
   > being able to check is not the same as the posting being gone, and they
   > need to know which it was - one means the details are gone, the other
   > means the page is sitting there and only you couldn't have it.

   Do not give a subagent a token, an account, an id, or anything to POST.
   They read one page and hand back what it said; every write in this run is
   yours to make, with the right account's token, in step 3. Keep your own note
   of which account and \`id\` each dispatched URL belongs to - the subagent
   never sees either, so nothing it returns can put a posting's details onto
   the wrong row.

   These subagents run inside this same turn and you wait for their results.
   That is the difference between this and backgrounding work, which the note
   at the top of this prompt rules out: nothing here outlives your turn.

3. REPORT WHAT THEY READ - one call per account, not one per row, and with that
   same account's token:

   \`\`\`
   curl -s -X POST "$TRACKER_URL/api/applications/autofill" \\
     -H "Authorization: Bearer $TRACKER_TOKEN_1" -H "Content-Type: application/json" \\
     -d '{"filled":[{"id":123,"company":"...","title":"...","location":"...","team":"...","setup":"...","comp":"..."}],
          "failed":[{"id":456,"reason":"posting has been taken down"}]}'
   \`\`\`

   Pair each subagent's answer back up with the account and \`id\` you dispatched
   it for, and send each account's rows with that account's token. \`id\` is the
   id from that account's step 1, unchanged. Send both lists in the one call;
   either may be omitted if it's empty. A \`filled\` row may carry a \`"note"\`
   alongside its fields - pass through whatever \`note\` the subagent returned,
   unchanged.

   **Anything a subagent established goes in \`filled\`, even one field.** Only a
   subagent that came back with \`failed\` - nothing established at all - goes in
   \`failed\`. A partial read is a result, not a failure: every field there is one
   the person doesn't have to type.

   Pass \`note\` and \`failed\` reasons through as the subagent wrote them rather
   than summarising, because **both are shown to the person on that row** -
   they are the only thing this whole job ever says on their page. A note
   explains why a filled-in row is still missing something; a \`failed\` reason
   explains why a row is blank and going to stay that way, since nothing
   retries it. Both have to be specific and true: "the posting has been taken
   down" and "the domain blocks automated fetches" ask completely different
   things of the reader. A vague one is worse than none, and a wrong one sends
   them looking for a page that is fine.

   Report every id every account gave you, in one list or the other. An id you
   report in neither comes back tomorrow night and every night after, which is
   the one outcome this is built to avoid - so a subagent that returned nothing
   usable at all, or that you never got an answer from, still gets a \`failed\`
   entry saying so.

   Nothing here overwrites anything. The tracker only writes into fields that
   are still empty, so if the person filled some of them in during the day,
   their version stays and yours is dropped. Send what came back and don't try
   to work out what is already in the row - you were not told, and that is
   deliberate.

   The response is \`{"filled":N,"failed":N,"unmatched":[id,...]}\`. An id in
   \`unmatched\` means that row was dealt with or deleted between step 1 and
   now - ordinary, and nothing to retry or work around.

4. Report in a few lines **per account**, naming which account each line is
   about: how many postings it gave you, what got filled in for each (company
   and title is enough), and every one that couldn't be read with the reason
   you sent. Nobody reads this in the normal course of things - it is the log
   someone checks when a row stayed blank - so be accurate rather than
   reassuring, and don't pad an account that had nothing.
`;
}
