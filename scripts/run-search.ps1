<#
.SYNOPSIS
  Runs one daily job-search prompt through the Claude Code CLI.

.DESCRIPTION
  Generic runner - contains no personal data itself. It fetches the prompt for
  one track from the tracker API (`GET /api/prompt/<task>`), runs it
  non-interactively via `claude -p`, and logs output to
  <DataDir>\<User>\logs\<Task>.log. Working directory is set to the user's
  folder so the relative paths inside the prompt (docs/..., resumes/...)
  resolve correctly.

  The prompt is composed server-side from that track's config in D1, not read
  from a file here. That's what lets one machine run several people's searches
  without holding several people's search config, and what keeps the API's own
  calling convention (the curl steps) defined in one place instead of copied
  into a prompt file per track. See ../server/src/prompt.js.

  Runs with a scoped tool allowlist (Read/Write/Edit/Glob/Grep/WebSearch/WebFetch/
  Bash) so it doesn't stall on a permission prompt with nobody there to answer
  it. Bash is unscoped rather than limited to e.g. "Bash(curl:*)" - a narrower
  pattern blocked the model from even checking whether TRACKER_URL/
  TRACKER_API_TOKEN were set before attempting curl, since env-checking
  commands (printenv etc.) didn't match the pattern.

  Logs a config summary at the start, a heartbeat line every 20s while the
  search is running (searches take several minutes - without this the log
  looks identical whether it's working or stuck), and the full output plus
  exit status at the end.

.PARAMETER Task
  Which track to run - any key configured for this user in the tracker (e.g.
  "SWE", "engineering"). Not a fixed list: the runner has no opinion on how
  many tracks exist or what they're called, only that the API has config for
  the one you name.

.PARAMETER User
  Which person's search this is - the user id (a GUID) whose folder under
  <DataDir> holds their resumes, docs, logs, and tracker.json credentials.
  Omit it for a single-user machine, where those live in <DataDir> directly
  and the credentials come from the environment.

.PARAMETER DataDir
  Path to the private data folder (the "silo"). With -User, it holds one
  folder per person; without, it holds one person's docs/, resumes/, logs/
  directly. Defaults to the JOB_SEARCH_DATA_DIR environment variable, then to
  a "private" folder next to this repo.

.EXAMPLE
  .\run-search.ps1 -Task SWE -User ab266b6c-00cc-45d1-92ac-cdad412c1558
  .\run-search.ps1 -Task engineering                 # single-user machine
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Task,

    [string]$User,

    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" })
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $DataDir)) {
    Write-Error "Data dir not found: $DataDir`nSet -DataDir, or the JOB_SEARCH_DATA_DIR environment variable, to your private job-search data folder."
    exit 1
}
$DataDir = (Resolve-Path $DataDir).Path

# One folder per person when -User is given; the data dir itself otherwise, so
# a machine that was set up before there was more than one person keeps working
# untouched.
$workDir = if ($User) { Join-Path $DataDir $User } else { $DataDir }
if (-not (Test-Path $workDir)) {
    Write-Error "User folder not found: $workDir`nSee private.example/README.md for the expected layout."
    exit 1
}

# Credentials live next to the data they belong to, not in the machine's
# environment: one machine runs several people's searches, and an environment
# variable can only hold one person's token. The environment stays as the
# fallback for a single-user machine that predates this.
$trackerFile = Join-Path $workDir "tracker.json"
if (Test-Path $trackerFile) {
    $tracker = Get-Content -Raw -Path $trackerFile | ConvertFrom-Json
    $trackerUrl = $tracker.url
    $trackerToken = $tracker.token
} else {
    $trackerUrl = $env:TRACKER_URL
    $trackerToken = $env:TRACKER_API_TOKEN
}

