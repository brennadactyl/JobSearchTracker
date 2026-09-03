-- Turn the company rotation into a log with a cursor, instead of a sort by date.
--
-- The rotation picked each night's slice with `ORDER BY last_swept, company`
-- and a LIMIT. That works, but it makes the date do two jobs: record when a
-- company was last attempted, and decide who goes next. Both of today's
-- rotation bugs came out of the second job.
--
-- The visible one: after a run recorded its slice, asking for replacements
-- returned companies it had just covered, because they now sorted alongside
-- everything else swept that day. The fix was a `?on=YYYY-MM-DD` filter, which
-- worked and was one more place a caller had to get its own local date right -
-- the worker cannot derive it, so a run passing the wrong one silently gets the
-- wrong slice.
--
-- The quieter one: `company` as the tiebreak means alphabetical order decides
-- who is covered first, every cycle, forever. On the live rotation that put
-- Meta, Microsoft, Netflix, Nvidia, OpenAI, Riot, Roblox, Rockstar, Sony,
-- Unity, Valve and every Seattle-local employer in the last 31 of 55 - none of
-- them reached in the rotation's first two days, while the A-to-M half was
-- covered twice.
--
-- ---- The log
--
-- `position` gives every company a fixed place, and `tracks.sweep_cursor` says
-- how far along a search has read. A run takes the next N from the cursor and
-- the cursor advances past what it attempted, so "further along" is the whole
-- of the selection rule. No dates in it at all. `last_swept` stays, as the
-- information it always was - when did anyone last try this - and stops
-- steering anything.
--
-- Reading further is then inherently fresh, which is what makes a run's
-- second call for replacements safe without a date filter, and it makes the
-- rotation's progress a number anyone can read: position 24 of 55 is a fact,
-- where "24 swept" had to be inferred from dates.
--
-- ---- Why the existing order is randomised rather than kept
--
-- Alphabetical is not neutral. Keeping it would preserve exactly the bias
-- above: the same names lead every cycle and the same tail is always last, so
-- a company's chance of being covered depends on its initial letter. Shuffling
-- once removes that for good without needing anyone to curate an order.
--
-- Once, not per cycle. A stable order is what makes the cursor mean anything -
-- reshuffling between runs would let a company be covered twice in a cycle
-- while another was skipped, which is the starvation this whole mechanism
-- exists to prevent.
--
-- Companies found later append after the highest position, so discovery adds
-- to the end of the log rather than jumping the queue.
ALTER TABLE company_sweeps ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tracks ADD COLUMN sweep_cursor INTEGER NOT NULL DEFAULT 0;

-- One shuffled permutation per (user_id, search), so two people's rotations are
-- ordered independently and neither inherits the other's. ROW_NUMBER over a
-- RANDOM() ordering gives a dense 0..n-1 sequence with no ties, which matters:
-- a tie would leave part of the log order undefined, and the cursor would step
-- over companies non-deterministically.
UPDATE company_sweeps
   SET position = (
     SELECT rn FROM (
       SELECT user_id AS u, search AS s, company AS c,
              ROW_NUMBER() OVER (PARTITION BY user_id, search ORDER BY RANDOM()) - 1 AS rn
         FROM company_sweeps
     )
      WHERE u = company_sweeps.user_id
        AND s = company_sweeps.search
        AND c = company_sweeps.company
   );
