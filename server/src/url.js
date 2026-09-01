/**
 * What makes two URLs the same job posting.
 *
 * A posting has exactly one identity, but a run can arrive at it by several
 * URLs: a search snippet appends `?gh_src=...`, a board's JSON API hands back
 * the bare path while its HTML page carries a slug, an ATS echoes the req id
 * into a query param the canonical link doesn't have. Compared as raw strings
 * those are four different postings.
 *
 * Nothing caught that before this file existed. The model's step-7 comparison
 * is a string comparison, and so is `UNIQUE(user_id, search, url)` behind it -
 * they agree with each other and are wrong together. On 2026-09-01 one night's
 * run added 8 duplicate leads, every one of them a posting already tracked
 * under a URL differing only by a `?gh_jid=` suffix or a slug:
 *
 *   https://careers.roblox.com/jobs/7997105
 *   https://careers.roblox.com/jobs/7997105?gh_jid=7997105
 *
 * It matters more since delisting started deleting. `removeDelistedLead` takes
 * a dead posting off the board and writes its URL into `screened` so tomorrow's
 * run doesn't rediscover and re-add it - "step 7 skips that URL for good", as
 * the prompt puts it. That promise is only as good as URL identity: a screened
 * URL that doesn't match the variant the next run finds keeps none of it.
 *
 * ---- The rule, and why it isn't "strip the query string".
 * A req id is the identity, wherever it appears. So if the path or query holds
 * any run of 5+ digits, the key is the host plus those ids and nothing else -
 * which collapses the Roblox pair above, and the slug/no-slug Pinterest pairs,
 * without caring which half of the URL carried the number.
 *
 * Dropping the query wholesale would be wrong in the other direction:
 *
 *   https://www.mongodb.com/careers/job/?gh_jid=7555398
 *   https://www.mongodb.com/careers/job/?gh_jid=7993419
 *
 * Every MongoDB posting has that identical path. There the query *is* the
 * identity, and stripping it would merge an entire careers site into one row.
 * The digit rule reads both cases correctly because it never looks at which
 * component the id came from.
 *
 * Only when there is no id at all does this fall back to comparing the path and
 * the surviving query, which is the best available answer for a board that
 * addresses postings by slug alone.
 *
 * Checked against all 432 live leads before shipping: merges exactly the 8
 * known duplicate groups, every one confirmed same-company-same-title, and
 * nothing else. Re-run that check (see verify-local.mjs) if the rule changes -
 * a normalization that is too aggressive doesn't announce itself, it silently
 * eats real postings.
 */

// Params that are provenance, not identity: which search or campaign sent you
// to the posting. Anything not listed here is kept, because on some boards an
// unrecognized param is the id - see the MongoDB case above.
const TRACKING_PARAMS = new Set([
  "gh_src",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ref",
  "src",
  "source",
]);

// 5+ digits, not 4: a 4-digit run matches a year ("careers-2026"), and job
// boards don't number reqs that low. The ids these actually carry are 7-10.
const REQ_ID = /\d{5,}/g;

/**
 * The identity of the posting a URL points at. Two URLs for the same posting
 * return the same string; two postings never do.
 *
 * Total by design - a URL that doesn't parse returns its own lowercased text
 * rather than throwing. The callers are insert paths, and a malformed URL from
 * a run is a bad row to store, not a reason to lose the other 90 in the batch.
 *
 * @param {string} url
 * @returns {string} an opaque comparison key - meaningful only against another
 *   key from this same function, never parsed or displayed
 */
export function canonicalUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw.toLowerCase();
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  for (const p of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
  }

  // Deduped and sorted, so the same id in both the path and the query counts
  // once and the order it appeared in doesn't matter.
  const ids = [...new Set(`${u.pathname} ${u.searchParams.toString()}`.match(REQ_ID) || [])].sort();
  if (ids.length) return `${host}#${ids.join(",")}`;

  const path = u.pathname.replace(/\/+$/, "").toLowerCase();
  const query = [...u.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${host}${path}${query ? `?${query}` : ""}`;
}

/**
 * Keys for a list of URLs, as a Set - what an insert path compares against.
 * @param {Array<string|{url: string}>} rows urls, or rows carrying one
 * @returns {Set<string>}
 */
export function canonicalUrlSet(rows) {
  const set = new Set();
  for (const r of rows || []) {
    const key = canonicalUrl(typeof r === "string" ? r : r && r.url);
    if (key) set.add(key);
  }
  return set;
}
