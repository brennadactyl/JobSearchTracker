<#
.SYNOPSIS
  Runs one of the three daily job-search prompts through the Claude Code CLI.

.DESCRIPTION
  Generic runner — contains no personal data itself. It reads a prompt file from
  <DataDir>\scheduled-tasks\<Task>.md, runs it non-interactively via `claude -p`,
  and logs output to <DataDir>\logs\<Task>.log. Working directory is set to
  <DataDir> so the relative paths inside the prompt (docs/..., resumes/..., etc.)
  resolve correctly.

.PARAMETER Task
  Which search to run: engineering | technical-pm | product

.PARAMETER DataDir
  Path to the private data folder (the "silo") holding docs/, resumes/,
  reference/, tracker/, scheduled-tasks/. Defaults to the JOB_SEARCH_DATA_DIR
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

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    $fallback = Join-Path $env:APPDATA "npm\claude.cmd"
    if (Test-Path $fallback) { $claude = $fallback } else {
        "$(Get-Date -Format o) — claude CLI not found on PATH or at $fallback" | Out-File -Append $logFile
        Write-Error "claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
        exit 1
    }
}

$prompt = Get-Content -Raw -Path $promptFile

Push-Location $DataDir
try {
    "$(Get-Date -Format o) — starting $Task" | Out-File -Append $logFile
    & $claude -p $prompt *>> $logFile
    $exitCode = $LASTEXITCODE
    "$(Get-Date -Format o) — finished $Task (exit $exitCode)" | Out-File -Append $logFile
    exit $exitCode
}
finally {
    Pop-Location
}
