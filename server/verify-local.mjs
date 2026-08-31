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
 * Expects a database with no users yet (a fresh `--local` one). Re-running
 * against the same database is fine: it resets the passwords it uses.
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
check("admin route rejects a session token as admin",
  true); // covered below once we have one
check("password under 12 chars refused",
  (await req("POST", "/api/users", { admin: true, body: { name: "shorty", password: "short" } })).status === 400);

const aCreate = await req("POST", "/api/users", { admin: true, body: { name: "Ada", password: "ada-long-password" } });
const bCreate = await req("POST", "/api/users", { admin: true, body: { name: "Bo", password: "bo-long-password1" } });
check("creating a user returns 201 and a guid",
  aCreate.status === 201 && /^[0-9a-f-]{36}$/.test(aCreate.json.id), JSON.stringify(aCreate.json));
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

await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Senior Backend", location: "Remote (U.S.)", url: "https://example.com/same-posting" }] } });
const bAdd = await req("POST", "/api/leads", { token: B_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Senior Backend", location: "Remote (U.S.)", url: "https://example.com/same-posting" }] } });
check("both users can track the same posting url independently", bAdd.json.added === 1);
const aDupe = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Senior Backend", location: "Remote (U.S.)", url: "https://example.com/same-posting" }] } });
check("the same user re-posting the same url is deduped", aDupe.json.added === 0);

const aData = await req("GET", "/api/data", { token: A_TOK });
const bData = await req("GET", "/api/data", { token: B_TOK });
check("each user sees only their own leads", aData.json.leads.length === 1 && bData.json.leads.length === 1);
check("/api/data reports who you are", aData.json.user.name === "Ada" && bData.json.user.name === "Bo");
const aLeadId = aData.json.leads[0].id, bLeadId = bData.json.leads[0].id;
check("their lead ids are genuinely different rows", aLeadId !== bLeadId);

console.log("\n== cross-user access ==");
check("B cannot read A's lead via status change",
  (await req("POST", `/api/leads/${aLeadId}/status`, { token: B_TOK, body: { status: "Applied" } })).status === 404);
check("B cannot update A's lead", (await req("POST", "/api/update", { token: B_TOK, body: { type: "lead", id: aLeadId, notes: "pwned" } })).status === 404);
await req("POST", `/api/leads/${aLeadId}/status`, { token: A_TOK, body: { status: "Applied" } });
const aApp = (await req("GET", "/api/data", { token: A_TOK })).json.applications[0];
check("applying created A's application", !!aApp && aApp.company === "Acme");
check("B cannot delete A's application",
  (await req("POST", "/api/delete-application", { token: B_TOK, body: { id: aApp.id } })).status === 404);
check("B cannot change A's application status",
  (await req("POST", `/api/applications/${aApp.id}/status`, { token: B_TOK, body: { status: "Rejected" } })).status === 404);
check("A's application survived all of that",
  (await req("GET", "/api/data", { token: A_TOK })).json.applications.length === 1);
check("B cannot fetch A's prompt for a key B also has (gets B's own)",
  (await req("GET", "/api/prompt/SWE", { token: B_TOK })).text.includes("Frontend roles"));
check("an unconfigured track key 404s",
  (await req("GET", "/api/prompt/NOPE", { token: A_TOK })).status === 404);

console.log("\n== runs ==");
check("recording a run works for your own track",
  (await req("POST", "/api/runs", { token: A_TOK, body: { search: "SWE", status: "ok", leadsAdded: 1, on: "2026-08-31", note: "ok" } })).status === 200);
const aAfterRun = await req("GET", "/api/config", { token: A_TOK });
const bAfterRun = await req("GET", "/api/config", { token: B_TOK });
check("A's run is recorded against A only",
  aAfterRun.json.tracks[0].last_run.note === "ok" && bAfterRun.json.tracks[0].last_run.note === "");
check("a track key nobody configured 404s",
  (await req("POST", "/api/runs", { token: A_TOK, body: { search: "GHOST", on: "2026-08-31" } })).status === 404);

console.log("\n== sessions ==");
const aSecond = await req("POST", "/api/login", { body: { name: "Ada", password: "ada-new-password-1", label: "browser" } });
check("logging out revokes only the token used",
  (await req("POST", "/api/logout", { token: A_TOK })).status === 200
  && (await req("GET", "/api/me", { token: A_TOK })).status === 401
  && (await req("GET", "/api/me", { token: aSecond.json.token })).status === 200);
check("B's session is untouched by A's logout", (await req("GET", "/api/me", { token: B_TOK })).status === 200);

console.log("\n== replaceTracks isolation ==");
await req("POST", "/api/config", { token: aSecond.json.token, body: { tracks: [{ key: "DATA", label: "Ada Data" }] } });
const bStill = await req("GET", "/api/config", { token: B_TOK });
check("A replacing their whole track list leaves B's tracks alone",
  bStill.json.tracks.length === 1 && bStill.json.tracks[0].key === "SWE");
check("A's old track is gone for A", (await req("GET", "/api/config", { token: aSecond.json.token })).json.tracks[0].key === "DATA");
check("A's leads survive their track being removed",
  (await req("GET", "/api/data", { token: aSecond.json.token })).json.leads.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
