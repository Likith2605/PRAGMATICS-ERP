# ============================================================
# PostgreSQL local password reset (user-approved)
# - Backup pg_hba.conf, temporarily allow localhost trust,
#   set password of role 'postgres' to 'postgres',
#   restore original pg_hba.conf, restart, verify.
# Original data / databases are NEVER touched.
# ============================================================
$ErrorActionPreference = 'Stop'
$pgData = 'C:\Program Files\PostgreSQL\18\data'
$hba    = Join-Path $pgData 'pg_hba.conf'
$svc    = 'postgresql-x64-18'
$psql   = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
$log    = 'D:\Pragmatics1\scratch\pg_reset_log.txt'
$bak    = Join-Path $pgData ("pg_hba.conf.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Log($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
    Add-Content -Path $log -Value $line
}

function Invoke-Psql($argsList) {
    $out = & $psql @argsList 2>&1 | Out-String
    return $out.Trim()
}

Set-Content -Path $log -Value "=== PostgreSQL password reset started $(Get-Date) ==="
$exitCode = 1

try {
    # ---- Step 1: backup current pg_hba.conf ----
    Copy-Item -Path $hba -Destination $bak -Force
    Log "Step 1: backup created -> $bak"

    # ---- Step 2: prepend trust rules for localhost (first match wins) ----
    $orig = [IO.File]::ReadAllText($hba)
    $trust = "local all all trust`r`nhost all all 127.0.0.1/32 trust`r`nhost all all ::1/128 trust`r`n"
    [IO.File]::WriteAllText($hba, $trust + $orig)
    Log "Step 2: temporary trust rules prepended"

    # ---- Step 3: restart service so new rules take effect ----
    Restart-Service -Name $svc -Force
    Log "Step 3: service restarted"

    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        $probe = Invoke-Psql @('-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-tAc', 'SELECT 1')
        if ($LASTEXITCODE -eq 0 -and $probe -match '1') { $ready = $true; break }
    }
    if (-not $ready) { throw "PostgreSQL did not become ready under trust auth. Probe output: $probe" }
    Log "Step 3: server ready under trust auth"

    # ---- Step 4: ensure role exists, then set the password ----
    $role = Invoke-Psql @('-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-tAc',
        "SELECT rolname FROM pg_roles WHERE rolname = 'postgres'")
    if ($role -ne 'postgres') {
        Log "Step 4: role 'postgres' missing (found: '$role') - creating it"
        $out = Invoke-Psql @('-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
            '-c', "CREATE ROLE postgres LOGIN SUPERUSER PASSWORD 'postgres'")
        if ($LASTEXITCODE -ne 0) { throw "CREATE ROLE failed: $out" }
    }
    $out = Invoke-Psql @('-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
        '-c', "ALTER ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres'")
    if ($LASTEXITCODE -ne 0) { throw "ALTER ROLE failed: $out" }
    Log "Step 4: password of role 'postgres' set to 'postgres'"

    # ---- Step 5: report databases (informational) ----
    $dbs = Invoke-Psql @('-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-tAc',
        "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY 1")
    $dbsOneLine = (($dbs -split "`n" | Where-Object { $_ }) -join ', ')
    Log "Step 5: databases present: $dbsOneLine"
    $exitCode = 0
}
catch {
    Log "ERROR: $($_.Exception.Message)"
    $exitCode = 1
}
finally {
    # ---- Step 6: ALWAYS restore the original pg_hba.conf ----
    try {
        if (Test-Path $bak) {
            Copy-Item -Path $bak -Destination $hba -Force
            Log "Step 6: original pg_hba.conf restored from backup"
        }
    } catch { Log "ERROR restoring pg_hba.conf: $($_.Exception.Message)"; $exitCode = 1 }
}

# ---- Step 7: restart to re-enforce password auth ----
try {
    Restart-Service -Name $svc -Force
    Log "Step 7: service restarted (scram-sha-256 enforced again)"
    Start-Sleep -Seconds 3
} catch { Log "ERROR restarting service: $($_.Exception.Message)"; $exitCode = 1 }

# ---- Step 8: verify with the new password ----
try {
    $env:PGPASSWORD = 'postgres'
    $ver = $null
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        $ver = Invoke-Psql @('-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-tAc', "SELECT 'VERIFIED as ' || current_user")
        if ($LASTEXITCODE -eq 0 -and $ver -match 'VERIFIED') { break }
    }
    if ($ver -match 'VERIFIED') { Log "Step 8: $ver"; if ($exitCode -eq 0) { $exitCode = 0 } }
    else { Log "Step 8: VERIFICATION FAILED - last output: $ver"; $exitCode = 1 }
} catch { Log "ERROR during verification: $($_.Exception.Message)"; $exitCode = 1 }

Log "=== Finished with exit code $exitCode ==="
exit $exitCode
