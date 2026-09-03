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
  excluded_companies: ["Quillwork / Quill Industries", "Vela", "Q (formerly Quantex)"] } });
const exLead = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Vela", title: "MTS", url: `https://vela.example.com/careers/${Date.now()}` },
  { search: "SWE", company: "Acme", title: "Fine", url: `https://example.com/ok-${Date.now()}` }] } });
check("an excluded company is dropped and the rest of the batch still lands",
  exLead.json.added === 1 && exLead.json.excluded === 1, JSON.stringify(exLead.json));
// The alias case: the list entry carries two names, and the parenthetical one
// is how the live data actually spells it.
const exAlias = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Quill Industries (Quillwork)", title: "Eng", url: `https://example.com/qw-${Date.now()}` }] } });
check("an alias from the same list entry is excluded too",
  exAlias.json.added === 0 && exAlias.json.excluded === 1, JSON.stringify(exAlias.json));
// The short-alias rule. "Q (formerly Quantex)" yields the alias "q", and as a
// bare substring that would take out a large slice of any real board. It must
// only match a company named exactly "q". The second row is the token-boundary
// rule: "Vela" is on the list, "Velabyte" is a different company.
// Distinct req ids, not just distinct paths: canonicalUrl keys on the id when
// there is one, so two urls carrying the same number are one posting however
// their paths differ.
const shortStamp = Date.now();
const exShort = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Torque Interactive", title: "Eng", url: `https://example.com/jobs/${shortStamp}01` },
  { search: "SWE", company: "Velabyte", title: "Eng", url: `https://example.com/jobs/${shortStamp}02` }] } });
check("a short alias does not swallow every company containing that letter",
  exShort.json.added === 2 && exShort.json.excluded === 0, JSON.stringify(exShort.json));
// Exclusions are dropped WITHOUT a screened row - the opposite of every other
// rejected candidate. A screened row is a memo saying "considered and ruled
// out", and an exclusion is never considered.
const exScreened = await req("POST", "/api/screened", { token: A_TOK, body: { screened: [
  { search: "SWE", company: "Vela", url: `https://vela.example.com/careers/s-${Date.now()}`, reason: "excluded" }] } });
check("an excluded company leaves no screened row behind either",
  exScreened.json.added === 0 && exScreened.json.excluded === 1, JSON.stringify(exScreened.json));
// The self-renewing case: /api/coverage creates a row for any company handed
// to it, so an excluded one swept once would be served back every cycle.
const exSweep = await req("POST", "/api/coverage", { token: A_TOK, body: {
  search: "SWE", on: "2026-09-02", swept: [{ company: "Vela" }, { company: "Acme" }] } });
check("an excluded company cannot join the rotation",
  exSweep.json.recorded === 1 && exSweep.json.excluded === 1, JSON.stringify(exSweep.json));
check("and does not come back from the rotation afterwards",
  !(await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies
    .some((c) => c.company === "Vela"));
// The ordinary way an exclusion happens: the company is already in the
// rotation, and gets excluded later because a posting from it turned up. A
// guard on the write path alone would go on serving it forever.
await req("POST", "/api/config", { token: A_TOK, body: { excluded_companies: [] } });
await req("POST", "/api/coverage", { token: A_TOK, body: {
  search: "SWE", on: "", swept: [{ company: "Latecomer Ltd" }] } });
check("a company registered before it was excluded is in the rotation",
  (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies
    .some((c) => c.company === "Latecomer Ltd"));
await req("POST", "/api/config", { token: A_TOK, body: { excluded_companies: ["Latecomer Ltd"] } });
const afterEx = await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK });
check("excluding it afterwards stops it being handed to a run",
  !afterEx.json.companies.some((c) => c.company === "Latecomer Ltd"),
  JSON.stringify(afterEx.json.companies.map((c) => c.company).slice(0, 8)));
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
// The lead's location has to survive becoming an application - it's the one
// carried-over field with no other source, since the lead it came from is a
// row whose posting is expected to die eventually.
check("A's application carried the lead's location",
  !!aApp && aApp.location === "Remote (U.S.)");
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

