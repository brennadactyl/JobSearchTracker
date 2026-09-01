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
  const filingStep = multi
    ? `7b. FILE EACH FINDING UNDER THE RIGHT TAB. This one search fills ${allKeys.length} tabs, and every finding from step 7 belongs to exactly one of them:\n${[track, ...fed]
        .map((t) => `   - \`${t.key}\` (${t.label}): ${branchOf(t)}`)
        .join("\n")}\n   Decide from what the posting and the company actually are, reading the tab descriptions above as written - not from a job title alone, which means different things at different companies. \`${doc}\` is where any finer rule for this particular split lives; follow it. If a posting genuinely reads more than one way after checking, file it under \`${key}\` and name those ones in your report. Don't spend a second verification pass on the question: the posting is already verified, this only decides which tab shows it. The answer is the \`"search"\` value in step 9.\n`
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
  const screenedNote = multi
    ? ` Every screened row goes under \`"${key}"\` regardless of which tab the posting would have been filed under - step 1b reads them back as one combined set and nothing displays them per-tab, so splitting them would only add a way to get it wrong.`
    : "";
  // Steps 1c and 9d appear only once a track has company_sweeps rows. Gating
  // on the data rather than on a config flag keeps this off for every track
  // that hasn't been seeded, and turns it on for one that has, with nothing to
  // remember to set - see migrations/0005_company_sweeps.sql.
  const rotates = Number(coverage) > 0;
  const coverageStep = rotates
    ? `1c. Get this run's companies: \`curl -s "$TRACKER_URL/api/coverage/${key}" -H "Authorization: Bearer $TRACKER_API_TOKEN"\`. The server picks them - the least-recently-swept of the list, capped at what one run can actually verify - and returns \`{companies: [{company, last_swept, board, note}], total, batch}\`. **Cover exactly these, all of them**, and don't reach past them into the rest of the list in step 3: that list is longer than one run can do properly, and the failure mode isn't a company going uncovered for a day, it's every company being skimmed. They come back round - what you cover today sorts last tomorrow. \`board\` is a JSON endpoint already confirmed for that company (\`greenhouse\`, \`ashby\`, \`workday cxs\`, ...); it makes a company cheap to cover, not privileged - use it where it's there. Anything broader discovery turns up is covered as well, whether or not it is in this list.
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
   comes back to the front of the queue every single run. Send \`board\` whenever
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
  // tab itself (see api.js's handleRecordRun). What's left in 9c is only what
  // the run alone knows - which track it is, whether it worked, its local
  // date, and a sentence for the page. The route still accepts
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
3. Search ${rotates ? "the step-1c companies" : "target companies"}' careers sites (web search as backup) for current ${roleLine}. ${rotates ? "Step 1c is the list for today, drawn from" : "Companies"}: ${companies}.${searchNote} Also run the doc's broader-discovery step.${exclusionNote}
4. MANDATORY VERIFICATION: fetch every candidate URL directly and confirm it renders an actual job description (real title, responsibilities/qualifications - not a landing page, 404, "job not found," a loading placeholder, or a listing/index page that merely contains the title text). A search-snippet URL is a lead, not a finding, until opened and confirmed. If a site won't reveal real content, skip that company today rather than report something unverified.
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

   Don't post these to \`/api/screened\` as well - this one call is the whole report. List a dead posting the same way whatever \`status\` its lead is in; the tracker knows which ones to leave alone (${name}'s applied-to leads are kept - what matters there is the application, not whether the listing survived). The response is \`{"removed":N,"kept":N,"unmatched":N,"unmatchedUrls":[...]}\`: \`removed\` is how many came off ${pn.poss} board and is the number step 9c wants, \`kept\` is how many were applied-to leads the tracker held on to - both are the tracker working as intended, not something to retry or work around. \`on\` is today's local date in both calls, and \`/api/delist\` refuses anything that isn't a real \`YYYY-MM-DD\` with a 400, since a value that isn't a date isn't a report of anything.

   **There is no undoing the delist report.** A removed lead's row is gone and its URL is in \`screened[]\` from then on, so step 7 skips that URL for good: if the posting turns out to be live after all, no future run puts it back.

   **Only put a posting in the \`/api/delist\` list if you have actually confirmed it dead** - a page that loads and says the role is closed or filled, or a genuine 404. Not being able to check is not the same as dead: a fetch timeout, a blocked domain, a 403/429, truncated content, or a JS shell that renders nothing all mean *unknown*, and an unknown belongs in **neither** list - it leaves the lead exactly as it is while you note the tooling problem in your report. Reporting a live posting as dead is not a mistake that shows up later as a wrong date on a row - it takes a real opening off ${pn.poss} board. When in doubt, leave it out of both lists and say so.

   A url coming back in \`unmatchedUrls\` from either call means you believe you're tracking something the tracker has no lead for - report that plainly rather than retrying it. If the tracker's unreachable, skip both calls and note that in your report.
8b. ${docUpdateLine}
9. SYNC NEW POSTINGS TO THE LIVE TRACKER WEBPAGE. If there are zero new verified postings from step 7, skip this step entirely - do not call the API. Otherwise, build a JSON array of only today's new postings and POST it with curl:

   \`\`\`
   curl -s -X POST "$TRACKER_URL/api/leads" \\
     -H "Authorization: Bearer $TRACKER_API_TOKEN" \\
     -H "Content-Type: application/json" \\
     -d '{"leads":[{"search":"${key}","company":"...","title":"...","location":"...","url":"...","found":"YYYY-MM-DD","verified":"YYYY-MM-DD","fit":"...","team":"...","setup":"...","comp":"..."}]}'
   \`\`\`

   Every object's \`"search"\` ${searchValueRule}${leadsNote}. \`found\` and \`verified\` are
   today's date. \`team\`, \`setup\`, and \`comp\` are the step-${captureNum} fields - omit
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
     -d '{"screened":[{"search":"${key}","url":"...","company":"...","title":"...","location":"...","reason":"..."}]}'
   \`\`\`

   \`"search"\` must be \`"${key}"\`.${screenedNote} \`reason\` is a short, specific, human-readable explanation (e.g. ${screenedExamples}) - this is what makes the entry useful later, don't leave it vague. Same success/failure check as step 9 (an \`"added"\` count means it worked).
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
