/**
 * Job Search Tracker - Cloudflare Worker
 *
 * Serves the tracker webpage and a small JSON API, backed by D1 (SQLite).
 * No dependency on any particular AI tool - just HTTP + D1, so the headless
 * search CLI can update it with a plain `curl` call and the page can edit
 * it with `fetch`.
 *
 * Routes:
 *   GET  /                   unauthenticated shell; JS prompts for the token,
 *                            then calls the API routes below with it
 *   GET  /api/data           requires Bearer token -> { updated, leads[], applications[] }
 *   POST /api/leads          requires Bearer token -> body: { leads: [...] }
 *                            appends leads not already present for the same
 *                            (search, url) pair (DB-enforced UNIQUE constraint
 *                            + INSERT OR IGNORE - atomic, race-free); never
 *                            touches existing status/notes
 *   POST /api/update         requires Bearer token -> body: { type: "lead"|"application", ... }
 *                            updates one lead's status/notes, or upserts one
 *                            application record
 *   GET  /api/migrate-from-kv  requires Bearer token - one-time: copies
 *                            whatever's in the old KV blob (key "data") into
 *                            D1, skipping anything already present. Safe to
 *                            call more than once. Delete this route (and the
 *                            KV binding in wrangler.toml) once you've
 *                            confirmed the migration worked.
 *
 * Schema: see ../schema.sql
 */

