-- Gives applications their own location.
--
-- Leads have carried one since 0001_schema.sql; applications never did, so
-- the moment a lead became an application the place it was for stopped being
-- tracked. That left the Applications tab unable to say where anything was,
-- and unable to sort by it - the one axis the search tabs have always had.
--
-- A column rather than a lookup through leadId. The originating lead is not a
-- reliable source: an application can be added by hand with no lead at all,
-- and the lead it did come from is a row whose posting is expected to die
-- eventually. Location is copied at creation for the same reason company,
-- title, notes and link already are (see db.js's
-- setLeadStatusAndMaybeCreateApplication) - an application is a record of
-- what you applied to, which shouldn't change under you because the posting
-- moved on. It stays editable afterwards like every other field.
ALTER TABLE applications ADD COLUMN location TEXT NOT NULL DEFAULT '';

-- Backfill from the originating lead, so existing applications aren't left
-- blank in a column the page now displays and sorts on. Same
-- leadId = CAST(leads.id AS TEXT) join 0004 used - leadId is text, leads.id
-- is an integer - and scoped by user_id, since two people's ids overlap.
-- Hand-added rows (leadId = '') and rows whose lead is gone keep '', which is
-- what an unknown location reads as everywhere else.
UPDATE applications
   SET location = COALESCE((
         SELECT l.location FROM leads l
          WHERE CAST(l.id AS TEXT) = applications.leadId
            AND l.user_id = applications.user_id
       ), '')
 WHERE leadId != '';
