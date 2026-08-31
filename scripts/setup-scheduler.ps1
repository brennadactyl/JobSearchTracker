<#
.SYNOPSIS
  Registers every tracked search as a Windows Scheduled Task, for every person
  set up on this machine.

.DESCRIPTION
  Generic setup script - contains no personal data. Discovers people by
  scanning <DataDir>\*\tracker.json (one folder per user id - see
  run-search.ps1 and private.example/README.md), asks each one's tracker
  account what tracks it has via GET /api/config, and registers one daily task
  per track at that track's configured time. Not tied to any fixed number or
  names of tracks, or to one person: add a track in the tracker, or add a
  person's folder, and the next run of this script picks it up.

  Safe to re-run: existing tasks for a still-present track are replaced in
  place; tasks left over from a track that no longer exists are unregistered.
  **Cleanup is scoped to the people this run actually processed** - a machine
  with two users must not have setting up the second one silently unregister
  the first one's schedule, which is what a blanket "remove every JobSearch-*
  task not in my list" would do.

  A single-user machine that predates per-user folders (no <DataDir>\*\tracker.json,
  credentials in TRACKER_URL/TRACKER_API_TOKEN) is still supported: it's
  treated as one unnamed user whose work dir is <DataDir> itself.

  Prerequisites checked/warned about, not auto-fixed:
    - Node.js + the claude CLI (npm install -g @anthropic-ai/claude-code)
    - CLAUDE_CODE_OAUTH_TOKEN set for your account (run `claude setup-token`,
      then `setx CLAUDE_CODE_OAUTH_TOKEN "<token>"`) so headless runs
      authenticate. Note this is the *machine owner's* Claude account, and
      every person's searches on this machine run through it.
    - Each person's <DataDir>\<user-id>\tracker.json holding their own
      tracker URL and session token (see ../server/README.md)

.PARAMETER DataDir
  Path to the private data folder. Defaults to the JOB_SEARCH_DATA_DIR
  environment variable, then to a "private" folder next to this repo.

.PARAMETER User
  Only set up this one user id, leaving everyone else's tasks alone. Omit to
  process every person found under DataDir.

.EXAMPLE
  .\setup-scheduler.ps1
  .\setup-scheduler.ps1 -DataDir "D:\JobSearchData" -User ab266b6c-00cc-45d1-92ac-cdad412c1558
#>
param(
    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" }),
    [string]$User
)

$ErrorActionPreference = "Stop"
$runScript = Join-Path $PSScriptRoot "run-search.ps1"

