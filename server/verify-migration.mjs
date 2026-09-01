/**
 * Checks 0002_multi_user.sql against a database that already has data.
 *
 *   node verify-migration.mjs
 *
 * This is the one file in the repo that runs exactly once, against real data,
 * and cannot be re-run or undone - `0002` drops and recreates five tables to
 * change constraints SQLite won't alter in place. `verify-local.mjs` exercises
 * the API but always against a database the migration built from empty, so it
 * would not notice the migration losing a column, dropping rows, resetting
 * AUTOINCREMENT, or leaving data owned by a user that doesn't exist.
 *
 * Runs entirely in-process against a throwaway `node:sqlite` database - no
 * wrangler, no dev worker, nothing to clean up, and it never touches D1.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const OWNER = "ab266b6c-00cc-45d1-92ac-cdad412c1558";
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " -- " + detail : ""}`); }
};

// D1 applies a migration file statement by statement; node:sqlite's exec()
// runs the whole script, which is close enough for what's being checked here.
const sql = (f) => readFileSync(new URL(`./migrations/${f}`, import.meta.url), "utf8");

function migrated(seed) {
  const db = new DatabaseSync(":memory:");
  db.exec(sql("0001_schema.sql"));
  if (seed) db.exec(seed);
  db.exec(sql("0002_multi_user.sql"));
  return db;
}

const SEED = `
INSERT INTO leads (id, search, found, company, title, location, url, verified, fit, status, notes, delistedOn, team, setup, source, link, lastContact, nextAction, nextActionDate, resume, referral, comp)
VALUES (7, 'SWE', '2026-08-01', 'Acme', 'Senior Backend', 'Bellevue, WA', 'https://example.com/a', '2026-08-30', 'strong', 'Applied', 'my note', '', 'Platform', 'Hybrid', '', '', '', '', '', '', 'a referral', '$1');
INSERT INTO leads (id, search, found, company, title, location, url, verified, fit, status, notes, delistedOn, team, setup, source, link, lastContact, nextAction, nextActionDate, resume, referral, comp)
VALUES (42, 'TPM', '2026-08-02', 'Globex', 'TPM', 'Remote (U.S.)', 'https://example.com/b', '2026-08-30', '', 'New', '', '2026-08-29', '', '', '', '', '', '', '', '', '', '');
INSERT INTO applications (id, leadId, company, title, dateApplied, status, notes, team, setup, source, link, lastContact, nextAction, nextActionDate, resume, referral, comp, dateRecruiterScreen, dateTechScreen, dateOnsite, dateOffer, dateRejected, dateWithdrawn)
VALUES (3, '7', 'Acme', 'Senior Backend', '2026-08-15', 'Recruiter Screen', '', '', '', '', '', '', '', '', '', '', '', '2026-08-20', '', '', '', '', '');
INSERT INTO screened (id, search, url, company, title, location, reason, date) VALUES (9, 'SWE', 'https://example.com/dead', 'Initech', 'SDE II', 'London, UK', 'outside the US', '2026-08-29');
INSERT INTO tracks (key, label, full_description, sort_order) VALUES ('SWE', 'Engineering', 'Senior / Staff SWE', 0);
INSERT INTO tracks (key, label, full_description, sort_order) VALUES ('TPM', 'Technical PM', 'Senior+ TPM', 1);
INSERT INTO search_runs (track_key, last_run_at, last_run_on, status, leads_added, screened_added, delisted, note)
VALUES ('SWE', '2026-08-30T15:15:31.422Z', '2026-08-30', 'ok', 3, 23, 0, '3 new leads');
INSERT INTO search_runs (track_key) VALUES ('TPM');
INSERT INTO meta (key, value) VALUES ('updated', '2026-08-30');
INSERT INTO meta (key, value) VALUES ('display_title', 'A Job Search');
INSERT INTO meta (key, value) VALUES ('priority_locations', '[{"tier":"p-high","label":"Seattle area","anyOf":["seattle"]}]');
`;

console.log("\n== against a database with data ==");
{
  const db = migrated(SEED);
  const all = (q) => db.prepare(q).all();
  const one = (q) => db.prepare(q).get();

  check("exactly one account exists, and owns everything",
    one("SELECT COUNT(*) c FROM users").c === 1 && one("SELECT id FROM users").id === OWNER);
  check("login starts disabled on it (nothing can hash a password in SQL)",
    one("SELECT password_hash h FROM users").h === "");

  for (const t of ["leads", "applications", "screened", "tracks", "search_runs", "meta"]) {
    check(`${t}: every row is owned`, one(`SELECT COUNT(*) c FROM ${t} WHERE user_id != '${OWNER}'`).c === 0);
  }
  check("no row count changed",
    one("SELECT COUNT(*) c FROM leads").c === 2 && one("SELECT COUNT(*) c FROM applications").c === 1
    && one("SELECT COUNT(*) c FROM screened").c === 1 && one("SELECT COUNT(*) c FROM tracks").c === 2
    && one("SELECT COUNT(*) c FROM search_runs").c === 2 && one("SELECT COUNT(*) c FROM meta").c === 3);

  const lead = one("SELECT * FROM leads WHERE id = 7");
  check("lead ids are preserved", !!lead && !!one("SELECT id FROM leads WHERE id = 42"));
  check("every lead column survived the rebuild",
    lead.status === "Applied" && lead.notes === "my note" && lead.referral === "a referral"
    && lead.comp === "$1" && lead.team === "Platform" && lead.fit === "strong",
    JSON.stringify(lead));
  // leads.delistedOn is dropped later, by 0003 - this file only ever applies
  // 0001 and 0002 (see migrated()), and what it checks is that 0002's table
  // rebuild didn't lose a column that existed at the time. Still a valid
  // check on 0002; just don't expect the column on a current database.
  check("delistedOn survived", one("SELECT delistedOn d FROM leads WHERE id = 42").d === "2026-08-29");
  check("application stage dates survived",
    one("SELECT dateRecruiterScreen d FROM applications WHERE id = 3").d === "2026-08-20");
  check("the application still points at its lead",
    one("SELECT leadId l FROM applications WHERE id = 3").l === "7");
  check("run history survived",
    one("SELECT leads_added n FROM search_runs WHERE track_key = 'SWE'").n === 3);
  check("settings survived",
    one("SELECT value v FROM meta WHERE key = 'display_title'").v === "A Job Search");

  // If AUTOINCREMENT didn't follow the rename, the next insert reuses an id
  // that already belongs to a row, and the UNIQUE constraint hides it as a
  // silent no-op rather than an error.
  db.exec(`INSERT INTO leads (user_id, search, found, company, title, url, verified) VALUES ('${OWNER}', 'SWE', '2026-09-01', 'New Co', 'Eng', 'https://example.com/new', '2026-09-01')`);
  check("AUTOINCREMENT continues past the highest existing id",
    one("SELECT MAX(id) m FROM leads").m === 43, JSON.stringify(one("SELECT MAX(id) m FROM leads")));

  check("the new per-user uniqueness holds within one user", (() => {
    try {
      db.exec(`INSERT INTO leads (user_id, search, found, company, title, url, verified) VALUES ('${OWNER}', 'SWE', '2026-09-01', 'Acme', 'Senior Backend', 'https://example.com/a', '2026-09-01')`);
      return false;
    } catch { return true; }
  })());
  check("...and lets a second user hold the same (search, url)", (() => {
    db.exec("INSERT INTO users (id, name) VALUES ('other-user', 'Someone Else')");
    db.exec(`INSERT INTO leads (user_id, search, found, company, title, url, verified) VALUES ('other-user', 'SWE', '2026-09-01', 'Acme', 'Senior Backend', 'https://example.com/a', '2026-09-01')`);
    return db.prepare("SELECT COUNT(*) c FROM leads WHERE url = 'https://example.com/a'").get().c === 2;
  })());
  check("two users can hold the same track key", (() => {
    db.exec("INSERT INTO tracks (user_id, key, label) VALUES ('other-user', 'SWE', 'Their Engineering')");
    return db.prepare("SELECT COUNT(*) c FROM tracks WHERE key = 'SWE'").get().c === 2;
  })());
  check("names are case-insensitively unique", (() => {
    try { db.exec("INSERT INTO users (id, name) VALUES ('dupe', 'someone else')"); return false; }
    catch { return true; }
  })());
  check("no scaffolding tables are left behind",
    all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_new'").length === 0);
  db.close();
}

console.log("\n== against an empty database ==");
{
  const db = migrated(null);
  check("no account is invented for a fresh install",
    db.prepare("SELECT COUNT(*) c FROM users").get().c === 0);
  check("every table is there and empty",
    ["leads", "applications", "screened", "tracks", "search_runs", "meta", "sessions"]
      .every((t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c === 0));
  check("the new columns exist",
    db.prepare("SELECT COUNT(*) c FROM pragma_table_info('tracks') WHERE name IN ('user_id','role_search_line','resume_line','fit_filter_step','leads_note','doc_update_line','schedule_time')").get().c === 7);
  db.close();
}

console.log("\n== against a database holding only screened rows ==");
{
  // The backfill is conditional on there being data; an early version checked
  // only four of the six tables, so a database in an unusual state migrated
  // its rows to an owner that was never created.
  const db = migrated("INSERT INTO screened (search, url, date) VALUES ('SWE', 'https://example.com/x', '2026-08-29');");
  check("an owner is still created for it",
    db.prepare("SELECT COUNT(*) c FROM users").get().c === 1);
  db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