console.log("\n== unreadable companies don't burn rotation slots ==");
// The cost this removes, measured on the live rotation: a twelve-company slice
// spent four slots on companies it could not read - two domains that had
// refused every fetch for nine days, two boards whose ids all 404'd - and the
// day produced one lead from the eight that were actually searched.
const covDay = "2026-09-05";
const cSeed = Array.from({ length: 20 }, (_, i) => ({ company: `CovCo ${String(i).padStart(2, "0")}` }));
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "", swept: cSeed } });
const slice1 = (await req("GET", "/api/coverage/SWE", { token: A_TOK })).json;
const doomed = slice1.companies.slice(0, 3).map((c) => c.company);
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: covDay,
  swept: slice1.companies.map((c) => ({ company: c.company, unreadable: doomed.includes(c.company),
    note: doomed.includes(c.company) ? "403 on every fetch" : "" })) } });

const slice2 = (await req("GET", "/api/coverage/SWE", { token: A_TOK })).json;
check("a company reported unreadable is held out of the next slice",
  doomed.every((c) => !slice2.companies.some((x) => x.company === c)),
  JSON.stringify(slice2.companies.map((c) => c.company).slice(0, 6)));
check("and the slice is topped up rather than left short",
  slice2.companies.length === slice1.companies.length,
  JSON.stringify({ before: slice1.companies.length, after: slice2.companies.length }));
check("the response says how many were held back, so a run can explain the gap",
  slice2.blocked >= 3, JSON.stringify({ blocked: slice2.blocked }));
check("?all=1 still shows blocked companies - it is the only view of the whole table",
  (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies
    .filter((c) => doomed.includes(c.company)).length === 3);

// Repeated failure lengthens the block; a success ends it outright.
const blockedRow = () => req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })
  .then((r) => r.json.companies.find((c) => c.company === doomed[0]));
const first = await blockedRow();
check("a first failure blocks for the shortest backoff, not forever",
  first.fetch_fail_streak === 1 && first.blocked_until === "2026-09-08",
  JSON.stringify({ streak: first.fetch_fail_streak, until: first.blocked_until }));
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "2026-09-08",
  swept: [{ company: doomed[0], unreadable: true }] } });
const second = await blockedRow();
check("a second consecutive failure backs off further",
  second.fetch_fail_streak === 2 && second.blocked_until === "2026-09-15",
  JSON.stringify({ streak: second.fetch_fail_streak, until: second.blocked_until }));
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "2026-09-15",
  swept: [{ company: doomed[0], board: "greenhouse" }] } });
const healed = await blockedRow();
check("one successful sweep clears the block and the streak",
  healed.fetch_fail_streak === 0 && healed.blocked_until === "",
  JSON.stringify({ streak: healed.fetch_fail_streak, until: healed.blocked_until }));
check("a company that came back is eligible again immediately",
  (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies
    .some((c) => c.company === doomed[0] && !c.blocked_until));

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
    full_description: "a role leading a team" },
  // An independent track, not part of the SWE feed group - the contrast that
  // makes the dedup-scope checks below mean something.
  { key: "DATA", label: "Ada Data", sort_order: 2,
    role_search_line: "Data roles", target_companies: ["Globex"] }] } });
check("a fed track posts fine alongside the track that feeds it", branched.status === 200, branched.text.slice(0, 120));

// Dedup follows the *search*, not the tab. SWE and LEAD are one search filling
// two tabs, so one posting cannot sit in both: a run that filed it under LEAD
// yesterday and sorts it into SWE today would otherwise add it twice, which is
// the duplicate this whole filter exists to stop arriving by another door.
const groupUrl = `https://boards.example.com/jobs/${Date.now()}31`;
const across = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Shared", url: groupUrl },
  { search: "LEAD", company: "Acme", title: "Shared", url: groupUrl }] } });
check("one posting cannot land in two tabs of the same branched search",
  across.json.added === 1 && across.json.duplicates === 1, JSON.stringify(across.json));
// ...while two genuinely separate searches tracking one posting stay two rows,
// which is what UNIQUE(user_id, search, url) has always said.
const indieUrl = `https://boards.example.com/jobs/${Date.now()}32`;
const indie = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Shared", url: indieUrl },
  { search: "DATA", company: "Acme", title: "Shared", url: indieUrl }] } });
check("but two independent tracks may each hold it",
  indie.json.added === 2, JSON.stringify(indie.json));
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
// The fan-out is one transaction, so a run record either exists for every tab
// the run fills or for none. The failure it replaced was a half-written
// fan-out leaving a tab that had just been searched reading as never-run - the
// exact state search_runs exists to make visible. A batch that violates the
// table's primary key fails as a whole, which is how this gets to observe
// all-or-nothing from outside: nothing should have moved.
const fanDay = "2026-12-01";
await req("POST", "/api/runs", { token: A_TOK, body: { search: "SWE", status: "ok", on: fanDay, note: "before" } });
const beforeFan = (await req("GET", "/api/config", { token: A_TOK })).json.tracks
  .filter((t) => ["SWE", "LEAD"].includes(t.key)).map((t) => t.last_run.note);
