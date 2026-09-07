<#
.SYNOPSIS
  Fills in the applications that were logged as nothing but a URL - one run
  for every account on this machine.

.DESCRIPTION
  Generic runner - contains no personal data itself. It discovers every person
  under <DataDir> the same way setup-scheduler.ps1 does (a
  <DataDir>\<user-id>\tracker.json holding their tracker URL and token),
  fetches the fill prompt from the tracker (`GET /api/prompt/_applications`),
  and runs it non-interactively via `claude -p` in a single turn that covers
  all of them.

  That turn pulls every account's outstanding rows first and then fans the slow
  part out: one subagent per posting, in batches, reading pages in parallel.
  Subagents get a URL and nothing else - no token, no account, no row id - so
  every write stays in the main turn with the right account's credential (see
  ../server/src/prompt.js's buildAutofillPrompt).

  ---- Why one run and not one per person, unlike run-search.ps1.
  A search is a different job for each person: different companies, resume,
  scope, doc and schedule. This is the same job however many people there are -
  open a posting, write down what it says - and the queue is empty on most
  nights for most accounts. A task per account would mean N headless CLI
  startups a night, nearly all of them to discover there is nothing to do.

  ---- How it stays scoped to one account at a time anyway.
  The API has no cross-user route and this doesn't add one: every request is
  still made with one person's session token and answered from their rows
  alone (see ../server/src/db.js - a `Db` is bound to one user id at
  construction, so no query can forget to filter). What changes is only that
  one CLI turn makes those requests for several accounts in sequence.

  Tokens are passed as TRACKER_TOKEN_1..N environment variables and the prompt
  uses them by name, so the values are expanded by the shell inside curl and
  never enter the model's context or this log - the same handling run-search.ps1
  gives its single TRACKER_API_TOKEN.

  Every account must be on the same tracker deployment; an account pointing at
  a different URL is skipped and named, since one run has one TRACKER_URL.

  Logs to <DataDir>\logs\applications.log - the machine's log, not any one
  person's, because the run isn't any one person's either.

.PARAMETER DataDir
  Path to the private data folder (the "silo"), holding one folder per person.
  Defaults to the JOB_SEARCH_DATA_DIR environment variable, then to a "private"
  folder next to this repo.

.PARAMETER User
  Only fill this one user id's applications, instead of everyone's. For trying
  it by hand; the scheduled task passes no -User.

.EXAMPLE
  .\run-fill.ps1
  .\run-fill.ps1 -User ab266b6c-00cc-45d1-92ac-cdad412c1558
#>
param(
    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" }),

    [string]$User
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $DataDir)) {
    Write-Error "Data dir not found: $DataDir`nSet -DataDir, or the JOB_SEARCH_DATA_DIR environment variable, to your private job-search data folder."
    exit 1
}
$DataDir = (Resolve-Path $DataDir).Path

$logDir = Join-Path $DataDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "applications.log"

# -Encoding utf8 is not optional - see the same note in run-search.ps1. Windows
# PowerShell 5.1's Out-File defaults to UTF-16LE, and appending that to a file
# already started as UTF-8 produces one file with two encodings in it.
function Log($msg) {
    "$(Get-Date -Format o) - $msg" | Out-File -Append -Encoding utf8 -FilePath $logFile
}

Log "===== starting applications fill ====="
Log "data dir:         $DataDir"

# Same discovery as setup-scheduler.ps1: a person is a folder with a
# tracker.json in it. The pre-multi-user layout (no per-user folders,
# credentials in the environment) is still supported as one unnamed account.
$accounts = @()
foreach ($dir in (Get-ChildItem $DataDir -Directory | Sort-Object Name)) {
    $trackerFile = Join-Path $dir.FullName "tracker.json"
    if (-not (Test-Path $trackerFile)) { continue }
    if ($User -and $dir.Name -ne $User) { continue }
    $tracker = Get-Content -Raw -Path $trackerFile | ConvertFrom-Json
    $accounts += [pscustomobject]@{ Id = $dir.Name; Url = $tracker.url.TrimEnd("/"); Token = $tracker.token }
}
if ($accounts.Count -eq 0 -and -not $User -and $env:TRACKER_URL -and $env:TRACKER_API_TOKEN) {
    $accounts += [pscustomobject]@{ Id = "(single-user)"; Url = $env:TRACKER_URL.TrimEnd("/"); Token = $env:TRACKER_API_TOKEN }
}

