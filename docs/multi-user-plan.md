# Multi-user tracker - implementation plan

> Status: **planned, not implemented.** Nothing on this branch is deployed, and
> none of it should reach `main` before the verification section below passes
> end to end against a local `wrangler dev`.
>
> This document follows the repo's rule that no personal data lives here: where
> the appendix needs to point at a real prompt's wording, it describes the text
> rather than quoting anything identifying. The verbatim originals are in the
> private data folder (see `private.example/README.md`).

## Context

Today this system is single-tenant by construction: one D1 database, one
`API_TOKEN` worker secret whose holder can read and write *everything*, one
`private/` folder on one machine holding the daily search prompts, and one set
of `tracks`/`meta` rows that the client renders as *the* page. No row anywhere
carries an owner. The server's own comments say so out loud - "self-hosted,
per-installer deployment... never a shared multi-tenant backend."

We want a second person's job search in the same deployment. Every row needs an
owner, the gate needs to ask who you are, and the per-track search config (role
line, target companies, candidate blurb, geo scope) has to stop being a `.md`
file that exists only on one machine and become D1 config keyed off a user id.
After this change a search is defined entirely by `(user_id, track key)` in the
database; the machine supplies only resumes, mutable per-track notes, and logs.

Decisions made during planning:

- **Identity**: GUID user ids, never the name as a key. Real login - a password
  hashed with PBKDF2, a `sessions` table, and `/api/login` + `/api/logout`, so
  a credential can actually be revoked. No self-signup: users are provisioned
  through an admin-gated route.
- **Config home**: track search config moves into D1 keyed by user id. The
  worker composes the daily prompt and serves it; `run-search.ps1` fetches it
  instead of reading a per-track `.md`. Both people's searches run on one
  machine.

## Phase 1 - Schema: `server/migrations/0002_multi_user.sql`

`0001_schema.sql` says in its own header not to edit it. This is a new
migration with real DDL.

