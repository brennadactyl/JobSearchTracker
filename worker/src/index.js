/**
 * Job Search Tracker - Cloudflare Worker
 *
 * Serves the tracker webpage and a small JSON API, backed by a single KV key.
 * Replaces the Claude Artifact used previously - this has no dependency on
 * any particular AI tool; it's just HTTP + KV, so the headless search CLI can
 * update it with a plain `curl` call and the page can edit it with `fetch`.
 *
 * Routes:
 *   GET  /                unauthenticated shell; JS prompts for the token,
 *                         then calls the API routes below with it
 *   GET  /api/data        requires Bearer token -> { updated, leads[], applications[] }
 *   POST /api/leads       requires Bearer token -> body: { leads: [...] }
 *                         appends leads not already present for the same
 *                         (search, url) pair; never touches existing status/notes
 *   POST /api/update      requires Bearer token -> body: { type: "lead"|"application", ... }
 *                         updates one lead's status/notes, or upserts one
 *                         application record
 *
 * Data shape stored under KV key "data":
 *   {
 *     "updated": "2026-08-26",
 *     "leads": [
 *       { "id":"l001", "search":"SWE"|"TPM"|"CPM", "found":"2026-08-20",
 *         "company":"", "title":"", "location":"", "url":"",
 *         "verified":"2026-08-20", "fit":"", "status":"New", "notes":"" }
 *     ],
 *     "applications": [
 *       { "id":"a001", "leadId":"l001", "company":"", "title":"",
 *         "dateApplied":"2026-08-21", "status":"Applied", "notes":"" }
 *     ]
 *   }
 */

const DATA_KEY = "data";
const EMPTY_DATA = { updated: null, leads: [], applications: [] };

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
      const data = await loadData(env);
      return json(data);
    }

    if (url.pathname === "/api/leads" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleAddLeads(request, env);
    }

    if (url.pathname === "/api/update" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleUpdate(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

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

async function loadData(env) {
  const raw = await env.TRACKER_KV.get(DATA_KEY);
  if (!raw) return { ...EMPTY_DATA };
  try {
    return JSON.parse(raw);
  } catch {
    return { ...EMPTY_DATA };
  }
}

async function saveData(env, data) {
  data.updated = new Date().toISOString().slice(0, 10);
  await env.TRACKER_KV.put(DATA_KEY, JSON.stringify(data));
}

function nextId(items, prefix) {
  let max = 0;
  for (const it of items) {
    const m = /^[a-z]+(\d+)$/.exec(it.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

async function handleAddLeads(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const incoming = Array.isArray(body.leads) ? body.leads : [];
  if (incoming.length === 0) return json({ error: "no leads provided" }, 400);

  const data = await loadData(env);
  const existingKeys = new Set(data.leads.map((l) => `${l.search}::${l.url}`));

  const added = [];
  for (const lead of incoming) {
    if (!lead.search || !lead.url || !lead.company || !lead.title) continue;
    const key = `${lead.search}::${lead.url}`;
    if (existingKeys.has(key)) continue;
    const newLead = {
      id: nextId(data.leads, "l"),
      search: lead.search,
      found: lead.found || new Date().toISOString().slice(0, 10),
      company: lead.company,
      title: lead.title,
      location: lead.location || "",
      url: lead.url,
      verified: lead.verified || new Date().toISOString().slice(0, 10),
      fit: lead.fit || "",
      status: "New",
      notes: "",
    };
    data.leads.push(newLead);
    existingKeys.add(key);
    added.push(newLead);
  }

  if (added.length > 0) await saveData(env, data);
  return json({ added: added.length, leads: added });
}

async function handleUpdate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const data = await loadData(env);

  if (body.type === "lead") {
    const lead = data.leads.find((l) => l.id === body.id);
    if (!lead) return json({ error: "lead not found" }, 404);
    if (typeof body.status === "string") lead.status = body.status;
    if (typeof body.notes === "string") lead.notes = body.notes;
    await saveData(env, data);
    return json({ ok: true, lead });
  }

  if (body.type === "application") {
    if (body.id) {
      const app = data.applications.find((a) => a.id === body.id);
      if (!app) return json({ error: "application not found" }, 404);
      for (const field of ["company", "title", "dateApplied", "status", "notes", "leadId"]) {
        if (typeof body[field] === "string") app[field] = body[field];
      }
      await saveData(env, data);
      return json({ ok: true, application: app });
    } else {
      const app = {
        id: nextId(data.applications, "a"),
        leadId: body.leadId || "",
        company: body.company || "",
        title: body.title || "",
        dateApplied: body.dateApplied || new Date().toISOString().slice(0, 10),
        status: body.status || "Applied",
        notes: body.notes || "",
      };
      data.applications.push(app);
      await saveData(env, data);
      return json({ ok: true, application: app });
    }
  }

  return json({ error: "unknown update type" }, 400);
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
  .hidden { display: none; }
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
  <input id="tokenInput" type="password" placeholder="token">
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
  } catch {
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
