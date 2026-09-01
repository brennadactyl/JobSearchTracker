/**
 * Verification matrix for the multi-user API. Run it against a LOCAL dev
 * worker only - it creates users and deletes nothing, but it writes freely
 * and assumes it can.
 *
 *   wrangler d1 migrations apply job-search-tracker-db --local
 *   echo ADMIN_TOKEN=local-admin-token-for-testing > .dev.vars
 *   wrangler dev --local --port 8787
 *   node verify-local.mjs
 *
 * Point it elsewhere with `node verify-local.mjs <base-url> <admin-token>`.
 *
 * What it's actually for: this repo has no test suite, and the one property
 * that most needs checking before a deploy is that two people's data cannot
 * reach each other. Most of the checks below are one user trying to read or
 * write another's rows by id and getting a 404 - the thing that would be
 * catastrophic and silent if the user scoping in db.js ever regressed.
 *
 * Re-running against the same local database is fine - it resets the
 * passwords it uses and tolerates its fixtures already existing.
 */
const A = process.argv[2] || "http://127.0.0.1:8787";
const ADMIN = process.argv[3] || "local-admin-token-for-testing";
let pass = 0, fail = 0;

const req = async (method, path, { token, body, admin } = {}) => {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  if (admin) headers.authorization = "Bearer " + ADMIN;
  const res = await fetch(A + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " -- " + detail : ""}`); }
}

console.log("\n== provisioning ==");
check("admin route rejects a missing admin token",
  (await req("POST", "/api/users", { body: { name: "x", password: "aaaaaaaaaaaa" } })).status === 401);
check("password under 12 chars refused",
  (await req("POST", "/api/users", { admin: true, body: { name: "shorty", password: "short" } })).status === 400);

const aCreate = await req("POST", "/api/users", { admin: true, body: { name: "Ada", password: "ada-long-password" } });
await req("POST", "/api/users", { admin: true, body: { name: "Bo", password: "bo-long-password1" } });
// 201 the first time, 200 on a re-run against the same local database.
check("creating a user returns a guid",
  [200, 201].includes(aCreate.status) && /^[0-9a-f-]{36}$/.test(aCreate.json.id), JSON.stringify(aCreate.json));
check("names are case-insensitive, so a reset can't fork a second account",
  (await req("POST", "/api/users", { admin: true, body: { name: "ADA", password: "ada-long-password" } })).json.id === aCreate.json.id);
check("re-posting an existing name is a password reset, not a new user",
  (await req("POST", "/api/users", { admin: true, body: { name: "Ada", password: "ada-new-password-1" } })).json.created === false);

console.log("\n== login ==");
check("old password stops working after the reset",
  (await req("POST", "/api/login", { body: { name: "Ada", password: "ada-long-password" } })).status === 401);
const aLogin = await req("POST", "/api/login", { body: { name: "Ada", password: "ada-new-password-1" } });
const bLogin = await req("POST", "/api/login", { body: { name: "Bo", password: "bo-long-password1", label: "scheduled-search" } });
check("login returns a token and the user", aLogin.status === 200 && !!aLogin.json.token && aLogin.json.user.name === "Ada");
const A_TOK = aLogin.json.token, B_TOK = bLogin.json.token;
const wrongName = await req("POST", "/api/login", { body: { name: "nobody", password: "ada-new-password-1" } });
const wrongPass = await req("POST", "/api/login", { body: { name: "Ada", password: "wrong-password-xx" } });
check("unknown name and wrong password are indistinguishable",
  wrongName.status === 401 && wrongPass.status === 401 && wrongName.json.error === wrongPass.json.error);
check("a session token is not accepted as the admin token",
  (await req("POST", "/api/users", { token: A_TOK, body: { name: "sneaky", password: "aaaaaaaaaaaaa" } })).status === 401);
check("no token at all is 401", (await req("GET", "/api/data")).status === 401);
check("a made-up token is 401", (await req("GET", "/api/data", { token: "not-a-real-token" })).status === 401);

console.log("\n== per-user config and data ==");
await req("POST", "/api/config", { token: A_TOK, body: {
  display_title: "Ada's Search", tracks: [{ key: "SWE", label: "Ada Eng", schedule_time: "08:00", role_search_line: "Backend roles", target_companies: ["Acme"] }] } });
await req("POST", "/api/config", { token: B_TOK, body: {
  display_title: "Bo's Search", tracks: [{ key: "SWE", label: "Bo Eng", schedule_time: "09:00", role_search_line: "Frontend roles", target_companies: ["Globex"] }] } });
const aCfg = await req("GET", "/api/config", { token: A_TOK });
const bCfg = await req("GET", "/api/config", { token: B_TOK });
check("two users can hold the same track key with different content",
  aCfg.json.tracks[0].label === "Ada Eng" && bCfg.json.tracks[0].label === "Bo Eng");
check("settings are per user",
  aCfg.json.settings.display_title === "Ada's Search" && bCfg.json.settings.display_title === "Bo's Search");

// A fresh url each run, so re-running against the same database still
// exercises "both users can insert this" rather than hitting the dedup.
const sharedUrl = `https://example.com/same-posting-${Date.now()}`;
await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Senior Backend", location: "Remote (U.S.)", url: sharedUrl }] } });
const bAdd = await req("POST", "/api/leads", { token: B_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Senior Backend", location: "Remote (U.S.)", url: sharedUrl }] } });
check("both users can track the same posting url independently", bAdd.json.added === 1, JSON.stringify(bAdd.json));
const aDupe = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Senior Backend", location: "Remote (U.S.)", url: sharedUrl }] } });
check("the same user re-posting the same url is deduped", aDupe.json.added === 0);

// The variant cases - a posting arriving under a URL that isn't byte-identical
// to the one already stored. This is what actually happened in production: 8
// leads filed in one night that were already tracked, each differing only by a
// ?gh_jid= suffix or a slug. The UNIQUE constraint cannot see any of these.
const aVariant = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Senior Backend", url: `${sharedUrl}?gh_src=search-snippet` }] } });
check("a tracking parameter doesn't make it a new posting",
  aVariant.json.added === 0 && aVariant.json.duplicates === 1, JSON.stringify(aVariant.json));

// Two rows for one posting inside a single payload. INSERT OR IGNORE can't see
// this either, since the two urls differ as strings.
const reqUrl = `https://boards.example.com/jobs/${Date.now()}7104`;
const aBatch = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Staff Backend", url: reqUrl },
  { search: "SWE", company: "Acme", title: "Staff Backend", url: `${reqUrl}/senior-staff-backend-engineer` }] } });
