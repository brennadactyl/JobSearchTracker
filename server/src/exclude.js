/**
 * Whether a company is one this person has said they will not work for.
 *
 * `settings.excluded_companies` is a list, and prompt.js renders it into one
 * sentence of the nightly prompt: "Never search X, Y and Z - permanently
 * excluded from this search, including via broader discovery: drop any hit
 * there without verifying it and without a `/api/screened` row." That sentence
 * is the entire enforcement. A list rendered into prose is a request, and a
 * request leaks in both directions - which it demonstrably has, on the live
 * board, in both directions at once:
 *
 *   lead 238        xAI                             filed as a normal lead
 *   screened 210    Beast Industries (MrBeast)      screened row written
 *   screened 211    Beast Industries (MrBeast)      screened row written
 *
 * The first is the obvious failure: an excluded company sitting on the board
 * as something to go apply to. The second is the quieter one - the prompt says
 * to drop these *without* a screened row, precisely so an exclusion never
 * consumes a slot in the delisting corpus, and two rows exist anyway. One
 * night's run read the same sentence and got it wrong twice in opposite
 * directions, which is what a prose rule does. So the rule moves here, where a
 * caller can ask a function instead of hoping.
 *
 * ---- Why this file is pure.
 * Same tier as url.js: no D1, no env, no import from db.js. It answers one
 * question about two strings. The insert paths in api.js and the composer in
 * prompt.js both need the answer, and neither should have to be holding a
 * database handle to get it. It also means the matching rule can be replayed
 * offline against the whole live corpus, which is the only way anyone can tell
 * whether a change to it over-matches - see the corpus-replay note below.
 *
 * ---- The matching rules, and what each one is defending against.
 * An entry is written by a person, so it is not a key. "MrBeast / Beast
 * Industries" is two names for one company. "X (formerly Twitter)" is a
 * renaming carried along so the entry stays readable. Both have to match a
 * board where the same company arrives as "Beast Industries (MrBeast)" or as
 * "xAI". So an entry is split on "/" and its parentheticals are lifted out as
 * aliases of their own, and matching is done on the aliases, not the entry.
 *
 * Aliases match on token boundaries, never as bare substrings. "Tesla" must not
 * take out a company called "Teslabyte", and "Beast Industries" must still
 * match inside "Beast Industries (MrBeast)". Comparing padded, single-spaced
 * token strings gets both without a regex per alias per row.
 *
 * ---- The one rule that matters more than the rest: short aliases.
 * "X (formerly Twitter)" yields the alias "x". As a token match, "x" is
 * harmless in theory and catastrophic in practice the moment a company name
 * has "x" as a standalone word, and as anything looser it is an extinction
 * event - a bare substring "x" flags Netflix, Roblox, Perplexity, Microsoft
 * (Xbox) and TelevisaUnivision (ViX), five of the ninety-five distinct
 * companies on the live board, none of which Elon Musk has ever owned.
 *
 * So an alias of 2 characters or fewer must equal the whole company name. That
 * is deliberately asymmetric: it accepts a false negative (a company filed as
 * "X Corp" would not be caught) to rule out a class of false positive that
 * would silently delete real, wanted postings. A missed exclusion is one row a
 * human sees and removes; an over-match is a board that quietly stops
 * containing jobs, and nothing about it looks broken.
 *
 * ---- Catch-alls stay inert, on purpose.
 * The live list ends with "any other company Elon Musk owns or leads". That is
 * an instruction to a language model, not a name, and no real company name
 * contains those eight words in sequence, so it never matches here. That is the
 * correct outcome and not a gap to fix: judging who owns what is exactly the
 * part the model is for, and any heuristic that tried to "understand" such an
 * entry here would be guessing at ownership from a string. This file handles
 * the named companies deterministically; the prompt keeps handling the rest.
 *
 * An entry's words are also matched as written - no article or suffix
 * rewriting. "The Boring Company" will not match a posting filed as "Boring
 * Company". Stripping a leading "the" would fix that one case and start the
 * file down the road of flagging companies the person never actually listed,
 * which is the failure that is expensive here.
 *
 * ---- Before changing any of this, replay it.
 * Checked against the whole live corpus - 432 leads and 899 screened rows, 95
 * distinct company names - against the live 8-entry exclusion list: flags lead
 * 238, screened 210 and screened 211, and nothing else. Re-run that replay if
 * the rules change. An over-matching exclusion rule does not announce itself;
 * it just returns a smaller board.
 */

