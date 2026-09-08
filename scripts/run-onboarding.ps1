<#
.SYNOPSIS
  Builds a search for everyone who has asked for one on the tracker page - one
  run for the whole machine, nightly.

.DESCRIPTION
  The last step of self-service onboarding, and the one that runs unattended.
  Someone opens an invite link, creates their own account, fills in the setup
  form and attaches their resume (see ../server/src/routes/intake.js). This is
  what picks that up and turns it into a working daily search: their folder,
  their credential, their per-track notes doc, their config, their company
  rotation and their scheduled tasks.

  Before it, all of that was the operator's evening: their resume on the
  operator's disk, the operator answering questions about someone else's career
  in a Claude session on that person's behalf.

  ---- What this script does, and what it hands to a model.

  Everything mechanical happens here, in PowerShell, where it either works or
  throws: minting each person's long-lived token, making their folders, writing
  tracker.json, downloading their uploaded documents to disk, working out a
  schedule slot that doesn't collide with anyone already running on this
  machine, and registering the scheduled tasks afterwards.

  What goes to the model is the part that actually needs judgement - reading a
  resume, turning "senior backend, ideally Seattle or remote US" into the prose
  the daily prompt reads verbatim, choosing a starting company list, writing the
  notes doc. It follows ../.claude/skills/job-search-setup/SKILL.md, which is
  the same instructions a person gets when they run that skill by hand. Pointed
  at rather than copied: this repo has already had one round of docs describing
  a shape the code had moved on from, and a second copy of the setup procedure
  in a PowerShell here-string is exactly how that happens again.

  The split matters for a second reason. A credential half-created by a run that
  died mid-turn is a bad state to be in; a notes doc half-written is not.

  ---- Failure is reported to the person, not swallowed.

  Anyone still 'pending' when the turn ends is marked 'failed' with a note, so
  their own page stops saying "your tracker will be ready in the morning" and
  starts saying what went wrong. A failed intake stays in the queue, so the
  next night tries again - and if the fix is theirs to make (a resume file
  nothing could read), they can see that and paste the text instead.

  Logs to <DataDir>\logs\onboarding.log - the machine's log, like the
  applications fill, because this run is nobody's in particular either.

.PARAMETER DataDir
  Path to the private data folder, holding one folder per person. Defaults to
  the JOB_SEARCH_DATA_DIR environment variable, then to a "private" folder
  next to this repo.

.PARAMETER AdminToken
  The deployment's ADMIN_TOKEN worker secret. This run needs it because the
  queue it reads spans everyone and belongs to no one - there is no session
  token that can see it (see ../server/src/routes/intake.js).

  Resolved from, in order: this parameter, the TRACKER_ADMIN_TOKEN environment
  variable, then an "adminToken" field in <DataDir>\deployment.json. The file
  is what a scheduled task actually uses, since a task registered to run while
  you are logged in does not reliably inherit a variable you set later.

.PARAMETER TrackerUrl
  The API worker's base URL. Resolved from this parameter, then TRACKER_URL,
  then deployment.json's "url", then the url in any existing person's
  tracker.json - which is the usual case on a machine that already runs
  somebody's search.

.PARAMETER User
  Only build this one user id, instead of everyone waiting. For trying it by
  hand; the scheduled task passes no -User.

.PARAMETER WhatIfOnly
  Print who is waiting and what would be built, and stop. Nothing is minted,
  written or posted. Not called -WhatIf: that name is reserved by PowerShell's
  own common parameters and behaves differently.

.EXAMPLE
  .\run-onboarding.ps1
  .\run-onboarding.ps1 -WhatIfOnly
  .\run-onboarding.ps1 -User f6d1e62d-e325-4c52-908a-91bb5850c776
#>
param(
    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" }),

    [string]$AdminToken,

    [string]$TrackerUrl,

    [string]$User,

    [switch]$WhatIfOnly
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $DataDir)) {
    Write-Error "Data dir not found: $DataDir`nSet -DataDir, or the JOB_SEARCH_DATA_DIR environment variable, to your private job-search data folder."
    exit 1
}
$DataDir = (Resolve-Path $DataDir).Path

$logDir = Join-Path $DataDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "onboarding.log"

