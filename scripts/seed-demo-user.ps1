<#
.SYNOPSIS
  Creates (or refreshes) the tracker's demonstration account and fills it with
  fabricated job-search data.

.DESCRIPTION
  A third kind of account, alongside the real people this deployment serves: a
  demo one, whose entire contents are invented. It exists so the tracker can be
  shown to someone - a screen share, a screenshot, a README - without opening a
  real person's job search, which is a document about their employment, their
  rejections and their salary expectations.

  Everything it writes goes through the public HTTP API, the same routes a real
  search and the webpage use. Nothing here touches D1 directly, so a demo
  account cannot end up in a state the API itself could not have produced - and
  seeding it is a live test that those routes still work end to end.

  ---- What makes this account safe to show, and safe to keep.

  The data is invented rather than anonymised. Companies like "Northwind
  Systems" and "Kestrel Analytics" do not exist, and every posting URL sits
  under example.com, which IANA reserves for documentation and which can never
  resolve to a real job posting. So no row here can be read as a record of a
  real company's hiring, and no link can be followed to something it misdescribes.
  See demo-user.json, which holds all of it.

  It gets no `private\<user id>\` folder and no scheduled tasks, and that is the
  whole mechanism rather than an omission: setup-scheduler.ps1 discovers people
  by scanning for `<data dir>\*\tracker.json`, so an account with no folder is
  invisible to it and can never acquire a nightly run. The demo's data changes
  only when this script is re-run.

  Its tracks therefore carry no `schedule_time` - there is nothing to schedule -
  and `stale_run_hours` is set to a year, because the staleness warning reports
  a search that has stopped firing and this account has no search to stop. Left
  at the default 36, every tab would show a warning about a run that was never
  going to happen.

  ---- Re-running it. Safe, and the way to refresh the dates: the postings are
  stored as day offsets, so a re-seed moves the whole search forward to today.
  Leads and screened rows dedup on the server, config and coverage are upserts,
  and run records are overwritten. Application rows are the exception - nothing
  dedups them - so a re-seed needs -Force, which deletes this account's existing
  applications before recreating them.

  -Force will not delete anything this script did not create. Before removing a
  single row it checks that every lead on the account is an example.com URL; one
  posting from a real job board and it refuses outright. That is what stands
  between a data file whose `user.name` has been edited to a real person's - or
  a deployment where "Demo" was later handed to one - and their application
  history.

.PARAMETER AdminToken
  The deployment's ADMIN_TOKEN worker secret - the operator credential that
  creates accounts (see server/README.md). Defaults to the TRACKER_ADMIN_TOKEN
  environment variable. This is not a login and not a session token; no search
  or browser ever holds it.

.PARAMETER TrackerUrl
  The API worker's base URL, e.g. https://job-search-tracker.<subdomain>.workers.dev.
  Defaults to the TRACKER_URL environment variable.

.PARAMETER Password
  The demo account's password, for signing in on the tracker page. Minimum 12
  characters (the API's rule). Omit it and one is generated and printed at the
  end; pass one to set something memorable you can hand out with the demo.

  Re-running with the same password changes no credential - the script signs in
  with it and provisions nothing. Re-running with a different one (which is what
  omitting it does, since a fresh password is generated each time) resets the
  account's password, the same as any account here.

.PARAMETER DataFile
  The fabricated data to load. Defaults to demo-user.json next to this script.

.PARAMETER Force
  Required to re-seed an account that already has data. Deletes this account's
  application rows before recreating them - see the safety check above.

.EXAMPLE
  .\seed-demo-user.ps1 -AdminToken $env:TRACKER_ADMIN_TOKEN

.EXAMPLE
  .\seed-demo-user.ps1 -Password "show-and-tell-account" -Force
#>
param(
    [string]$AdminToken = $env:TRACKER_ADMIN_TOKEN,

    [string]$TrackerUrl = $env:TRACKER_URL,

    [string]$Password,

    [string]$DataFile = (Join-Path $PSScriptRoot "demo-user.json"),

    [switch]$Force
)

$ErrorActionPreference = "Stop"

# --------------------------------------------------------------- preflight --

if (-not $TrackerUrl) {
    Write-Error "No tracker URL. Pass -TrackerUrl, or set the TRACKER_URL environment variable."
    exit 1
}
$TrackerUrl = $TrackerUrl.TrimEnd("/")

if (-not $AdminToken) {
    Write-Error "No admin token. Pass -AdminToken, or set TRACKER_ADMIN_TOKEN.`nIt's the ADMIN_TOKEN worker secret from the API deployment - see server/README.md. Creating an account is the one thing a session token cannot do."
    exit 1
}

