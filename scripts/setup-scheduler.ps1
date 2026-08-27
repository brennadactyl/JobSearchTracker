<#
.SYNOPSIS
  Registers every daily job-search track as a Windows Scheduled Task.

.DESCRIPTION
  Generic setup script - contains no personal data. Discovers tracks by
  scanning <DataDir>\scheduled-tasks\*.md (one file per track - see
  run-search.ps1 and private.example/README.md), then registers one daily
  task per track, at staggered local times so they don't race on the shared
  tracker artifact. Not tied to any fixed number or names of tracks: add or
  remove a .md file in scheduled-tasks/ and the next run of this script
  picks up the change.

  Safe to re-run: existing tasks for a still-present track are replaced in
  place; tasks left over from a track that no longer has a .md file (e.g.
  you renamed or removed one, or ran an older version of this script that
  used fixed track names) are unregistered.

  Prerequisites checked/warned about, not auto-fixed:
    - Node.js + the claude CLI (npm install -g @anthropic-ai/claude-code)
    - CLAUDE_CODE_OAUTH_TOKEN set for your account (run `claude setup-token`,
      then `setx CLAUDE_CODE_OAUTH_TOKEN "<token>"`) so headless runs authenticate
    - TRACKER_URL and TRACKER_API_TOKEN set (see ../worker/README.md) so runs
      can sync new postings to the tracker webpage
    - Your private data folder (docs/, resumes/, reference/, scheduled-tasks/)
      in place - see private.example/README.md in this repo

.PARAMETER DataDir
  Path to the private data folder. Defaults to the JOB_SEARCH_DATA_DIR
  environment variable, then to a "private" folder next to this repo.

.PARAMETER Times
  Local HH:mm start times, one per discovered track, in the same order as
  the tracks sorted alphabetically by file name. If omitted, tracks are
  staggered automatically starting at 08:00, 30 minutes apart. If supplied,
  must have exactly as many entries as there are tracks.

.EXAMPLE
  .\setup-scheduler.ps1
  .\setup-scheduler.ps1 -DataDir "D:\JobSearchData" -Times "07:00","07:30","08:00"
#>
param(
    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" }),
    [string[]]$Times
)

$ErrorActionPreference = "Stop"
$runScript = Join-Path $PSScriptRoot "run-search.ps1"

# Turns a track key like "technical-pm" into a Windows Task Scheduler name
# suffix like "TechnicalPm" - not meant to reproduce any particular past
# naming exactly, just to keep generated task names readable.
function ConvertTo-TaskSuffix([string]$key) {
    ($key -split "[-_]" | Where-Object { $_ } | ForEach-Object {
        $_.Substring(0, 1).ToUpper() + $_.Substring(1)
    }) -join ""
}

function New-DefaultTimes([int]$count) {
    $base = [datetime]"08:00"
    0..($count - 1) | ForEach-Object { $base.AddMinutes(30 * $_).ToString("HH:mm") }
}

Write-Host "== Checking prerequisites ==" -ForegroundColor Cyan

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    Write-Warning "claude CLI not found on PATH. Install Node.js, then: npm install -g @anthropic-ai/claude-code"
} else {
    Write-Host "claude CLI found: $($claude.Source)"
}

if (-not $env:CLAUDE_CODE_OAUTH_TOKEN) {
    Write-Warning "CLAUDE_CODE_OAUTH_TOKEN is not set for this user. Headless/scheduled runs will fail to authenticate."
    Write-Warning 'Run `claude setup-token`, then `setx CLAUDE_CODE_OAUTH_TOKEN "<token>"`, then open a new terminal.'
} else {
    Write-Host "CLAUDE_CODE_OAUTH_TOKEN is set."
}

if (-not $env:TRACKER_URL -or -not $env:TRACKER_API_TOKEN) {
    Write-Warning "TRACKER_URL and/or TRACKER_API_TOKEN are not set. Runs will still search and update the local docs, but won't sync new postings to the tracker webpage."
    Write-Warning "See ..\worker\README.md to deploy the webpage and get these values, then: setx TRACKER_URL `"...`" and setx TRACKER_API_TOKEN `"...`""
} else {
    Write-Host "TRACKER_URL and TRACKER_API_TOKEN are set."
}

if (-not (Test-Path $DataDir)) {
    Write-Warning "Data dir not found: $DataDir"
    Write-Warning "Scheduled tasks will be created but will fail until this exists. See private.example/README.md."
} else {
    Write-Host "Data dir: $((Resolve-Path $DataDir).Path)"
}

Write-Host "`n== Discovering tracks ==" -ForegroundColor Cyan

$tasksDir = Join-Path $DataDir "scheduled-tasks"
$trackFiles = if (Test-Path $tasksDir) { Get-ChildItem $tasksDir -Filter "*.md" | Sort-Object Name } else { @() }

if ($trackFiles.Count -eq 0) {
    Write-Warning "No .md files found in $tasksDir - nothing to schedule."
    Write-Warning "Add one prompt file per track (e.g. scheduled-tasks\engineering.md) - see private.example/README.md."
    exit 1
}

$keys = $trackFiles | ForEach-Object { $_.BaseName }
Write-Host "Found $($keys.Count) track(s): $($keys -join ', ')"

if ($Times) {
    if ($Times.Count -ne $keys.Count) {
        Write-Error "-Times has $($Times.Count) entr$(if ($Times.Count -eq 1) {'y'} else {'ies'}) but there are $($keys.Count) tracks ($($keys -join ', ')). Pass exactly one time per track, or omit -Times to auto-stagger."
        exit 1
    }
} else {
    $Times = New-DefaultTimes $keys.Count
}

Write-Host "`n== Registering scheduled tasks ==" -ForegroundColor Cyan

$tasks = for ($i = 0; $i -lt $keys.Count; $i++) {
    @{ Name = "JobSearch-" + (ConvertTo-TaskSuffix $keys[$i]); Task = $keys[$i]; Time = $Times[$i] }
}

foreach ($t in $tasks) {
    $action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runScript`" -Task $($t.Task) -DataDir `"$DataDir`""
    schtasks /Create /TN $t.Name /TR $action /SC DAILY /ST $t.Time /F | Out-Null
    Write-Host "  $($t.Name) - daily at $($t.Time) (-Task $($t.Task))"
}

$currentNames = $tasks | ForEach-Object { $_.Name }
$stale = Get-ScheduledTask -TaskName "JobSearch-*" -ErrorAction SilentlyContinue |
    Where-Object { $currentNames -notcontains $_.TaskName }
if ($stale) {
    Write-Host "`n== Removing stale scheduled tasks (no matching track file) ==" -ForegroundColor Cyan
    foreach ($s in $stale) {
        Unregister-ScheduledTask -TaskName $s.TaskName -Confirm:$false
        Write-Host "  removed $($s.TaskName)"
    }
}

Write-Host "`nDone. Tasks run only while you're logged in (no stored password required)." -ForegroundColor Green
Write-Host "Test one now with, e.g.: schtasks /Run /TN $($tasks[0].Name)"
Write-Host "View/manage them in Task Scheduler under the root task folder, or: schtasks /Query /TN $($tasks[0].Name) /V /FO LIST"