check("a fan-out writes a record for the posted track and every tab it feeds",
  beforeFan.length === 2 && beforeFan.every((n) => n === "before"), JSON.stringify(beforeFan));
check("and the fed tab's record is not the feeding track's row copied over",
  (await req("GET", "/api/config", { token: A_TOK })).json.tracks
    .find((t) => t.key === "LEAD").last_run.on === fanDay);

check("a fed track still accepts a run record - that's what keeps its tab from reading stale",
  (await req("POST", "/api/runs", { token: A_TOK, body: { search: "LEAD", on: "2026-08-31", note: "filed by SWE" } })).status === 200);

console.log("\n== leads and screened must name a configured track ==");
// The orphan-row failure, from the write side. /api/runs has 404'd an
// unconfigured key for a while; /api/leads and /api/screened took any string,
// and 145 leads plus 185 screened rows spent months under a retired "TPM" key
// - stored, invisible, and un-erroring. Ada's tracks here are SWE, LEAD (fed
// by SWE) and DATA.
const ghostLead = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "GHOST", company: "Acme", title: "Nowhere", url: `https://boards.example.com/jobs/${Date.now()}41` }] } });
check("a lead naming an unconfigured track is refused, and the error names the key",
  ghostLead.status === 404 && /GHOST/.test(ghostLead.json.error), ghostLead.text.slice(0, 140));
const ghostScreened = await req("POST", "/api/screened", { token: A_TOK, body: { screened: [
  { search: "GHOST", url: `https://boards.example.com/jobs/${Date.now()}42`, reason: "out of scope" }] } });
check("and so is a screened row naming one",
  ghostScreened.status === 404 && /GHOST/.test(ghostScreened.json.error), ghostScreened.text.slice(0, 140));

// The half-applied payload is the case worth holding onto: the run reads
// `added`, reports it, and stops looking for those postings. So a payload that
// is one-third wrong must file none of it - checked from outside by asking
// whether the good row's url is anywhere in the data afterwards.
const mixedUrl = `https://boards.example.com/jobs/${Date.now()}43`;
const mixed = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Valid one", url: mixedUrl },
  { search: "GHOST", company: "Acme", title: "Drifted one", url: `${mixedUrl}-b` }] } });
check("a payload mixing a valid key with an unknown one is rejected whole",
  mixed.status === 404, mixed.text.slice(0, 140));
const afterMixed = await req("GET", "/api/data", { token: A_TOK });
check("and the valid row in that payload was not inserted",
  !afterMixed.json.leads.some((l) => l.url === mixedUrl));
const mixedScreenUrl = `https://boards.example.com/jobs/${Date.now()}44`;
check("same for screened - one bad key, nothing filed",
  (await req("POST", "/api/screened", { token: A_TOK, body: { screened: [
    { search: "SWE", url: mixedScreenUrl, reason: "wrong level" },
    { search: "GHOST", url: `${mixedScreenUrl}-b`, reason: "wrong level" }] } })).status === 404 &&
  !(await req("GET", "/api/data", { token: A_TOK })).json.screened.some((s) => s.url === mixedScreenUrl));

// A fed key must keep working. It is a track row like any other, and a
// branched run files into the tab it feeds by name - a check that only allowed
// "tracks that run their own search" would break every branched run on the
// first night.
const fedLead = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "LEAD", company: "Acme", title: "Fed tab", url: `https://boards.example.com/jobs/${Date.now()}45` }] } });
check("a fed (fed_by) key is still accepted by /api/leads", fedLead.status === 200 && fedLead.json.added === 1,
  fedLead.text.slice(0, 140));
const fedScreenUrl = `https://boards.example.com/jobs/${Date.now()}46`;
const fedScreened = await req("POST", "/api/screened", { token: A_TOK, body: { screened: [
  { search: "LEAD", url: fedScreenUrl, reason: "wrong level" }] } });
check("and by /api/screened, which then rewrites it to the feed root",
  fedScreened.status === 200 && fedScreened.json.added === 1, fedScreened.text.slice(0, 140));
check("the rewrite still happened - the row is filed under SWE, not LEAD",
  (await req("GET", "/api/data", { token: A_TOK })).json.screened
    .find((s) => s.url === fedScreenUrl)?.search === "SWE");

