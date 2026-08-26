<#
.SYNOPSIS
  Registers the three daily job-search searches as Windows Scheduled Tasks.

.DESCRIPTION
  Generic setup script — contains no personal data. Registers three tasks that
  each invoke run-search.ps1 for one search track, daily, at staggered local
  times so they don't race on the shared tracker artifact. Safe to re-run:
  existing tasks with the same names are replaced.

  Prerequisites checked/warned about, not auto-fixed:
    - Node.js + the claude CLI (npm install -g @anthropic-ai/claude-code)
    - CLAUDE_CODE_OAUTH_TOKEN set for your account (run `claude setup-token`,
      then `setx CLAUDE_CODE_OAUTH_TOKEN "<token>"`) so headless runs authenticate
    - Your private data folder (docs/, resumes/, reference/, tracker/,
      scheduled-tasks/) in place — see private.example/README.md in this repo

.PARAMETER DataDir
  Path to the private data folder. Defaults to the JOB_SEARCH_DATA_DIR
  environment variable, then to a "private" folder next to this repo.

.PARAMETER Times
  Local HH:mm times for engineering / technical-pm / product, in that order.
  Defaults to 08:00 / 08:30 / 09:00.

.EXAMPLE
  .\setup-scheduler.ps1
  .\setup-scheduler.ps1 -DataDir "D:\JobSearchData" -Times "07:00","07:30","08:00"
#>
param(
    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" }),
    [string[]]$Times = @("08:00", "08:30", "09:00")
)

$ErrorActionPreference = "Stop"
$runScript = Join-Path $PSScriptRoot "run-search.ps1"

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

if (-not (Test-Path $DataDir)) {
    Write-Warning "Data dir not found: $DataDir"
    Write-Warning "Scheduled tasks will be created but will fail until this exists. See private.example/README.md."
} else {
    Write-Host "Data dir: $((Resolve-Path $DataDir).Path)"
}

Write-Host "`n== Registering scheduled tasks ==" -ForegroundColor Cyan

$tasks = @(
    @{ Name = "JobSearch-Engineering"; Task = "engineering";   Time = $Times[0] }
    @{ Name = "JobSearch-TechnicalPM"; Task = "technical-pm";  Time = $Times[1] }
    @{ Name = "JobSearch-Product";     Task = "product";       Time = $Times[2] }
)

foreach ($t in $tasks) {
    $action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runScript`" -Task $($t.Task) -DataDir `"$DataDir`""
    schtasks /Create /TN $t.Name /TR $action /SC DAILY /ST $t.Time /F | Out-Null
    Write-Host "  $($t.Name) — daily at $($t.Time)"
}

Write-Host "`nDone. Tasks run only while you're logged in (no stored password required)." -ForegroundColor Green
Write-Host "Test one now with, e.g.: schtasks /Run /TN JobSearch-Engineering"
Write-Host "View/manage them in Task Scheduler under the root task folder, or: schtasks /Query /TN JobSearch-Engineering /V /FO LIST"
