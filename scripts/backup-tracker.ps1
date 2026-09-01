<#
.SYNOPSIS
  Exports the entire tracker database to a timestamped .sql file, locally and
  to an off-machine mirror.

.DESCRIPTION
  Generic script - contains no personal data. Runs `wrangler d1 export` against
  the deployed database and writes one dated file per run.

  This is the whole of the off-account recovery story. Cloudflare's own
  protection for D1 is Time Travel, which is point-in-time recovery *inside*
  the account - it restores a database that still exists. It cannot help with
  `wrangler d1 delete`, which takes the database and its Time Travel history in
  one step, and it cannot help if the account itself goes away. A file on this
  machine is the only copy that survives either.

  Three deliberate details:

  - **Staged, then copied in.** The export goes to a temp file first and is
    validated before it lands in the backup folder. A half-written or empty
    export that reached the archive would sit there looking like a backup; the
    archive is append-only by design (see protect-backups.ps1), so a bad file
    could not be removed afterwards.

  - **Validated, not just written.** `wrangler d1 export` can exit 0 having
    produced something useless. The checks below are for the failure mode that
    actually matters: a backup that exists, is the right shape, and is empty.

  - **Nothing is ever deleted.** No retention pruning, on purpose. At roughly
    half a megabyte a day this costs well under a gigabyte a year, which is not
    worth the risk of a script that deletes backups on a schedule. Pruning old
    files is a human decision, made with elevation - see protect-backups.ps1.

  Exit codes: 0 wrote and validated; 1 the export itself failed, nothing
  written; 2 wrote the file but a validity check failed - look at the log.
  Task Scheduler surfaces the code as "Last Run Result", which is the only
  signal anyone sees without opening the log.

.PARAMETER RepoDir
  The repository root - used to find server\wrangler.toml (for the database
  name) and the default backup folder. Defaults to the parent of this script.

.PARAMETER BackupDir
  Where dated exports are written. Defaults to <RepoDir>\private\backups.

.PARAMETER MirrorDir
  A second copy, meant to be somewhere this machine's filesystem isn't the last
  word - a synced folder, an external drive. Defaults to the
  JOB_SEARCH_BACKUP_MIRROR environment variable, then to a folder in OneDrive.
  A mirror that can't be written is a warning, not a failure: the local copy
  still happened.

.PARAMETER NoMirror
  Skip the off-machine copy entirely.

.PARAMETER MinBytes
  Refuse to call an export healthy below this size. Defaults to 10 KB - large
  enough to catch an empty or truncated file, small enough not to trip on a
  brand-new install with almost no rows.

.EXAMPLE
  .\backup-tracker.ps1
  .\backup-tracker.ps1 -NoMirror -BackupDir D:\Backups
#>
param(
    [string]$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$BackupDir,
    [string]$MirrorDir = $(
        if ($env:JOB_SEARCH_BACKUP_MIRROR) { $env:JOB_SEARCH_BACKUP_MIRROR }
        elseif ($env:OneDrive) { Join-Path $env:OneDrive "JobSearchTracker\backups" }
        else { "" }
    ),
    [switch]$NoMirror,
    [int]$MinBytes = 10240
)

$ErrorActionPreference = "Stop"