// Another user's track key is an unconfigured key here, which is the property
// this shares with the rest of the cross-user matrix. "DATA" is one of Ada's
// tabs and none of Bo's, and the refusal Bo gets is the ordinary unknown-track
// 404 - the same answer a typo gets, saying nothing about whether anyone else
// has such a track.
check("one user cannot file a lead into another user's track key",
  (await req("POST", "/api/leads", { token: B_TOK, body: { leads: [
    { search: "DATA", company: "Acme", title: "Not yours", url: `https://boards.example.com/jobs/${Date.now()}47` }] } })).status === 404);

console.log("\n== dates and counts line up ==");
// The bug this catches: /api/screened accepts a local `on`, and a run record
// counts a day's screened rows by `date = on`. If the caller sends `on` to
// /api/runs but not to /api/screened, the rows get the worker's UTC date and
// the run truthfully records having screened nothing. It only diverges when
// the two dates differ, which a same-day test cannot produce - so this sends a
// date that is nobody's "today" and checks the counts still find each other.
const farDay = "2026-11-14";
// Distinct req ids, not a shared stem with different suffixes: canonicalUrl
// keys on the number and ignores the rest of the path, so urls built by
// appending to one stem are all the same posting.
const dStamp = Date.now();
// Deltas, not absolutes: this file is re-run against the same local database,
// and a previous run's rows are still sitting on that date.
const base = (await req("POST", "/api/runs", { token: A_TOK, body: {
  search: "SWE", status: "ok", on: farDay, note: "baseline" } })).json.run;
await req("POST", "/api/leads", { token: A_TOK, body: { on: farDay, leads: [
  { search: "SWE", company: "Acme", title: "Dated", url: `https://dates.example.com/jobs/${dStamp}10` }] } });
await req("POST", "/api/screened", { token: A_TOK, body: { search: "SWE", on: farDay, screened: [
  { search: "SWE", url: `https://dates.example.com/jobs/${dStamp}11`, reason: "below target level" },
  { search: "SWE", url: `https://dates.example.com/jobs/${dStamp}12`, reason: "outside scope: London, UK" }] } });
const dated = await req("POST", "/api/runs", { token: A_TOK, body: {
  search: "SWE", status: "ok", on: farDay, note: "dates" } });
check("a lead posted with a top-level `on` is stamped and counted on that date",
  dated.json.run.leads_added - base.leads_added === 1, JSON.stringify(dated.json.run));
check("screened rows posted with the same `on` are counted on it too",
  dated.json.run.screened_added - base.screened_added === 2, JSON.stringify(dated.json.run));
// DELISTED_REASON is the server's marker for "a lead we tracked came down".
// A run screening a dead-on-arrival candidate would describe it the same way
// in English, and that row must not be counted as a delisting.
await req("POST", "/api/screened", { token: A_TOK, body: { search: "SWE", on: farDay, screened: [
  { search: "SWE", url: `https://dates.example.com/jobs/${dStamp}13`, reason: "posting taken down" }] } });
const reasoned = await req("POST", "/api/runs", { token: A_TOK, body: { search: "SWE", status: "ok", on: farDay } });
check("a screened row cannot claim the reason that means 'delisted'",
  reasoned.json.run.delisted === base.delisted &&
  reasoned.json.run.screened_added - base.screened_added === 3,
  JSON.stringify(reasoned.json.run));

console.log("\n== url-keyed routes ==");
// These are the first routes that find a lead by url rather than by id, so
// they do not inherit the protection every other cross-user check in this file
// relies on - an id that simply doesn't resolve for the wrong user. A
// `WHERE url IN (...)` missing its user_id would match the other person's row
// perfectly, and one of these routes deletes. Hence the two checks below.
const bothUrl = `https://careers.example.com/jobs/${Date.now()}4210`;
for (const tok of [A_TOK, B_TOK]) {
  await req("POST", "/api/leads", { token: tok, body: { leads: [
    { search: "SWE", company: "Acme", title: "Shared", url: bothUrl, verified: "2026-01-01" }] } });
}
// Sent as a variant, to prove the canonical match is what resolves it.
const bStamp = await req("POST", "/api/verified", { token: B_TOK, body: {
  search: "SWE", on: "2026-09-02", urls: [`${bothUrl}?gh_src=search-snippet`] } });