check("one posting twice in one payload is inserted once",
  aBatch.json.added === 1 && aBatch.json.duplicates === 1, JSON.stringify(aBatch.json));

// The distinguishing case that stops the rule being "strip the query string":
// some boards give every posting an identical path and tell them apart only by
// a query param, so those must stay separate rows.
const sharedPath = `https://ats.example.com/careers/job/?jid=${Date.now()}`;
const aTwoJobs = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "One", url: `${sharedPath}1` },
  { search: "SWE", company: "Acme", title: "Two", url: `${sharedPath}2` }] } });
check("two postings sharing a path but not an id stay two leads",
  aTwoJobs.json.added === 2, JSON.stringify(aTwoJobs.json));

// The multi-user version of the variant case. Dedup widened from "same string"
// to "same posting", and the whole point of doing that lookup in db.js is that
// it can only ever see the calling user's rows - so B posting a variant of a
// url A already tracks must still be a new lead for B.
// A url only A holds - `sharedUrl` above is deliberately tracked by BOTH
// users, so a variant of it is B's own duplicate and would pass this check
// while proving nothing about scoping.
const soloUrl = `https://example.com/a-only-${Date.now()}`;
await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Solo", url: soloUrl }] } });
const aSoloDupe = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Solo", url: `${soloUrl}?gh_src=search-snippet` }] } });
check("the variant is a duplicate for the user who holds the original",
  aSoloDupe.json.added === 0, JSON.stringify(aSoloDupe.json));