**New tables**

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,     -- GUID; the only thing other tables reference
  name          TEXT NOT NULL UNIQUE, -- login + display; never a key
  password_hash TEXT NOT NULL,        -- PBKDF2-SHA256 derived bits, base64 ('' = login disabled)
  password_salt TEXT NOT NULL,
  iterations    INTEGER NOT NULL DEFAULT 100000,
  created_at    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,     -- the bearer token itself (32 random bytes, base64url)
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  label      TEXT NOT NULL DEFAULT ''  -- 'browser' | 'scheduled-search' | ...
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
```

`label` is what makes revocation useful in practice: the headless runner holds
one long-lived session, browsers hold their own, and either can be killed
without touching the other. No expiry - matching today's never-expiring token;
logout is a row delete.

**Backfill user** - insert with a fixed GUID generated when the migration is
written, owning every existing row, with an empty `password_hash` (SQL can't run
PBKDF2). Rollout step 6 sets the real password through the admin route.

**Scope every existing table to a user.** `applications` only needs a column,
so `ALTER TABLE applications ADD COLUMN user_id TEXT NOT NULL DEFAULT ''` +
`UPDATE`. The other five change a PK or UNIQUE constraint, which SQLite cannot
do in place, so each is a create-new / copy / drop / rename rebuild (no foreign
keys are declared anywhere in this schema, so no PRAGMA dance is needed; keep
`id INTEGER PRIMARY KEY AUTOINCREMENT` and copy ids explicitly so numbering
survives):

| table | change |
|---|---|
| `leads` | `+ user_id`, `UNIQUE(search, url)` → `UNIQUE(user_id, search, url)` - two people can track the same posting independently |
| `screened` | `+ user_id`, same UNIQUE change |
| `tracks` | `+ user_id`, `PRIMARY KEY(key)` → `PRIMARY KEY(user_id, key)` - both can have a track called `SWE` - plus the new config columns below |
| `search_runs` | `+ user_id`, `PRIMARY KEY(track_key)` → `PRIMARY KEY(user_id, track_key)` |
| `meta` | `+ user_id`, `PRIMARY KEY(key)` → `PRIMARY KEY(user_id, key)` - `updated`, `display_title`, `priority_locations` and every other setting become per-person |
| `applications` | `+ user_id` via ALTER |

Add `CREATE INDEX` on `user_id` for `leads`, `applications`, `screened`.

**New `tracks` columns** and **new `meta` setting keys** - see the appendix,
which derives the exact column set from what the live prompts actually contain.

The mutable `docs/tracked_<key>_postings.md` stays a file - it accumulates
fetch-reliability notes the search itself edits each run, which is content, not
config.

## Phase 2 - Server

**`server/src/auth.js`** (new) - all the crypto in one file, no dependencies
(Web Crypto is native to Workers):

- `hashPassword(password, salt?, iterations?)` → `{hash, salt, iterations}` via
  `crypto.subtle.deriveBits` (PBKDF2-SHA256, 100k, 256-bit output).
- `verifyPassword(password, user)` → bool, with a constant-time compare.
- `newSessionToken()` → 32 bytes from `crypto.getRandomValues`, base64url.
- `getSessionUser(d1, token)` → the joined `sessions`/`users` row, or null.

**`server/src/db.js`** - `Db` gains a user: `new Db(env.DB, userId)`, with
`this.userId` used by every statement. Every `SELECT`/`UPDATE`/`DELETE` gains
`AND user_id = ?`; every `INSERT` writes it; `replaceTracks` and its
`search_runs` sync scope their `DELETE ... NOT IN` to this user. Scoping the
repository rather than passing `userId` per call is the point: no method is
left that *can* forget the filter, and another user's id in `getLead` /
`getApplication` / `trackExists` returns null for free, which the existing
handlers already turn into a 404 with no new code.

User and session access stays outside `Db` (it necessarily runs before a scoped
`Db` exists) - that's `auth.js` plus a small `Users` helper for create /
set-password. Extend `SETTING_KEYS`/`DEFAULT_SETTINGS` with the new settings and
the track row shape with the new config columns.

**`server/src/prompt.js`** (new) - `buildSearchPrompt({user, track, settings,
siblingTracks})` returns the daily prompt text, replacing
`.claude/skills/job-search-setup/templates/scheduled-task.template.md` and the
per-track copies of it in the private folder. See the appendix for the draft and
for what it must carry verbatim. Emitted paths are relative
(`resumes/<file>`, `docs/<doc file>`); the runner sets the working directory.

**`server/src/api.js`** - `authorized(request, env)` goes away. New handlers:

- `handleLogin(request, d1)` - `POST /api/login {name, password, label?}` →
  verify, insert a session, return `{token, user: {id, name}}`. 401 on either
  a bad name or a bad password, with the same message for both.
- `handleLogout(request, d1, token)` - `POST /api/logout` deletes that one
  session row.
- `handleUpsertUser(request, env, d1)` - `POST /api/users {name, password}`,
  gated by a new `ADMIN_TOKEN` worker secret. Creates the user with a fresh
  GUID, or sets the password if the name already exists - so this doubles as
  password reset, which matters because nothing else can hash.
- `handleGetMe(user)` - `GET /api/me` → `{id, name}`.
- `handleGetPrompt(db, user, key)` - `GET /api/prompt/<track key>` →
  `text/plain`, 404 on an unconfigured key.

`handleSetConfig` validates and persists the new track columns and settings;
`handleGetConfig`/`handleGetData` return them. `handleGetData` also returns
`user: {id, name}` so the client can show who is signed in.

**`server/src/index.js`** - resolve the session once, before routing, and build
the scoped `Db` from it:

```js
const session = await getSessionUser(env.DB, bearer(request));
if (!session) return unauthorized();
const db = new Db(env.DB, session.user_id);
```

`OPTIONS`, `POST /api/login`, and `POST /api/users` run before that (the last
gated by `ADMIN_TOKEN` instead). Update the route table in the file header
comment - it is this API's real documentation - with the new routes and the
per-user scoping.

## Phase 3 - Client (`client/public/index.html`)

- Gate gains a **Name** field above the password field (`tracker_name` in
  `localStorage`, prefilled). Submit posts `/api/login`; on success store the
  returned **token** - never the password - and `boot()`. On 401: "That name
  and password don't match."
- Header shows `Signed in as <name>` from `state.user` plus **Log out**, which
  calls `POST /api/logout` then clears `tracker_token`, `tracker_name`, and the
  `bjs.tab` / `bjs.view` / `bjs.leadSort` / `bjs.appSort` prefs, so the next
  person on this browser doesn't land on a tab that isn't theirs.
- The existing 401 handler clears the same keys.
- Nothing else changes: title, tabs, and location tiers already render from
  `/api/config`, which is now per-user.
- Mirror any new settings in `defaultSettings()` - the deliberate client/server
  duplication this repo uses in place of a build step.

## Phase 4 - Scripts (both users, one machine)

**`scripts/run-search.ps1`** - `-Task <track key> -User <user-id>`. Reads
`<DataDir>\<user-id>\tracker.json` (`{url, token}`, gitignored) for that user's
long-lived `scheduled-search` session token, falling back to
`TRACKER_URL`/`TRACKER_API_TOKEN` when absent so today's single-user setup keeps
working. Fetches the prompt from `GET /api/prompt/<task>` instead of reading
`scheduled-tasks\<task>.md`, sets the job's working directory to
`<DataDir>\<user-id>`, and passes the token into the child process as
`TRACKER_API_TOKEN` (the prompt's own `curl` calls still read it from the
environment). Logs to `<DataDir>\<user-id>\logs\<task>.log`. The headless "do
not background any of this" preamble stays here - it describes how *this
runner* invokes the CLI, not the search.

**`scripts/setup-scheduler.ps1`** - discovers users by scanning for
`<DataDir>\*\tracker.json`, then each user's tracks from their `/api/config`
rather than from `*.md` files. Registers `JobSearch-<user-slug>-<TrackSuffix>`
per track at that track's `schedule_time`, auto-staggering blanks.
**Its stale-task cleanup must be scoped to the users this run processed** -
today it unregisters every `JobSearch-*` task not in its own list, so setting up
a second user would silently delete the first user's entire schedule.

## Phase 5 - Skill and docs

**`.claude/skills/job-search-setup/SKILL.md`** - new step 0: identify the user
(existing name, or provision one via `POST /api/users`), mint their
`scheduled-search` session token via `/api/login`, and create
`private/<user-id>/{resumes,docs,logs}` + `tracker.json`. Step 4 stops writing
`scheduled-tasks/<key>.md` and instead posts the track's search config to
`/api/config` (the GET-merge-POST warning still applies, now per-user); it still
writes the per-track doc from `templates/tracked-postings.template.md`. Step 5
previews the real composed prompt via `GET /api/prompt/<key>`. Step 7 passes the
user to `setup-scheduler.ps1`. Delete `templates/scheduled-task.template.md` -
it now lives in `server/src/prompt.js`.

**Docs**: `server/README.md` (users/sessions, `ADMIN_TOKEN`, provisioning,
per-user scoping, the new routes, new config fields, `API_TOKEN` removal),
`client/README.md` (name + password gate, log out), `private.example/README.md`
(new `private/<user-id>/` layout; prompts are no longer files), root
`README.md` (multi-user setup + the rollout order below).
`docs/architecture.svg` and `docs/architecture.html` still describe a
single-user, prompt-file-driven flow - update their labels last, once the code
has settled.

## Rollout order (there is live data in the deployed D1)

1. `wrangler d1 export` - back up first.
2. `wrangler d1 migrations apply` - creates `users`/`sessions`, scopes all rows
   to the backfill GUID.
3. `wrangler secret put ADMIN_TOKEN` - a fresh value, not the old one.
4. `wrangler d1 execute` - insert a session row whose `id` is the **current**
   `API_TOKEN` value, owned by the backfill user, labelled
   `legacy scheduled search`. This is what keeps the already-registered
   scheduled tasks authenticating with nothing changed on the machine, and it
   stays revocable by deleting that one row.
5. `wrangler deploy` the server, then the client. Steps 2-4 finish before any
   new code is live, so no request window 401s.
6. `POST /api/users` with `ADMIN_TOKEN` to set the first user's password; sign
   in from the browser.
7. Delete the `API_TOKEN` secret - its value now lives only as that session row.
8. Provision user 2 and run the setup skill for them.

## Verification

There is no test suite in this repo; verification is curl plus the real UI.

- Local: `wrangler d1 migrations apply --local` + `wrangler dev`, create two
  users through the admin route, then prove isolation - B's `/api/data`
  contains none of A's leads; `POST /api/leads/<A's lead id>/status` with B's
  token 404s; `POST /api/runs` with B's token and A's track key 404s "unknown
  track"; `/api/config` and `/api/prompt/<key>` differ per token.
