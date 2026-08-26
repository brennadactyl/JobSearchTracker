<#
.SYNOPSIS
  Runs one of the three daily job-search prompts through the Claude Code CLI.

.DESCRIPTION
  Generic runner - contains no personal data itself. It reads a prompt file from
  <DataDir>\scheduled-tasks\<Task>.md, runs it non-interactively via `claude -p`,
  and logs output to <DataDir>\logs\<Task>.log. Working directory is set to
  <DataDir> so the relative paths inside the prompt (docs/..., resumes/..., etc.)
  resolve correctly.

  Runs with a scoped tool allowlist (Read/Write/Edit/Glob/Grep/WebSearch/WebFetch
  plus `curl` via Bash) so it doesn't stall on a permission prompt with nobody
  there to answer it. The prompt syncs new postings to the tracker webpage via
  `curl`, which needs TRACKER_URL and TRACKER_API_TOKEN set as environment
  variables (see ../worker/README.md) - if they're missing, the search and doc
  update still run, the sync step is just skipped.

  Logs a config summary at the start, a heartbeat line every 20s while the
  search is running (searches take several minutes - without this the log
  looks identical whether it's working or stuck), and the full output plus
  exit status at the end.

.PARAMETER Task
  Which search to run: engineering | technical-pm | product

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
    [ValidateSet("engineering", "technical-pm", "product")]
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
    Write-Error "Prompt file not found: $promptFile"
    exit 1
}

$logDir = Join-Path $DataDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "$Task.log"

function Log($msg) {
    "$(Get-Date -Format o) - $msg" | Out-File -Append -FilePath $logFile
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

$prompt = Get-Content -Raw -Path $promptFile
$allowedTools = "Read Write Edit Glob Grep WebSearch WebFetch Bash(curl:*)"

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
if ($output) { $output | Out-String | Out-File -Append -FilePath $logFile }
Log "----- end output -----"

$exitCode = if ($jobState -eq "Completed") { 0 } else { 1 }
$elapsed = [int]((Get-Date) - $start).TotalSeconds
Log "finished $Task - job state: $jobState, elapsed: ${elapsed}s, exit code: $exitCode"
Log "===== done ====="

exit $exitCode
