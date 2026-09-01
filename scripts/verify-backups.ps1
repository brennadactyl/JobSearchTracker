<#
.SYNOPSIS
  Checks that the protected backup archive is actually protected. Run it from a
  NORMAL, unelevated PowerShell - that is the whole point.

.DESCRIPTION
  protect-backups.ps1 makes a series of claims: reads work, writes don't,
  the script SYSTEM executes can't be edited, and the permissions can't be
  granted back. This proves them, from the same kind of process the protection
  exists to stop - an unelevated one, which is what a scheduled task, a stray
  script, or an AI agent actually is.

  Run it after protect-backups.ps1, and again after anything that touches
  permissions, ownership, or the archive location. An ACL that silently stopped
  applying looks exactly like one that works.

  **The destructive probes are safe**, and they have to be real attempts to
  prove anything. Each one is expected to fail; the script reports FAIL if it
  succeeds. On the vanishingly unlikely chance the archive isn't protected and
  a delete goes through, nothing is lost - every archived file also exists in
  the working folder and the off-machine mirror, and the next archive run
  copies it back.

  Elevated, it will report failures. That is correct: an administrator can
  modify the archive, and that is the only way anything in it is ever removed.

.PARAMETER ArchiveDir
  The protected folder. Defaults to the same path protect-backups.ps1 uses.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\VibeCoding\scripts\verify-backups.ps1"
#>
param(
    [string]$ArchiveDir = (Join-Path $env:ProgramData "JobSearchTracker\backups")
)

if (-not (Test-Path $ArchiveDir)) {
    Write-Host "No archive at $ArchiveDir - run protect-backups.ps1 (elevated) first." -ForegroundColor Yellow
    exit 1
}

$elevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($elevated) {
    Write-Host "You are running elevated. The write probes below SHOULD succeed for you," -ForegroundColor Yellow
    Write-Host "so this run proves nothing - re-run it from an ordinary PowerShell window." -ForegroundColor Yellow
    Write-Host ""
}

$pass = 0; $fail = 0
function Probe($label, $shouldSucceed, $block) {
    $err = $null
    try { & $block } catch { $err = $_.Exception.Message }
    $ok = ($null -eq $err)
    if ($ok -eq $shouldSucceed) { $script:pass++; $v = "PASS" } else { $script:fail++; $v = "FAIL" }
    "  {0}  {1,-46} {2}" -f $v, $label, $(if ($ok) { "succeeded" } else { "refused" })
}

$owner  = (Get-Acl $ArchiveDir).Owner
$sqls   = @(Get-ChildItem $ArchiveDir -Filter *.sql -File)
$logPath = Join-Path $ArchiveDir "archive.log"
"archive: $ArchiveDir"
"owner  : $owner"
"holds  : $($sqls.Count) backup(s)"
""

if ($sqls.Count -eq 0) {
    Write-Host "Nothing archived yet - run the JobSearchTracker-ArchiveBackups task, then this again." -ForegroundColor Yellow
    exit 1
}
# Probe the smallest file: if a destructive probe ever does get through, lose
# the least, and lose the one most likely to be redundant.
$target = $sqls | Sort-Object Length | Select-Object -First 1

"===== reads (must work - restoring a backup shouldn't need ceremony) ====="
Probe "list the archive"            $true  { Get-ChildItem $ArchiveDir -File | Out-Null }
Probe "read a backup end to end"    $true  { [System.IO.File]::ReadAllBytes($target.FullName) | Out-Null }
Probe "read the archive log"        $true  { Get-Content $logPath -Raw | Out-Null }

""
"===== writes (must all be refused) ====="
Probe "open a backup for writing"   $false { $fs = [System.IO.File]::Open($target.FullName, "Open", "Write"); $fs.Close() }
Probe "create a new file"           $false { [System.IO.File]::WriteAllText((Join-Path $ArchiveDir "probe.sql"), "x") }
Probe "rewrite the archive log"     $false { Set-Content -Path $logPath -Value "x" -ErrorAction Stop }
Probe "rename a backup"             $false { Rename-Item $target.FullName ($target.Name + ".bak") -ErrorAction Stop }
Probe "delete a backup"             $false { Remove-Item $target.FullName -Force -ErrorAction Stop }
Probe "delete the archive folder"   $false { Remove-Item -Recurse -Force $ArchiveDir -ErrorAction Stop }

""
"===== escalation (the script SYSTEM runs must not be user-writable) ====="
# A task running as SYSTEM that executes a file the everyday account can edit is
# administrator access handed over for free. This is why the archiver runs from
# a copy inside the protected folder rather than from the repo.
$sysScript = Join-Path $ArchiveDir "bin\archive-backups.ps1"
Probe "edit the script SYSTEM runs" $false { $fs = [System.IO.File]::Open($sysScript, "Open", "Write"); $fs.Close() }
Probe "replace it with a new file"  $false { [System.IO.File]::WriteAllText($sysScript, "# owned") }

""
"===== undoing the protection (Administrators owns it, so no WRITE_DAC) ====="
# An owner always holds WRITE_DAC and could simply grant the rights back, so
# ownership is as load-bearing as the permission entries themselves.
Probe "grant myself full control"   $false {
    & icacls $ArchiveDir /grant "${env:USERNAME}:(OI)(CI)F" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "access denied" }
}
Probe "take ownership back"         $false {
    & icacls $ArchiveDir /setowner "$env:USERNAME" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "access denied" }
}

""
$still = @(Get-ChildItem $ArchiveDir -Filter *.sql -File).Count
"===== $pass passed, $fail failed; $still backup(s) still present ====="
if ($fail -gt 0) {
    Write-Host "The archive is NOT protected as intended - re-run protect-backups.ps1 elevated." -ForegroundColor Red
    exit 1
}
exit 0
