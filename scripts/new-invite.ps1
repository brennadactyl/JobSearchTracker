<#
.SYNOPSIS
  Makes an invite link to send someone, and shows what became of the ones you
  already sent.

.DESCRIPTION
  The whole of adding a person, from the operator's side. Run it, paste the link
  into a message, and stop thinking about it: they create their own account,
  describe their own search and attach their own resume on the tracker page,
  and the nightly run-onboarding.ps1 builds it.

  What this replaces is a curl with the ADMIN_TOKEN in it, a password chosen on
  someone else's behalf, and that password sent over chat where it stays legible
  in two devices' scrollback forever.

  ---- The code is shown once and never again.

  Only its hash is stored (see ../server/src/auth.js), so there is no way to look
  a code up later and nothing in a database export to leak. Lost one? Mint
  another - they cost nothing and the old one expires on its own.

  An invite is single-use and expires in 14 days. It creates an account and
  cannot touch an existing one, which is what makes it safe to send through a
  messaging app: the worst a stranger who intercepts it can do is take the one
  account it was going to make.

.PARAMETER Note
  Your own shorthand for who it is for, shown in -List. Never shown to them.

.PARAMETER ClientUrl
  The tracker webpage's URL, used to build the link. Defaults to the
  TRACKER_CLIENT_URL environment variable, then a "clientUrl" field in
  <DataDir>\deployment.json. Without one this prints the bare code and the
  link to paste it into by hand.

.PARAMETER List
  Show every invite and what became of it - who has signed up, who hasn't yet,
  and the user id each signup produced. That id is what names their folder in
  the private data dir, so this is where you look it up.

.PARAMETER Days
  How long the link stays good for. Default 14, capped at 30 by the API.

.PARAMETER AdminToken
  The deployment's ADMIN_TOKEN worker secret. Defaults to the
  TRACKER_ADMIN_TOKEN environment variable, then deployment.json's "adminToken".

.PARAMETER TrackerUrl
  The API worker's base URL. Defaults to TRACKER_URL, then deployment.json's
  "url", then whatever is in an existing person's tracker.json.

.EXAMPLE
  .\new-invite.ps1 -Note "Sam from the climbing gym"
  .\new-invite.ps1 -List
#>
param(
    [string]$Note = "",
    [string]$ClientUrl,
    [switch]$List,
    [int]$Days = 14,
    [string]$AdminToken,
    [string]$TrackerUrl,
    [string]$DataDir = $(if ($env:JOB_SEARCH_DATA_DIR) { $env:JOB_SEARCH_DATA_DIR } else { Join-Path $PSScriptRoot "..\private" })
)

$ErrorActionPreference = "Stop"

$deployment = $null
$deployFile = $null
if (Test-Path $DataDir) {
    $DataDir = (Resolve-Path $DataDir).Path
    $deployFile = Join-Path $DataDir "deployment.json"
    if (Test-Path $deployFile) {
        try { $deployment = Get-Content -Raw -Path $deployFile | ConvertFrom-Json } catch { }
    }
}

function Field($obj, [string[]]$names) {
    if (-not $obj) { return $null }
    foreach ($n in $names) {
        $v = $obj.PSObject.Properties[$n]
        if ($v -and $v.Value) { return [string]$v.Value }
    }
    return $null
}

# The URL and the admin token are resolved together, from one source, rather
# than each from the first place that happens to have it.
#
# Mixing them is how an operator credential gets aimed at the wrong deployment,
# and it is not hypothetical: this was written taking the URL from
# $env:TRACKER_URL and the token from deployment.json, and the first real run
# sent a test deployment's admin token to the live tracker. It was refused, and
# the error said "check it matches the ADMIN_TOKEN secret" - which was true of
# neither deployment and pointed at nothing.
#
# So: the first source holding both wins, whole. If no single source has both,
# each is taken from the first that has it and the mix is named out loud, since
# by then it is a guess about which deployment you meant.
function Resolve-Deployment($sources) {
    $paired = @($sources | Where-Object { $_.Url -and $_.Token }) | Select-Object -First 1
    if ($paired) { return $paired }
    $url = @($sources | Where-Object { $_.Url }) | Select-Object -First 1
    $tok = @($sources | Where-Object { $_.Token }) | Select-Object -First 1
    if ($url -and $tok) {
        Write-Warning "Using the tracker URL from $($url.Name) with the admin token from $($tok.Name) - check they belong to the same deployment."
    }
    [pscustomobject]@{
        Name  = "a mix of sources"
        Url   = $(if ($url) { $url.Url })
        Token = $(if ($tok) { $tok.Token })
    }
}

