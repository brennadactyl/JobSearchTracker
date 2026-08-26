/**
 * D1-backed API handlers for the Job Search Tracker worker.
 * See ../migrations/ for schema, and index.js for routing.
 */

export function authorized(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token && env.API_TOKEN && token === env.API_TOKEN;
}

export function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function touchUpdated(env) {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('updated', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(today()).run();
}

// Extra freeform fields shared by leads and applications - same columns on
// both tables (see migrations/), so a referral/comp/next-action can be jotted
// down on a posting before it's ever "applied to", and it's still there
// after it becomes an application.
export const EXTRA_FIELDS = [
  "team", "setup", "source", "link", "lastContact",
  "nextAction", "nextActionDate", "resume", "referral", "comp",
];

export async function handleAddLeads(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const incoming = Array.isArray(body.leads) ? body.leads : [];
  if (incoming.length === 0) return json({ error: "no leads provided" }, 400);

  const t = today();
  // team/setup/comp are the fields a job posting can actually state (org,
  // remote/hybrid/onsite, a posted salary range); the rest of EXTRA_FIELDS
  // (referral, resume, lastContact, nextAction*, link) are personal/workflow
  // facts the search has no way to know, so they're accepted here (in case a
  // future caller has them) but the scheduled searches never send them -
  // they default to '' and stay for the user to fill in from Details.
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO leads
       (search, found, company, title, location, url, verified, fit, status, notes, ${EXTRA_FIELDS.join(", ")})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New', '', ${EXTRA_FIELDS.map(() => "?").join(", ")})`
  );

  const batch = [];
  for (const lead of incoming) {
    if (!lead.search || !lead.url || !lead.company || !lead.title) continue;
    batch.push(
      stmt.bind(
        lead.search,
        lead.found || t,
        lead.company,
        lead.title,
        lead.location || "",
        lead.url,
        lead.verified || t,
        lead.fit || "",
        ...EXTRA_FIELDS.map((f) => lead[f] || "")
      )
    );
  }
  if (batch.length === 0) return json({ error: "no valid leads in payload" }, 400);

  const results = await env.DB.batch(batch);
  const added = results.reduce((n, r) => n + (r.meta.changes || 0), 0);
  if (added > 0) await touchUpdated(env);

  return json({ added });
}

export async function handleUpdate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (body.type === "lead") {
    const fields = ["status", "notes", ...EXTRA_FIELDS];
    const setClause = fields.map((f) => `${f} = COALESCE(?, ${f})`).join(", ");
    const values = fields.map((f) => (typeof body[f] === "string" ? body[f] : null));
    const result = await env.DB.prepare(`UPDATE leads SET ${setClause} WHERE id = ?`)
      .bind(...values, body.id)
      .run();
    if (result.meta.changes === 0) return json({ error: "lead not found" }, 404);
    await touchUpdated(env);
    const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(body.id).first();
    return json({ ok: true, lead });
  }

  if (body.type === "application") {
    const fields = ["company", "title", "dateApplied", "status", "notes", "leadId", ...EXTRA_FIELDS];
    if (body.id) {
      const setClause = fields.map((f) => `${f} = COALESCE(?, ${f})`).join(", ");
      const values = fields.map((f) => (typeof body[f] === "string" ? body[f] : null));
      const result = await env.DB.prepare(`UPDATE applications SET ${setClause} WHERE id = ?`)
        .bind(...values, body.id)
        .run();
      if (result.meta.changes === 0) return json({ error: "application not found" }, 404);
      await touchUpdated(env);
      const app = await env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(body.id).first();
      return json({ ok: true, application: app });
    } else {
      const placeholders = fields.map(() => "?").join(", ");
      const values = fields.map((f) => {
        if (f === "dateApplied") return body.dateApplied || today();
        if (f === "status") return body.status || "Applied";
        return body[f] || "";
      });
      const result = await env.DB.prepare(
        `INSERT INTO applications (${fields.join(", ")}) VALUES (${placeholders})`
      )
        .bind(...values)
        .run();
      await touchUpdated(env);
      const app = await env.DB
        .prepare("SELECT * FROM applications WHERE id = ?")
        .bind(result.meta.last_row_id)
        .first();
      return json({ ok: true, application: app });
    }
  }

  return json({ error: "unknown update type" }, 400);
}

export async function handleDeleteApplication(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.id) return json({ error: "missing id" }, 400);
  const result = await env.DB.prepare("DELETE FROM applications WHERE id = ?").bind(body.id).run();
  if (result.meta.changes === 0) return json({ error: "application not found" }, 404);
  await touchUpdated(env);
  return json({ ok: true });
}
