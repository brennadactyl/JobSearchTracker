/**
 * Refuses a deploy that would take `local-config.js` off the live site.
 *
 * `[assets]` publishes exactly what's in `public/` - so a deploy is a
 * *replacement*, not a merge. Anything on the live site that isn't on disk
 * here comes down. `local-config.js` is gitignored (see README.md, "How it
 * finds its API"), which makes it the one required file a checkout can be
 * missing while looking completely healthy: git status is clean, the page
 * renders locally off whatever config that checkout has, and the deploy
 * reports success while the live gate degrades to "This deployment has no
 * API URL configured" for everyone.
 *
 * A git worktree is the case that actually bites, because worktrees never
 * carry gitignored files - a fresh one is missing this the moment it's
 * created. That's the "never deploy from a worktree" rule in README.md, and
 * this is that rule enforced rather than written down: it went unnoticed
 * once and cost a few hours of an unusable sign-in page.
 *
 * Runs automatically before `npm run deploy` (npm's `pre` hook). It does not
 * run for a bare `wrangler deploy`, which is why README.md now points at the
 * npm script instead.
 */
import { existsSync } from "node:fs";

if (!existsSync(new URL("public/local-config.js", import.meta.url))) {
  console.error(
    "\n  public/local-config.js is missing - refusing to deploy.\n\n" +
      "  It's gitignored, so this checkout never had it (a git worktree or a\n" +
      "  fresh clone). Deploying now would not just skip it - it would DELETE\n" +
      "  it from the live site, and the sign-in page would show \"This\n" +
      "  deployment has no API URL configured\" to everyone.\n\n" +
      "  Deploy from a checkout on main that has the file, or copy it in:\n" +
      "    copy public\\local-config.example.js public\\local-config.js\n" +
      "  then set LOCAL_API_BASE to your server Worker's URL.\n"
  );
  process.exit(1);
}