if ($accounts.Count -eq 0) {
    Log "ERROR: no accounts found under $DataDir - nothing to fill"
    Write-Error "No accounts found. Each person needs <DataDir>\<user-id>\tracker.json - see ../private.example/README.md."
    exit 1
}

# One run has one TRACKER_URL, so accounts on another deployment can't be part
# of it. Named and skipped rather than silently dropped: a person whose
# applications quietly stop filling in has no way to notice from the page.
$trackerUrl = $accounts[0].Url
$offDeployment = @($accounts | Where-Object { $_.Url -ne $trackerUrl })
if ($offDeployment.Count -gt 0) {
    foreach ($a in $offDeployment) {
        Log "WARNING: skipping $($a.Id) - its tracker.json points at $($a.Url), not $trackerUrl"
        Write-Warning "Skipping $($a.Id): it is on a different tracker deployment ($($a.Url))."
    }
    $accounts = @($accounts | Where-Object { $_.Url -eq $trackerUrl })
}

Log "tracker:          $trackerUrl"
Log "accounts:         $($accounts.Count) ($(($accounts | ForEach-Object { $_.Id }) -join ', '))"

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

# The prompt is the same text for every account (see ../server/src/prompt.js's
# buildAutofillPrompt), so any account's token can fetch it. A failure here is
# fatal and loud rather than skipped: running no prompt would look exactly like
# a night where every queue happened to be empty.
try {
    $promptBody = Invoke-RestMethod -Uri "$trackerUrl/api/prompt/_applications" `
        -Headers @{ Authorization = "Bearer $($accounts[0].Token)" } -ErrorAction Stop
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    $hint = if ($status -eq 401) { "the token in $($accounts[0].Id)'s tracker.json isn't valid (revoked, or from another deployment)" } else { $_.Exception.Message }
    Log "ERROR: couldn't fetch the fill prompt ($status): $hint"
    Write-Error "Couldn't fetch the fill prompt ($status): $hint"
    exit 1
}
if (-not $promptBody) {
    Log "ERROR: the tracker returned an empty fill prompt"
    Write-Error "The tracker returned an empty fill prompt."
    exit 1
}

# Which accounts tonight's run covers, and where each one's token is. This is
# machine-specific knowledge - the composed prompt has no idea how many people
# are set up here - which is why it is assembled at this end, the same reason
# the headless preamble below lives here rather than in the tracker's copy.
#
# The variable names go in; the tokens do not. The model writes
# `-H "Authorization: Bearer $TRACKER_TOKEN_1"` and the shell fills it in, so
# no token reaches the model's context or this log.
$accountLines = @()
for ($i = 0; $i -lt $accounts.Count; $i++) {
    $accountLines += "  - account $($i + 1): token is in the environment variable TRACKER_TOKEN_$($i + 1)"
}
$accountNote = @"
Tonight this run covers $($accounts.Count) account$(if ($accounts.Count -ne 1) { 's' }) on this machine:

$($accountLines -join "`n")

Work through them in that order, one at a time. TRACKER_URL is the same for
all of them. Never print a token, and never reuse one account's ids or token
against another account.
"@

# This runs as a single headless, non-interactive `claude -p` turn - the same
# constraint run-search.ps1 documents at length, and for the same reason: this
# process exits as soon as the turn ends, so anything backgrounded is killed
# mid-flight and nothing gets written back.
#
# The line this one has to walk that run-search.ps1 doesn't: the prompt asks
# for subagents on purpose (one per posting, see buildAutofillPrompt's step 2),
# so "don't use subagents" would be the wrong instruction. What kills a headless
# run is not a subagent, it is *ending the turn while work is still outstanding*
# - so the rule below is about waiting for them, not about avoiding them.
$prompt = @"
IMPORTANT: this is one single non-interactive headless run. This process
exits as soon as your turn ends, and nobody reads any message after that -
there is no follow-up turn.

Subagents are expected here and the prompt below tells you when to use them.
What you must not do is end your turn with work still outstanding: wait for
every subagent you dispatch and use its result, and do not hand any part of
this off to a backgrounded Bash command or a background agent and finish early
saying you will report back. Anything still running when your turn ends is
killed with this process, and nothing it found gets written back.

$accountNote

$promptBody
"@

# Task is the subagent tool - the fan-out in step 2 needs it. No Write/Edit:
# this run reads job postings and posts what they say. It has no files to
# change, and the applications it fills in are the least recoverable rows in
# the database.
$allowedTools = "Task Read Glob Grep WebSearch WebFetch Bash"

Log "prompt:           $($promptBody.Length) chars from $trackerUrl/api/prompt/_applications"
Log "claude CLI:       $claudePath"
Log "allowed tools:    $allowedTools"
Log "CLAUDE_CODE_OAUTH_TOKEN set: $([bool]$env:CLAUDE_CODE_OAUTH_TOKEN)"

$job = Start-Job -ScriptBlock {
    param($claudePath, $prompt, $allowedTools, $workDir, $trackerUrl, $tokens)
    Set-Location $workDir
    # Set inside the script block because Start-Job runs in its own process.
    $env:TRACKER_URL = $trackerUrl
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        Set-Item -Path "env:TRACKER_TOKEN_$($i + 1)" -Value $tokens[$i]
    }
    # The claude CLI writes UTF-8; without this PowerShell decodes its stdout
    # using the console's OEM codepage and mangles every non-ASCII character
    # before it reaches the log.
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    & $claudePath -p $prompt --allowedTools $allowedTools 2>&1
} -ArgumentList $claudePath, $prompt, $allowedTools, $DataDir, $trackerUrl, @($accounts | ForEach-Object { $_.Token })

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

