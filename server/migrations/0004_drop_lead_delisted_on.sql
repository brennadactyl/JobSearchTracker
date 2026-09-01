-- Removes leads.delistedOn.
--
-- A posting confirmed taken down used to be marked with a date in this column
-- and kept as a row: the webpage drew a "Delisted" badge beside it and the
-- lead stayed in its search tab. Neither is true any more. A dead posting is
-- now removed from the tab outright, which left this column as a flag whose
-- only remaining job was to hide the row carrying it - state the page had to
-- read in order to draw nothing.
--
-- The searches still report a taken-down posting exactly as they always have,
-- with POST /api/update and a delistedOn date - that contract is unchanged.
-- What changed is that the server now acts on the report instead of storing
-- it: api.js's removeDelistedLead deletes the lead and writes its URL into
-- `screened` in one transaction (see db.js's deleteLeadAndScreen). The
-- screened row is what keeps dedup honest - without it tomorrow's run
-- rediscovers the same URL, sees nothing tracking it, and adds it straight
-- back as a new lead.
--
-- A lead already marked "Applied" is kept instead. Its id is pointed at by an
-- application row, and once you've applied what's being tracked is the
-- application, not whether the posting outlived it - so the report is simply
-- absorbed, which is the other reason this column has nothing left to hold.
--
-- The rows already carrying a date get the same treatment first, rather than
-- just losing the flag. Dropping the column on its own would put every
-- known-dead lead back on the board looking live - the badge that used to mark
-- it is gone too - and leave it there until some later run happens to re-fetch
-- that exact URL and confirm it dead again, which isn't guaranteed: a domain
-- under a confirmed blanket fetch block is re-attempted about weekly or
-- skipped entirely. So this does by hand what removeDelistedLead now does per
-- report - screened row first, then the delete, same reason and the original
-- delistedOn as the date, so what was there and when it went survives the
-- column that recorded it. Leads an application row points at are left alone
-- here for the same reason the endpoint leaves them alone.
INSERT OR IGNORE INTO screened (user_id, search, url, company, title, location, reason, date)
SELECT user_id, search, url, company, title, location, 'posting taken down', delistedOn
  FROM leads
 WHERE delistedOn != ''
   AND status != 'Applied'
   AND NOT EXISTS (SELECT 1 FROM applications a
                    WHERE a.user_id = leads.user_id AND a.leadId = CAST(leads.id AS TEXT));

DELETE FROM leads
 WHERE delistedOn != ''
   AND status != 'Applied'
   AND NOT EXISTS (SELECT 1 FROM applications a
                    WHERE a.user_id = leads.user_id AND a.leadId = CAST(leads.id AS TEXT));

-- search_runs.delisted is deliberately untouched: it counts an event per run
-- ("2 postings came down today"), not a state on a lead, and the run summary
-- on the page still reports it.
ALTER TABLE leads DROP COLUMN delistedOn;