if (-not (Test-Path $DataFile)) {
    Write-Error "Data file not found: $DataFile"
    exit 1
}
$data = Get-Content -Raw -Path $DataFile -Encoding UTF8 | ConvertFrom-Json

if ($Password) {
    if ($Password.Length -lt 12) {
        Write-Error "The API requires a password of at least 12 characters."
        exit 1
    }
} else {
    # Long rather than clever, matching the API's own rule. Printed at the end -
    # this script is the only thing that ever sees it, and it is never written
    # to disk.
    $alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray()
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Password = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

$demoName = $data.user.name

# ------------------------------------------------------------------ helpers --

# One place that turns a failed call into something readable. Invoke-RestMethod
# throws away the response body on a non-2xx, which is where this API puts the
# only useful part of the error - "unknown track X", "password must be at least
# 12 characters" - so it gets read back off the stream explicitly.
function Invoke-Api {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Token,
        $Body,
        [string]$What,
        # Return $null on a non-2xx instead of stopping the script. Used for the
        # one call whose failure is information rather than an error - the
        # speculative sign-in below, where a 401 is how the script learns that
        # the account doesn't exist yet.
        [switch]$AllowFailure
    )

    $headers = @{}
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }

    $req = @{
        Uri     = "$TrackerUrl$Path"
        Method  = $Method
        Headers = $headers
    }
    if ($null -ne $Body) {
        # Encoded to UTF-8 bytes rather than handed over as a string: PowerShell
        # 5.1 would otherwise send it in the console's codepage, which mangles
        # any non-ASCII character in a note or a config setting on the way out.
        $json = $Body | ConvertTo-Json -Depth 20 -Compress
        $req["Body"] = [System.Text.Encoding]::UTF8.GetBytes($json)
        $req["ContentType"] = "application/json; charset=utf-8"
    }

    try {
        return Invoke-RestMethod @req
    } catch {
        if ($AllowFailure) { return $null }
        $status = ""
        $detail = $_.Exception.Message
        if ($_.Exception.Response) {
            $status = $_.Exception.Response.StatusCode.value__
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $raw = $reader.ReadToEnd()
                if ($raw) { $detail = $raw }
            } catch { }
        }
        $label = $What
        if (-not $label) { $label = "$Method $Path" }
        Write-Error "$label failed ($status): $detail"
        exit 1
    }
}

# The dataset stores offsets, not dates, so a demo seeded today reads as a
# search that has been running for three weeks - and one seeded next year does
# too. Local date, deliberately: every `on`/`found`/`date` field in this API is
# the caller's own day, not the worker's UTC one.
function DaysAgo([int]$n) { (Get-Date).AddDays(-$n).ToString("yyyy-MM-dd") }
function DaysAhead([int]$n) { (Get-Date).AddDays($n).ToString("yyyy-MM-dd") }

function Say($msg) { Write-Host $msg }

# ------------------------------------------------------- account + session --

Say "Tracker:   $TrackerUrl"
Say "Account:   $demoName"
Say "Data file: $DataFile"
Say ""

# Sign in before provisioning, not after. POST /api/users is create-*or-reset*
# (it is how a forgotten password gets fixed - see server/src/routes/accounts.js), so
# calling it unconditionally would reset the password of whatever account
# happens to bear this name, including one that turns out not to be the demo
# and that the safeguards below would then refuse to touch. By then the reset
# has already happened, and it is not undoable without knowing what the
# password used to be.
#
# So: try the password first. If it works the account already exists in the
# state this run wants, and no provisioning call is made at all - which is the
# ordinary re-run, and it now changes no credential. Provisioning happens only
# when the sign-in fails, which is the case where a password is being set
# either way.
$loginBody = @{ name = $demoName; password = $Password; label = "demo-seed" }
$session = Invoke-Api -Method POST -Path "/api/login" -Body $loginBody -AllowFailure
$passwordWasReset = $false