# The CLI exiting cleanly is not the same as the CLI having done anything.
# An unauthenticated run prints "Not logged in - Please run /login" and exits
# 0, which is what this script did on its first real invocation: job state
# Completed, exit code 0, twenty seconds, nothing filled in. Task Scheduler
# recorded a success.
#
# That matters more here than it would elsewhere, because this job deliberately
# writes no run record (see ../server/src/prompt.js) - the evidence it stopped
# is supposed to be a row that stayed blank, which is indistinguishable from a
# posting nobody could read. So the one signal that exists, the task's Last Run
# Result, has to be honest.
#
# Checked against the output rather than by pre-flighting the credential: the
# token is read by the CLI in a child process, and what matters is whether that
# process could use it, not whether this one can see it.
$exitCode = if ($jobState -eq "Completed") { 0 } else { 1 }
$outputText = if ($output) { ($output | Out-String).Trim() } else { "" }
if (-not $outputText) {
    Log "ERROR: the CLI produced no output at all - nothing was filled in"
    $exitCode = 1
} elseif ($outputText -match "Not logged in|Please run /login|Invalid API key|authentication_error") {
    Log "ERROR: the CLI is not authenticated - nothing was filled in."
    Log "       Run ``claude setup-token``, then: setx CLAUDE_CODE_OAUTH_TOKEN ""<token>"""
    $exitCode = 1
}

$elapsed = [int]((Get-Date) - $start).TotalSeconds
Log "finished - job state: $jobState, elapsed: ${elapsed}s, exit code: $exitCode"
Log "===== done ====="

exit $exitCode