# -Encoding utf8 is not optional - see the same note in run-search.ps1. Windows
# PowerShell 5.1's Out-File defaults to UTF-16LE, and appending that to a file
# already started as UTF-8 produces one file with two encodings in it.
function Log($msg) {
    "$(Get-Date -Format o) - $msg" | Out-File -Append -Encoding utf8 -FilePath $logFile
}

Log "===== starting onboarding run ====="
Log "data dir:         $DataDir"

# ---------------------------------------------------------------- credentials
$deployFile = Join-Path $DataDir "deployment.json"
$deployment = $null
if (Test-Path $deployFile) {
    try { $deployment = Get-Content -Raw -Path $deployFile | ConvertFrom-Json } catch {
        Log "WARNING: $deployFile is not readable JSON - ignoring it"
    }
}

function Field($obj, [string[]]$names) {
    if (-not $obj) { return $null }
    foreach ($n in $names) {
        $v = $obj.PSObject.Properties[$n]
        if ($v -and $v.Value) { return [string]$v.Value }
    }
    return $null
}

# The URL and the admin token are resolved together, from one source, rather
# than each from the first place that happens to have it.
#
# Mixing them is how an operator credential gets aimed at the wrong deployment,
# and it is not hypothetical: this was written taking the URL from
# $env:TRACKER_URL and the token from deployment.json, and the first real run
# sent a test deployment's admin token to the live tracker. It was refused, and
# the error said "check it matches the ADMIN_TOKEN secret" - which was true of
# neither deployment and pointed at nothing.
#
# So: the first source holding both wins, whole. If no single source has both,
# each is taken from the first that has it and the mix is named out loud, since
# by then it is a guess about which deployment you meant.
function Resolve-Deployment($sources) {
    $paired = @($sources | Where-Object { $_.Url -and $_.Token }) | Select-Object -First 1
    if ($paired) { return $paired }
    $url = @($sources | Where-Object { $_.Url }) | Select-Object -First 1
    $tok = @($sources | Where-Object { $_.Token }) | Select-Object -First 1
    if ($url -and $tok) {
        Write-Warning "Using the tracker URL from $($url.Name) with the admin token from $($tok.Name) - check they belong to the same deployment."
    }
    [pscustomobject]@{
        Name  = "a mix of sources"
        Url   = $(if ($url) { $url.Url })
        Token = $(if ($tok) { $tok.Token })
    }
}

$resolved = Resolve-Deployment @(
    [pscustomobject]@{ Name = "the -TrackerUrl/-AdminToken arguments"; Url = $TrackerUrl;      Token = $AdminToken }
    [pscustomobject]@{ Name = "the environment";                       Url = $env:TRACKER_URL; Token = $env:TRACKER_ADMIN_TOKEN }
    [pscustomobject]@{ Name = "$deployFile";                           Url = (Field $deployment @("url", "trackerUrl", "TRACKER_URL")); Token = (Field $deployment @("adminToken", "admin_token", "ADMIN_TOKEN")) }
)
$TrackerUrl = $resolved.Url
$AdminToken = $resolved.Token

# Every person's tracker.json already carries the deployment's URL, so a machine
# that runs anybody's search knows it without being told twice.
$existing = @()
foreach ($dir in (Get-ChildItem $DataDir -Directory | Sort-Object Name)) {
    $trackerFile = Join-Path $dir.FullName "tracker.json"
    if (-not (Test-Path $trackerFile)) { continue }
    try { $t = Get-Content -Raw -Path $trackerFile | ConvertFrom-Json } catch { continue }
    $existing += [pscustomobject]@{ Id = $dir.Name; Url = $t.url.TrimEnd("/"); Token = $t.token }
}
if (-not $TrackerUrl -and $existing.Count -gt 0) { $TrackerUrl = $existing[0].Url }

if (-not $TrackerUrl) {
    Log "ERROR: no tracker URL - pass -TrackerUrl, set TRACKER_URL, or put a `"url`" in $deployFile"
    Write-Error "No tracker URL. Pass -TrackerUrl, set TRACKER_URL, or add a `"url`" to $deployFile."
    exit 1
}
$TrackerUrl = $TrackerUrl.TrimEnd("/")

