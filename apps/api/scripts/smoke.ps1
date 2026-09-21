<#
.SYNOPSIS
  Walks the implemented API end to end against a running dev server.

.DESCRIPTION
  Exercises the owner -> driver flow and the safety-critical behaviours:
  the one-open-rental invariant (FR-RENT-02), snapshot immutability
  (§5.6.4 / FR-DRV-04), read-only guest and 404 ownership scoping (§5.7.2).

  Read-only apart from creating one rental, which it cancels at the end.

.EXAMPLE
  npm run dev -w apps/api      # in another terminal
  ./apps/api/scripts/smoke.ps1
#>
param(
    [string]$BaseUrl = 'http://127.0.0.1:3000'
)

$ErrorActionPreference = 'Stop'
$api = "$BaseUrl/api/v1"
$pass = 0
$fail = 0

function Step($name, $expected, $actual) {
    $ok = $expected -eq $actual
    if ($ok) {
        Write-Host "  PASS  $name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  FAIL  $name (expected '$expected', got '$actual')" -ForegroundColor Red
        $script:fail++
    }
}

# Calls that are meant to fail: return the error body instead of throwing.
# Windows PowerShell 5.1 has already drained the response stream by the time we
# see the exception, so the body comes from ErrorDetails; the stream is only a
# fallback for hosts that populate it instead.
function Try-Api($method, $url, $headers, $body) {
    try {
        $params = @{ Uri = $url; Method = $method; Headers = $headers; ContentType = 'application/json' }
        if ($body) { $params.Body = ($body | ConvertTo-Json -Depth 5) }
        return @{ ok = $true; data = (Invoke-RestMethod @params) }
    } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }

        $text = $_.ErrorDetails.Message
        if (-not $text -and $_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $stream.Position = 0
                $text = (New-Object System.IO.StreamReader($stream)).ReadToEnd()
            } catch { $text = $null }
        }

        $parsed = $null
        if ($text) { try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $null } }

        return @{ ok = $false; status = $status; data = $parsed; raw = $text }
    }
}

Write-Host "`nCrashLink API smoke test -> $BaseUrl`n" -ForegroundColor Cyan

# --- health -----------------------------------------------------------------
$health = Invoke-RestMethod -Uri "$BaseUrl/health"
Step 'health reports ok' 'ok' $health.status
Step 'database reachable' 'ok' $health.db

# --- auth -------------------------------------------------------------------
$owner = Invoke-RestMethod -Uri "$api/auth/login" -Method POST -ContentType 'application/json' `
    -Body (@{ identifier = 'arushan@gmail.com'; password = 'demo1234' } | ConvertTo-Json)
Step 'owner logs in' 'OWNER' $owner.user.role

$driver = Invoke-RestMethod -Uri "$api/auth/login" -Method POST -ContentType 'application/json' `
    -Body (@{ identifier = 'janukshan@gmail.com'; password = 'demo1234' } | ConvertTo-Json)
Step 'driver logs in' 'DRIVER' $driver.user.role

$ownerHdr  = @{ Authorization = "Bearer $($owner.accessToken)" }
$driverHdr = @{ Authorization = "Bearer $($driver.accessToken)" }

# FR-AUTH-03: the presented refresh token is revoked on use.
$rotated = Invoke-RestMethod -Uri "$api/auth/refresh" -Method POST -ContentType 'application/json' `
    -Body (@{ refreshToken = $owner.refreshToken } | ConvertTo-Json)
Step 'refresh returns a new token' $true ($rotated.refreshToken -ne $owner.refreshToken)
$replay = Try-Api 'POST' "$api/auth/refresh" @{} @{ refreshToken = $owner.refreshToken }
Step 'replayed refresh token rejected' 401 $replay.status

# --- bikes ------------------------------------------------------------------
$bikes = Invoke-RestMethod -Uri "$api/bikes" -Headers $ownerHdr
Step 'owner sees seeded bikes' $true ($bikes.items.Count -ge 2)

# A previous run leaves its rental in ENDING_SYNC, which still counts as open
# (FR-RENT-02) and would make this run fail with DRIVER_BUSY. Re-seeding is the
# reset, so say that rather than dying on a raw exception.
$bike = $bikes.items | Where-Object { $null -eq $_.activeRental } | Select-Object -First 1
if (-not $bike) {
    Write-Host "`n  No free bike - a previous run left an open rental." -ForegroundColor Yellow
    Write-Host "  Reset with:  npm run db:seed -w apps/api`n" -ForegroundColor Yellow
    exit 1
}

