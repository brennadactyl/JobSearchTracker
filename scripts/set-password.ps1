<#
.SYNOPSIS
  Sets or resets a tracker account's password, interactively.

.DESCRIPTION
  POST /api/users with the deployment's ADMIN_TOKEN both creates an account and
  resets an existing one's password - nothing else in the system can hash a
  password. This wraps that call so the password is typed at a prompt instead
  of being passed as an argument: an argument lands in shell history, in a
  scrollback, and in the transcript of any agent that runs it, and the one
  thing this value must not do is persist anywhere.

  It updates password_hash only, so existing sessions survive - including the
  long-lived scheduled-search token in <data dir>/<user id>/tracker.json. A
  reset does not require knowing the old password, which means an account can
  be created with a random one nobody ever sees (see the job-search-setup
  skill, step 1) and given a real password here afterwards.

.PARAMETER Name
  The account name, exactly as stored. users.name is UNIQUE COLLATE NOCASE, so
  case does not matter but spelling does: a name that does not match an
  existing account creates a NEW empty one, and the person then signs in to an
  empty tracker while their data sits behind the original. The script says so
  loudly if that happens.

.EXAMPLE
  .\set-password.ps1 -Name "Jordan Lee"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" }),
  [string]$DeploymentFile
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $DeploymentFile) { $DeploymentFile = Join-Path $DataDir "deployment.json" }
if (-not (Test-Path $DeploymentFile)) {
  throw "No deployment.json at $DeploymentFile - see server/README.md's Accounts section for what it holds."
}
$d = Get-Content $DeploymentFile -Raw | ConvertFrom-Json
if (-not $d.admin_token) { throw "$DeploymentFile has no admin_token." }

$s1 = Read-Host "New password for '$Name' (12+ characters)" -AsSecureString
$s2 = Read-Host "Confirm" -AsSecureString

$b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1)
$b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2)
try {
  $p1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b1)
  $p2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b2)

  if ($p1 -cne $p2) { throw "The two entries did not match. Nothing was changed." }
  # Enforced server-side too; checked here so a typo fails before the request.
  # /api/login has no rate limiting in front of it, so length is the defence.
  if ($p1.Length -lt 12) { throw "Too short: $($p1.Length) characters. The server requires 12+." }

  $body = @{ name = $Name; password = $p1 } | ConvertTo-Json -Compress
  # Cloudflare's browser-integrity check 403s some default user agents with
  # "error code: 1010", which reads exactly like a rejected admin token.
  $res = Invoke-RestMethod -Uri "$($d.url)/api/users" -Method Post `
    -Headers @{ Authorization = "Bearer $($d.admin_token)" } `
    -ContentType "application/json" -UserAgent "curl/8.0" -Body $body

  if ($res.created) {
    Write-Warning ("created = True: no account named '$Name' existed, so a NEW empty one was made " +
                   "(id $($res.id)). Check the spelling against the intended account, and clean this up - " +
                   "otherwise they will sign in to an empty tracker.")
  } else {
    Write-Host "Password updated for '$Name' (id $($res.id))." -ForegroundColor Green
    Write-Host "Existing sessions still work, including the scheduled-search token." -ForegroundColor DarkGray
  }
}
finally {
  # Zero both plaintext copies whether or not the request succeeded.
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
  Remove-Variable p1, p2 -ErrorAction SilentlyContinue
}