- Auth: wrong password 401s; wrong name 401s with the same message;
  `/api/users` without `ADMIN_TOKEN` 401s; `POST /api/logout` then reusing that
  token 401s; a second session for the same user survives the first's logout.
- Confirm the migration preserved data: row counts and a spot check of lead ids
  before/after, all now carrying the backfill GUID.
- Client: sign in as each user, check title/tabs/name, log out, confirm the gate
  returns and the other user's tab selection isn't inherited.
- End to end: `run-search.ps1 -Task <key> -User <id>` for the new user, then
  check the log and that the track's tab reports its last run.
- Prompt parity: see the appendix's diff gate. No `.md` prompt gets deleted
  until its composed replacement diffs clean against it.

## Worth knowing

- `/api/login` has no rate limiting - a guessable password is now brute-forcible
  over the internet in a way a 32-byte token never was. PBKDF2 at 100k makes
  each attempt cost real worker CPU (which is also its own small DoS surface).
  Use long passwords; a per-name attempt throttle is a reasonable follow-up.
- Both users' searches run under one machine's single `CLAUDE_CODE_OAUTH_TOKEN`,
  i.e. on the machine owner's Claude account. Stagger the schedule times - each
  run takes minutes and they share the CLI.
- Isolation here is app-level, not privacy from the operator: whoever holds the
  Cloudflare account can read either user's rows directly in D1.

