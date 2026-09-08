-- Lets someone create their own account, so the operator never handles anyone
-- else's password.
--
-- Until now adding a person meant the operator running POST /api/users with
-- the ADMIN_TOKEN, which requires *choosing a password on their behalf* and
-- then sending it to them - over chat, usually, where it stays legible in the
-- scrollback of two devices forever. That is the wrong shape twice over: a
-- password one other person has typed and transmitted is not the person's own,
-- and the step can only ever be done by whoever holds the admin secret, which
-- is exactly the involvement this table exists to remove.
--
-- An invite is a bearer credential that buys one thing and nothing else: the
-- right to call POST /api/signup once. It cannot read anything, cannot write
-- anything, and cannot touch an account that already exists (see
-- src/auth.js's createUser, which refuses a taken name rather than resetting
-- its password the way upsertUser deliberately does - upsertUser is reachable
-- only with the admin secret, and an invite is a far weaker credential to hold
-- because it travels through a chat message).
--
-- Three properties, each one a column:
--
--   Single use   `used_at` is set by the signup that consumes it, and the
--                claim is a conditional UPDATE ... WHERE used_at = '' so two
--                simultaneous signups cannot both win. One invite, one
--                account.
--   Expiring     A link sent in a message lives in that message forever. An
--                invite that never expires is an account-creation hole sitting
--                in someone's chat history, so every one carries an
--                `expires_at` (14 days by default).
--   Traceable    `used_by` records the user id the signup created, which is
--                what lets the operator answer "has Sam joined yet, and what
--                is their id?" from GET /api/invites instead of by scanning
--                the users table. That id is what names their folder under
--                the private data dir, so it is needed on the very next step
--                of setting them up.
--
-- `note` is the operator's own words about who a code was minted for. It is
-- never returned to the person holding the invite - only to the admin listing
-- - because it is a note *about* them, written before they were asked.
CREATE TABLE IF NOT EXISTS invites (
  -- SHA-256 of the code, never the code itself. Same treatment as sessions
  -- (see src/auth.js's hashToken) and for the same reason: without it a `d1
  -- export`, a backup file, or a glance at the table hands over a working
  -- account-creation credential for every invite that has not been used yet.
  id          TEXT PRIMARY KEY,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,            -- full ISO8601 - expiry needs the time
  expires_at  TEXT NOT NULL,
  used_at     TEXT NOT NULL DEFAULT '', -- '' means unused; the claim flag
  used_by     TEXT NOT NULL DEFAULT ''  -- users.id the signup created
);