const bVariant = await req("POST", "/api/leads", { token: B_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Solo", url: `${soloUrl}?gh_src=search-snippet` }] } });
check("but is new for a user who does not - dedup never reaches across users",
  bVariant.json.added === 1, JSON.stringify(bVariant.json));

// Excluded companies. The list has been structured config for a while; until
// now the only thing acting on it was a sentence in the prompt, and both
// directions leaked in production - a lead got filed for an excluded company,
// and two screened rows were written for one the prompt says to drop without
// recording at all.
await req("POST", "/api/config", { token: A_TOK, body: {
  excluded_companies: ["MrBeast / Beast Industries", "xAI", "X (formerly Twitter)"] } });
const exLead = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "xAI", title: "MTS", url: `https://x.ai/careers/${Date.now()}` },
  { search: "SWE", company: "Acme", title: "Fine", url: `https://example.com/ok-${Date.now()}` }] } });
check("an excluded company is dropped and the rest of the batch still lands",
  exLead.json.added === 1 && exLead.json.excluded === 1, JSON.stringify(exLead.json));
// The alias case: the list entry carries two names, and the parenthetical one
// is how the live data actually spells it.
const exAlias = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Beast Industries (MrBeast)", title: "Eng", url: `https://example.com/mb-${Date.now()}` }] } });
check("an alias from the same list entry is excluded too",
  exAlias.json.added === 0 && exAlias.json.excluded === 1, JSON.stringify(exAlias.json));
// The short-alias rule. "X (formerly Twitter)" yields the alias "x", and as a
// bare substring that matches Netflix, Roblox, Perplexity - most of a real
// board. It must only match a company named exactly "x".
const exShort = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Roblox", title: "Eng", url: `https://example.com/rbx-${Date.now()}` }] } });
check("a two-letter alias does not swallow every company containing that letter",
  exShort.json.added === 1 && exShort.json.excluded === 0, JSON.stringify(exShort.json));
// Exclusions are dropped WITHOUT a screened row - the opposite of every other
// rejected candidate. A screened row is a memo saying "considered and ruled
// out", and an exclusion is never considered.
const exScreened = await req("POST", "/api/screened", { token: A_TOK, body: { screened: [
  { search: "SWE", company: "xAI", url: `https://x.ai/careers/s-${Date.now()}`, reason: "excluded" }] } });
check("an excluded company leaves no screened row behind either",
  exScreened.json.added === 0 && exScreened.json.excluded === 1, JSON.stringify(exScreened.json));
// The self-renewing case: /api/coverage creates a row for any company handed
// to it, so an excluded one swept once would be served back every cycle.
const exSweep = await req("POST", "/api/coverage", { token: A_TOK, body: {
  search: "SWE", on: "2026-09-02", swept: [{ company: "xAI" }, { company: "Acme" }] } });
check("an excluded company cannot join the rotation",
  exSweep.json.recorded === 1 && exSweep.json.excluded === 1, JSON.stringify(exSweep.json));