---

# Appendix - what `prompt.js` has to carry

## The finding

The live per-track prompts are **not** filled-in copies of
`templates/scheduled-task.template.md`. They have been hand-edited since they
were generated, and several of those edits are operationally load-bearing.
Anything that decomposes a prompt into keyword-ish columns and re-synthesizes
the prose loses them. Checked against all three live prompts and the deployed
`/api/config`.

**Would have been lost by a naive structured-columns port:**

| What | Where | Why it matters | Fix |
|---|---|---|---|
| The per-track doc filename | steps 1, 8b | All three live tracks use legacy doc names that predate the one-slug convention, not `tracked_<key>_postings.md`. Deriving the path points every existing track at a file that doesn't exist. | `tracks.doc_file` |
| The resume line's fallback file | step 2 | The `.docx` is not readable on the machine that runs the searches (no pandoc/python/LibreOffice), so the `.txt` fallback is what actually gets read. One track has a *different*, conditional fallback that also instructs the model to report which file it used. | `tracks.resume_line`, verbatim |
| The candidate blurb | step 2 | It is **per track**, not per user - the three tracks frame the same resume three different ways for three different role types. | `tracks.candidate_blurb`, not a user setting |
| A hand-added sentence widening the company search | step 3 | In no template. It tells the model not to treat the company list as an industry filter, which materially widens what gets surfaced. A JSON `target_companies` array drops it silently. | `tracks.search_note` |
| The geo-scope paragraph, with its worked examples of excluded locations and its "record exclusions via step 9b" hookup | step 5 | Storing a keyword like `"US only"` and generating a sentence loses both the examples and the step-9b wiring. | `geo_scope_line` setting, verbatim |
| The location-string guidance: explicit city lists per priority tier **plus** the string-format conventions (`"Remote (U.S.)"`, "include city and state") | step 6 | **Deriving this from `priority_locations` does not work.** The live rules contain a substring the guidance doesn't mention, and contain no formatting conventions at all - derivation would both add and drop instructions. | `location_guidance` setting, verbatim |
| A closing guardrail naming a historical file to leave alone | footer | In no template. Stops the model editing an archived spreadsheet. | `footer_note` setting |
| The doc's real section headings, named inline | step 8b | Tells the model where in the doc to write its fetch-reliability notes. | `tracks.doc_sections` |
| A track-specific screening example | step 9b | Sharper than the template's generic "below target level". | `tracks.screened_examples` |
| One track's step 10, which asks for a fit note and for flagging roles where the candidate likely has a personal connection | step 10 | Step 10 has drifted per track too. | `tracks.report_line`, verbatim when set |
| The installer's name and pronouns | steps 1b, 6b, 8 | A second user needs their own. | `pronouns` setting, defaulting to they/them |

**Confirmed safe to treat as shared boilerplate** - byte-identical across all
three live prompts, and the part that most needs to stay correct as the API
changes: steps 1b, 4, 5, 6, 6b, 8, 9, 9b, 9c. Today they are copy-pasted three
times, which is exactly why `private.example/README.md` has to warn that a
hand-authored prompt may be missing step 9c. Centralizing them is the real win
here; the per-track prose is what has to stay verbatim.

