# Remo AI Learning Platform - start on Windows.
#   scripts\start.ps1          run the platform (API + web UI) at http://127.0.0.1:8787
#   scripts\start.ps1 -Dev     development mode with hot reload at http://127.0.0.1:5173
#   scripts\start.ps1 -NoOpen  do not open the browser automatically
# Or double-click start.cmd in the project root.

param(
    [switch]$Dev,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Test-Path 'node_modules') -or -not (Test-Path '.env')) {
    Write-Host 'First run: setting things up...' -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'bootstrap.ps1')
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

& node scripts\doctor.mjs --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Environment check failed. Fix the items listed above, then try again.' -ForegroundColor Red
    exit 1
}

# Read PORT from .env so the browser opens the right address.
$port = 8787
$line = Get-Content '.env' -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)' } | Select-Object -First 1
if ($line -and ($line -match '(\d+)')) { $port = [int]$Matches[1] }

if ($Dev) {
    if (-not $NoOpen) { Start-Job -ScriptBlock { Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:5173' } | Out-Null }
    & node scripts\dev.mjs
} else {
    if (-not $NoOpen) {
        Start-Job -ArgumentList $port -ScriptBlock { param($p) Start-Sleep -Seconds 5; Start-Process "http://127.0.0.1:$p" } | Out-Null
    }
    & node scripts\run-prod.mjs
}
exit $LASTEXITCODE