function authorized(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token && env.API_TOKEN && token === env.API_TOKEN;
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function touchUpdated(env) {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('updated', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(today()).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(PAGE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/data" && request.method === "GET") {
      if (!authorized(request, env)) return unauthorized();
      const [leads, applications, meta] = await Promise.all([
        env.DB.prepare("SELECT * FROM leads ORDER BY id").all(),
        env.DB.prepare("SELECT * FROM applications ORDER BY id").all(),
        env.DB.prepare("SELECT value FROM meta WHERE key = 'updated'").first(),
      ]);
      return json({
        updated: meta ? meta.value : null,
        leads: leads.results,
        applications: applications.results,
      });
    }

    if (url.pathname === "/api/leads" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleAddLeads(request, env);
    }

    if (url.pathname === "/api/update" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleUpdate(request, env);
    }

    if (url.pathname === "/api/migrate-from-kv" && request.method === "GET") {
      if (!authorized(request, env)) return unauthorized();
      return handleMigrateFromKv(env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleAddLeads(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const incoming = Array.isArray(body.leads) ? body.leads : [];
  if (incoming.length === 0) return json({ error: "no leads provided" }, 400);

  const t = today();
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO leads (search, found, company, title, location, url, verified, fit, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New', '')`
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
        lead.fit || ""
      )
    );
  }
  if (batch.length === 0) return json({ error: "no valid leads in payload" }, 400);

  const results = await env.DB.batch(batch);
  const added = results.reduce((n, r) => n + (r.meta.changes || 0), 0);
  if (added > 0) await touchUpdated(env);

  return json({ added });
}

async function handleUpdate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (body.type === "lead") {
    const result = await env.DB.prepare(
      `UPDATE leads SET
         status = COALESCE(?, status),
         notes = COALESCE(?, notes)
       WHERE id = ?`
    )
      .bind(
        typeof body.status === "string" ? body.status : null,
        typeof body.notes === "string" ? body.notes : null,
        body.id
      )
      .run();
    if (result.meta.changes === 0) return json({ error: "lead not found" }, 404);
    await touchUpdated(env);
    const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(body.id).first();
    return json({ ok: true, lead });
  }

  if (body.type === "application") {
    if (body.id) {
      const result = await env.DB.prepare(
        `UPDATE applications SET
           company = COALESCE(?, company),
           title = COALESCE(?, title),
           dateApplied = COALESCE(?, dateApplied),
           status = COALESCE(?, status),
           notes = COALESCE(?, notes),
           leadId = COALESCE(?, leadId)
         WHERE id = ?`
      )
        .bind(
          body.company ?? null,
          body.title ?? null,
          body.dateApplied ?? null,
          body.status ?? null,
          body.notes ?? null,
          body.leadId ?? null,
          body.id
        )
        .run();
      if (result.meta.changes === 0) return json({ error: "application not found" }, 404);
      await touchUpdated(env);
      const app = await env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(body.id).first();
      return json({ ok: true, application: app });
    } else {
      const result = await env.DB.prepare(
        `INSERT INTO applications (leadId, company, title, dateApplied, status, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.leadId || "",
          body.company || "",
          body.title || "",
          body.dateApplied || today(),
          body.status || "Applied",
          body.notes || ""
        )
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

async function handleMigrateFromKv(env) {
  if (!env.TRACKER_KV) return json({ error: "no KV binding present - already cleaned up?" }, 400);
  const raw = await env.TRACKER_KV.get("data");
  if (!raw) return json({ migrated: { leads: 0, applications: 0 }, note: "no KV data found" });

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: "KV data isn't valid JSON" }, 500);
  }

  let leadsAdded = 0;
  if (Array.isArray(data.leads) && data.leads.length > 0) {
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO leads (search, found, company, title, location, url, verified, fit, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const batch = data.leads.map((l) =>
      stmt.bind(
        l.search || "",
        l.found || today(),
        l.company || "",
        l.title || "",
        l.location || "",
        l.url || "",
        l.verified || today(),
        l.fit || "",
        l.status || "New",
        l.notes || ""
      )
    );
    const results = await env.DB.batch(batch);
    leadsAdded = results.reduce((n, r) => n + (r.meta.changes || 0), 0);
  }

  let appsAdded = 0;
  if (Array.isArray(data.applications) && data.applications.length > 0) {
    const stmt = env.DB.prepare(
      `INSERT INTO applications (leadId, company, title, dateApplied, status, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const batch = data.applications.map((a) =>
      stmt.bind(
        a.leadId || "",
        a.company || "",
        a.title || "",
        a.dateApplied || today(),
        a.status || "Applied",
        a.notes || ""
      )
    );
    const results = await env.DB.batch(batch);
    appsAdded = results.reduce((n, r) => n + (r.meta.changes || 0), 0);
  }

  if (leadsAdded > 0 || appsAdded > 0) await touchUpdated(env);

  return json({
    migrated: { leads: leadsAdded, applications: appsAdded },
    sourceHad: { leads: (data.leads || []).length, applications: (data.applications || []).length },
  });
}

const PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Search Tracker</title>
<style>
  :root {
    --bg: #0f1420; --panel: #171d2b; --border: #2a3242; --text: #e6e9ef;
    --muted: #8b93a7; --accent: #4fd1c5; --accent-soft: rgba(79,209,197,0.15);
    --warn: #f0b429; --danger: #f26d6d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, Segoe UI, Roboto, sans-serif; font-size: 14px;
  }
  header { padding: 20px 24px; border-bottom: 1px solid var(--border); }
  h1 { margin: 0 0 4px; font-size: 20px; }
  #updated { color: var(--muted); font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 0 24px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  nav button {
    background: none; border: none; color: var(--muted); padding: 10px 14px;
    cursor: pointer; font-size: 14px; border-bottom: 2px solid transparent;
  }
  nav button.active { color: var(--accent); border-bottom-color: var(--accent); }
  main { padding: 20px 24px; max-width: 1100px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
  tr.top { box-shadow: inset 3px 0 0 var(--accent); }
  tr.mid { box-shadow: inset 3px 0 0 var(--warn); }
  a { color: var(--accent); }
  select, textarea, input {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 6px; font-size: 13px; width: 100%;
  }
  textarea { min-height: 32px; resize: vertical; }
  .pill {
    display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px;
    background: var(--accent-soft); color: var(--accent);
  }
  #gate {
    position: fixed; inset: 0; background: var(--bg); display: flex;
    align-items: center; justify-content: center; flex-direction: column; gap: 12px;
  }
  #gate input { width: 280px; }
  #gate button { background: var(--accent); color: #05201d; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
  .hidden { display: none !important; }
  .muted { color: var(--muted); }
  .row-actions { white-space: nowrap; }
  .row-actions button {
    background: var(--panel); border: 1px solid var(--border); color: var(--text);
    border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 12px; margin-right: 4px;
  }
</style>
</head>
<body>

<div id="gate">
  <div>Enter access token</div>
  <input id="tokenInput" type="password" placeholder="token" onkeydown="if(event.key==='Enter')submitToken()">
  <button onclick="submitToken()">Enter</button>
  <div id="gateError" class="muted"></div>
</div>

<div id="app" class="hidden">
  <header>
    <h1>Job Search Tracker</h1>
    <div id="updated"></div>
  </header>
  <nav id="tabs"></nav>
  <main id="content"></main>
</div>

<script>
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "applications", label: "Applications" },
  { key: "SWE", label: "Engineering" },
  { key: "TPM", label: "Technical PM" },
  { key: "CPM", label: "Product" },
];
let TOKEN = localStorage.getItem("tracker_token") || "";
let DATA = null;
let activeTab = "overview";

function submitToken() {
  TOKEN = document.getElementById("tokenInput").value.trim();
  if (!TOKEN) return;
  localStorage.setItem("tracker_token", TOKEN);
  boot();
}

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json", ...(opts && opts.headers) },
  });
  if (res.status === 401) {
    localStorage.removeItem("tracker_token");
    document.getElementById("gate").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
    document.getElementById("gateError").textContent = "Invalid token.";
    throw new Error("unauthorized");
  }
  return res.json();
}

