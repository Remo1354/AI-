# Remo AI Workspace - Windows one-step setup.
# Checks the environment, creates .env, installs dependencies, builds the web app.
# Safe to run again at any time.
#
# Usage (PowerShell, from the project folder):
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
# or simply double-click bootstrap.cmd in the project root.
#
# Messages in this file are ASCII-only on purpose: Windows PowerShell 5.1 misreads
# UTF-8 scripts without a BOM. The detailed (Chinese) report comes from scripts\doctor.mjs.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host '== Remo AI Workspace - setup ==' -ForegroundColor Cyan

function Test-NodeVersion {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $false }
    $ok = & node -e "const [a,b]=process.versions.node.split('.').map(Number);process.stdout.write(a>22||(a===22&&b>=13)?'yes':'no')"
    return ($ok -eq 'yes')
}

if (-not (Test-NodeVersion)) {
    $current = if (Get-Command node -ErrorAction SilentlyContinue) { & node -v } else { 'not installed' }
    Write-Host "Node.js 22.13 or newer is required (found: $current)." -ForegroundColor Yellow
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        $answer = Read-Host 'Install Node.js LTS now with winget? [Y/n]'
        if ($answer -eq '' -or $answer -match '^[Yy]') {
            winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
            # Make the new install visible to this session.
            $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
        }
    }
    if (-not (Test-NodeVersion)) {
        Write-Host 'Node.js is still missing or too old.' -ForegroundColor Red
        Write-Host 'Install it from https://nodejs.org (LTS, version 22 or newer), open a NEW terminal, and run this script again.'
        exit 1
    }
}
Write-Host ("OK  Node.js " + (& node -v)) -ForegroundColor Green

if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Host 'OK  Created .env from .env.example (local-only access, no changes needed to run)' -ForegroundColor Green
} else {
    Write-Host 'OK  .env already exists, left unchanged' -ForegroundColor Green
}

Write-Host '--> Installing dependencies (this can take a minute)...'
if (Test-Path 'package-lock.json') {
    & npm ci --no-audit --no-fund
} else {
    & npm install --no-audit --no-fund
}
if ($LASTEXITCODE -ne 0) { Write-Host 'npm install failed. See the messages above.' -ForegroundColor Red; exit 1 }

Write-Host '--> Building the web app...'
& npm run build --silent
if ($LASTEXITCODE -ne 0) { Write-Host 'Build failed. See the messages above.' -ForegroundColor Red; exit 1 }

& node scripts\doctor.mjs
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  Start the platform   scripts\start.ps1   (or double-click start.cmd)'
Write-Host '                       then open http://127.0.0.1:8787'
Write-Host '  Development mode     scripts\start.ps1 -Dev'
Write-Host '  Back up your data    npm run backup'
