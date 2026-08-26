-- 0001_baseline.sql used CREATE TABLE IF NOT EXISTS with these columns
-- already included, which is a no-op against a table that already existed
-- (it did, from the original hand-run schema.sql) - so it never actually
-- added them. This migration does that for real.

ALTER TABLE leads ADD COLUMN team TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN setup TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN link TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN lastContact TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN nextAction TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN nextActionDate TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN resume TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN referral TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN comp TEXT NOT NULL DEFAULT '';

ALTER TABLE applications ADD COLUMN team TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN setup TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN link TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN lastContact TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN nextAction TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN nextActionDate TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN resume TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN referral TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN comp TEXT NOT NULL DEFAULT '';