check("a url variant re-confirms the lead it names", bStamp.json.stamped === 1, JSON.stringify(bStamp.json));
const aRow = (await req("GET", "/api/data", { token: A_TOK })).json.leads.find((l) => l.url === bothUrl);
check("and stamping it did not touch the other user's copy",
  aRow && aRow.verified === "2026-01-01", JSON.stringify(aRow && aRow.verified));

const bDel = await req("POST", "/api/delist", { token: B_TOK, body: {
  search: "SWE", on: "2026-09-02", urls: [bothUrl] } });
check("delisting removes the caller's lead", bDel.json.removed === 1, JSON.stringify(bDel.json));
const aData2 = await req("GET", "/api/data", { token: A_TOK });
const bData2 = await req("GET", "/api/data", { token: B_TOK });
check("and leaves the other user's lead for the same posting alone",
  aData2.json.leads.some((l) => l.url === bothUrl) && !bData2.json.leads.some((l) => l.url === bothUrl));

// A date that isn't a date is not a report of anything, and what this triggers
// is a permanent delete - so it is refused for the whole batch, before
// anything is removed.
const liveUrl = `https://careers.example.com/jobs/${Date.now()}5511`;
await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Still live", url: liveUrl }] } });
const badOn = await req("POST", "/api/delist", { token: A_TOK, body: { search: "SWE", on: "today", urls: [liveUrl] } });
check("delist refuses a non-date and deletes nothing",
  badOn.status === 400 &&
  (await req("GET", "/api/data", { token: A_TOK })).json.leads.some((l) => l.url === liveUrl),
  badOn.text.slice(0, 100));
const noMatch = await req("POST", "/api/delist", { token: A_TOK, body: {
  search: "SWE", on: "2026-09-02", urls: ["https://example.com/nothing-tracks-this"] } });
check("a url nothing tracks is reported back as a raw url, not a count",
  noMatch.json.unmatched === 1 && noMatch.json.unmatchedUrls[0] === "https://example.com/nothing-tracks-this",
  JSON.stringify(noMatch.json));

console.log("\n== moving a lead between tabs ==");
const moved = await req("POST", "/api/update", { token: A_TOK, body: { type: "lead", id: aLeadId, search: "LEAD" } });
check("a lead moves to another of your own tabs", moved.status === 200 && moved.json.lead.search === "LEAD", moved.text.slice(0, 120));
check("moving to a track you don't have is a 404, not a lost lead",
  (await req("POST", "/api/update", { token: A_TOK, body: { type: "lead", id: aLeadId, search: "GHOST" } })).status === 404);
check("B cannot move A's lead into one of B's tabs",
  (await req("POST", "/api/update", { token: B_TOK, body: { type: "lead", id: aLeadId, search: "SWE" } })).status === 404);
// Its own url rather than the shared fixture: a second row for that one would
// quietly break the "A's leads survive their track being removed" count below.
//
// The destination is DATA, an independent track, not LEAD. Since dedup follows
// the search rather than the tab, one posting can no longer be filed into two
// tabs of the same branched search at all - so a genuine UNIQUE collision on
// move can only be built out of two separate searches.
const conflictUrl = `https://example.com/in-both-tabs-${Date.now()}`;
await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Staff Backend", location: "Remote (U.S.)", url: conflictUrl },
  { search: "DATA", company: "Acme", title: "Staff Backend", location: "Remote (U.S.)", url: conflictUrl }] } });
const dupId = (await req("GET", "/api/data", { token: A_TOK })).json.leads
  .find((l) => l.url === conflictUrl && l.search === "SWE").id;
check("moving onto a url the destination tab already holds is a 409, not a 500",
  (await req("POST", "/api/update", { token: A_TOK, body: { type: "lead", id: dupId, search: "DATA" } })).status === 409);

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

console.log("\n== removing postings by hand ==");
// The third way a lead leaves the board, after delisting and purging. What
// these check is the part that makes it different from both: the reason is
// the caller's, it reaches the screened row, and that row is what stops the
// removal undoing itself on the next run.
const rmTok = aSecond.json.token; // A_TOK is revoked by the sessions section above
// The varying part has to be the 5+ digit run itself. url.js treats such a
// run as the posting's identity and ignores everything around it, so
// `remove-me-1-<ts>` and `remove-me-2-<ts>` are the SAME posting to it - a
// fixture written that way silently gets one lead instead of three.
const rmStamp = Date.now();
const rmUrl = (n) => `https://example.com/remove-me-${rmStamp + n}`;
const rmUrls = [rmUrl(1), rmUrl(2), rmUrl(3)];
// Whatever track A has right now, not a hard-coded "SWE": the replaceTracks
// section just above swaps A's track list out, so assuming a key here made
// this section depend on the order the file happens to run in.
const rmTrack = (await req("GET", "/api/config", { token: rmTok })).json.tracks[0].key;
const rmAdd = await req("POST", "/api/leads", { token: rmTok, body: { leads: rmUrls.map((u, i) => (
  { search: rmTrack, company: `Removable ${i}`, title: "Engineer", location: "Austin, TX", url: u })) } });