if ($session) {
    $userId = $session.user.id
    Say "Signed in to the existing account $demoName ($userId)."
} else {
    $account = Invoke-Api -Method POST -Path "/api/users" -Token $AdminToken -What "Creating the demo account" -Body @{
        name     = $demoName
        password = $Password
    }
    $userId = $account.id
    if ($account.created) {
        Say "Created account $demoName ($userId)."
    } else {
        # The name was taken and the password didn't match, so this call was a
        # reset. Flagged rather than glossed over: if the safeguards below then
        # refuse the account, this is the one change that already landed.
        $passwordWasReset = $true
        Say "Account $demoName ($userId) already existed - its password has been reset to the one below."
    }
    $session = Invoke-Api -Method POST -Path "/api/login" -What "Signing in as $demoName" -Body $loginBody
}
$token = $session.token

# ------------------------------------------------- existing-data safeguards --

$existing = Invoke-Api -Method GET -Path "/api/data" -Token $token -What "Reading the account's current contents"
$existingLeads = @($existing.leads)
$existingApps = @($existing.applications)

if (($existingLeads.Count -gt 0 -or $existingApps.Count -gt 0) -and -not $Force) {
    Write-Error @"
$demoName already holds $($existingLeads.Count) leads and $($existingApps.Count) applications.

Re-run with -Force to refresh it. Leads, screened rows, config and coverage all
merge safely on their own; -Force is about the application rows, which nothing
dedups, so they are deleted and recreated rather than doubled.
"@
    exit 1
}

if ($Force -and $existingApps.Count -gt 0) {
    # The check that makes -Force safe to hand to anyone. This script only ever
    # writes example.com postings, so a lead on any other host means the token
    # in hand belongs to somebody's real job search - a mistyped account name,
    # or a demo name that a real person was later given. Refuse the whole run
    # rather than delete one row of it.
    $real = @($existingLeads | Where-Object { $_.url -notmatch '(^|\.)example\.com/' })
    if ($real.Count -gt 0) {
        $resetWarning = ""
        if ($passwordWasReset) {
            $resetWarning = @"

One change did land before this check: the sign-in failed, so the account was
provisioned, and POST /api/users on an existing name is a password reset. That
account's password is now the one this run used. Set it back with the same
route and the ADMIN_TOKEN if you know what it was.
"@
        }
        Write-Error @"
Refusing to touch this account: it holds $($real.Count) lead(s) that this script did not write,
the first being "$($real[0].company) - $($real[0].title)" at $($real[0].url).

Every posting this script creates is an example.com URL. A real one means "$demoName"
is not the demo account on this deployment, and -Force would have deleted real
application records. No rows have been changed.$resetWarning
"@
        exit 1
    }

    Say "Removing $($existingApps.Count) existing application row(s) before reseeding..."
    foreach ($app in $existingApps) {
        Invoke-Api -Method POST -Path "/api/delete-application" -Token $token -What "Deleting application $($app.id)" -Body @{ id = $app.id } | Out-Null
    }
}

# ------------------------------------------------------------------- config --

# One post carries the whole track list and every setting. `tracks` replaces the
# list wholesale (see server/README.md), which is exactly what's wanted here -
# the file is the complete definition of this account, not a patch on it.
$configBody = @{ tracks = @($data.tracks) }
foreach ($prop in $data.settings.PSObject.Properties) {
    $configBody[$prop.Name] = $prop.Value
}
Invoke-Api -Method POST -Path "/api/config" -Token $token -What "Posting the track and page config" -Body $configBody | Out-Null
Say "Configured $(@($data.tracks).Count) tracks and the page settings."

# --------------------------------------------------------------- coverage --