if (-not $AdminToken) {
    # Named plainly rather than as "unauthorized" later: this is the one
    # prerequisite that is nobody's fault but the operator's, and the fix is a
    # single line in one file.
    Log "ERROR: no admin token - pass -AdminToken, set TRACKER_ADMIN_TOKEN, or put an `"adminToken`" in $deployFile"
    Write-Error @"
No ADMIN_TOKEN. This run reads the setup queue, which spans every account and
so is admin-only. Add it to ${deployFile}:

  { "url": "$TrackerUrl", "adminToken": "<the ADMIN_TOKEN worker secret>" }

That file is inside your private data folder, which is never committed.
"@
    exit 1
}

Log "tracker:          $TrackerUrl"

$adminHeaders = @{ Authorization = "Bearer $AdminToken" }

# See scripts/set-password.ps1 and the skill's API section: Cloudflare answers
# a rejected default agent with a 403 whose body is `error code: 1010`, which
# looks exactly like a refused ADMIN_TOKEN from the status alone. This run is
# unattended, so a failure it misdiagnoses is one nobody is watching to
# correct.
$API_USER_AGENT = "curl/8.0"

function Api($method, $path, $body) {
    $req = @{ Uri = "$TrackerUrl$path"; Method = $method; Headers = $adminHeaders
              UserAgent = $API_USER_AGENT; ErrorAction = "Stop" }
    if ($body) {
        $req.Body = ($body | ConvertTo-Json -Depth 8 -Compress)
        $req.ContentType = "application/json; charset=utf-8"
    }
    Invoke-RestMethod @req
}

# ---------------------------------------------------------------- the queue
try {
    $queue = (Api GET "/api/intake/pending" $null).pending
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    $hint = if ($status -eq 401) { "the admin token was refused - check it matches the ADMIN_TOKEN secret on the worker" }
            elseif ($status -eq 404) { "this deployment doesn't have the intake routes yet - deploy ../server/ first" }
            else { $_.Exception.Message }
    Log "ERROR: couldn't read the setup queue ($status): $hint"
    Write-Error "Couldn't read the setup queue ($status): $hint"
    exit 1
}

if ($User) { $queue = @($queue | Where-Object { $_.user.id -eq $User }) }
$queue = @($queue)

if ($queue.Count -eq 0) {
    # The ordinary result on almost every night. Exit 0 and quietly: a machine
    # where nobody new has signed up is not a machine with a problem.
    Log "nobody waiting - nothing to do"
    Log "===== done ====="
    exit 0
}

Log "waiting:          $($queue.Count) ($(($queue | ForEach-Object { $_.user.name }) -join ', '))"

# ------------------------------------------------------- a free schedule slot
#
# Everyone's searches share one CLI and one Claude account on this machine, and
# each run takes several minutes, so two searches at the same time is two
# searches fighting. The slot is worked out here rather than left to the model:
# it is arithmetic over what is already registered, and a model asked to "pick
# a time nobody else is using" has to be told what everyone else is using
# anyway.
$taken = @()
foreach ($acct in $existing) {
    try {
        $cfg = Invoke-RestMethod -Uri "$TrackerUrl/api/config" `
            -Headers @{ Authorization = "Bearer $($acct.Token)" } `
            -UserAgent $API_USER_AGENT -ErrorAction Stop
        foreach ($tr in $cfg.tracks) { if ($tr.schedule_time) { $taken += $tr.schedule_time } }
    } catch {
        Log "WARNING: couldn't read $($acct.Id)'s config for schedule times - $($_.Exception.Message)"
    }
}
$taken = @($taken | Sort-Object -Unique)
Log "slots in use:     $(if ($taken.Count) { $taken -join ', ' } else { '(none)' })"

function NextSlot([string[]]$used) {
    # 30 minutes after the latest run already scheduled on this machine. Each
    # slot handed out is added to $used by the caller, so a second person built
    # on the same night lands 30 minutes after the first rather than on top of
    # them - the walk forward is that append, not an offset here as well, which
    # is how the first version handed out 07:00 and then 08:00.
    #
    # 07:00 is the starting point on a machine with nothing scheduled yet.
    $minutes = 7 * 60
    if ($used.Count -gt 0) {
        $latest = 0
        foreach ($t in $used) {
            if ($t -match '^(\d{1,2}):(\d{2})$') {
                $m = [int]$Matches[1] * 60 + [int]$Matches[2]
                if ($m -gt $latest) { $latest = $m }
            }
        }
        $minutes = $latest + 30
    }
    $minutes = $minutes % (24 * 60)
    "{0:00}:{1:00}" -f [math]::Floor($minutes / 60), ($minutes % 60)
}

# --------------------------------------------------- prepare each person's dir
$prepared = @()
foreach ($item in $queue) {
    $id = $item.user.id
    $name = $item.user.name
    $userDir = Join-Path $DataDir $id
    $slot = NextSlot $taken
    $taken += $slot
    Log "--- $name ($id) - submitted $($item.submitted_at), $($item.files.Count) document(s), slot $slot"

    if ($WhatIfOnly) {
        foreach ($tr in $item.answers.tracks) { Log "      track: $($tr.label) - $($tr.role_search_line)" }
        foreach ($f in $item.files) { Log "      file:  $($f.filename) ($($f.bytes) bytes)" }
        continue
    }

    New-Item -ItemType Directory -Force -Path (Join-Path $userDir "docs") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $userDir "resumes") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $userDir "reference") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $userDir "logs") | Out-Null

    # The credential their scheduled searches will hold. Minted here because
    # the operator no longer knows this person's password - which is the whole
    # improvement - so logging in as them is no longer possible or wanted.
    $trackerFile = Join-Path $userDir "tracker.json"
    if (-not (Test-Path $trackerFile)) {
        $minted = Api POST "/api/tokens" @{ user = $name; label = "scheduled-search" }
        # Depth 8 and no -Compress: this file gets read by a person often
        # enough to be worth it being readable.
        @{ url = $TrackerUrl; token = $minted.token } | ConvertTo-Json | Out-File -Encoding utf8 -FilePath $trackerFile
        Log "      minted a scheduled-search token and wrote tracker.json"
    } else {
        Log "      tracker.json already there - reusing it (this is a retry)"
    }

    # Their documents, off the database and onto this disk. The filenames were
    # rebuilt server-side from the basename up (see routes/intake.js), so
    # nothing here can be a path.
    $resumePaths = @()
    foreach ($f in $item.files) {
        $dest = Join-Path (Join-Path $userDir "resumes") $f.filename
        $file = Api GET "/api/intake/file/$($f.id)" $null
        [System.IO.File]::WriteAllBytes($dest, [System.Convert]::FromBase64String($file.body))
        $resumePaths += $dest
        Log "      wrote $dest ($($f.bytes) bytes)"
    }

    # The answers, as a file rather than as prompt text: `resume_text` alone can
    # be a hundred kilobytes, and this is also the record of what they actually
    # asked for, which is worth keeping next to what got built from it.
    $intakeFile = Join-Path (Join-Path $userDir "reference") "intake.json"
    $item.answers | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 -FilePath $intakeFile

    $prepared += [pscustomobject]@{
        Id = $id; Name = $name; Dir = $userDir; IntakeFile = $intakeFile
        Resumes = $resumePaths; Slot = $slot; Retry = ($item.status -eq "failed")
    }
}

if ($WhatIfOnly) {
    Log "-WhatIfOnly: nothing was minted, written or posted"
    Log "===== done ====="
    Write-Host "Would build $($queue.Count) search(es). See $logFile."
    exit 0
}

# ---------------------------------------------------------------- the CLI turn
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    $fallback = Join-Path $env:APPDATA "npm\claude.cmd"
    if (Test-Path $fallback) { $claude = $fallback } else {
        Log "ERROR: claude CLI not found on PATH or at $fallback"
        Write-Error "claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
        exit 1
    }
}
$claudePath = if ($claude -is [System.Management.Automation.CommandInfo]) { $claude.Source } else { $claude }

# Where the setup instructions live, which differs by how this repo got here.
# A plugin install keeps them under CLAUDE_PLUGIN_ROOT; a git clone keeps them
# beside this script.
$skillDir = if ($env:CLAUDE_PLUGIN_ROOT) {
    Join-Path $env:CLAUDE_PLUGIN_ROOT ".claude\skills\job-search-setup"
} else {
    (Resolve-Path (Join-Path $PSScriptRoot "..\.claude\skills\job-search-setup")).Path
}
if (-not (Test-Path (Join-Path $skillDir "SKILL.md"))) {
    Log "ERROR: setup instructions not found at $skillDir"
    Write-Error "Couldn't find job-search-setup/SKILL.md at $skillDir."
    exit 1
}
Log "skill:            $skillDir"

$personBlocks = @()
$n = 0
foreach ($p in $prepared) {
    $n++
    $resumeList = if ($p.Resumes.Count) { ($p.Resumes | ForEach-Object { "      - $_" }) -join "`n" } else { "      (none attached - use resume_text in the answers file)" }
    $personBlocks += @"
  - Name:            $($p.Name)
    User id:         $($p.Id)
    Their folder:    $($p.Dir)
    Their answers:   $($p.IntakeFile)
    Their token:     the environment variable TRACKER_TOKEN_$n
    Schedule time:   $($p.Slot)   (already checked against everyone else on this machine - use it as-is)
    Resume files:
$resumeList$(if ($p.Retry) { "`n    NOTE: this is a retry - a previous run failed on them. Their folder may be half-built." })
"@
}