const rmData = await req("GET", "/api/data", { token: rmTok });
const rmLeads = rmUrls.map((u) => rmData.json.leads.find((l) => l.url === u));
check("fixtures for removal exist", rmLeads.every(Boolean), `track=${rmTrack} add=${rmAdd.text.slice(0,120)} data=${rmData.status}/${(rmData.json.leads||[]).length}`);

check("removing without a reason is refused",
  (await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [rmLeads[0].id] } })).status === 400);
check("a blank reason is refused too",
  (await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [rmLeads[0].id], reason: "   " } })).status === 400);
check("an over-long reason is refused",
  (await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [rmLeads[0].id], reason: "x".repeat(201) } })).status === 400);
check("no ids is refused",
  (await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [], reason: "outside target locations" } })).status === 400);

const rmOne = await req("POST", "/api/delete-leads",
  { token: rmTok, body: { ids: [rmLeads[0].id, rmLeads[1].id], reason: "outside target locations" } });
check("removing two leads reports both", rmOne.status === 200 && rmOne.json.removed === 2, rmOne.text.slice(0, 140));
const afterRm = await req("GET", "/api/data", { token: rmTok });
check("the removed leads are gone from the board",
  !afterRm.json.leads.some((l) => l.id === rmLeads[0].id || l.id === rmLeads[1].id));
check("each removal left a screened row carrying the caller's reason",
  rmUrls.slice(0, 2).every((u) => afterRm.json.screened.some(
    (sc) => sc.url === u && sc.reason === "outside target locations")),
  JSON.stringify(afterRm.json.screened.filter((sc) => rmUrls.includes(sc.url))));
check("the screened row is what stops tomorrow's run re-adding it",
  (await req("GET", `/api/dedup/${rmTrack}`, { token: rmTok })).json.screened.includes(rmUrls[0]));
check("removing an id twice is unmatched, not an error",
  (await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [rmLeads[0].id], reason: "again" } }))
    .json.unmatched.length === 1);

// The applied-to guard, tested through the application row rather than the
// status, because that is what the handler checks.
await req("POST", `/api/leads/${rmLeads[2].id}/status`, { token: rmTok, body: { status: "Applied" } });
const rmApplied = await req("POST", "/api/delete-leads",
  { token: rmTok, body: { ids: [rmLeads[2].id], reason: "outside target locations" } });
check("a lead an application points at is kept, not removed",
  rmApplied.json.removed === 0 && rmApplied.json.kept.includes(rmLeads[2].id), rmApplied.text.slice(0, 140));
check("that lead is still on the board",
  (await req("GET", "/api/data", { token: rmTok })).json.leads.some((l) => l.id === rmLeads[2].id));

// The delisting marker is reserved: countRunActivity splits a day's screened
// rows on that exact string, so a person typing it into the reason box would
// be counted as a delisting rather than a rejection.
const rmSentUrl = `https://example.com/remove-me-${rmStamp + 90}`;
await req("POST", "/api/leads", { token: rmTok, body: { leads: [
  { search: rmTrack, company: "Sentinel Co", title: "Engineer", location: "Austin, TX", url: rmSentUrl }] } });
const rmSent = (await req("GET", "/api/data", { token: rmTok })).json.leads.find((l) => l.url === rmSentUrl);
await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [rmSent.id], reason: "Posting Taken Down" } });
const rmSentRow = (await req("GET", "/api/data", { token: rmTok })).json.screened.find((sc) => sc.url === rmSentUrl);
check("a reason equal to the delisting marker is rewritten, not stored as typed",
  rmSentRow && rmSentRow.reason === "removed by hand", JSON.stringify(rmSentRow));

// Isolation: the whole reason this file exists.
const bTargets = (await req("GET", "/api/data", { token: B_TOK })).json.leads[0];
const crossRm = await req("POST", "/api/delete-leads",
  { token: rmTok, body: { ids: [bTargets.id], reason: "should not work" } });
