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
 *   POST /api/delete-application  requires Bearer token -> body: { id } ->
 *                            removes one application row (used by the
 *                            page's "remove" control; leads are never
 *                            deleted, only re-statused)
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

    if (url.pathname === "/api/delete-application" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleDeleteApplication(request, env);
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

async function handleDeleteApplication(request, env) {
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

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brenna's Job Search</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{
  --ground:#F4F5F9; --surface:#FFFFFF; --surface2:#ECEEF6; --line:#DCDFEB;
  --ink:#14172A; --ink2:#555B77; --ink3:#868CA6;
  --accent:#A96C15; --accent-soft:#F6EBD8;
  --eng:#1B6B64; --eng-soft:#DEEFEC;
  --tpm:#4548BC; --tpm-soft:#E4E5FA;
  --prod:#A03A5C; --prod-soft:#F8E3EA;
  --good:#226642; --warn:#96600F; --crit:#A93A31;
  --pri-high:#0F7B6C; --pri-high-soft:#D8EEEA;
  --pri-med:#5E8A83; --pri-med-soft:#E8F0EE;
  --shadow:0 1px 2px rgba(20,23,42,.06),0 8px 24px -12px rgba(20,23,42,.18);
}
@media (prefers-color-scheme:dark){:root{
  --ground:#0E1018; --surface:#161925; --surface2:#1E2230; --line:#2A2F41;
  --ink:#E9EBF4; --ink2:#A3AAC3; --ink3:#717892;
  --accent:#E0A544; --accent-soft:#33280F;
  --eng:#4FC1B2; --eng-soft:#13322F;
  --tpm:#9093F2; --tpm-soft:#1E2050;
  --prod:#E48AAA; --prod-soft:#3D1A28;
  --good:#4FBE85; --warn:#DFA63C; --crit:#E8756A;
  --pri-high:#4FD1B8; --pri-high-soft:#10322D;
  --pri-med:#7FA9A2; --pri-med-soft:#1A2A27;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -12px rgba(0,0,0,.6);
}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font-family:"IBM Plex Sans",system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;
  -webkit-text-size-adjust:100%}
.wrap{max-width:1360px;margin:0 auto;padding:0 20px 72px}
h1,h2,h3{font-family:"Bricolage Grotesque","IBM Plex Sans",sans-serif;margin:0;letter-spacing:-.02em}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}

.hdr{display:flex;flex-wrap:wrap;gap:14px;align-items:baseline;justify-content:space-between;padding:30px 0 18px}
.hdr h1{font-size:clamp(24px,3.6vw,33px);font-weight:700}
.hdr .sub{color:var(--ink2);font-size:14px;margin-top:5px}
.stamp{font-size:12px;color:var(--ink3);display:flex;align-items:center;gap:9px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--good);flex:none}
.dot.off{background:var(--ink3)}
.dot.bad{background:var(--crit)}

.tabs{display:flex;gap:3px;overflow-x:auto;scrollbar-width:none;
  border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20;
  background:var(--ground);padding-top:2px}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:none;appearance:none;border:0;background:none;cursor:pointer;color:var(--ink2);
  font:inherit;font-weight:500;padding:11px 14px;border-bottom:2px solid transparent;
  white-space:nowrap;display:flex;align-items:center;gap:7px}
.tab:hover{color:var(--ink)}
.tab[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--accent)}
.tab .n{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink3);
  background:var(--surface2);padding:1px 6px;border-radius:9px}
.tab[aria-selected="true"] .n{color:var(--accent);background:var(--accent-soft)}
.tab:focus-visible,.btn:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px}

.toolbar{display:flex;flex-wrap:wrap;gap:9px;align-items:center;padding:16px 0 12px}
.search{flex:1;min-width:180px;max-width:320px}
input[type=search],input[type=text],input[type=date],input[type=password],select,textarea{
  font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);
  border-radius:7px;padding:7px 10px;width:100%}
textarea{resize:vertical;min-height:34px}
.btn{appearance:none;font:inherit;font-weight:500;cursor:pointer;border-radius:7px;
  border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:7px 13px}