if (-not $trackerUrl -or -not $trackerToken) {
    Write-Error "No tracker credentials. Create $trackerFile with {`"url`": `"...`", `"token`": `"...`"}, or set TRACKER_URL and TRACKER_API_TOKEN. See ../server/README.md."
    exit 1
}
$trackerUrl = $trackerUrl.TrimEnd("/")

$logDir = Join-Path $workDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "$Task.log"

# -Encoding utf8 is not optional here. Windows PowerShell 5.1's Out-File
# defaults to UTF-16LE, but this log file may already have been started as
# UTF-8 by an earlier version of this script - appending the default encoding
# to it produces one file with two encodings in it, which grep reports as
# binary and Get-Content silently decodes only the first half of, showing a
# stale tail that looks like the searches stopped running. Pin it explicitly
# on every writer (there are two - see the claude-output append below).
function Log($msg) {
    "$(Get-Date -Format o) - $msg" | Out-File -Append -Encoding utf8 -FilePath $logFile
}

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

# The prompt comes from the tracker, composed from this track's config. A
# failure here is fatal and loud: running a stale or empty prompt would look
# like a search that ran and found nothing, which is the exact ambiguity the
# run record exists to prevent.
Log "===== starting $Task ====="
Log "data dir:         $DataDir"
Log "work dir:         $workDir"
Log "user:             $(if ($User) { $User } else { '(single-user machine)' })"
Log "tracker:          $trackerUrl"
Log "credentials from: $(if (Test-Path $trackerFile) { $trackerFile } else { 'environment' })"

try {
    $promptBody = Invoke-RestMethod -Uri "$trackerUrl/api/prompt/$Task" -Headers @{ Authorization = "Bearer $trackerToken" } -ErrorAction Stop
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    $hint = switch ($status) {
        401 { "the token in $trackerFile isn't valid (revoked, or from another deployment)" }
        404 { "no track '$Task' is configured for this user - check the tracker's config" }
        default { $_.Exception.Message }
    }
    Log "ERROR: couldn't fetch the prompt ($status): $hint"
    Write-Error "Couldn't fetch the prompt for '$Task' ($status): $hint"
    exit 1
}
if (-not $promptBody) {
    Log "ERROR: the tracker returned an empty prompt for $Task"
    Write-Error "The tracker returned an empty prompt for '$Task'."
    exit 1
}

# This runs as a single headless, non-interactive `claude -p` turn - nobody is
# there to read a "kicked off as a background agent, I'll report back" reply.
# If the model backgrounds any part of the work (a Bash run_in_background
# call, or a subagent), this process's background-task wait ceiling (600s by
# default) kills it and exits before the search finishes - it never gets to
# verify postings, sync leads, or record the run. Confirmed happening for
# real on 2026-08-30 (technical-pm run): the model backgrounded the whole
# search, the ceiling hit, and nothing was synced or recorded even though
# Task Scheduler saw exit code 0. So the prompt has to say explicitly, every
# run, not to do that - it's about how this runner invokes the CLI, which is
# why it's here and not in the prompt the tracker composes.
$prompt = @"
IMPORTANT: this is one single non-interactive headless run. This process
exits as soon as your turn ends, and nobody reads any message after that -
there is no follow-up turn. Do all of the work below yourself, synchronously,
in this one turn. Do not hand any part of it (web searches, URL
verification, curl calls, or the task as a whole) off to a backgrounded Bash
command or a background subagent and end your turn early saying you'll
report back - a backgrounded task does not survive this process exiting, so
it would be killed mid-run and nothing would get verified, synced, or
recorded. If the work risks running long, that's fine - just do it inline;
do not shorten or skip verification steps to save time either.

$promptBody
"@
$allowedTools = "Read Write Edit Glob Grep WebSearch WebFetch Bash"

Log "prompt:           $($promptBody.Length) chars from $trackerUrl/api/prompt/$Task"
Log "claude CLI:       $claudePath"
Log "allowed tools:    $allowedTools"
Log "CLAUDE_CODE_OAUTH_TOKEN set: $([bool]$env:CLAUDE_CODE_OAUTH_TOKEN)"

$job = Start-Job -ScriptBlock {
    param($claudePath, $prompt, $allowedTools, $workDir, $trackerUrl, $trackerToken)
    Set-Location $workDir
    # The prompt's own curl calls read these from the environment. Set inside
    # the script block because Start-Job runs in its own process - and set from
    # the resolved per-user values, so two people's searches on one machine
    # each authenticate as themselves.
    $env:TRACKER_URL = $trackerUrl
    $env:TRACKER_API_TOKEN = $trackerToken
    # The claude CLI writes UTF-8. Without this, PowerShell decodes its stdout
    # using the console's OEM codepage instead, so every non-ASCII character
    # the model writes is mangled before it ever reaches the log file - an
    # em-dash lands as "-o" garbage, and no amount of fixing the file's own
    # encoding recovers it, because the damage happened upstream of the write.
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    & $claudePath -p $prompt --allowedTools $allowedTools 2>&1
} -ArgumentList $claudePath, $prompt, $allowedTools, $workDir, $trackerUrl, $trackerToken

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

$exitCode = if ($jobState -eq "Completed") { 0 } else { 1 }
$elapsed = [int]((Get-Date) - $start).TotalSeconds
Log "finished $Task - job state: $jobState, elapsed: ${elapsed}s, exit code: $exitCode"
Log "===== done ====="

exit $exitCode
