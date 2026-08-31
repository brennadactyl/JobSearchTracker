<#
.SYNOPSIS
  Runs one daily job-search prompt through the Claude Code CLI.

.DESCRIPTION
  Generic runner - contains no personal data itself. It reads a prompt file from
  <DataDir>\scheduled-tasks\<Task>.md, runs it non-interactively via `claude -p`,
  and logs output to <DataDir>\logs\<Task>.log. Working directory is set to
  <DataDir> so the relative paths inside the prompt (docs/..., resumes/..., etc.)
  resolve correctly.

  Runs with a scoped tool allowlist (Read/Write/Edit/Glob/Grep/WebSearch/WebFetch/
  Bash) so it doesn't stall on a permission prompt with nobody there to answer
  it. Bash is unscoped rather than limited to e.g. "Bash(curl:*)" - a narrower
  pattern blocked the model from even checking whether TRACKER_URL/
  TRACKER_API_TOKEN were set before attempting curl, since env-checking
  commands (printenv etc.) didn't match the pattern. The prompt syncs new
  postings to the tracker API via `curl`, which needs TRACKER_URL and
  TRACKER_API_TOKEN set as environment variables (see ../server/README.md) -
  if they're missing, the search and doc update still run, the sync step is
  just skipped.

  Logs a config summary at the start, a heartbeat line every 20s while the
  search is running (searches take several minutes - without this the log
  looks identical whether it's working or stuck), and the full output plus
  exit status at the end.

.PARAMETER Task
  Which search to run - any name with a matching <DataDir>\scheduled-tasks\<Task>.md
  file (e.g. "engineering", "data-science", whatever tracks you've set up).
  Not a fixed list: this runner has no opinion on how many tracks you have or
  what they're called, only that a prompt file exists for the one you name.

.PARAMETER DataDir
  Path to the private data folder (the "silo") holding docs/, resumes/,
  reference/, scheduled-tasks/. Defaults to the JOB_SEARCH_DATA_DIR
  environment variable, then to a "private" folder next to this repo.

.EXAMPLE
  .\run-search.ps1 -Task engineering
  .\run-search.ps1 -Task product -DataDir "D:\JobSearchData"
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Task,

    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" })
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $DataDir)) {
    Write-Error "Data dir not found: $DataDir`nSet -DataDir, or the JOB_SEARCH_DATA_DIR environment variable, to your private job-search data folder."
    exit 1
}
$DataDir = (Resolve-Path $DataDir).Path

$promptFile = Join-Path $DataDir "scheduled-tasks\$Task.md"
if (-not (Test-Path $promptFile)) {
    $tasksDir = Join-Path $DataDir "scheduled-tasks"
    $available = if (Test-Path $tasksDir) {
        (Get-ChildItem $tasksDir -Filter "*.md" | ForEach-Object { $_.BaseName }) -join ", "
    } else { $null }
    $hint = if ($available) { "Available tasks: $available" } else { "No .md files found in $tasksDir either." }
    Write-Error "Prompt file not found: $promptFile`n$hint"
    exit 1
}

$logDir = Join-Path $DataDir "logs"
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

$promptBody = Get-Content -Raw -Path $promptFile

# This runs as a single headless, non-interactive `claude -p` turn - nobody is
# there to read a "kicked off as a background agent, I'll report back" reply.
# If the model backgrounds any part of the work (a Bash run_in_background
# call, or a subagent), this process's background-task wait ceiling (600s by
# default) kills it and exits before the search finishes - it never gets to
# verify postings, sync leads, or record the run. Confirmed happening for
# real on 2026-08-30 (technical-pm run): the model backgrounded the whole
# search, the ceiling hit, and nothing was synced or recorded even though
# Task Scheduler saw exit code 0. So the prompt has to say explicitly, every
# run, not to do that - the per-track .md files can't be trusted to always
# include this on their own since they're per-installer generated copies.
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

Log "===== starting $Task ====="
Log "data dir:        $DataDir"
Log "prompt file:      $promptFile ($((Get-Item $promptFile).Length) bytes)"
Log "claude CLI:      $claudePath"
Log "allowed tools:    $allowedTools"
Log "CLAUDE_CODE_OAUTH_TOKEN set: $([bool]$env:CLAUDE_CODE_OAUTH_TOKEN)"
Log "TRACKER_URL set:            $([bool]$env:TRACKER_URL)"
Log "TRACKER_API_TOKEN set:      $([bool]$env:TRACKER_API_TOKEN)"

$job = Start-Job -ScriptBlock {
    param($claudePath, $prompt, $allowedTools, $dataDir)
    Set-Location $dataDir
    # The claude CLI writes UTF-8. Without this, PowerShell decodes its stdout
    # using the console's OEM codepage instead, so every non-ASCII character
    # the model writes is mangled before it ever reaches the log file - an
    # em-dash lands as "-o" garbage, and no amount of fixing the file's own
    # encoding recovers it, because the damage happened upstream of the write.
    # Set inside the script block on purpose: Start-Job runs in its own
    # process, so setting this in the parent would have no effect here.
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    & $claudePath -p $prompt --allowedTools $allowedTools 2>&1
} -ArgumentList $claudePath, $prompt, $allowedTools, $DataDir

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