.btn:hover{border-color:var(--ink3)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
@media (prefers-color-scheme:dark){.btn.primary{color:#241B08}}
.btn.primary:hover{filter:brightness(1.07)}
.btn.ghost{border-color:transparent;background:none;color:var(--ink2);padding:6px 9px}
.btn.ghost:hover{background:var(--surface2);color:var(--ink)}

.chips{display:flex;gap:5px;flex-wrap:wrap}
.chip{appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:99px;
  border:1px solid var(--line);background:var(--surface);color:var(--ink2);padding:4px 11px}
.chip[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--ground)}

.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}
.scroller{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-weight:600;font-size:11px;letter-spacing:.07em;text-transform:uppercase;
  color:var(--ink3);padding:11px 12px;border-bottom:1px solid var(--line);white-space:nowrap;
  background:var(--surface)}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--surface2)}
.co{font-weight:600;white-space:nowrap}
.ttl{display:block;max-width:360px}
.ttl a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line)}
.ttl a:hover{border-bottom-color:var(--accent);color:var(--accent)}
.loc{color:var(--ink2);font-size:13px;max-width:190px}
.dt{color:var(--ink3);font-size:12.5px;white-space:nowrap}
.fit{color:var(--ink2);font-size:12.5px;max-width:260px;display:block}
td select{padding:5px 7px;font-size:13px;min-width:118px}
td textarea{font-size:13px;min-height:32px;min-width:150px}

td:first-child{border-left:3px solid transparent}
tr.p-high td:first-child{border-left-color:var(--pri-high)}
tr.p-med td:first-child{border-left-color:var(--pri-med)}
.lc{border-left:3px solid transparent}
.lc.p-high{border-left-color:var(--pri-high)}
.lc.p-med{border-left-color:var(--pri-med)}
.geo{display:inline-block;margin-top:4px;font-size:11px;font-weight:600;letter-spacing:.03em;
  padding:2px 8px;border-radius:99px;white-space:nowrap}
.geo.p-high{background:var(--pri-high-soft);color:var(--pri-high)}
.geo.p-med{background:var(--pri-med-soft);color:var(--pri-med)}
.key{display:flex;gap:15px;flex-wrap:wrap;align-items:center;font-size:12.5px;
  color:var(--ink3);padding:0 0 11px}
.key i{display:inline-block;width:3px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-2px}

.pill{display:inline-block;font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:99px;
  border:1px solid transparent;white-space:nowrap}
.pill.new{background:var(--accent-soft);color:var(--accent)}
.pill.live{background:var(--surface2);color:var(--ink2)}
.pill.go{background:var(--surface2);color:var(--good);border-color:var(--good)}
.pill.no{background:none;color:var(--ink3);border-color:var(--line)}
.pill.hot{background:var(--surface2);color:var(--warn);border-color:var(--warn)}
.pill.bad{background:none;color:var(--crit);border-color:var(--crit)}

.tiles{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));margin-bottom:20px}
.tile{padding:16px 17px;border-radius:12px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow)}
.tile .k{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink3);font-weight:600}
.tile .v{font-family:"Bricolage Grotesque",sans-serif;font-size:31px;font-weight:700;line-height:1.15;margin-top:7px;letter-spacing:-.03em}
.tile .f{font-size:12.5px;color:var(--ink2);margin-top:3px}
.tile.hi .v{color:var(--accent)}

.bars{display:flex;flex-direction:column;gap:13px}
.bar h3{font-size:14px;font-weight:600;display:flex;justify-content:space-between;
  align-items:baseline;gap:6px 14px;flex-wrap:wrap;margin-bottom:7px}
.bar h3 span{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--ink3);font-weight:400}
.meter{height:8px;border-radius:99px;background:var(--surface2);overflow:hidden;display:flex}
.meter i{display:block;height:100%}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:9px;font-size:12.5px;color:var(--ink2)}
.legend b{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px}

.sec{margin:26px 0 11px;display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.sec h2{font-size:17px;font-weight:700}
.sec p{margin:0;font-size:13px;color:var(--ink3)}

.empty{padding:44px 22px;text-align:center;color:var(--ink3)}
.empty strong{display:block;color:var(--ink2);font-weight:600;margin-bottom:5px;font-size:15px}

.cards{display:none;flex-direction:column;gap:10px}
.lc{padding:14px;border-radius:12px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow)}
.lc .top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:7px}
.lc .co{font-size:14px}
.lc .ttl{margin:2px 0 8px;font-size:14.5px;line-height:1.35}
.lc .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:9px}
.lc .row select{min-width:0;flex:1}
.lc .meta{font-size:12.5px;color:var(--ink3);display:flex;gap:10px;flex-wrap:wrap}