# --- driver lookup ----------------------------------------------------------
$lookup = Invoke-RestMethod -Uri "$api/drivers/lookup?q=janukshan@gmail.com" -Headers $ownerHdr
# A masked number keeps only the last 4 digits, so it is never a bare E.164.
Step 'driver lookup masks the phone' $true ($lookup.phoneMasked -notmatch '^\+\d+$')
Step 'driver has an emergency contact' $true $lookup.hasEmergencyContact

# --- rentals ----------------------------------------------------------------
$assigned = Try-Api 'POST' "$api/rentals" $ownerHdr @{ bikeId = $bike.id; driverId = $lookup.id; idempotencyKey = [guid]::NewGuid().ToString() }
if (-not $assigned.ok) {
    Write-Host "`n  Could not assign a rental: $($assigned.data.code) - $($assigned.data.message)" -ForegroundColor Yellow
    Write-Host "  Reset with:  npm run db:seed -w apps/api`n" -ForegroundColor Yellow
    exit 1
}
$rental = $assigned.data
Step 'rental starts PENDING_SYNC' 'PENDING_SYNC' $rental.state

# FR-RENT-02, enforced by the partial unique index in §5.6.3.
$dup = Try-Api 'POST' "$api/rentals" $ownerHdr @{ bikeId = $bike.id; driverId = $lookup.id; idempotencyKey = [guid]::NewGuid().ToString() }
Step 'second rental on same bike refused' 'RENTAL_ACTIVE_EXISTS' $dup.data.code

# FR-RENT-03: only allowed because DEMO_MODE=true.
$activated = Invoke-RestMethod -Uri "$api/rentals/$($rental.id)/force-activate" -Method POST -Headers $ownerHdr `
    -ContentType 'application/json' -Body (@{ confirm = $true } | ConvertTo-Json)
Step 'force-activate flags demoOverride' $true $activated.demoOverride

# --- snapshot immutability (the safety-critical one) ------------------------
$before = Invoke-RestMethod -Uri "$api/rentals/$($rental.id)" -Headers $ownerHdr
$originalContact = $before.snapshot.contactPhone

$changed = Invoke-RestMethod -Uri "$api/drivers/me/emergency-contact" -Method PUT -Headers $driverHdr `
    -ContentType 'application/json' -Body (@{ name = 'Sunil'; phone = '+94719998877'; relationship = 'Brother' } | ConvertTo-Json)
Step 'contact edit says NEXT_RENTAL' 'NEXT_RENTAL' $changed.appliesTo

$after = Invoke-RestMethod -Uri "$api/rentals/$($rental.id)" -Headers $ownerHdr
Step 'rental snapshot unchanged' $originalContact $after.snapshot.contactPhone

# §5.7.3: a driver never sees a full number, even on their own rental.
$driverView = Invoke-RestMethod -Uri "$api/rentals/$($rental.id)" -Headers $driverHdr
Step 'driver sees masked contact' $true ($driverView.snapshot.contactPhone -ne $originalContact)

# --- authorization ----------------------------------------------------------
$missing = Try-Api 'GET' "$api/bikes/11111111-1111-1111-1111-111111111111" $ownerHdr $null
Step 'unknown bike id returns 404' 404 $missing.status

$guest = Invoke-RestMethod -Uri "$api/auth/guest" -Method POST -ContentType 'application/json' -Body '{}'
$guestHdr = @{ Authorization = "Bearer $($guest.accessToken)" }
$guestRead = Invoke-RestMethod -Uri "$api/bikes" -Headers $guestHdr
Step 'guest can read demo fleet' $true ($guestRead.items.Count -ge 1)

$guestWrite = Try-Api 'POST' "$api/bikes" $guestHdr @{ label = 'should not exist' }
Step 'guest blocked from writing' 'READ_ONLY_GUEST' $guestWrite.data.code

$driverWrite = Try-Api 'POST' "$api/bikes" $driverHdr @{ label = 'not mine' }
Step 'driver blocked from owner routes' 'FORBIDDEN' $driverWrite.data.code

# --- cleanup ----------------------------------------------------------------
$ended = Invoke-RestMethod -Uri "$api/rentals/$($rental.id)/end" -Method POST -Headers $ownerHdr `
    -ContentType 'application/json' -Body (@{ idempotencyKey = [guid]::NewGuid().ToString() } | ConvertTo-Json)
Step 'end moves to ENDING_SYNC' 'ENDING_SYNC' $ended.state

Write-Host ""
if ($fail -eq 0) {
    Write-Host "All $pass checks passed." -ForegroundColor Green
} else {
    Write-Host "$pass passed, $fail failed." -ForegroundColor Red
    exit 1
}
Write-Host "Note: the rental is left in ENDING_SYNC - only a device ack can move it"
Write-Host "to ENDED (FR-RENT-04), and the device gateway is not built yet."
Write-Host "Re-seed to reset:  npm run db:seed -w apps/api`n"