# Turns a track key like "technical-pm" into a Windows Task Scheduler name
# suffix like "TechnicalPm" - not meant to reproduce any particular past
# naming exactly, just to keep generated task names readable.
function ConvertTo-TaskSuffix([string]$key) {
    ($key -split "[-_ ]" | Where-Object { $_ } | ForEach-Object {
        $_.Substring(0, 1).ToUpper() + $_.Substring(1)
    }) -join ""
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

if (-not (Test-Path $DataDir)) {
    Write-Error "Data dir not found: $DataDir. See private.example/README.md."
    exit 1
}
$DataDir = (Resolve-Path $DataDir).Path
Write-Host "Data dir: $DataDir"

Write-Host "`n== Discovering people ==" -ForegroundColor Cyan

$people = @()
foreach ($dir in (Get-ChildItem $DataDir -Directory | Sort-Object Name)) {
    $trackerFile = Join-Path $dir.FullName "tracker.json"
    if (-not (Test-Path $trackerFile)) { continue }
    if ($User -and $dir.Name -ne $User) { continue }
    $tracker = Get-Content -Raw -Path $trackerFile | ConvertFrom-Json
    $people += [pscustomobject]@{ Id = $dir.Name; Url = $tracker.url.TrimEnd("/"); Token = $tracker.token }
}

# The pre-multi-user layout: no per-user folders, credentials in the
# environment. Treated as one person with no id, whose tasks keep their
# original "JobSearch-<Track>" names so an existing machine isn't churned.
if ($people.Count -eq 0 -and -not $User -and $env:TRACKER_URL -and $env:TRACKER_API_TOKEN) {
    Write-Host "No per-user folders found - using TRACKER_URL/TRACKER_API_TOKEN for a single-user machine."
    $people += [pscustomobject]@{ Id = ""; Url = $env:TRACKER_URL.TrimEnd("/"); Token = $env:TRACKER_API_TOKEN }
}

if ($people.Count -eq 0) {
    Write-Warning "No people found. Each person needs <DataDir>\<user-id>\tracker.json with their tracker URL and token - see private.example/README.md."
    exit 1
}
Write-Host "Found $($people.Count) $(if ($people.Count -eq 1) {'person'} else {'people'}): $(($people | ForEach-Object { if ($_.Id) { $_.Id } else { '(single-user)' } }) -join ', ')"

Write-Host "`n== Registering scheduled tasks ==" -ForegroundColor Cyan

# Only the prefixes this run is responsible for. Anything outside them belongs
# to a person we weren't asked about, and must survive untouched.
$ownedPrefixes = @()
$registered = @()

foreach ($person in $people) {
    $label = if ($person.Id) { $person.Id } else { "single-user" }
    try {
        $config = Invoke-RestMethod -Uri "$($person.Url)/api/config" -Headers @{ Authorization = "Bearer $($person.Token)" } -ErrorAction Stop
    } catch {
        Write-Warning "Couldn't read config for $label ($($_.Exception.Message)) - skipping. Their existing tasks are left alone."
        continue
    }

    if (-not $config.tracks -or $config.tracks.Count -eq 0) {
        Write-Warning "$label has no tracks configured yet - nothing to schedule. Run the job-search-setup skill for them first."
        continue
    }

    # Task names are prefixed per person so two people's tracks can share a
    # key ("SWE") without colliding, and so cleanup can tell whose is whose.
    $prefix = if ($person.Id) { "JobSearch-$($person.Id.Substring(0, 8))-" } else { "JobSearch-" }
    $ownedPrefixes += $prefix

    # Auto-stagger anything without a configured time, starting at 08:00 and
    # 30 minutes apart. Searches take several minutes each and every person's
    # runs share this machine's one Claude CLI, so overlapping them helps
    # nobody.
    $auto = [datetime]"08:00"
    foreach ($track in ($config.tracks | Sort-Object sort_order, key)) {
        $time = $track.schedule_time
        if (-not $time -or $time -notmatch '^\d{2}:\d{2}$') {
            $time = $auto.ToString("HH:mm")
            $auto = $auto.AddMinutes(30)
        }
        $name = $prefix + (ConvertTo-TaskSuffix $track.key)
        $userArg = if ($person.Id) { " -User $($person.Id)" } else { "" }
        $action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runScript`" -Task $($track.key)$userArg -DataDir `"$DataDir`""
        schtasks /Create /TN $name /TR $action /SC DAILY /ST $time /F | Out-Null
        Write-Host "  $name - daily at $time ($label / $($track.key))"
        $registered += $name
    }
}

if ($ownedPrefixes.Count -gt 0) {
    $stale = Get-ScheduledTask -TaskName "JobSearch-*" -ErrorAction SilentlyContinue | Where-Object {
        $taskName = $_.TaskName
        $mine = $false
        foreach ($p in $ownedPrefixes) { if ($taskName.StartsWith($p)) { $mine = $true } }
        $mine -and ($registered -notcontains $taskName)
    }
    if ($stale) {
        Write-Host "`n== Removing stale tasks (track no longer configured) ==" -ForegroundColor Cyan
        foreach ($s in $stale) {
            Unregister-ScheduledTask -TaskName $s.TaskName -Confirm:$false
            Write-Host "  removed $($s.TaskName)"
        }
    }
}

Write-Host "`nDone. Tasks run only while you're logged in (no stored password required)." -ForegroundColor Green
if ($registered.Count -gt 0) {
    Write-Host "Test one now with, e.g.: schtasks /Run /TN $($registered[0])"
    Write-Host "View/manage them in Task Scheduler under the root task folder, or: schtasks /Query /TN $($registered[0]) /V /FO LIST"
}