$prompt = @"
IMPORTANT: this is one single non-interactive headless run. This process exits
as soon as your turn ends, and nobody reads any message after that - there is
no follow-up turn, and there is nobody to ask. Every decision the setup
instructions would normally put to an installer, you make yourself from what
these people wrote on the form. Do not end your turn with work outstanding.

You are setting up a job search for each person below. They filled in a form on
the tracker page describing what they want; nobody has spoken to them, and
nobody will before this runs.

Follow the instructions in:

    $skillDir\SKILL.md

with these differences, because this is the unattended path:

  - Steps 1 and 2's provisioning is already done. Each person's account, folder,
    credential and documents exist on disk (paths below). Do not create accounts
    and do not mint tokens.
  - Wherever the instructions say to ask the installer something, read the
    answer out of their answers file instead. It holds exactly what they typed,
    in their own words: display_title, pronouns, geo_scope, priority_locations,
    excluded_companies, resume_text, notes, and one entry per track with label,
    role_search_line, target_companies and fit_note.
  - Wherever they say to confirm something with the installer before continuing,
    proceed with your best reading of what the person asked for. Prefer the
    interpretation that surfaces more jobs: an over-tight fit filter silently
    hides work they wanted, and nobody is watching to catch it.
  - Track keys are yours to choose - one lowercase-hyphenated slug per track,
    from their label. A track whose answers say it splits off another one gets
    that one's key as its `fed_by`.
  - Use the schedule time given below for each track. It has already been
    checked against every other search on this machine. A `fed_by` track gets
    no schedule time.
  - Their per-track notes doc goes in their own folder's docs\ directory, from
    the template in $skillDir\templates\.
  - Do skip step 7 entirely (registering scheduled tasks). This script does that
    itself after your turn, deterministically.