check("and does not come back from the rotation afterwards",
  !(await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies
    .some((c) => c.company === "xAI"));
await req("POST", "/api/config", { token: A_TOK, body: { excluded_companies: [] } });

const screenedUrl = `https://example.com/screened-${Date.now()}`;
await req("POST", "/api/screened", { token: A_TOK, body: { screened: [{ search: "SWE", url: screenedUrl, reason: "out of scope" }] } });
const bScreened = await req("POST", "/api/screened", { token: B_TOK, body: { screened: [{ search: "SWE", url: screenedUrl, reason: "out of scope" }] } });
check("screened items dedup per user, not globally", bScreened.json.added === 1, JSON.stringify(bScreened.json));

const aData = await req("GET", "/api/data", { token: A_TOK });
const bData = await req("GET", "/api/data", { token: B_TOK });
// Counted by this run's own url rather than by table size, so a re-run
// against a database that still holds the last run's fixtures still means
// something.
const mine = (rows, url) => rows.filter((r) => r.url === url).length;
check("each user sees exactly their own copy of the shared posting",
  mine(aData.json.leads, sharedUrl) === 1 && mine(bData.json.leads, sharedUrl) === 1);
check("each user sees exactly their own screened item",
  mine(aData.json.screened, screenedUrl) === 1 && mine(bData.json.screened, screenedUrl) === 1);
check("/api/data reports who you are", aData.json.user.name === "Ada" && bData.json.user.name === "Bo");
const aLeadId = aData.json.leads.find((l) => l.url === sharedUrl).id;
const bLeadId = bData.json.leads.find((l) => l.url === sharedUrl).id;
check("their lead ids are genuinely different rows", aLeadId !== bLeadId);

console.log("\n== cross-user access ==");
check("B cannot read A's lead via status change",
  (await req("POST", `/api/leads/${aLeadId}/status`, { token: B_TOK, body: { status: "Applied" } })).status === 404);
check("B cannot update A's lead", (await req("POST", "/api/update", { token: B_TOK, body: { type: "lead", id: aLeadId, notes: "pwned" } })).status === 404);
await req("POST", `/api/leads/${aLeadId}/status`, { token: A_TOK, body: { status: "Applied" } });
const aApp = (await req("GET", "/api/data", { token: A_TOK })).json.applications.find((x) => x.leadId === String(aLeadId));
check("applying created A's application", !!aApp && aApp.company === "Acme");
check("B cannot delete A's application",
  (await req("POST", "/api/delete-application", { token: B_TOK, body: { id: aApp.id } })).status === 404);
check("B cannot edit A's application through the generic update route",
  (await req("POST", "/api/update", { token: B_TOK, body: { type: "application", id: aApp.id, notes: "pwned" } })).status === 404);
check("B cannot change A's application status",
  (await req("POST", `/api/applications/${aApp.id}/status`, { token: B_TOK, body: { status: "Rejected" } })).status === 404);
const aAppAfter = (await req("GET", "/api/data", { token: A_TOK })).json.applications.find((x) => x.id === aApp.id);
check("A's application survived all of that",
  !!aAppAfter && aAppAfter.status === "Applied" && aAppAfter.notes !== "pwned");
check("B cannot fetch A's prompt for a key B also has (gets B's own)",
  (await req("GET", "/api/prompt/SWE", { token: B_TOK })).text.includes("Frontend roles"));
check("an unconfigured track key 404s",
  (await req("GET", "/api/prompt/NOPE", { token: A_TOK })).status === 404);

console.log("\n== dedup endpoint (what every scheduled run fetches) ==");
const aDedup = await req("GET", "/api/dedup/SWE", { token: A_TOK });
check("returns this track's leads as {id, url, status} and nothing else",
  aDedup.status === 200 && aDedup.json.leads.every((l) => "id" in l && "url" in l && "status" in l && !("notes" in l)),
  JSON.stringify(aDedup.json).slice(0, 120));
check("screened comes back as bare urls, not whole rows",
  Array.isArray(aDedup.json.screened) && aDedup.json.screened.every((u) => typeof u === "string"));
check("it is substantially smaller than /api/data - the whole point",
  JSON.stringify(aDedup.json).length * 2 < JSON.stringify(aData.json).length);
check("B cannot read dedup data for a track key B doesn't have",
  (await req("GET", "/api/dedup/DATA", { token: B_TOK })).status === 404);
check("an unconfigured key 404s rather than returning an empty list",
  (await req("GET", "/api/dedup/GHOST", { token: A_TOK })).status === 404);

console.log("\n== runs ==");
check("recording a run works for your own track",
  (await req("POST", "/api/runs", { token: A_TOK, body: { search: "SWE", status: "ok", leadsAdded: 1, on: "2026-08-31", note: "ok" } })).status === 200);
const aAfterRun = await req("GET", "/api/config", { token: A_TOK });
const bAfterRun = await req("GET", "/api/config", { token: B_TOK });
check("A's run is recorded against A only",
  aAfterRun.json.tracks[0].last_run.note === "ok" && bAfterRun.json.tracks[0].last_run.note === "");
check("a track key nobody configured 404s",
  (await req("POST", "/api/runs", { token: A_TOK, body: { search: "GHOST", on: "2026-08-31" } })).status === 404);

// One search, several tabs: a track with fed_by is a tab the named sibling's
// run fills. The failure this guards against is a tab nothing ever fills or
// records a run against - which looks like a working, quiet search.
// The rotation's memory. What matters here is the ordering (least-recently-
// swept first, never-swept before that) and that a stamp doesn't wipe the
// board endpoint an earlier run confirmed - both are what stop the rotation
// from restarting at the top of the list every night.
console.log("\n== company coverage ==");
check("an unconfigured track key 404s rather than reading as 'never swept'",
  (await req("GET", "/api/coverage/GHOST", { token: A_TOK })).status === 404);
check("a track with no rows yet is an empty list, not an error",
  (await req("GET", "/api/coverage/SWE", { token: B_TOK })).status === 200 &&
  Array.isArray((await req("GET", "/api/coverage/SWE", { token: B_TOK })).json.companies));
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "2026-08-20",
  swept: [{ company: "Acme", board: "greenhouse" }, { company: "Globex" }] } });
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "2026-08-28",
  swept: [{ company: "Acme", note: "blocked" }] } });
