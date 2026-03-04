#Requires -Version 5.1
<#
.SYNOPSIS
    csi installer (Windows).

.DESCRIPTION
    Downloads the prebuilt daemon, the built Chrome extension, and the Claude
    Code skill from GitHub Releases — no local build, no Go/Node required.
    Windows counterpart to scripts/install.sh.

.EXAMPLE
    irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -NoStart -Yes
#>

[CmdletBinding()]
param(
    [switch]$Help,
    [switch]$NoStart,
    [switch]$NoSkill,
    [switch]$Yes
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- config ----------

$Releases   = 'https://github.com/ximing/csi/releases'
$InstallDir = Join-Path $env:USERPROFILE '.csi'
$BinDir     = Join-Path $InstallDir 'bin'
$BinPath    = Join-Path $BinDir 'csi.exe'
$ExtDir     = Join-Path $InstallDir 'extension'
$SkillDir   = Join-Path $env:USERPROFILE '.claude\skills\csi'
$E2ESkillDir = Join-Path $env:USERPROFILE '.claude\skills\csi-e2e'

# ---------- output helpers ----------

function Step ([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Info ([string]$m) { Write-Host "    $m" }
function Ok   ([string]$m) { Write-Host "    $([char]0x2713) $m" -ForegroundColor Green }
function Warn ([string]$m) { Write-Host "    ! $m" -ForegroundColor Yellow }
function Die  ([string]$m) { Write-Host "    $([char]0x2717) $m" -ForegroundColor Red; exit 1 }

# ---------- help ----------

if ($Help) {
    @"
csi installer (Windows)

Usage:
  irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [options]

Options:
  -Help        Show this help.
  -NoStart     Install everything, but don't start the daemon.
  -NoSkill     Skip installing the Claude Code skill.
  -Yes         Don't prompt before overwriting an existing skill install.

Environment:
  `$env:CSI_VERSION   Pin to a specific release tag (e.g. v0.2.0; default: latest).

What it does:
  1. Download the prebuilt daemon  -> $BinPath
  2. Download the built extension  -> $ExtDir  (load this in chrome://extensions)
  3. Install the Claude Code skills -> $SkillDir + $E2ESkillDir
  4. Start the daemon (idempotent)
"@
    exit 0
}

# ---------- config summary ----------

Step 'csi install'
Info 'platform : windows-amd64'
Info "install  : $InstallDir"

# latest 是 Releases 里的固定目录；指定版本走 download/<tag>/
$Version = if ($env:CSI_VERSION) { $env:CSI_VERSION } else { 'latest' }
$DL = if ($Version -eq 'latest') { "$Releases/latest/download" } else { "$Releases/download/$Version" }
Info "version  : $Version"

$TmpDir = Join-Path $env:TEMP "csi-install-$([System.Guid]::NewGuid().Guid)"
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

function Download ([string]$url, [string]$dest) {
    # 简单重试：网络抖动时重试 2 次再放弃
    for ($i = 1; $i -le 3; $i++) {
        try {
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 60
            return
        } catch {
            if ($i -eq 3) { Die "download failed: $url" }
            Warn "download failed, retrying ($i/3)..."
            Start-Sleep -Seconds 3
        }
    }
}

try {
    # ---------- 1. daemon ----------

    Step '[1/4] Installing daemon (windows-amd64)'

    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $daemonZip = Join-Path $TmpDir 'daemon.zip'
    Download "$DL/csi-windows-amd64.zip" $daemonZip
    Expand-Archive $daemonZip -DestinationPath $TmpDir -Force
    Move-Item (Join-Path $TmpDir 'csi.exe') $BinPath -Force
    Ok "daemon: $BinPath"

    # ---------- 2. extension ----------

    Step '[2/4] Installing Chrome extension'

    $extZip = Join-Path $TmpDir 'extension.zip'
    Download "$DL/csi-extension.zip" $extZip
    if (Test-Path $ExtDir) { Remove-Item $ExtDir -Recurse -Force }
    Expand-Archive $extZip -DestinationPath $ExtDir
    Ok "extension: $ExtDir"

    # ---------- 3. Claude Code skills ----------

    function Install-Skill ([string]$TarName, [string]$DestDir) {
        $tar = Join-Path $TmpDir $TarName
        Download "$DL/$TarName" $tar
        if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force }
        New-Item -ItemType Directory -Path (Split-Path -Parent $DestDir) -Force | Out-Null
        # Windows 10+ 自带 bsdtar，可直接解 tar.gz
        & tar -xzf $tar -C (Split-Path -Parent $DestDir)
        if ($LASTEXITCODE -ne 0) { Die "failed to extract $TarName" }
        Ok "skill: $DestDir"
    }

    if ($NoSkill) {
        Step '[3/4] Claude Code skills - skipped (-NoSkill)'
    } else {
        Step '[3/4] Claude Code skills'

        $doInstall = $true
        if (((Test-Path $SkillDir) -or (Test-Path $E2ESkillDir)) -and -not $Yes) {
            $answer = Read-Host '    skills already present under ~/.claude/skills - overwrite? [y/N]'
            $doInstall = ($answer -match '^(y|yes)$')
        }

        if ($doInstall) {
            Install-Skill 'csi-skill.tar.gz' $SkillDir
            Install-Skill 'csi-e2e-skill.tar.gz' $E2ESkillDir
        } else {
            Info 'skipped (kept existing)'
        }
    }

    # ---------- 4. start daemon ----------

    if ($NoStart) {
        Step '[4/4] Start daemon - skipped (-NoStart)'
        Info "start it later with:  $BinPath start"
    } else {
        Step '[4/4] Starting daemon'
        $started = $false
        try {
            & $BinPath start
            $started = ($LASTEXITCODE -eq 0)
        } catch {
            $started = $false
        }
        if ($started) {
            Ok 'daemon is running'
        } else {
            Warn "daemon failed to start - check logs at $InstallDir\logs\daemon.log"
        }
    }
} finally {
    Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------- done ----------

Step 'Done. Next steps:'
Info '1. Load the extension in Chrome:'
Info '     chrome://extensions -> Developer mode -> Load unpacked -> select:'
Info "       $ExtDir"
Info "2. Open the extension popup and confirm it shows 'connected'"
Info '3. Check status:  curl.exe -s http://127.0.0.1:10088/status'
Write-Host ''