check("one user cannot remove another's lead",
  crossRm.json.removed === 0 && crossRm.json.unmatched.length === 1, crossRm.text.slice(0, 140));
check("B's lead is still there afterwards",
  (await req("GET", "/api/data", { token: B_TOK })).json.leads.some((l) => l.id === bTargets.id));
check("and no screened row was invented in B's data",
  !(await req("GET", "/api/data", { token: B_TOK })).json.screened.some((sc) => sc.reason === "should not work"));

console.log("\n== a person's pruning is not the search's work ==");
// Two changes that are each right alone: run counts derive from rows, and a
// person removing a posting writes a screened row so it isn't rediscovered.
// Together they let one person's pruning be reported as the night's search
// work. Measured before the fix: one hand-deletion moved a run record from
// {leads:3, screened:2} to {leads:2, screened:3}.
const attrDay = new Date().toISOString().slice(0, 10);
const aStamp = Date.now();
const amk = (n) => ({ search: "SWE", company: "Acme", title: "Attr" + n, url: `https://attr.example.com/jobs/${aStamp}${n}` });
await req("POST", "/api/leads", { token: B_TOK, body: { on: attrDay, leads: [amk(41), amk(42), amk(43)] } });
await req("POST", "/api/screened", { token: B_TOK, body: { search: "SWE", on: attrDay, screened: [
  { search: "SWE", url: `https://attr.example.com/jobs/${aStamp}44`, reason: "below target level" }] } });
const attrBase = (await req("POST", "/api/runs", { token: B_TOK, body: { search: "SWE", status: "ok", on: attrDay } })).json.run;

const attrLeads = (await req("GET", "/api/data", { token: B_TOK })).json.leads
  .filter((l) => l.url.startsWith(`https://attr.example.com/jobs/${aStamp}`));
const handDel = await req("POST", "/api/delete-leads", { token: B_TOK, body: {
  ids: [attrLeads[0].id], reason: "not interested" } });
check("a hand removal deletes the lead and screens its url", handDel.json.removed === 1, JSON.stringify(handDel.json));
const attrAfter = (await req("POST", "/api/runs", { token: B_TOK, body: { search: "SWE", status: "ok", on: attrDay } })).json.run;
check("it does not turn up in the run's screened count",
  attrAfter.screened_added === attrBase.screened_added,
  JSON.stringify({ before: attrBase.screened_added, after: attrAfter.screened_added }));
check("nor in its delisted count",
  attrAfter.delisted === attrBase.delisted,
  JSON.stringify({ before: attrBase.delisted, after: attrAfter.delisted }));

// `added_by` must be a closed set: every write path sets it explicitly, so ''
// means exactly "written before the column existed" and nothing else. A new ''
// appearing is a code path that forgot, and the column stops meaning anything.
const attrRows = (await req("GET", "/api/data", { token: B_TOK })).json.screened
  .filter((s) => s.url.startsWith(`https://attr.example.com/jobs/${aStamp}`));
check("both write paths stamp added_by - '' stays a closed historical set",
  attrRows.length === 2 && attrRows.every((s) => s.added_by === "run" || s.added_by === "hand"),
  JSON.stringify(attrRows.map((s) => ({ by: s.added_by, reason: s.reason.slice(0, 24) }))));
check("the search's row is 'run' and the person's is 'hand'",
  attrRows.some((s) => s.added_by === "run" && s.reason === "below target level") &&
  attrRows.some((s) => s.added_by === "hand" && s.reason === "not interested"),
  JSON.stringify(attrRows.map((s) => s.added_by + ":" + s.reason.slice(0, 20))));

// The refusal that keeps the column honest. `addedBy` is a required parameter,
// and the tempting way to write that - a ternary picking a fallback - IS a
// default, and would default to 'run': a caller that forgot the argument would
// have its rows counted as the night's search work, which is the exact bug
// this whole change exists to fix. JavaScript gives a missing argument as
// `undefined` rather than an error, so the check has to be explicit.
const attrDb = await import("./src/db.js");
let threw = "";
try {
  await new attrDb.Db({}, "u").deleteLeadAndScreen({ id: 1, search: "SWE", url: "u" }, "r", null);
} catch (e) { threw = e.message; }
check("deleteLeadAndScreen refuses a missing added_by instead of guessing 'run'",
  /addedBy must be 'run' or 'hand'/.test(threw), JSON.stringify(threw.slice(0, 90)));