// By name, not by index: this file is meant to be re-run against a database
// that still holds the last run's fixtures, and every check that assumed a
// position broke the moment a later one added a row.
// ?all=1: these two are about what the table holds, not about the slice a run
// is handed, and the default response is capped.
const cov = (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies;
const at = (name) => cov.findIndex((c) => c.company === name);
check("least-recently-swept sorts first", at("Globex") < at("Acme"), JSON.stringify(cov));
const acme = cov[at("Acme")];
check("a later stamp keeps the board an earlier run confirmed",
  acme.board === "greenhouse" && acme.last_swept === "2026-08-28" && acme.note === "blocked",
  JSON.stringify(acme));
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "",
  swept: [{ company: "Acme" }, { company: "Initech" }] } });
const seeded = (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies;
check("registering with an empty date doesn't overwrite a real sweep",
  seeded.find((c) => c.company === "Acme").last_swept === "2026-08-28");
check("a newly registered company sorts ahead of everything already swept",
  seeded[0].last_swept === "" &&
  seeded.findIndex((c) => c.company === "Initech") < seeded.findIndex((c) => c.company === "Globex"));
check("recording against a track you don't have 404s",
  (await req("POST", "/api/coverage", { token: A_TOK, body: { search: "GHOST", swept: [{ company: "Acme" }] } })).status === 404);
check("an empty sweep list is refused rather than stamping nothing",
  (await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", swept: [] } })).status === 400);
check("B's coverage for the same track key is B's own",
  (await req("GET", "/api/coverage/SWE", { token: B_TOK })).json.companies.length === 0);
check("the prompt gains the rotation steps once a track has rows",
  (await req("GET", "/api/prompt/SWE", { token: A_TOK })).text.includes("1c. Get this run's companies"));
check("and B's, with no rows, does not",
  !(await req("GET", "/api/prompt/SWE", { token: B_TOK })).text.includes("1c. Get this run's companies"));
// The cap is the whole point, and it has to hold on the night it matters most:
// a freshly seeded list, where every row is never-swept and nothing has a date
// to sort by. It also has to be the *server's* cap - the prompt describing one
// is what this replaced.
// A's list, not B's - B is the "no coverage rows" control for the check above,
// and seeding B here is what quietly broke it the first time. Company names are
// unique per run, and there are enough of them that stamping one batch still
// leaves a full batch of never-swept behind: that's what makes the last check
// below true on a re-run against a database that kept the last run's rows.
const runId = Date.now().toString(36);
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "", swept:
  Array.from({ length: 40 }, (_, i) => ({ company: `Co-${runId}-${String(i).padStart(2, "0")}` })) } });
