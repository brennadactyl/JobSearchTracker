/**
 * Whether a company is one this person has said they will not work for.
 *
 * `settings.excluded_companies` has always been a list, but until this file
 * existed the only thing acting on it was a sentence in the nightly prompt.
 * A list rendered into prose is a request, and the request leaked in both
 * directions at once on the live board: one excluded company was filed as a
 * normal lead, and another had two `screened` rows written for it despite the
 * same sentence saying to drop it *without* recording one. So the rule moves
 * here, where a caller asks a function instead of hoping.
 *
 * Pure, like url.js - no D1, no env, no import from db.js - so it can be
 * replayed offline over the whole live corpus, which is the only way to tell
 * whether a change to it over-matches.
 *
 * ---- The rules, in full.
 * An entry is written by a person, not typed as a key, so "/" and parentheses
 * are treated as "or": "Quillwork / Quill Industries" and
 * "Quill Industries (Quillwork)" are the same company written two ways, and
 * either spelling has to match either way round. Each alternative is matched as
 * a run of whole words, so "Vela" does not take out "Velabyte".
 *
 * The one rule worth more than the rest: an alternative of 2 characters or
 * fewer must equal the entire company name. A list entry like
 * "Q (formerly Quantex)" yields the alternative "q", and as a loose match "q"
 * takes out every Torque, Bosque and Marquee on the board. This is deliberately
 * asymmetric - it accepts a false negative to rule out a false positive -
 * because a missed exclusion is one row a human sees and deletes, while an
 * over-match is a board that quietly stops containing jobs and looks fine.
 *
 * Everything else is left alone on purpose, and each omission has the same
 * justification: the fix is to edit the list, not to make this cleverer.
 *   - No qualifier stripping. "Q (formerly Quantex)" yields "q" and the dead
 *     alternative "formerly quantex", which matches nothing. So a posting filed
 *     under the old name is not caught - add the old name to the list.
 *   - No article or suffix rewriting. "The Ridgeline Company" will not match
 *     "Ridgeline Company".
 *   - A catch-all entry ("any other company Dana Whitlock owns or leads") is an
 *     instruction to a language model, not a name, and matches nothing here.
 *     That is correct: judging who owns what is the part the model is for.
 *
 * The examples above are invented. The real list is one person's private "I
 * will not work here" and belongs in their settings row, not in a public repo.
 *
 * ---- Before changing any of this, replay it.
 * Checked against the whole live corpus - 432 leads, 899 screened rows, 95
 * distinct company names, against the real list: flags exactly the three known
 * rows and nothing else. An over-matching exclusion rule does not announce
 * itself; it just returns a smaller board.
 */

/** Below this length an alternative has to be the entire company name. */
const WHOLE_NAME_MAX = 2;

/** Lowercased, punctuation collapsed to single spaces, trimmed. */
function normalize(name) {
  return String(name == null ? "" : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Build the predicate for one exclusion list. Built once per request and called
 * per row: the list is JSON in settings, and re-parsing it for each of several
 * hundred candidates is work with one answer.
 *
 * Total by design, like canonicalUrl - a missing or malformed list yields a
 * predicate that excludes nothing rather than throwing. A run that cannot read
 * settings should file its findings and be corrected, not lose the batch.
 *
 * @param {string[]|null|undefined} excludedCompanies settings.excluded_companies
 * @returns {(companyName: string) => boolean}
 */
export function excludedCompanyMatcher(excludedCompanies) {
  const wholeName = new Set();
  const phrases = new Set();

  for (const entry of Array.isArray(excludedCompanies) ? excludedCompanies : []) {
    // "/" and parentheses both mean "also known as", so both just delimit.
    for (const piece of String(entry == null ? "" : entry).split(/[/()]/)) {
      const alt = normalize(piece);
      if (!alt) continue;
      // Padded, so the includes() below can only land on word boundaries.
      if (alt.length <= WHOLE_NAME_MAX) wholeName.add(alt);
      else phrases.add(` ${alt} `);
    }
  }

  return function isExcludedCompany(companyName) {
    const name = normalize(companyName);
    if (!name) return false;
    if (wholeName.has(name)) return true;
    const padded = ` ${name} `;
    for (const phrase of phrases) if (padded.includes(phrase)) return true;
    return false;
  };
}