**Deliberate normalizations** - differences the composer introduces knowingly.
None change behaviour; all should be eyeballed once:

- A stale dated parenthetical in step 1 is dropped.
- Step 7(c)'s tail becomes "duplicate of an existing lead" on every track (two
  tracks say just "duplicate" today).
- Step 1b's "the same dead/out-of-scope candidate" is used everywhere (one
  track says "closed/wrong-fit").
- The header's summary line comes from `full_description` rather than each
  file's hand-written variant. It's a comment line the model doesn't act on.
- One track has no sibling-tracks note today despite having two siblings;
  `intro_note` is stored verbatim, so it stays absent rather than being
  helpfully added.

## The column set this implies

Structured where the *app* reads it (`key`, `label`, `full_description`,
`sort_order`, `schedule_time`, `target_companies`); **verbatim prose where only
the model reads it**. That split is the finding - going further and decomposing
the prose is what loses things.

- **`tracks`**: `role_search_line`, `target_companies` (JSON array),
  `search_note`, `candidate_blurb`, `resume_line`, `fit_clause`,
  `fit_disqualifier`, `doc_file`, `doc_summary`, `doc_sections`, `intro_note`,
  `report_line`, `screened_examples`, `schedule_time`.
- **`meta` settings**: `geo_scope_line`, `scope_clause`, `scope_disqualifier`,
  `location_guidance`, `footer_note`, `pronouns`.

## Draft `server/src/prompt.js`