.note{font-size:12.5px;color:var(--ink3);padding:14px 0 0;line-height:1.6}
.del{color:var(--ink3);font-size:16px;line-height:1;padding:4px 7px}
.del:hover{color:var(--crit)}
@media (max-width:900px){
  .wrap{padding:0 13px 60px}
  .scroller.responsive{display:none}
  .cards{display:flex}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}

#gate{position:fixed;inset:0;background:var(--ground);display:flex;align-items:center;justify-content:center;padding:20px}
#gate .card{padding:26px 30px;display:flex;flex-direction:column;gap:12px;width:100%;max-width:320px}
#gate h1{font-size:19px}
#gate p{margin:0;color:var(--ink2);font-size:13px}
#gate .err{color:var(--crit);font-size:12.5px;min-height:1em}
.hidden{display:none!important}
</style>
</head>
<body>

<div id="gate">
  <div class="card">
    <h1>Job search access</h1>
    <p>Enter your access token to continue.</p>
    <input id="tokenInput" type="password" placeholder="Token" onkeydown="if(event.key==='Enter')submitToken()">
    <button class="btn primary" onclick="submitToken()">Enter</button>
    <div id="gateError" class="err"></div>
  </div>
</div>

<div id="app" class="hidden">
  <div class="wrap">
    <div class="hdr">
      <div>
        <h1>Brenna's Job Search</h1>
        <div class="sub">Verified openings across three tracks, refreshed daily. Edit anything &mdash; it saves for every device.</div>
      </div>
      <div class="stamp"><span class="dot" id="savedot"></span><span id="savetext">Loading</span></div>
    </div>
    <nav class="tabs" id="tabs" role="tablist"></nav>
    <main id="panel"></main>
  </div>
</div>