When a person is completely done - their doc written, their config posted,
their company coverage seeded - report it, using the admin token in the
environment variable TRACKER_ADMIN_TOKEN:

    curl -s -X POST "`$TRACKER_URL/api/intake/complete" \
      -H "Authorization: Bearer `$TRACKER_ADMIN_TOKEN" -H "Content-Type: application/json" \
      -d '{"user":"<their name>","status":"done"}'

If you cannot finish someone - their resume is unreadable, their answers do not
say enough to search on - report that instead, with a note written to be read
by them, on their own page, saying what they can do about it:

    -d '{"user":"<their name>","status":"failed","note":"We could not read your resume file. Paste the text of your resume into the setup form instead."}'

Report every person one way or the other before your turn ends. Anyone left
unreported is marked failed by this script afterwards with a generic message,
which is worse for them than a specific one from you.

Never print a token. Use the environment variable names as written, so the
shell expands them inside curl and the values never enter your context.

TRACKER_URL is in the environment. The people to set up:

$($personBlocks -join "`n`n")
"@

# Write and Edit are the difference from the other two runners: this one
# authors a notes doc in each person's folder, which is the one file the setup
# instructions produce. Task for the parallel reading the setup work does.
$allowedTools = "Task Read Write Edit Glob Grep WebSearch WebFetch Bash"

Log "prompt:           $($prompt.Length) chars"
Log "claude CLI:       $claudePath"
Log "allowed tools:    $allowedTools"
Log "CLAUDE_CODE_OAUTH_TOKEN set: $([bool]$env:CLAUDE_CODE_OAUTH_TOKEN)"