```js
/**
 * Composes one track's daily search prompt from its D1 config.
 *
 * This replaces .claude/skills/job-search-setup/templates/scheduled-task.template.md
 * and the per-track .md copies of it that used to live in the private data
 * folder. The reason it moved here: steps 1b/8/9/9b/9c are this API's own
 * calling convention, they were byte-identical in all three hand-copies, and a
 * copy that silently lacked 9c was a documented, real failure mode. Those steps
 * now have exactly one definition, next to the routes they call.
 *
 * The per-track prose (candidate blurb, resume line, search note, report line)
 * is stored and emitted VERBATIM, not synthesized from keywords. That is
 * deliberate - see docs/multi-user-plan.md's appendix: every load-bearing thing
 * the live prompts had that the template didn't was prose someone hand-added.
 */

const PRONOUNS = {
  "she/her": { subj: "she", obj: "her", poss: "her" },
  "he/him": { subj: "he", obj: "him", poss: "his" },
  "they/them": { subj: "they", obj: "them", poss: "their" },
};

// "a, b, and c" - matches the live step-7 phrasing at both 3 and 4 items.
function joinAnd(parts) {
  const p = parts.filter(Boolean);
  if (p.length <= 1) return p[0] || "";
  return p.slice(0, -1).join(", ") + ", and " + p[p.length - 1];
}

export function buildSearchPrompt({ user, track, settings }) {
  const name = user.name;
  const pn = PRONOUNS[settings.pronouns] || PRONOUNS["they/them"];
  const key = track.key;
  const doc = track.doc_file || `docs/tracked_${key}_postings.md`;
  const companies = JSON.parse(track.target_companies || "[]").join(", ");
  const searchNote = track.search_note ? ` ${track.search_note}` : "";
  const docSections = track.doc_sections ? ` (${track.doc_sections})` : "";
  const intro = track.intro_note ? `${track.intro_note}\n` : "";

  const findingIs = joinAnd([
    "genuinely new", "verified live", settings.scope_clause, track.fit_clause,
  ]);
  const disqualified = [
    "dead-on-arrival", settings.scope_disqualifier, track.fit_disqualifier,
    "wrong level", "duplicate of an existing lead",
  ].filter(Boolean).join(", ");

  const report = track.report_line || `Report: if there are new verified ` +
    `postings, list each (company, title, location, URL) as "New today - ` +
    `verified live", and say whether the webpage sync succeeded. Mention the ` +
    `screened-out count too, if any. Say whether the step-9c run record was ` +
    `accepted. If nothing new either way, say so plainly - don't pad.`;

  return `# Scheduled task: ${track.label} - ${track.full_description}
# Schedule: ${track.schedule_time || "unscheduled"} local (headless, via Windows Task Scheduler + scripts\\run-search.ps1)
# Track key in the tracker data: ${key}
# ---------------------------------------------------------------------------

${intro}Do the following:

1. Read \`${doc}\` - ${track.doc_summary}. Follow its numbered process. The doc doesn't keep a found-postings table or a screened/dead-link list of its own - dedup data comes from step 1b instead.
1b. Fetch the tracker's current data: \`curl -s "$TRACKER_URL/api/data" -H "Authorization: Bearer $TRACKER_API_TOKEN"\`. This returns \`leads[]\` (postings already tracked - keep each one's \`url\` and \`status\` on hand for step 8, it's how you tell a stale lead nobody's touched from one ${name} has already applied to) and \`screened[]\` (postings already looked at and rejected - keep each one's \`url\` on hand for step 7, so you don't re-verify the same dead/out-of-scope candidate every run).
2. ${track.resume_line}
3. Search target companies' careers sites (web search as backup) for current ${track.role_search_line}. Companies: ${companies}.${searchNote} Also run the doc's broader-discovery step.
4. MANDATORY VERIFICATION: fetch every candidate URL directly and confirm it renders an actual job description (real title, responsibilities/qualifications - not a landing page, 404, "job not found," a loading placeholder, or a listing/index page that merely contains the title text). A search-snippet URL is a lead, not a finding, until opened and confirmed. If a site won't reveal real content, skip that company today rather than report something unverified.
5. ${settings.geo_scope_line}
6. ${settings.location_guidance}
6b. While the posting is open, also capture - only when it's stated plainly, never inferred or guessed - the team/org named for the role (\`team\`), the stated work arrangement (\`setup\`, e.g. "Remote", "Hybrid - 3 days/week onsite", "Onsite"), and any posted compensation range (\`comp\`, e.g. "$180,000-$230,000/yr"; many US states disclose this by law). Leave any of these as an empty string when the posting doesn't say. These land in the tracker's per-lead "Details" panel alongside referral/resume/next-action fields that are ${name}'s alone to fill in by hand - this search never touches those.
7. Compare candidate URLs against \`leads[]\` and \`screened[]\` from step 1b (not a doc table). Sort each candidate into: (a) already tracked or already screened - skip it; (b) ${findingIs} - a finding, goes to step 9; (c) genuinely new but disqualified (${disqualified}) - goes to step 9b instead of being dropped silently.
8. For a previously-tracked lead (from step 1b's \`leads[]\`) confirmed dead on this check, **never remove or move it** - it stays a lead. Use the step-1b tracker data (match by \`url\`) to call \`POST /api/update\` marking it delisted:
   \`\`\`
   curl -s -X POST "$TRACKER_URL/api/update" \\
     -H "Authorization: Bearer $TRACKER_API_TOKEN" -H "Content-Type: application/json" \\
     -d '{"type":"lead","id":<its id>,"delistedOn":"<today YYYY-MM-DD>"}'
   \`\`\`
   This is independent of \`status\` (Applied, Interviewing, etc. are untouched) - ${name} still needs to track what ${pn.subj} applied to regardless of whether the listing survives. If a posting previously marked delisted is found live again, clear it the same way with \`"delistedOn":""\`. If the tracker's unreachable, skip the API call and note it in your report - don't guess an id.
8b. If you learned something about fetch reliability worth keeping - a newly-blocked domain, a working URL-format fix, a company worth promoting from "expanded net" to "core" - update the relevant section of \`${doc}\`${docSections}. Do not add a found-postings table or a screened/dead-link list back to the doc; those live in the tracker only.
9. SYNC NEW POSTINGS TO THE LIVE TRACKER WEBPAGE. [...the live step 9, verbatim, with "search":"${key}"...]
9b. RECORD SCREENED-OUT CANDIDATES. [...the live step 9b, verbatim, "search":"${key}", examples: ${track.screened_examples}...]
9c. RECORD THE RUN. [...the live step 9c, verbatim, "search":"${key}"...]
10. ${report}

Never add an unverified link to any output.${settings.footer_note ? " " + settings.footer_note : ""}`;
}
```

Steps 9/9b/9c are elided above only for length - in the real file they are the
live text verbatim, with the hardcoded track key replaced by `${key}`. They are
the whole reason this moved server-side, so they get copied exactly, not
paraphrased.

## The diff gate

Before deleting a single `.md`: seed the existing tracks' columns from the
current files, then for each track,
`GET /api/prompt/<key> | diff - <data dir>/scheduled-tasks/<file>.md`. Expect
only the normalizations listed above - anything else is a real loss. Do this
against a **local** `wrangler dev`, before any of it goes near the deployed
worker.