# `on = ""` registers a company without claiming a sweep that never happened,
# which is what leaves the whole list sorted as never-covered.
foreach ($prop in $data.coverage.PSObject.Properties) {
    $swept = @($prop.Value)
    Invoke-Api -Method POST -Path "/api/coverage" -Token $token -What "Seeding company coverage for $($prop.Name)" -Body @{
        search = $prop.Name
        on     = ""
        swept  = $swept
    } | Out-Null
    Say "Registered $($swept.Count) companies in the $($prop.Name) rotation."
}

# ------------------------------------------------------------------- leads --

# Each lead carries its own found/verified date, so the tab reads as three
# weeks of accumulated searching rather than everything arriving at once.
$leadPayload = @()
foreach ($lead in $data.leads) {
    $row = @{
        search   = $lead.search
        company  = $lead.company
        title    = $lead.title
        location = $lead.location
        url      = $lead.url
        fit      = $lead.fit
        found    = DaysAgo $lead.foundDaysAgo
        verified = DaysAgo $lead.verifiedDaysAgo
    }
    foreach ($f in @("team", "setup", "comp")) {
        if ($lead.PSObject.Properties[$f]) { $row[$f] = $lead.$f }
    }
    $leadPayload += $row
}
$added = Invoke-Api -Method POST -Path "/api/leads" -Token $token -What "Adding leads" -Body @{ leads = $leadPayload }
Say "Leads: $($added.added) added, $($added.duplicates) already present."

# ---------------------------------------------------------------- screened --

$screenedPayload = @()
foreach ($item in $data.screened) {
    $screenedPayload += @{
        search   = $item.search
        company  = $item.company
        title    = $item.title
        location = $item.location
        url      = $item.url
        reason   = $item.reason
        date     = DaysAgo $item.daysAgo
    }
}
$screenedResult = Invoke-Api -Method POST -Path "/api/screened" -Token $token -What "Adding screened postings" -Body @{ screened = $screenedPayload }
Say "Screened: $($screenedResult.added) added, $($screenedResult.duplicates) already present."

# ------------------------------------------------- lead notes and statuses --

# /api/leads inserts every lead as "New" with empty notes - the search has no
# opinion about either - so the statuses and notes that make the demo look
# lived-in are a second pass, through the same routes the webpage uses.
$current = Invoke-Api -Method GET -Path "/api/data" -Token $token -What "Reading back the seeded leads"
$leadIdByUrl = @{}
foreach ($lead in $current.leads) { $leadIdByUrl[$lead.url] = $lead.id }

$statusCount = 0
foreach ($lead in $data.leads) {
    $id = $leadIdByUrl[$lead.url]
    if (-not $id) {
        Write-Warning "No lead id came back for $($lead.url) - skipping its status and notes."
        continue
    }

    # Notes first: moving a lead to "Applied" copies them onto the application
    # row it creates, so writing them afterwards would leave the application
    # with a blank note.
    $notes = ""
    if ($lead.PSObject.Properties["notes"]) { $notes = $lead.notes }
    if ($notes) {
        Invoke-Api -Method POST -Path "/api/update" -Token $token -What "Setting notes on lead $id" -Body @{
            type  = "lead"
            id    = $id
            notes = $notes
        } | Out-Null
    }

    if ($lead.status -eq "New") { continue }

    if ($lead.status -eq "Applied") {
        # The purpose-built route, not a plain field write: it is what creates
        # the application row alongside the status change, in one transaction.
        Invoke-Api -Method POST -Path "/api/leads/$id/status" -Token $token -What "Marking lead $id applied" -Body @{ status = $lead.status } | Out-Null
    } else {
        Invoke-Api -Method POST -Path "/api/update" -Token $token -What "Setting status on lead $id" -Body @{
            type   = "lead"
            id     = $id
            status = $lead.status
        } | Out-Null
    }
    $statusCount++
}
Say "Set the status on $statusCount leads."

# ------------------------------------------------------------ applications --

# Re-read: the "Applied" statuses above created application rows, and their ids
# are what the pipeline walk below needs.
$current = Invoke-Api -Method GET -Path "/api/data" -Token $token -What "Reading back the created applications"
$appByLeadId = @{}
foreach ($app in $current.applications) {
    if ($app.leadId) { $appByLeadId[[string]$app.leadId] = $app.id }
}