$resolved = Resolve-Deployment @(
    [pscustomobject]@{ Name = "the -TrackerUrl/-AdminToken arguments"; Url = $TrackerUrl;      Token = $AdminToken }
    [pscustomobject]@{ Name = "the environment";                       Url = $env:TRACKER_URL; Token = $env:TRACKER_ADMIN_TOKEN }
    [pscustomobject]@{ Name = "$deployFile";                           Url = (Field $deployment @("url", "trackerUrl", "TRACKER_URL")); Token = (Field $deployment @("adminToken", "admin_token", "ADMIN_TOKEN")) }
)
$TrackerUrl = $resolved.Url
$AdminToken = $resolved.Token

if (-not $ClientUrl) { $ClientUrl = $env:TRACKER_CLIENT_URL }
if (-not $ClientUrl) { $ClientUrl = Field $deployment @("clientUrl", "client_url", "pageUrl") }

if (-not $TrackerUrl) {
    Write-Error "No tracker URL. Pass -TrackerUrl, set TRACKER_URL, or add a `"url`" to $deployFile."
    exit 1
}
$TrackerUrl = $TrackerUrl.TrimEnd("/")

if (-not $AdminToken) {
    Write-Error @"
No ADMIN_TOKEN. Creating invites is an operator action, so it needs the worker
secret rather than a login. Pass -AdminToken, set TRACKER_ADMIN_TOKEN, or put
it in ${deployFile}:

  { "url": "$TrackerUrl", "clientUrl": "<your tracker page's URL>", "adminToken": "<the secret>" }
"@
    exit 1
}

$headers = @{ Authorization = "Bearer $AdminToken" }

if ($List) {
    try {
        $invites = (Invoke-RestMethod -Uri "$TrackerUrl/api/invites" -Headers $headers -ErrorAction Stop).invites
    } catch {
        $status = $_.Exception.Response.StatusCode.value__
        if ($status -eq 401) { Write-Error "The admin token was refused - check it matches the ADMIN_TOKEN secret on the worker." }
        else { Write-Error "Couldn't list invites: $($_.Exception.Message)" }
        exit 1
    }
    if (-not $invites -or @($invites).Count -eq 0) {
        Write-Host "No invites yet. Make one with:  .\new-invite.ps1 -Note ""their name"""
        exit 0
    }
    $now = (Get-Date).ToUniversalTime().ToString("o")
    $invites | ForEach-Object {
        $state = if ($_.used_at) { "signed up as $($_.used_by_name)" }
                 elseif ($_.expires_at -lt $now) { "expired" }
                 else { "waiting - expires $($_.expires_at.Substring(0,10))" }
        [pscustomobject]@{
            Note    = $_.note
            Sent    = $_.created_at.Substring(0, 10)
            State   = $state
            # The id their folder under the data dir is named by, and the next
            # thing you need after they sign up.
            UserId  = $_.used_by
        }
    } | Format-Table -AutoSize
    exit 0
}

try {
    $invite = Invoke-RestMethod -Uri "$TrackerUrl/api/invites" -Method POST -Headers $headers `
        -ContentType "application/json; charset=utf-8" `
        -Body (@{ note = $Note; days = $Days } | ConvertTo-Json -Compress) -ErrorAction Stop
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 401) { Write-Error "The admin token was refused - check it matches the ADMIN_TOKEN secret on the worker." }
    elseif ($status -eq 404) { Write-Error "This deployment doesn't have the invite routes yet - deploy ../server/ first." }
    else { Write-Error "Couldn't create an invite: $($_.Exception.Message)" }
    exit 1
}

Write-Host ""
if ($ClientUrl) {
    Write-Host "Send them this link:" -ForegroundColor Green
    Write-Host ""
    Write-Host "  $($ClientUrl.TrimEnd('/'))/?invite=$($invite.code)"
} else {
    # No client URL configured, so the link can't be built here. The code alone
    # is still everything they need, just with a manual step.
    Write-Host "Invite code:" -ForegroundColor Green
    Write-Host ""
    Write-Host "  $($invite.code)"
    Write-Host ""
    Write-Host "Send them your tracker page's URL with ?invite=<that code> on the end."
    Write-Host "Add a `"clientUrl`" to $deployFile and this will print the whole link next time."
}
Write-Host ""
Write-Host "Good for $Days days, one use. They pick their own name and password," -ForegroundColor DarkGray
Write-Host "then fill in the setup form - nothing else is needed from you." -ForegroundColor DarkGray
Write-Host "This code is not stored anywhere and cannot be shown again." -ForegroundColor DarkGray
Write-Host ""