/**
 * A built predicate. Build it once per request from the settings list, then
 * call it per row - the parsing and normalizing of the list happens once.
 * @typedef {(companyName: string) => boolean} ExcludedCompanyPredicate
 */

/**
 * Words that introduce a parenthetical alias rather than being part of it.
 * "X (formerly Twitter)" means the alias is "twitter", not "formerly twitter".
 * Kept to the handful that actually appear in this position - anything else in
 * parentheses is treated as a name, because a parenthetical that isn't a
 * qualifier usually is one ("Beast Industries (MrBeast)").
 */
const ALIAS_QUALIFIERS = new Set(["formerly", "formally", "previously", "prev", "fka", "aka", "now", "nee"]);

/** Below this length an alias has to be the entire company name. See the header. */
const WHOLE_NAME_ALIAS_MAX = 2;

/**
 * A company name reduced to lowercase words separated by single spaces.
 *
 * Punctuation becomes a space rather than being deleted, so "X (formerly
 * Twitter)" and "Beast Industries (MrBeast)" break into words instead of
 * fusing into "xformerlytwitter". Deleting it instead would also weld "Small
 * Axe Studios" style names together and hand the token rules nothing to work
 * with.
 *
 * @param {string} name
 * @returns {string} lowercased, punctuation-free, single-spaced, trimmed
 */
export function normalizeCompanyName(name) {
  return String(name == null ? "" : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The names one exclusion-list entry actually stands for.
 *
 * "MrBeast / Beast Industries" is two companies' worth of naming for one
 * company, and "X (formerly Twitter)" carries a rename inline. Both are how a
 * person writes a list they expect to re-read later, and both have to survive
 * into matching, so an entry is one input and several aliases out.
 *
 * Parentheticals are lifted before the "/" split, so a slash inside a
 * parenthetical stays with its alias instead of cutting it in half.
 *
 * @param {string} entry one item of settings.excluded_companies
 * @returns {string[]} normalized aliases, deduped, never containing a blank
 */
export function companyAliases(entry) {
  const raw = String(entry == null ? "" : entry);
  const parts = [];

  // Everything in parens is an alias candidate; what's left is the main name.
  const outer = raw.replace(/\(([^)]*)\)/g, (_, inner) => {
    parts.push(inner);
    return " ";
  });
  parts.push(outer);

  const aliases = new Set();
  for (const part of parts) {
    for (const piece of part.split("/")) {
      let alias = normalizeCompanyName(piece);
      // Drop a leading qualifier, but only if something is left after it -
      // "(formerly)" alone is a note to the reader, not a company.
      const [first, ...rest] = alias.split(" ");
      if (rest.length && ALIAS_QUALIFIERS.has(first)) alias = rest.join(" ");
      if (alias) aliases.add(alias);
    }
  }
  return [...aliases];
}

/**
 * Build the predicate for one exclusion list.
 *
 * Built once and reused across a batch of rows on purpose: the list lives in
 * settings as JSON, and re-splitting and re-normalizing eight entries for each
 * of several hundred candidate postings is work that has one answer.
 *
 * Total by design, like canonicalUrl - a missing or malformed list yields a
 * predicate that excludes nothing rather than throwing. A run that can't read
 * settings should file its findings and be corrected, not lose the batch.
 *
 * @param {string[]|null|undefined} excludedCompanies settings.excluded_companies
 * @returns {ExcludedCompanyPredicate}
 */
export function excludedCompanyMatcher(excludedCompanies) {
  const wholeName = new Set();
  const phrases = new Set();

  for (const entry of Array.isArray(excludedCompanies) ? excludedCompanies : []) {
    for (const alias of companyAliases(entry)) {
      if (alias.length <= WHOLE_NAME_ALIAS_MAX) wholeName.add(alias);
      // Padded so the includes() test below can only land on token boundaries.
      else phrases.add(` ${alias} `);
    }
  }

  return function isExcludedCompany(companyName) {
    const name = normalizeCompanyName(companyName);
    if (!name) return false;
    if (wholeName.has(name)) return true;
    const padded = ` ${name} `;
    for (const phrase of phrases) {
      if (padded.includes(phrase)) return true;
    }
    return false;
  };
}
