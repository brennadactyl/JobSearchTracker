<#
.SYNOPSIS
  One-time elevated setup: creates the protected backup archive and the SYSTEM
  task that fills it. Must be run from an Administrator PowerShell.

.DESCRIPTION
  Generic script - contains no personal data. Everything here needs elevation,
  which is exactly the point: the protection is only worth something because
  the everyday account cannot undo it.

  Why elevation is the boundary. This account is a member of Administrators but
  does not run elevated day to day, and Windows hands an unelevated process a
  filtered token: the Administrators membership is present but marked deny-only,
  and the privileges that would let it take ownership or restore files are
  stripped. So permissions granted to Administrators are genuinely unavailable
  to an unelevated process, and getting them back requires a UAC consent dialog
  that only a person sitting at the machine can answer. That gap is the whole
  mechanism.

  What it sets up:

  1. An archive folder outside the repository, owned by Administrators, with
     inheritance broken and exactly three entries - Administrators and SYSTEM
     full control, Authenticated Users read. An unelevated process can list and
     read the backups (so restoring one needs no ceremony) but cannot write,
     truncate, rename or delete them. Ownership matters as much as the
     permissions: an owner always holds WRITE_DAC and could simply grant the
     rights back, so leaving this account as owner would make the whole thing
     decorative.

  2. A copy of archive-backups.ps1 inside that folder, and a daily scheduled
     task running **that copy** as SYSTEM. The copy is not fussiness. A task
     that runs as SYSTEM must not execute a script the everyday account can
     edit, or the task becomes a way to run arbitrary code as SYSTEM - a
     privilege escalation handed over for free. The repo copy stays the source
     of truth; re-run this script after changing it.

  Deliberately left alone: the repo's own private\backups folder. The daily
  export has to be able to write there, and anything that can write can delete.
  It is the working copy; the archive is the safeguard.

  What this does NOT protect against, stated plainly:

  - Someone deleting the D1 database itself. That capability comes from
    wrangler's stored credential, and no filesystem permission touches it. The
    PreToolUse hook refuses the obvious commands, but a hook is a guardrail, not
    a boundary. What this setup guarantees is that if the database does go, the
    data is still here.
  - Anyone who elevates. That is the person at the keyboard, by design.

  Safe to re-run: it refreshes the permissions, the script copy, and the task.

.PARAMETER SourceDir
  Where backup-tracker.ps1 writes its exports. Defaults to
  <repo>\private\backups.

.PARAMETER ArchiveDir
  The protected destination. Defaults to a folder under ProgramData - outside
  the repository on purpose.

.PARAMETER At
  When the daily archive task runs. Defaults to 03:00, meant to sit after the
  export task rather than race it.

.PARAMETER TaskName
  Name of the scheduled task.

.EXAMPLE
  # From an Administrator PowerShell:
  C:\VibeCoding\scripts\protect-backups.ps1
#>
param(
    [string]$SourceDir,
    [string]$ArchiveDir = (Join-Path $env:ProgramData "JobSearchTracker\backups"),
    [string]$At = "03:00",
    [string]$TaskName = "JobSearchTracker-ArchiveBackups"
)

$ErrorActionPreference = "Stop"

$repoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $SourceDir) { $SourceDir = Join-Path $repoDir "private\backups" }

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "This script has to run elevated - that is the point of it." -ForegroundColor Yellow
    Write-Host "Right-click PowerShell, Run as administrator, then:"
    Write-Host "    $PSCommandPath"
    Write-Host ""
    exit 1
}

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---- 1. The archive folder ------------------------------------------------
Step "Creating $ArchiveDir"
$binDir = Join-Path $ArchiveDir "bin"
foreach ($d in @($ArchiveDir, $binDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

Step "Taking ownership as Administrators"
# Well-known SIDs rather than names: "BUILTIN\Administrators" is localized, and
# a script that silently no-ops on a non-English Windows is worse than one that
# fails.
& icacls $ArchiveDir /setowner "*S-1-5-32-544" /T /C /Q | Out-Null

Step "Locking permissions (Administrators + SYSTEM full, everyone else read)"
& icacls $ArchiveDir /inheritance:r /Q | Out-Null
& icacls $ArchiveDir /grant "*S-1-5-32-544:(OI)(CI)F" /Q | Out-Null   # Administrators
& icacls $ArchiveDir /grant "*S-1-5-18:(OI)(CI)F"     /Q | Out-Null   # SYSTEM
& icacls $ArchiveDir /grant "*S-1-5-11:(OI)(CI)(RX)"  /Q | Out-Null   # Authenticated Users: read

# ---- 2. The SYSTEM-executed copy of the archiver --------------------------
Step "Copying archive-backups.ps1 into $binDir (SYSTEM must not run a user-writable script)"
$srcScript = Join-Path $PSScriptRoot "archive-backups.ps1"
if (-not (Test-Path $srcScript)) { throw "archive-backups.ps1 not found next to this script." }
Copy-Item $srcScript (Join-Path $binDir "archive-backups.ps1") -Force
$runScript = Join-Path $binDir "archive-backups.ps1"

# ---- 3. The scheduled task ------------------------------------------------
Step "Registering '$TaskName' to run as SYSTEM daily at $At"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`" -SourceDir `"{1}`" -ArchiveDir `"{2}`"" -f $runScript, $SourceDir, $ArchiveDir)
$trigger   = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force `
    -Description "Copies job-search tracker database exports into an archive the everyday account cannot modify or delete." | Out-Null

# ---- 4. Prove it works now, not tomorrow at 3am ---------------------------
Step "Running it once"
Start-ScheduledTask -TaskName $TaskName
$deadline = (Get-Date).AddSeconds(60)
do {
    Start-Sleep -Seconds 2
    $state = (Get-ScheduledTask -TaskName $TaskName).State
} while ($state -eq "Running" -and (Get-Date) -lt $deadline)
$result = (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult

Write-Host ""
Write-Host "----- result -----"
Write-Host "Task last run result: $result  (0 = clean, 2 = ran with warnings, anything else = look at the log)"
$archived = Get-ChildItem $ArchiveDir -Filter "*.sql" -File -ErrorAction SilentlyContinue
Write-Host ("Archived backups: {0} file(s), {1:N1} MB" -f $archived.Count, (($archived | Measure-Object -Property Length -Sum).Sum / 1MB))
Write-Host ""
Write-Host "----- permissions on $ArchiveDir -----"
& icacls $ArchiveDir
Write-Host ""
Write-Host "Verify from a NORMAL (unelevated) PowerShell - both should refuse:" -ForegroundColor Yellow
Write-Host "    Remove-Item '$ArchiveDir\*.sql'"
Write-Host "    Set-Content '$ArchiveDir\archive.log' -Value 'x'"
Write-Host ""
Write-Host "To prune old backups later, do it from an elevated prompt - that is the only"
Write-Host "way anything in here can be removed, and it is meant to take a deliberate act."