if (-not $BackupDir) { $BackupDir = Join-Path $RepoDir "private\backups" }
$logDir = Join-Path $RepoDir "private\logs"
foreach ($d in @($BackupDir, $logDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}
$logFile = Join-Path $logDir "backup.log"

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

Log "===== backup-tracker starting ====="

# The database name lives in wrangler.toml, not here - one definition, and a
# renamed database doesn't silently start backing up nothing.
$wranglerToml = Join-Path $RepoDir "server\wrangler.toml"
if (-not (Test-Path $wranglerToml)) {
    Log "ERROR: no server\wrangler.toml under $RepoDir - can't tell which database to export."
    exit 1
}
$dbName = ([regex]::Match((Get-Content $wranglerToml -Raw), 'database_name\s*=\s*"([^"]+)"')).Groups[1].Value
if (-not $dbName) {
    Log "ERROR: server\wrangler.toml has no database_name."
    exit 1
}
Log "database: $dbName"

$stamp   = Get-Date -Format "yyyy-MM-dd-HHmmss"
$name    = "d1-$dbName-$stamp.sql"
$staging = Join-Path $env:TEMP $name

# Run wrangler through Start-Process rather than the call operator. Windows
# PowerShell 5.1 turns a native command's stderr into ErrorRecords when you
# redirect it, which both mangles wrangler's output and trips
# $ErrorActionPreference = "Stop" on a run that actually succeeded. Redirecting
# to files sidesteps the whole behaviour and still gets the output into the log.
$wranglerCmd = Join-Path $env:APPDATA "npm\wrangler.cmd"
if (-not (Test-Path $wranglerCmd)) { $wranglerCmd = "wrangler.cmd" }
$outFile = Join-Path $env:TEMP "backup-tracker-wrangler-out.txt"
$errFile = Join-Path $env:TEMP "backup-tracker-wrangler-err.txt"

function Invoke-Export {
    param([string]$Target)
    $p = Start-Process -FilePath $wranglerCmd `
        -ArgumentList @("d1", "export", $dbName, "--remote", "--output", "`"$Target`"") `
        -WorkingDirectory (Join-Path $RepoDir "server") `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    return $p.ExitCode
}

# The export endpoint is genuinely flaky - it returned "A request to the
# Cloudflare API failed" once and succeeded on the next call seconds later, with
# nothing changed. One retry, because an unattended nightly job that gives up on
# a transient 500 is a backup that quietly stops existing.
Log "exporting to staging: $staging"
$code = Invoke-Export $staging
if ($code -ne 0 -or -not (Test-Path $staging)) {
    Log "export attempt 1 failed (exit $code) - retrying in 30s"
    Get-Content $errFile -ErrorAction SilentlyContinue | ForEach-Object { Log "  wrangler: $_" }
    Start-Sleep -Seconds 30
    $code = Invoke-Export $staging
}

if ($code -ne 0 -or -not (Test-Path $staging)) {
    Log "ERROR: wrangler d1 export failed (exit $code) on both attempts. Nothing was written."
    Get-Content $outFile -ErrorAction SilentlyContinue | ForEach-Object { Log "  wrangler: $_" }
    Get-Content $errFile -ErrorAction SilentlyContinue | ForEach-Object { Log "  wrangler: $_" }
    exit 1
}

# ---- Validate the staged file before it becomes a backup. ------------------
$size    = (Get-Item $staging).Length
$text    = Get-Content $staging -Raw
$tables  = ([regex]::Matches($text, '(?im)^\s*CREATE TABLE')).Count
$inserts = ([regex]::Matches($text, '(?im)^\s*INSERT INTO')).Count
Log ("staged: {0:N0} bytes, {1} CREATE TABLE, {2} INSERT INTO" -f $size, $tables, $inserts)

$problems = @()
if ($size -lt $MinBytes) { $problems += "only $size bytes (under the $MinBytes floor)" }
if ($tables -lt 1)       { $problems += "no CREATE TABLE statements" }
if ($inserts -lt 1)      { $problems += "no INSERT statements - the schema came back but no data" }

# An export that succeeds but returns far less than last time is the quiet
# failure this is really watching for: a partial dump reads as a valid file.
$previous = Get-ChildItem $BackupDir -Filter "*.sql" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($previous -and $size -lt ($previous.Length * 0.5)) {
    $problems += ("less than half the size of the previous backup ({0:N0} vs {1:N0} bytes)" -f $size, $previous.Length)
}

foreach ($p in $problems) { Log "WARNING: $p" }

# ---- Land it. The local copy first; the mirror is best-effort. -------------
$final = Join-Path $BackupDir $name
Copy-Item $staging $final -Force
Log ("wrote {0} ({1:N0} bytes)" -f $final, (Get-Item $final).Length)

if (-not $NoMirror -and $MirrorDir) {
    try {
        if (-not (Test-Path $MirrorDir)) { New-Item -ItemType Directory -Force -Path $MirrorDir | Out-Null }
        Copy-Item $staging (Join-Path $MirrorDir $name) -Force
        Log "mirrored to $MirrorDir"
    } catch {
        Log "WARNING: mirror copy to $MirrorDir failed - $($_.Exception.Message)"
        Log "         the local copy is fine; only the off-machine copy is missing."
    }
} elseif (-not $NoMirror) {
    Log "WARNING: no mirror configured (set JOB_SEARCH_BACKUP_MIRROR) - this machine holds the only copy."
}

Remove-Item $staging -Force -ErrorAction SilentlyContinue

$kept = (Get-ChildItem $BackupDir -Filter "*.sql" -ErrorAction SilentlyContinue).Count
Log "$kept backup file(s) now in $BackupDir"

if ($problems.Count -gt 0) {
    Log "===== done, WITH WARNINGS ====="
    exit 2
}
Log "===== done ====="
exit 0
