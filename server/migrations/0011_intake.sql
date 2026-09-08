-- The queue that lets a person set their own search up, in their own words,
-- without the operator sitting in the conversation.
--
-- Setting a track up has always been an interview: what roles, which
-- companies, where, what does the resume say, what should the page be called.
-- The job-search-setup skill runs that interview, and until now the operator
-- ran it - in their own Claude session, with the other person's resume on
-- their own disk, answering questions about someone else's career on that
-- person's behalf. Every answer had to be relayed first.
--
-- This is the same interview, asked in the browser by the person it is about,
-- and left here for a nightly run to pick up. It is deliberately the same
-- shape as the application autofill queue (see 0009_application_autofill.sql):
-- a row that is looked at once, a derived queue nobody has to remember to fill,
-- and a flag whose only job is to stop it being looked at twice.
--
--   'pending'  submitted, nothing has acted on it yet
--   'done'     a run built their folder, config and schedule
--   'failed'   a run tried and couldn't - `status_note` says why, and the
--              page shows it to them, because a person waiting on a setup
--              that is never coming should be told rather than left guessing
--
-- One row per person, keyed by user id rather than an id of its own: an intake
-- is a thing an account either has outstanding or doesn't. Re-submitting
-- replaces it (see db.js), so a person who realises they wrote the wrong
-- target companies can just send the form again while it is still pending.
CREATE TABLE IF NOT EXISTS intake (
  user_id      TEXT PRIMARY KEY,
  submitted_at TEXT NOT NULL,
  -- Exactly what the form collected, as JSON, in the person's own words. Not
  -- the composed config: turning "I want senior backend roles, ideally
  -- Seattle or remote US" into the prose fields /api/config stores is the
  -- run's job, and it is the part that needs a model rather than a form. What
  -- is kept here is the input to that, so a setup that came out wrong can be
  -- re-run against what they actually said instead of being re-interviewed.
  answers      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  status_note  TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT ''
);

-- The resume(s), carried from their browser to whichever machine will run
-- their search. This is the one thing the form cannot express as text: the
-- run needs the actual file to put in their `resumes/` folder, and the person
-- uploading it is not sitting at the machine that will hold it.
--
-- Stored base64 in a TEXT column rather than in R2, because R2 would be a
-- second binding to provision in every deployment - one more thing the
-- one-click deploy cannot do for you - to hold a document that is measured in
-- tens of kilobytes. D1 caps a single value at 1,000,000 bytes, so the route
-- caps the decoded upload well under that (see routes/intake.js).
--
-- **These rows are deleted when the intake completes.** A resume is the most
-- personal thing this deployment ever holds, it is needed only for the hop
-- from browser to machine, and after the run has written it to disk the copy
-- here is a second place it lives for no reason. POST /api/intake/complete
-- removes them in the same statement batch that marks the intake done.
CREATE TABLE IF NOT EXISTS intake_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  bytes        INTEGER NOT NULL,       -- decoded size, for showing before fetching
  body         TEXT NOT NULL,          -- base64 of the file
  uploaded_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intake_files_user ON intake_files(user_id);