<script>
(function(){
"use strict";

var LEAD_STATUS=["New","Reviewing","Applied","Not a fit","Closed"];
var APP_STATUS=["Applied","Recruiter Screen","Tech Screen","Onsite / Loop","Offer","Rejected","Withdrawn"];
var ACTIVE=["Recruiter Screen","Tech Screen","Onsite / Loop"];
var TRACKS={
  SWE:{label:"Engineering",full:"Senior / Staff Software Engineer"},
  TPM:{label:"Technical PM",full:"Senior+ Technical Program Manager"},
  CPM:{label:"Product",full:"Consumer Product Manager"}
};

var TOKEN=localStorage.getItem("tracker_token")||"";
var state={updated:null,leads:[],applications:[]};
var ui={tab:"dashboard",q:"",filter:"All"};
try{var s=localStorage.getItem("bjs.tab");if(s)ui.tab=s;}catch(e){}

function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}

function daysSince(d){if(!d)return null;var t=Date.parse(d);if(isNaN(t))return null;
  return Math.max(0,Math.floor((Date.now()-t)/86400000));}

function today(){return new Date().toISOString().slice(0,10);}

function geo(location){
  var loc=String(location||"").toLowerCase();
  var sea=["seattle","bellevue","redmond","kirkland","mercer island","bothell","renton","everett","tacoma","sammamish","issaquah","puget sound"];
  for(var i=0;i<sea.length;i++){ if(loc.indexOf(sea[i])>=0) return {p:"p-high",label:"Seattle area"}; }
  var isRemote=loc.indexOf("remote")>=0;
  var isUS=loc.indexOf("usa")>=0||loc.indexOf("u.s")>=0||loc.indexOf("united states")>=0;
  if(isRemote&&isUS) return {p:"p-high",label:"Remote US"};
  var pdx=["portland","beaverton","hillsboro","vancouver, wa","vancouver,wa","oregon"];
  for(var j=0;j<pdx.length;j++){ if(loc.indexOf(pdx[j])>=0) return {p:"p-med",label:"Portland"}; }
  return null;
}
function rank(l){var g=geo(l.location);return g?(g.p==="p-high"?0:1):2;}

function setSaved(msg,ok){
  var d=document.getElementById("savedot"),t=document.getElementById("savetext");
  if(!d)return; d.className="dot"+(ok===false?" off":ok==="bad"?" bad":"");
  t.textContent=msg;
}

function submitToken(){
  TOKEN=document.getElementById("tokenInput").value.trim();
  if(!TOKEN)return;
  localStorage.setItem("tracker_token",TOKEN);
  boot();
}

function api(path,opts){
  var headers={"Authorization":"Bearer "+TOKEN,"Content-Type":"application/json"};
  if(opts&&opts.headers){for(var k in opts.headers){headers[k]=opts.headers[k];}}
  var merged={};
  if(opts){for(var k2 in opts){merged[k2]=opts[k2];}}
  merged.headers=headers;
  return fetch(path,merged).then(function(res){
    if(res.status===401){
      localStorage.removeItem("tracker_token");
      document.getElementById("gate").classList.remove("hidden");
      document.getElementById("app").classList.add("hidden");
      document.getElementById("gateError").textContent="Invalid token.";
      throw new Error("unauthorized");
    }
    return res.json();
  });
}

function boot(){
  setSaved("Loading",false);
  api("/api/data").then(function(data){
    state=data;
    if(!state.leads)state.leads=[];
    if(!state.applications)state.applications=[];
    document.getElementById("gate").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    setSaved("Saved",true);
    render();
  }).catch(function(err){
    var el=document.getElementById("gateError");
    if(el&&err.message!=="unauthorized")el.textContent="Couldn't load: "+err.message;
  });
}

function tabsHtml(){
  var t=[{id:"dashboard",label:"Overview",n:null},
         {id:"applications",label:"Applications",n:state.applications.length}];
  Object.keys(TRACKS).forEach(function(k){
    t.push({id:k,label:TRACKS[k].label,n:state.leads.filter(function(l){return l.search===k;}).length});
  });
  return t.map(function(x){
    return '<button class="tab" role="tab" data-tab="'+x.id+'" aria-selected="'+(ui.tab===x.id)+'">'+
      esc(x.label)+(x.n!==null?'<span class="n">'+x.n+'</span>':'')+'</button>';
  }).join("");
}

function pillFor(st){
  var m={"New":"new","Reviewing":"hot","Applied":"go","Not a fit":"no","Closed":"no",
         "Recruiter Screen":"hot","Tech Screen":"hot","Onsite / Loop":"hot","Offer":"go",
         "Rejected":"bad","Withdrawn":"no"};
  return m[st]||"live";
}

function selectHtml(opts,val,attrs){
  var list=opts.slice();
  if(val&&list.indexOf(val)<0)list.push(val);
  return '<select '+attrs+'>'+list.map(function(o){
    return '<option'+(o===val?" selected":"")+'>'+esc(o)+'</option>';}).join("")+'</select>';
}

function dashboard(){
  var L=state.leads, A=state.applications;
  var fresh=L.filter(function(l){return l.status==="New";}).length;
  var active=A.filter(function(a){return ACTIVE.indexOf(a.status)>=0;}).length;
  var stale=A.filter(function(a){var d=daysSince(a.dateApplied);
    return a.status==="Applied"&&d!==null&&d>14;}).length;
  var appliedLeads=L.filter(function(l){return l.status==="Applied";}).length;
  var near=L.filter(function(l){var g=geo(l.location);
    return g&&g.p==="p-high"&&l.status!=="Not a fit"&&l.status!=="Closed";}).length;

  var h='<div class="tiles">'+
    '<div class="tile hi"><div class="k">Untriaged</div><div class="v mono">'+fresh+'</div><div class="f">leads marked New</div></div>'+
    '<div class="tile"><div class="k">Seattle or remote</div><div class="v mono" style="color:var(--pri-high)">'+near+'</div><div class="f">still open</div></div>'+
    '<div class="tile"><div class="k">Tracked leads</div><div class="v mono">'+L.length+'</div><div class="f">across three tracks, US only</div></div>'+
    '<div class="tile"><div class="k">Applied</div><div class="v mono">'+(appliedLeads+A.length)+'</div><div class="f">'+A.length+' in the pipeline</div></div>'+
    '<div class="tile"><div class="k">In conversation</div><div class="v mono">'+active+'</div><div class="f">screen or loop stage</div></div>'+
    '<div class="tile"><div class="k">Gone quiet</div><div class="v mono">'+stale+'</div><div class="f">applied 14+ days ago</div></div>'+
  '</div>';

  h+='<div class="card" style="padding:19px"><div class="bars">';
  Object.keys(TRACKS).forEach(function(k){
    var rows=state.leads.filter(function(l){return l.search===k;});
    var byStatus=LEAD_STATUS.map(function(st){
      return {s:st,n:rows.filter(function(r){return r.status===st;}).length};});
    var tot=rows.length||1;
    var cols={"New":"var(--accent)","Reviewing":"var(--warn)","Applied":"var(--good)",
              "Not a fit":"var(--line)","Closed":"var(--line)"};
    h+='<div class="bar"><h3>'+esc(TRACKS[k].label)+' <span>'+esc(TRACKS[k].full)+' &middot; '+rows.length+'</span></h3>'+
      '<div class="meter">'+byStatus.map(function(b){
        return b.n?'<i style="width:'+(b.n/tot*100)+'%;background:'+cols[b.s]+'"></i>':"";}).join("")+'</div>'+
      '<div class="legend">'+byStatus.filter(function(b){return b.n;}).map(function(b){
        return '<span><b style="background:'+cols[b.s]+'"></b>'+esc(b.s)+' '+b.n+'</span>';}).join("")+
      (rows.length?"":'<span style="color:var(--ink3)">No postings found yet</span>')+'</div></div>';
  });
  h+='</div></div>';

  var followUp=A.filter(function(a){return a.status==="Applied";})
    .map(function(a){return {a:a,d:daysSince(a.dateApplied)};})
    .sort(function(x,y){return (y.d||0)-(x.d||0);});
  h+='<div class="sec"><h2>Needs a follow-up</h2><p>Applications still marked &ldquo;Applied,&rdquo; oldest first</p></div>';
  if(!followUp.length){
    h+='<div class="card empty"><strong>Nothing waiting</strong>Everything in your pipeline has moved past the initial application, or there&rsquo;s nothing in it yet.</div>';
  }else{
    h+='<div class="card"><div class="scroller"><table><thead><tr><th>Company</th><th>Role</th><th>Applied</th><th>Days</th><th>Status</th></tr></thead><tbody>'+
      followUp.map(function(x){
        return '<tr><td class="co">'+esc(x.a.company)+'</td><td>'+esc(x.a.title)+'</td>'+
          '<td class="dt mono">'+esc(x.a.dateApplied)+'</td><td class="dt mono">'+(x.d===null?"&mdash;":x.d)+'</td>'+
          '<td><span class="pill '+pillFor(x.a.status)+'">'+esc(x.a.status)+'</span></td></tr>';
      }).join("")+'</tbody></table></div></div>';
  }
  h+='<div class="note">Three scheduled searches add rows here every morning &mdash; engineering at 15:00 UTC, technical PM at 15:30, product at 16:00. Every posting is opened and confirmed live before it lands; nothing arrives from a search snippet alone.</div>';
  return h;
}

function leadsTab(key){
  var all=state.leads.filter(function(l){return l.search===key;});
  var q=ui.q.toLowerCase();
  var rows=all.filter(function(l){
    if(ui.filter!=="All"&&l.status!==ui.filter)return false;
    if(!q)return true;
    return (l.company+" "+l.title+" "+l.location).toLowerCase().indexOf(q)>=0;
  }).sort(function(a,b){
    var d=rank(a)-rank(b); if(d)return d;
    return String(b.found).localeCompare(String(a.found));
  });
  var h='<div class="toolbar">'+
    '<div class="search"><input type="search" id="q" placeholder="Filter '+esc(TRACKS[key].label)+'&hellip;" value="'+esc(ui.q)+'"></div>'+
    '<div class="chips">'+["All"].concat(LEAD_STATUS).map(function(f){
      return '<button class="chip" data-filter="'+esc(f)+'" aria-pressed="'+(ui.filter===f)+'">'+esc(f)+'</button>';
    }).join("")+'</div></div>'+
    '<div class="key"><span><i style="background:var(--pri-high)"></i>Seattle area or remote in the US</span>'+
    '<span><i style="background:var(--pri-med)"></i>Portland</span>'+
    '<span>Closest roles sorted first</span></div>';

  if(!all.length){
    return h+'<div class="card empty"><strong>No postings yet</strong>The '+esc(TRACKS[key].label).toLowerCase()+
      ' search hasn&rsquo;t turned up a verified opening yet. An empty day is a real result &mdash; nothing gets padded in here.</div>';
  }
  if(!rows.length) return h+'<div class="card empty"><strong>Nothing matches</strong>Try a different filter.</div>';

  h+='<div class="card scroller responsive"><table><thead><tr>'+
    '<th>Company</th><th>Role</th><th>Location</th><th>Found</th><th>Status</th><th>Your notes</th><th></th>'+
    '</tr></thead><tbody>'+rows.map(function(l){
    var g=geo(l.location);
    return '<tr'+(g?' class="'+g.p+'"':'')+'><td class="co">'+esc(l.company)+'</td>'+
      '<td><span class="ttl"><a href="'+esc(l.url)+'" target="_blank" rel="noopener">'+esc(l.title)+'</a></span>'+
        (l.fit?'<span class="fit">'+esc(l.fit)+'</span>':"")+'</td>'+
      '<td class="loc">'+esc(l.location)+(g?'<br><span class="geo '+g.p+'">'+esc(g.label)+'</span>':'')+'</td>'+
      '<td class="dt mono">'+esc(l.found)+'</td>'+
      '<td>'+selectHtml(LEAD_STATUS,l.status,'data-id="'+l.id+'" data-field="status"')+'</td>'+
      '<td><textarea data-id="'+l.id+'" data-field="notes" rows="1" placeholder="Add a note">'+esc(l.notes)+'</textarea></td>'+
      '<td><span class="pill live" title="Confirmed live on this date">'+esc(l.verified)+'</span></td></tr>';
  }).join("")+'</tbody></table></div>';

  h+='<div class="cards">'+rows.map(function(l){
    var g=geo(l.location);
    return '<div class="lc'+(g?' '+g.p:'')+'"><div class="top"><span class="co">'+esc(l.company)+'</span>'+
      '<span class="pill '+pillFor(l.status)+'">'+esc(l.status)+'</span></div>'+
      '<div class="ttl"><a href="'+esc(l.url)+'" target="_blank" rel="noopener">'+esc(l.title)+'</a></div>'+
      '<div class="meta"><span>'+esc(l.location)+'</span><span class="mono">Found '+esc(l.found)+'</span>'+
      (g?'<span class="geo '+g.p+'">'+esc(g.label)+'</span>':'')+'</div>'+
      (l.fit?'<div class="fit" style="margin-top:6px">'+esc(l.fit)+'</div>':"")+
      '<div class="row">'+selectHtml(LEAD_STATUS,l.status,'data-id="'+l.id+'" data-field="status"')+'</div>'+
      '<div class="row"><textarea data-id="'+l.id+'" data-field="notes" rows="2" placeholder="Your notes&hellip;">'+esc(l.notes)+'</textarea></div>'+
      '</div>';
  }).join("")+'</div>';
  h+='<div class="note">Status and notes save when you click away from the field. '+rows.length+' of '+all.length+' shown.</div>';
  return h;
}

function appsTab(){
  var A=state.applications;
  var h='<div class="toolbar"><button class="btn primary" id="addapp">Add application</button>'+
    '<span style="font-size:13px;color:var(--ink3)">Your own pipeline &mdash; the scheduled searches never touch this tab.</span></div>';
  if(!A.length){
    return h+'<div class="card empty"><strong>No applications logged</strong>'+
      'When you apply to something, add it here to track the conversation. Days-since updates itself.</div>';
  }
  h+='<div class="card scroller"><table><thead><tr>'+
    '<th>Company</th><th>Role</th><th>Applied</th><th>Status</th><th>Notes</th><th>Days</th><th></th>'+
    '</tr></thead><tbody>'+A.map(function(a){
    var d=daysSince(a.dateApplied);
    return '<tr>'+
      '<td><input type="text" data-id="'+a.id+'" data-field="company" data-app="1" value="'+esc(a.company)+'"></td>'+
      '<td><input type="text" data-id="'+a.id+'" data-field="title" data-app="1" value="'+esc(a.title)+'"></td>'+
      '<td><input type="date" data-id="'+a.id+'" data-field="dateApplied" data-app="1" value="'+esc(a.dateApplied)+'"></td>'+
      '<td>'+selectHtml(APP_STATUS,a.status,'data-id="'+a.id+'" data-field="status" data-app="1"')+'</td>'+
      '<td><textarea data-id="'+a.id+'" data-field="notes" data-app="1" rows="1">'+esc(a.notes)+'</textarea></td>'+
      '<td class="dt mono">'+(d===null?"&mdash;":d)+'</td>'+
      '<td><button class="btn ghost del" data-del="'+a.id+'" title="Remove">&times;</button></td></tr>';
  }).join("")+'</tbody></table></div>'+
  '<div class="note">Edits save when you click away. Days counts from the applied date.</div>';
  return h;
}

function render(){
  document.getElementById("tabs").innerHTML=tabsHtml();
  var p=document.getElementById("panel");
  if(ui.tab==="dashboard")p.innerHTML=dashboard();
  else if(ui.tab==="applications")p.innerHTML=appsTab();
  else p.innerHTML=leadsTab(ui.tab);
}

document.addEventListener("click",function(e){
  var t=e.target.closest("[data-tab]");
  if(t){ui.tab=t.getAttribute("data-tab");ui.q="";ui.filter="All";
    try{localStorage.setItem("bjs.tab",ui.tab);}catch(err){} render(); return;}

  var f=e.target.closest("[data-filter]");
  if(f){ui.filter=f.getAttribute("data-filter"); render(); return;}

  if(e.target.id==="addapp"){
    setSaved("Saving&hellip;",false);
    api("/api/update",{method:"POST",body:JSON.stringify({
      type:"application",company:"",title:"",dateApplied:today(),status:"Applied",notes:""
    })}).then(function(res){
      state.applications.unshift(res.application);
      render();
      setSaved("Saved",true);
    }).catch(function(){setSaved("Couldn't save &mdash; try again","bad");});
    return;
  }

  var del=e.target.closest("[data-del]");
  if(del){
    var id=del.getAttribute("data-del");
    var row=state.applications.filter(function(a){return String(a.id)===String(id);})[0];
    var name=row&&(row.company||row.title)?((row.company||"")+" "+(row.title||"")).trim():"this row";
    if(confirm("Remove "+name+" from Applications?")){
      setSaved("Saving&hellip;",false);
      api("/api/delete-application",{method:"POST",body:JSON.stringify({id:id})}).then(function(){
        state.applications=state.applications.filter(function(a){return String(a.id)!==String(id);});
        render();
        setSaved("Saved",true);
      }).catch(function(){setSaved("Couldn't save &mdash; try again","bad");});
    }
  }
});

document.addEventListener("input",function(e){
  if(e.target.id==="q"){
    ui.q=e.target.value;
    var pos=e.target.selectionStart; render();
    var n=document.getElementById("q"); if(n){n.focus();n.setSelectionRange(pos,pos);}
  }
});

function commit(el){
  var id=el.getAttribute("data-id"), field=el.getAttribute("data-field");
  if(!id||!field)return;
  var isApp=!!el.getAttribute("data-app");
  var list=isApp?state.applications:state.leads;
  var row=list.filter(function(r){return String(r.id)===String(id);})[0];
  if(!row||row[field]===el.value)return;
  row[field]=el.value;
  setSaved("Saving&hellip;",false);
  var body=isApp?{type:"application",id:id}:{type:"lead",id:id};
  body[field]=el.value;
  api("/api/update",{method:"POST",body:JSON.stringify(body)}).then(function(){
    setSaved("Saved",true);
    if(field==="status"&&!isApp)render();
  }).catch(function(){setSaved("Couldn't save &mdash; try again","bad");});
}
document.addEventListener("change",function(e){
  if(e.target.matches("select[data-id],input[data-id]"))commit(e.target);
});
document.addEventListener("focusout",function(e){
  if(e.target.matches("textarea[data-id],input[data-id]"))commit(e.target);
});

if(TOKEN)boot(); else document.getElementById("gate").classList.remove("hidden");
})();
</script>
</body>
</html>`;