$job = Start-Job -ScriptBlock {
    param($claudePath, $prompt, $allowedTools, $workDir, $trackerUrl, $adminToken, $tokens)
    Set-Location $workDir
    $env:TRACKER_URL = $trackerUrl
    $env:TRACKER_ADMIN_TOKEN = $adminToken
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        Set-Item -Path "env:TRACKER_TOKEN_$($i + 1)" -Value $tokens[$i]
    }
    # The claude CLI writes UTF-8; without this PowerShell decodes its stdout
    # using the console's OEM codepage and mangles every non-ASCII character
    # before it reaches the log.
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    & $claudePath -p $prompt --allowedTools $allowedTools 2>&1
} -ArgumentList $claudePath, $prompt, $allowedTools, $DataDir, $TrackerUrl, $AdminToken,
    @($prepared | ForEach-Object { (Get-Content -Raw -Path (Join-Path $_.Dir "tracker.json") | ConvertFrom-Json).token })

$start = Get-Date
Log "job started (id $($job.Id)), waiting..."
while ($job.State -eq "Running") {
    Start-Sleep -Seconds 20
    $elapsed = [int]((Get-Date) - $start).TotalSeconds
    Log "... still running (${elapsed}s elapsed)"
}
$output = Receive-Job $job -ErrorAction SilentlyContinue
$jobState = $job.State
Remove-Job $job -Force

Log "----- claude output -----"
if ($output) { $output | Out-String | Out-File -Append -Encoding utf8 -FilePath $logFile }
Log "----- end output -----"

# The CLI exiting cleanly is not the same as the CLI having done anything - an
# unauthenticated run prints "Not logged in" and exits 0. See the same check in
# run-fill.ps1, where that cost a night of silently doing nothing.
$exitCode = if ($jobState -eq "Completed") { 0 } else { 1 }
$outputText = if ($output) { ($output | Out-String).Trim() } else { "" }
if (-not $outputText) {
    Log "ERROR: the CLI produced no output at all"
    $exitCode = 1
} elseif ($outputText -match "Not logged in|Please run /login|Invalid API key|authentication_error") {
    Log "ERROR: the CLI is not authenticated - nothing was set up."
    Log "       Run ``claude setup-token``, then: setx CLAUDE_CODE_OAUTH_TOKEN ""<token>"""
    $exitCode = 1
}

# --------------------------------------------------- what actually got built
#
# Asked of the tracker rather than taken from the model's summary. The record
# that matters is the one the person's own page reads.
$built = @()
foreach ($p in $prepared) {
    $state = $null
    try {
        $still = @((Api GET "/api/intake/pending" $null).pending | Where-Object { $_.user.id -eq $p.Id })
        $state = if ($still.Count -eq 0) { "done" } else { $still[0].status }
    } catch {
        Log "WARNING: couldn't re-read the queue for $($p.Name) - $($_.Exception.Message)"
        continue
    }

    if ($state -eq "done") {
        Log "$($p.Name): set up"
        $built += $p
        continue
    }

    # Still waiting after the turn ended. Left as-is, their page would keep
    # promising a tracker in the morning forever. 'failed' both tells them and
    # keeps them in the queue for tomorrow night.
    if ($state -eq "pending") {
        Log "$($p.Name): the run ended without reporting on them - marking failed so they are told"
        try {
            Api POST "/api/intake/complete" @{
                user = $p.Name; status = "failed"
                note = "Setting your search up didn't finish. It will be tried again tonight - no action needed from you unless this repeats."
            } | Out-Null
        } catch { Log "WARNING: couldn't mark $($p.Name) failed - $($_.Exception.Message)" }
    } else {
        Log "$($p.Name): reported failed by the run - see their status note"
    }
    $exitCode = 1
}

# ------------------------------------------------------------ their schedules
#
# Deterministic, and after the fact: setup-scheduler.ps1 reads each person's
# tracker.json and asks their account what tracks it has, so it can only work
# once the config above has actually landed.
if ($built.Count -gt 0) {
    $scheduler = Join-Path $PSScriptRoot "setup-scheduler.ps1"
    foreach ($p in $built) {
        try {
            Log "registering scheduled tasks for $($p.Name)..."
            & $scheduler -DataDir $DataDir -User $p.Id *>&1 | Out-File -Append -Encoding utf8 -FilePath $logFile
        } catch {
            Log "ERROR: couldn't register tasks for $($p.Name) - $($_.Exception.Message)"
            $exitCode = 1
        }
    }
}

$elapsed = [int]((Get-Date) - $start).TotalSeconds
Log "finished - job state: $jobState, built: $($built.Count)/$($prepared.Count), elapsed: ${elapsed}s, exit code: $exitCode"
Log "===== done ====="

exit $exitCode
