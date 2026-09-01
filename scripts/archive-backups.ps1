<#
.SYNOPSIS
  Copies new database exports into the protected archive. Runs as SYSTEM.

.DESCRIPTION
  Generic script - contains no personal data. The second half of the backup
  story, and the half that makes it worth anything.

  backup-tracker.ps1 writes exports into the repo's own private\backups folder,
  which the account running it can obviously also delete - anything that can
  create a file there can remove one. That folder is a working copy, not a
  safeguard.

  This script exists to get a copy somewhere the everyday account cannot reach.
  The archive folder is owned by Administrators and grants Authenticated Users
  read access only, so an unelevated process - which is what an agent, a
  scheduled task, or a stray script actually is - can list and read the backups
  but cannot write, rename, truncate, or delete them. Getting files *into* a
  folder like that needs a writer the everyday account isn't: hence a task
  registered to run as SYSTEM, which only an elevated one-time setup can create
  (protect-backups.ps1 does both).

  Deliberately not clever: it copies files that aren't there yet, by name, and
  never removes anything. There is no sync, no mirroring of deletions, no
  pruning. A backup archive that can act on a file disappearing from the source
  is an archive that can be emptied by deleting the source.

  Its log lives inside the archive for the same reason the backups do - SYSTEM
  can append to it, and nothing unelevated can rewrite it afterwards.

.PARAMETER SourceDir
  Where backup-tracker.ps1 writes. Required.

.PARAMETER ArchiveDir
  The protected destination. Defaults to a folder under ProgramData, chosen
  because it sits outside the repository: an `rm -rf` aimed at the project
  should not even graze the archive.

.PARAMETER Pattern
  Which files to archive. Defaults to *.sql.

.EXAMPLE
  .\archive-backups.ps1 -SourceDir C:\VibeCoding\private\backups
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,

    [string]$ArchiveDir = (Join-Path $env:ProgramData "JobSearchTracker\backups"),

    [string]$Pattern = "*.sql"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ArchiveDir)) {
    Write-Error "Archive folder $ArchiveDir does not exist. Run protect-backups.ps1 (elevated) first - it creates the folder, locks it down, and registers this task."
    exit 1
}

$logFile = Join-Path $ArchiveDir "archive.log"
function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    try { Add-Content -Path $logFile -Value $line -Encoding utf8 } catch { }
}

Log "===== archive-backups starting (running as $env:USERNAME) ====="

if (-not (Test-Path $SourceDir)) {
    Log "ERROR: source folder $SourceDir does not exist."
    exit 1
}

$copied = 0
$failed = 0
foreach ($f in Get-ChildItem $SourceDir -Filter $Pattern -File | Sort-Object Name) {
    $dest = Join-Path $ArchiveDir $f.Name
    if (Test-Path $dest) { continue }
    try {
        Copy-Item $f.FullName $dest
        Log ("archived {0} ({1:N0} bytes)" -f $f.Name, $f.Length)
        $copied++
    } catch {
        Log "ERROR: could not archive $($f.Name) - $($_.Exception.Message)"
        $failed++
    }
}

$total = (Get-ChildItem $ArchiveDir -Filter $Pattern -File).Count
$bytes = (Get-ChildItem $ArchiveDir -Filter $Pattern -File | Measure-Object -Property Length -Sum).Sum
Log ("$copied new, $failed failed; archive now holds {0} file(s), {1:N1} MB" -f $total, ($bytes / 1MB))

# Nothing new isn't automatically fine: if the source stopped producing
# exports, this is the only place that would notice.
$newest = Get-ChildItem $ArchiveDir -Filter $Pattern -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest -and ((Get-Date) - $newest.LastWriteTime).TotalDays -gt 2) {
    Log ("WARNING: newest archived backup is {0:N1} days old - the daily export may have stopped running." -f ((Get-Date) - $newest.LastWriteTime).TotalDays)
    Log "===== done, WITH WARNINGS ====="
    exit 2
}

Log "===== done ====="
if ($failed -gt 0) { exit 2 }
exit 0