for (const bad of ["", "RUN", "person", null]) {
  let m = "";
  try { await new attrDb.Db({}, "u").deleteLeadAndScreen({ id: 1, search: "SWE", url: "u" }, "r", null, bad); }
  catch (e) { m = e.message; }
  check(`and refuses ${JSON.stringify(bad)}`, /addedBy must be/.test(m), JSON.stringify(m.slice(0, 60)));
}

// A delisting report is a run's work and must still count as delisted.
const delUrl = `https://attr.example.com/jobs/${aStamp}51`;
await req("POST", "/api/leads", { token: B_TOK, body: { on: attrDay, leads: [
  { search: "SWE", company: "Acme", title: "Doomed", url: delUrl }] } });
await req("POST", "/api/delist", { token: B_TOK, body: { search: "SWE", on: attrDay, urls: [delUrl] } });
const attrDelisted = (await req("POST", "/api/runs", { token: B_TOK, body: { search: "SWE", status: "ok", on: attrDay } })).json.run;
check("a delisting reported by the search still counts as delisted",
  attrDelisted.delisted === attrBase.delisted + 1,
  JSON.stringify({ before: attrBase.delisted, after: attrDelisted.delisted }));

console.log("\n== purging a retired search ==");
// A's track list is now just DATA (above), so SWE is retired for A and its
// rows are eligible. B still has a live SWE, which is what makes the
// cross-user and still-configured guards testable in the same breath.
const A2 = aSecond.json.token;
check("a session token cannot reach the purge route, only the admin secret",
  (await req("POST", "/api/purge", { token: A2, body: { user: "Ada", search: "SWE" } })).status === 401);
check("no token at all is 401",
  (await req("POST", "/api/purge", { body: { user: "Ada", search: "SWE" } })).status === 401);
check("an unknown user is 404, not a silent no-op",
  (await req("POST", "/api/purge", { admin: true, body: { user: "Nobody", search: "SWE" } })).status === 404);
const liveGuard = await req("POST", "/api/purge", { admin: true, body: { user: "Bo", search: "SWE" } });
check("purging a key that is still a configured track is refused",
  liveGuard.status === 409 && /configured track/.test(liveGuard.json.error), liveGuard.text.slice(0, 140));

const dry = await req("POST", "/api/purge", { admin: true, body: { user: "Ada", search: "SWE", dryRun: true } });
check("dryRun reports what it would remove and removes nothing",
  dry.json.dryRun === true && dry.json.wouldPurge.leads > 0 &&
  (await req("GET", "/api/data", { token: A2 })).json.leads.some((l) => l.search === "SWE"),
  JSON.stringify(dry.json));

// An application pointing at a lead that is about to be deleted. The record of
// having applied is the least recoverable thing here - the posting is gone
// from the internet too - so it must survive with its pointer cleared.
const appLead = (await req("GET", "/api/data", { token: A2 })).json.leads.find((l) => l.search === "SWE");
await req("POST", `/api/leads/${appLead.id}/status`, { token: A2, body: { status: "Applied" } });
const appsBefore = (await req("GET", "/api/data", { token: A2 })).json.applications;
const linked = appsBefore.find((a) => String(a.leadId) === String(appLead.id));
check("the fixture application is linked to a lead about to be purged", !!linked);

const purged = await req("POST", "/api/purge", { admin: true, body: { user: "Ada", search: "SWE" } });
check("purging removes the retired search's leads and screened rows",
  purged.json.purged.leads > 0 && purged.json.purged.screened >= 0, JSON.stringify(purged.json));
const afterPurge = await req("GET", "/api/data", { token: A2 });
check("nothing is left under that search",
  !afterPurge.json.leads.some((l) => l.search === "SWE") &&
  !afterPurge.json.screened.some((s) => s.search === "SWE"));
check("the application survived, un-pointed rather than deleted",
  afterPurge.json.applications.length === appsBefore.length &&
  afterPurge.json.applications.find((a) => a.id === linked.id).leadId === "",
  JSON.stringify(afterPurge.json.applications.find((a) => a.id === linked.id) || null));
check("B's identically-keyed live track is untouched",
  (await req("GET", "/api/data", { token: B_TOK })).json.leads.some((l) => l.search === "SWE"));
const twice = await req("POST", "/api/purge", { admin: true, body: { user: "Ada", search: "SWE" } });
check("purging again is a no-op, not an error",
  twice.status === 200 && twice.json.purged.leads === 0, twice.text.slice(0, 120));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