$appCount = 0
foreach ($spec in $data.applications) {
    if ($spec.PSObject.Properties["leadUrl"]) {
        $leadId = $leadIdByUrl[$spec.leadUrl]
        if (-not $leadId) {
            Write-Warning "No lead for $($spec.leadUrl) - skipping its application."
            continue
        }
        $appId = $appByLeadId[[string]$leadId]
        if (-not $appId) {
            Write-Warning "Lead $leadId has no application row - skipping."
            continue
        }
    } else {
        # An application with no lead behind it: added by hand, the way a
        # referral or a posting found outside the search would be.
        $created = Invoke-Api -Method POST -Path "/api/update" -Token $token -What "Adding the $($spec.company) application" -Body @{
            type    = "application"
            company = $spec.company
            title   = $spec.title
        }
        $appId = $created.application.id
    }

    # Everything the row carries besides its stage history, in one patch.
    # dateApplied is set here rather than left to the status walk below: the
    # stage stamp only fires on a blank column, and the row was created with
    # today's date, so the walk alone could never backdate it.
    $patch = @{ type = "application"; id = $appId }
    foreach ($f in @("company", "title", "link", "source", "referral", "comp", "notes")) {
        if ($spec.PSObject.Properties[$f]) { $patch[$f] = $spec.$f }
    }
    if ($spec.PSObject.Properties["nextAction"]) {
        $patch["nextAction"] = $spec.nextAction
        $patch["nextActionDate"] = DaysAhead $spec.nextActionDaysAhead
    }
    $appliedStage = @($spec.stages | Where-Object { $_.status -eq "Applied" })
    if ($appliedStage.Count -gt 0) { $patch["dateApplied"] = DaysAgo $appliedStage[0].daysAgo }
    Invoke-Api -Method POST -Path "/api/update" -Token $token -What "Filling in application $appId" -Body $patch | Out-Null

    # Walk the pipeline in order. Each call stamps that stage's date column and
    # leaves the row sitting at the last stage in the list - the same sequence
    # of clicks a person would make on the page over several weeks, which is
    # why the stage history comes out populated rather than hand-written.
    foreach ($stage in $spec.stages) {
        $body = @{ status = $stage.status }
        if ($stage.PSObject.Properties["daysAgo"]) { $body["date"] = DaysAgo $stage.daysAgo }
        Invoke-Api -Method POST -Path "/api/applications/$appId/status" -Token $token -What "Advancing application $appId to $($stage.status)" -Body $body | Out-Null
    }
    $appCount++
}
Say "Built $appCount applications with their stage histories."

# -------------------------------------------------------------- run records --

# Without these every tab reads "No run recorded yet", which is the state a
# brand-new install shows - accurate for this account, and the least
# interesting thing to demonstrate. One post per searching track; the server
# fans it out to the tabs that track feeds, and counts the rows itself.
foreach ($run in $data.runs) {
    $result = Invoke-Api -Method POST -Path "/api/runs" -Token $token -What "Recording a run for $($run.search)" -Body @{
        search = $run.search
        status = $run.status
        note   = $run.note
        on     = (Get-Date).ToString("yyyy-MM-dd")
    }
    $tabs = 1 + @($result.also).Count
    Say "Recorded a run for $($run.search) across $tabs tab(s)."
}

# ------------------------------------------------------------------ summary --

Say ""
Say "Done. The demo account is ready."
Say ""
Say "  User id:  $userId"
Say "  Name:     $demoName"
Say "  Password: $Password"
Say ""
Say "Sign in at the tracker page with that name and password."
Say "The password is not stored anywhere - note it down now, or re-run this"
Say "script with -Password to set one of your own."
Say ""
Say "No private\$userId\ folder and no scheduled tasks were created, which is"
Say "what keeps this account demonstration-only: setup-scheduler.ps1 finds"
Say "people by their tracker.json, so it will never register a search for one"
Say "that has no folder. Re-run this script with -Force to refresh the dates."
