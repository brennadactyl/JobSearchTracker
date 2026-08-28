-- One date per pipeline stage an application has reached (see APP_STATUS in
-- page.html) - not an append-only history log of every status click, just
-- "when did this application first reach X". Auto-stamped with today's date
-- client-side the first time status moves to that stage (see commit() in
-- page.html), but editable afterward like any other date field, so it can
-- be corrected if the tracker wasn't updated the same day the stage
-- actually happened, or backfilled for a stage skipped over in the status
-- dropdown (e.g. going straight from Applied to Onsite / Loop without ever
-- separately selecting Recruiter Screen/Tech Screen).
--
-- "Applied" itself isn't here - it already has dateApplied (0001_baseline).
--
-- Applications-only: leads use LEAD_STATUS (New/Reviewing/Applied/Not a
-- fit), which has no equivalent pipeline-stage concept.
ALTER TABLE applications ADD COLUMN dateRecruiterScreen TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN dateTechScreen TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN dateOnsite TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN dateOffer TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN dateRejected TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN dateWithdrawn TEXT NOT NULL DEFAULT '';
