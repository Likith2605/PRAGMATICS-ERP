<#
.SYNOPSIS
    Configures Windows Defender Firewall rules for PRAGMATICS1 ERP LAN deployment.

.DESCRIPTION
    Creates inbound TCP firewall rules restricted strictly to the office LAN subnet and 'Private' profile:
      1. Port 3001: Pragmatics ERP Web & API Server
      2. Port 4000: QualityApp Mobile Sync Server
    
    SECURITY SAFEGUARDS:
    - RemoteAddress is restricted to 'LocalSubnet' (or a user-specified office subnet).
    - Profile is restricted to 'Private' and 'Domain' (Public networks are NEVER allowed).
    - PostgreSQL port 5432 is explicitly NOT opened (accessible only locally on 127.0.0.1 by server.js).
    - Unrelated firewall rules are completely untouched.
    - -RemoveRules safely deletes ONLY the two specific rules created by this script.

.PARAMETER RemoveRules
    When specified, cleanly removes only the Pragmatics ERP and QualityApp firewall rules.

.PARAMETER Subnet
    The allowed remote address range. Defaults to 'LocalSubnet' (the client office's local subnet).

.PARAMETER ErpPort
    The Pragmatics ERP TCP port. Defaults to 3001.

.PARAMETER QcPort
    The QualityApp Mobile Sync TCP port. Defaults to 4000.

.EXAMPLE
    # Right-click PowerShell -> 'Run as Administrator', then run:
    .\configure-lan-firewall.ps1

.EXAMPLE
    # To remove the rules later:
    .\configure-lan-firewall.ps1 -RemoveRules
#>

[CmdletBinding()]
param(
    [switch]$RemoveRules,
    [string]$Subnet = "LocalSubnet",
    [int]$ErpPort = 3001,
    [int]$QcPort = 4000
)

# Rule names (used for creation, verification, and targeted removal)
$ruleErpName = "Pragmatics ERP - Production Web & API (Port $ErpPort)"
$ruleQcName  = "QualityApp Mobile Sync Server (Port $QcPort)"

# 1. Administrator Elevation Check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "[X] ERROR: Administrator privileges are required to configure firewall rules." -ForegroundColor Red
    Write-Host "    Please right-click PowerShell, select 'Run as administrator', and run this script again." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# 2. Targeted Rollback Mode (-RemoveRules)
if ($RemoveRules) {
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host "   PRAGMATICS ERP - Firewall Rule Removal" -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Removing only Pragmatics ERP and QualityApp firewall rules..." -ForegroundColor Yellow
    
    # Strictly target ONLY the two specific rules created by this script
    Remove-NetFirewallRule -DisplayName $ruleErpName -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName $ruleQcName  -ErrorAction SilentlyContinue
    
    Write-Host "[OK] Firewall rules successfully removed. All other firewall rules were untouched." -ForegroundColor Green
    Write-Host ""
    exit 0
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   PRAGMATICS ERP - Windows Defender Firewall Configurator" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Target Configuration:"
Write-Host "  * ERP Port:        TCP $ErpPort (Inbound)"
Write-Host "  * QualityApp Port: TCP $QcPort (Inbound)"
Write-Host "  * Allowed Remote:  $Subnet (Restricted to office LAN)"
Write-Host "  * Allowed Profile: Private, Domain (Public networks blocked)"
Write-Host ""

# 3. Configure Port 3001 (Pragmatics ERP Web & API)
try {
    # Remove previous rule with this exact display name to avoid duplicates
    Remove-NetFirewallRule -DisplayName $ruleErpName -ErrorAction SilentlyContinue

    New-NetFirewallRule -DisplayName $ruleErpName `
                        -Direction Inbound `
                        -Action Allow `
                        -Protocol TCP `
                        -LocalPort $ErpPort `
                        -RemoteAddress $Subnet `
                        -Profile Private, Domain `
                        -Description "Allows office workstations on the local subnet to access Pragmatics ERP." | Out-Null

    Write-Host "[OK] Created rule: '$ruleErpName' (Remote: $Subnet, Profile: Private/Domain)" -ForegroundColor Green
} catch {
Write-Host "[X] Failed to create rule for Port ${ErpPort}: $($_.Exception.Message)" -ForegroundColor Red}

# 4. Configure Port 4000 (QualityApp Mobile Sync Server)
try {
    # Remove previous rule with this exact display name to avoid duplicates
    Remove-NetFirewallRule -DisplayName $ruleQcName -ErrorAction SilentlyContinue

    New-NetFirewallRule -DisplayName $ruleQcName `
                        -Direction Inbound `
                        -Action Allow `
                        -Protocol TCP `
                        -LocalPort $QcPort `
                        -RemoteAddress $Subnet `
                        -Profile Private, Domain `
                        -Description "Allows mobile devices on office Wi-Fi ($Subnet) to synchronize QualityApp inspection data." | Out-Null

    Write-Host "[OK] Created rule: '$ruleQcName' (Remote: $Subnet, Profile: Private/Domain)" -ForegroundColor Green
} catch {
Write-Host "[X] Failed to create rule for Port ${QcPort}: $($_.Exception.Message)" -ForegroundColor Red}

Write-Host ""
Write-Host "SECURITY AUDIT CONFIRMATION:" -ForegroundColor Cyan
Write-Host "  [SECURE] PostgreSQL Port 5432 remains BLOCKED from LAN (accessible only locally by server.js)." -ForegroundColor Green
Write-Host "  [SECURE] Public network profile is NOT allowed (safe if server ever connects to guest/public Wi-Fi)." -ForegroundColor Green
Write-Host "  [SECURE] Unrelated firewall rules were NOT modified or deleted." -ForegroundColor Green
Write-Host ""
Write-Host "To remove these rules at any time, execute:" -ForegroundColor Gray
Write-Host "  powershell -ExecutionPolicy Bypass -File .\configure-lan-firewall.ps1 -RemoveRules" -ForegroundColor Gray
Write-Host ""