const due = (await req("GET", "/api/coverage/SWE", { token: A_TOK })).json;
const all = (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json;
check("a run is handed a capped slice, not the whole list",
  due.companies.length === 12 && due.batch === 12 && due.total > 12,
  JSON.stringify({ n: due.companies.length, total: due.total, batch: due.batch }));
check("?all=1 returns the whole table, for seeding and for looking",
  all.companies.length === all.total && all.total === due.total);
// The ordering contract the cap rests on: nothing already covered outranks
// something never covered, and dates only ever go forwards down the list.
const dates = all.companies.map((c) => c.last_swept);
check("never-swept outranks swept, and older outranks newer",
  dates.every((d, i) => i === 0 || d >= dates[i - 1]), JSON.stringify(dates.slice(0, 15)));
const today = "2026-09-01";
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: today,
  swept: due.companies.map((c) => ({ company: c.company })) } });
const next = (await req("GET", "/api/coverage/SWE", { token: A_TOK })).json.companies;
check("what a run covers goes to the back of the queue, not round again",
  next.every((c) => c.last_swept !== today),
  JSON.stringify(next.map((c) => `${c.company}:${c.last_swept}`).slice(0, 4)));

console.log("\n== branched tracks ==");
check("fed_by naming a track that isn't in the list is refused",
  (await req("POST", "/api/config", { token: A_TOK, body: { tracks: [
    { key: "SWE", label: "Ada Eng" },
    { key: "LEAD", label: "Ada Lead", fed_by: "NOPE" }] } })).status === 400);
check("a track cannot feed itself",
  (await req("POST", "/api/config", { token: A_TOK, body: { tracks: [
    { key: "SWE", label: "Ada Eng" },
    { key: "LEAD", label: "Ada Lead", fed_by: "LEAD" }] } })).status === 400);
const branched = await req("POST", "/api/config", { token: A_TOK, body: { tracks: [
  { key: "SWE", label: "Ada Eng", sort_order: 0, schedule_time: "08:00",
    role_search_line: "Backend roles", target_companies: ["Acme"],
    full_description: "a hands-on backend role" },
  { key: "LEAD", label: "Ada Lead", sort_order: 1, fed_by: "SWE",
    full_description: "a role leading a team" }] } });
check("a fed track posts fine alongside the track that feeds it", branched.status === 200, branched.text.slice(0, 120));
const fedPrompt = await req("GET", "/api/prompt/LEAD", { token: A_TOK });
check("a fed track has no prompt of its own, and the refusal names the one to run",
  fedPrompt.status === 409 && /"SWE"/.test(fedPrompt.json.error), fedPrompt.text.slice(0, 120));
const feedPrompt = (await req("GET", "/api/prompt/SWE", { token: A_TOK })).text;
// The third clause used to look for `"search":"LEAD"`, which only ever
// appeared in the per-tab run-record instruction. The server fans that out
// now, so the literal is gone by design; what still has to be true is that the
// fed tab is a place step 9 can file a posting under.
check("the feeding track's prompt covers both tabs",
  feedPrompt.includes("/api/dedup/LEAD") &&
  feedPrompt.includes("a role leading a team") &&
  feedPrompt.includes('`"LEAD"`'));
