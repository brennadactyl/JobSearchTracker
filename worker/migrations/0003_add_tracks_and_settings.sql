-- Makes the tracker's tracks, display title, and "priority location" rules
-- data instead of hard-coded JS (see src/page.html, which previously baked
-- in a TRACKS object, "Brenna's Job Search", and a Seattle/Portland geo()
-- lookup). That's what let one installer's Worker code serve only one
-- installer's job search - this makes the same deployed code reusable by
-- anyone, configured via POST /api/config instead of editing page.html.
--
-- Seeded with this deployment's existing values so nothing changes visually
-- until someone posts different config.

CREATE TABLE IF NOT EXISTS tracks (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  full_description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO tracks (key, label, full_description, sort_order) VALUES
  ('SWE', 'Engineering', 'Senior / Staff Software Engineer', 0),
  ('TPM', 'Technical PM', 'Senior+ Technical Program Manager', 1),
  ('CPM', 'Product', 'Consumer Product Manager', 2)
ON CONFLICT(key) DO NOTHING;

INSERT INTO meta (key, value) VALUES
  ('display_title', 'Brenna''s Job Search')
ON CONFLICT(key) DO NOTHING;

-- Ordered rules, first match wins. "tier" must be "p-high" or "p-med" (the
-- two priority levels page.html's CSS already styles). "anyOf" matches if
-- any listed substring appears in the (lowercased) location string; "allOf"
-- (optional) additionally requires every listed substring to appear - used
-- here so "Remote US" only lights up for remote postings that also say a US
-- indicator, not just anything containing "remote".
INSERT INTO meta (key, value) VALUES
  ('priority_locations', '[{"tier":"p-high","label":"Seattle area","anyOf":["seattle","bellevue","redmond","kirkland","mercer island","bothell","renton","everett","tacoma","sammamish","issaquah","puget sound"]},{"tier":"p-high","label":"Remote US","allOf":["remote"],"anyOf":["usa","u.s","united states"]},{"tier":"p-med","label":"Portland","anyOf":["portland","beaverton","hillsboro","vancouver, wa","vancouver,wa","oregon"]}]')
ON CONFLICT(key) DO NOTHING;