async function boot() {
  try {
    DATA = await api("/api/data");
  } catch (err) {
    const el = document.getElementById("gateError");
    if (el && err.message !== "unauthorized") el.textContent = "Couldn't load: " + err.message;
    return;
  }
  document.getElementById("gate").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  renderTabs();
  render();
}

function renderTabs() {
  const nav = document.getElementById("tabs");
  nav.innerHTML = "";
  for (const t of TABS) {
    const btn = document.createElement("button");
    btn.textContent = t.label;
    btn.className = t.key === activeTab ? "active" : "";
    btn.onclick = () => { activeTab = t.key; renderTabs(); render(); };
    nav.appendChild(btn);
  }
}

function priorityClass(location) {
  const loc = (location || "").toLowerCase();
  const top = ["seattle","bellevue","redmond","kirkland","mercer island","bothell","renton","everett","tacoma","sammamish","issaquah","remote (u.s.","usa — remote","usa - remote"];
  const mid = ["portland","beaverton","hillsboro","vancouver wa","oregon"];
  if (top.some((k) => loc.includes(k))) return "top";
  if (mid.some((k) => loc.includes(k))) return "mid";
  return "";
}

function render() {
  document.getElementById("updated").textContent = DATA.updated ? "Last updated " + DATA.updated : "";
  const content = document.getElementById("content");
  content.innerHTML = "";

  if (activeTab === "overview") {
    const counts = { SWE: 0, TPM: 0, CPM: 0 };
    for (const l of DATA.leads) counts[l.search] = (counts[l.search] || 0) + 1;
    content.innerHTML = \`
      <p><span class="pill">\${DATA.leads.length} total leads</span>
      <span class="pill">\${DATA.applications.length} applications</span></p>
      <ul>
        <li>Engineering (SWE): \${counts.SWE || 0}</li>
        <li>Technical PM (TPM): \${counts.TPM || 0}</li>
        <li>Product (CPM): \${counts.CPM || 0}</li>
      </ul>\`;
    return;
  }

  if (activeTab === "applications") {
    renderApplications(content);
    return;
  }

  renderLeads(content, activeTab);
}

function renderLeads(content, searchKey) {
  const rows = DATA.leads
    .filter((l) => l.search === searchKey)
    .sort((a, b) => {
      const rank = { top: 0, mid: 1, "": 2 };
      return rank[priorityClass(a.location)] - rank[priorityClass(b.location)];
    });

  const table = document.createElement("table");
  table.innerHTML = \`<thead><tr>
    <th>Company</th><th>Title</th><th>Location</th><th>Found</th>
    <th>Status</th><th>Notes</th><th>Fit</th><th></th>
  </tr></thead>\`;
  const tbody = document.createElement("tbody");

  for (const lead of rows) {
    const tr = document.createElement("tr");
    tr.className = priorityClass(lead.location);
    tr.innerHTML = \`
      <td>\${escapeHtml(lead.company)}</td>
      <td><a href="\${escapeHtml(lead.url)}" target="_blank" rel="noopener">\${escapeHtml(lead.title)}</a></td>
      <td>\${escapeHtml(lead.location)}</td>
      <td>\${escapeHtml(lead.found)}</td>
      <td></td>
      <td></td>
      <td class="muted">\${escapeHtml(lead.fit || "")}</td>
      <td class="row-actions"><button data-act="apply">Mark applied</button></td>
    \`;

    const statusSelect = document.createElement("select");
    ["New","Reviewed","Applied","Interviewing","Offer","Rejected","Withdrawn","Not a fit"].forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      if (s === lead.status) opt.selected = true;
      statusSelect.appendChild(opt);
    });
    statusSelect.onchange = () => updateLead(lead.id, { status: statusSelect.value });
    tr.children[4].appendChild(statusSelect);

    const notesBox = document.createElement("textarea");
    notesBox.value = lead.notes || "";
    notesBox.onblur = () => updateLead(lead.id, { notes: notesBox.value });
    tr.children[5].appendChild(notesBox);

    tr.querySelector('[data-act="apply"]').onclick = () => addApplication(lead);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  content.appendChild(table);
}

function renderApplications(content) {
  const table = document.createElement("table");
  table.innerHTML = \`<thead><tr>
    <th>Company</th><th>Title</th><th>Applied</th><th>Status</th><th>Notes</th>
  </tr></thead>\`;
  const tbody = document.createElement("tbody");
  for (const app of DATA.applications) {
    const tr = document.createElement("tr");
    tr.innerHTML = \`
      <td>\${escapeHtml(app.company)}</td>
      <td>\${escapeHtml(app.title)}</td>
      <td>\${escapeHtml(app.dateApplied)}</td>
      <td></td>
      <td></td>
    \`;
    const statusSelect = document.createElement("select");
    ["Applied","Interviewing","Offer","Rejected","Withdrawn"].forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      if (s === app.status) opt.selected = true;
      statusSelect.appendChild(opt);
    });
    statusSelect.onchange = () => updateApplication(app.id, { status: statusSelect.value });
    tr.children[3].appendChild(statusSelect);

    const notesBox = document.createElement("textarea");
    notesBox.value = app.notes || "";
    notesBox.onblur = () => updateApplication(app.id, { notes: notesBox.value });
    tr.children[4].appendChild(notesBox);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  content.appendChild(table);
}

async function updateLead(id, patch) {
  const res = await api("/api/update", { method: "POST", body: JSON.stringify({ type: "lead", id, ...patch }) });
  const lead = DATA.leads.find((l) => l.id === id);
  if (lead && res.lead) Object.assign(lead, res.lead);
}

async function addApplication(lead) {
  const res = await api("/api/update", {
    method: "POST",
    body: JSON.stringify({ type: "application", leadId: lead.id, company: lead.company, title: lead.title }),
  });
  DATA.applications.push(res.application);
  await updateLead(lead.id, { status: "Applied" });
  render();
}

async function updateApplication(id, patch) {
  const res = await api("/api/update", { method: "POST", body: JSON.stringify({ type: "application", id, ...patch }) });
  const app = DATA.applications.find((a) => a.id === id);
  if (app && res.application) Object.assign(app, res.application);
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

if (TOKEN) boot(); else document.getElementById("gate").classList.remove("hidden");
</script>
</body>
</html>`;