check("a fed track still accepts a run record - that's what keeps its tab from reading stale",
  (await req("POST", "/api/runs", { token: A_TOK, body: { search: "LEAD", on: "2026-08-31", note: "filed by SWE" } })).status === 200);

console.log("\n== moving a lead between tabs ==");
const moved = await req("POST", "/api/update", { token: A_TOK, body: { type: "lead", id: aLeadId, search: "LEAD" } });
check("a lead moves to another of your own tabs", moved.status === 200 && moved.json.lead.search === "LEAD", moved.text.slice(0, 120));
check("moving to a track you don't have is a 404, not a lost lead",
  (await req("POST", "/api/update", { token: A_TOK, body: { type: "lead", id: aLeadId, search: "GHOST" } })).status === 404);
check("B cannot move A's lead into one of B's tabs",
  (await req("POST", "/api/update", { token: B_TOK, body: { type: "lead", id: aLeadId, search: "SWE" } })).status === 404);
// Its own url rather than the shared fixture: a second row for that one would
// quietly break the "A's leads survive their track being removed" count below.
const conflictUrl = `https://example.com/in-both-tabs-${Date.now()}`;
await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Staff Backend", location: "Remote (U.S.)", url: conflictUrl },
  { search: "LEAD", company: "Acme", title: "Staff Backend", location: "Remote (U.S.)", url: conflictUrl }] } });
const dupId = (await req("GET", "/api/data", { token: A_TOK })).json.leads
  .find((l) => l.url === conflictUrl && l.search === "SWE").id;
check("moving onto a url the destination tab already holds is a 409, not a 500",
  (await req("POST", "/api/update", { token: A_TOK, body: { type: "lead", id: dupId, search: "LEAD" } })).status === 409);

console.log("\n== sessions ==");
const aSecond = await req("POST", "/api/login", { body: { name: "Ada", password: "ada-new-password-1", label: "browser" } });
check("logging out revokes only the token used",
  (await req("POST", "/api/logout", { token: A_TOK })).status === 200
  && (await req("GET", "/api/me", { token: A_TOK })).status === 401
  && (await req("GET", "/api/me", { token: aSecond.json.token })).status === 200);
check("B's session is untouched by A's logout", (await req("GET", "/api/me", { token: B_TOK })).status === 200);

console.log("\n== config writes ==");
check("an empty tracks array is refused rather than wiping the list",
  (await req("POST", "/api/config", { token: B_TOK, body: { tracks: [] } })).status === 400);
// Posting {key, label} to rename a tab must not blank the track's search
// config - the prompt would quietly fall back to its generic defaults.
await req("POST", "/api/config", { token: B_TOK, body: { tracks: [{ key: "SWE", label: "Renamed" }] } });
const bKept = (await req("GET", "/api/config", { token: B_TOK })).json.tracks[0];
check("a partial track post keeps the fields it didn't mention",
  bKept.label === "Renamed" && bKept.role_search_line === "Frontend roles" && bKept.schedule_time === "09:00",
  JSON.stringify({ label: bKept.label, role: bKept.role_search_line, time: bKept.schedule_time }));
check("a field sent as empty string still clears",
  (await req("POST", "/api/config", { token: B_TOK, body: { tracks: [{ key: "SWE", label: "Renamed", search_note: "" }] } })).status === 200);

console.log("\n== replaceTracks isolation ==");
await req("POST", "/api/config", { token: aSecond.json.token, body: { tracks: [{ key: "DATA", label: "Ada Data" }] } });
const bStill = await req("GET", "/api/config", { token: B_TOK });
check("A replacing their whole track list leaves B's tracks alone",
  bStill.json.tracks.length === 1 && bStill.json.tracks[0].key === "SWE");
check("A's old track is gone for A", (await req("GET", "/api/config", { token: aSecond.json.token })).json.tracks[0].key === "DATA");
check("A's leads survive their track being removed",
  mine((await req("GET", "/api/data", { token: aSecond.json.token })).json.leads, sharedUrl) === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
