#Requires -Version 5.1
<#
.SYNOPSIS
    csi installer (Windows).

.DESCRIPTION
    Downloads the prebuilt daemon (and optionally the unpacked Chrome
    extension) plus coding-agent skills from GitHub Releases — no local
    build, no Go/Node required. Chrome Web Store users pass -NoExtension
    or set CSI_NO_EXTENSION=1. Windows counterpart to scripts/install.sh.

.EXAMPLE
    irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -NoStart -Yes
#>

[CmdletBinding()]
param(
    [switch]$Help,
    [switch]$NoStart,
    [switch]$NoAutostart,
    [switch]$NoSkill,
    [switch]$NoExtension,
    [string]$Agents,
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

# 与 install.sh --agents 对齐：claude(默认) codex cursor agents opencode all
$Agents = if ($Agents) { $Agents } elseif ($env:CSI_AGENTS) { $env:CSI_AGENTS } else { 'claude' }
if (-not $NoExtension -and $env:CSI_NO_EXTENSION -eq '1') { $NoExtension = $true }
if (-not $NoAutostart -and $env:CSI_NO_AUTOSTART -eq '1') { $NoAutostart = $true }

function Get-SkillsBase ([string]$Agent) {
    switch ($Agent) {
        'claude'   { Join-Path $env:USERPROFILE '.claude\skills' }
        'codex'    { Join-Path $env:USERPROFILE '.codex\skills' }
        'cursor'   { Join-Path $env:USERPROFILE '.cursor\skills' }
        'agents'   { Join-Path $env:USERPROFILE '.agents\skills' }
        'opencode' {
            $cfg = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $env:USERPROFILE '.config' }
            Join-Path $cfg 'opencode\skills'
        }
        default { Die "unknown agent: $Agent (valid: claude, codex, cursor, agents, opencode, all)" }
    }
}

# ---------- output helpers ----------

function Step ([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Info ([string]$m) { Write-Host "    $m" }
function Ok   ([string]$m) { Write-Host "    $([char]0x2713) $m" -ForegroundColor Green }
function Warn ([string]$m) { Write-Host "    ! $m" -ForegroundColor Yellow }
function Die  ([string]$m) { Write-Host "    $([char]0x2717) $m" -ForegroundColor Red; exit 1 }

# 耗时格式化：<60s 走 3.2s（浮点）或 3s（整数），>=60s 走 1m12s
# 分钟/秒用 Floor：PS 的 [int] 是银行家舍入，90s 会变成 2m30s。
# 先算进变量再 -f：-f 优先级高于 %，直接写 `... -f $m, $s % 60` 会对格式化后的字符串取模。
function Format-Elapsed ([double]$Sec) {
    if ($Sec -ge 60) {
        $m = [int][Math]::Floor($Sec / 60)
        $s = [int][Math]::Floor($Sec % 60)
        '{0}m{1}s' -f $m, $s
    } elseif ($Sec -eq [Math]::Floor($Sec)) {
        '{0}s' -f [int]$Sec
    } else {
        '{0:F1}s' -f $Sec
    }
}

# ---------- help ----------

if ($Help) {
    @"
csi installer (Windows)

Usage:
  irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [options]

Options:
  -Help          Show this help.
  -NoExtension   Skip the unpacked extension zip (Chrome Web Store users).
  -NoStart       Install everything, but don't start the daemon.
  -NoAutostart   Don't register login autostart (csi start at login).
                 Re-running the installer re-enables autostart even if
                 you previously ran csi autostart off.
  -NoSkill       Skip installing the coding-agent skills entirely.
  -Agents LIST   Comma-separated skill targets: claude, codex, cursor,
                 agents (the ~\.agents standard dir), opencode, or all.
                 Default: claude. (Alias for `$env:CSI_AGENTS.)
  -Yes           Don't prompt before overwriting an existing skill install.

Environment:
  `$env:CSI_VERSION        Pin to a specific release tag (e.g. v0.2.0; default: latest).
  `$env:CSI_AGENTS         Same as -Agents (e.g. "codex,cursor").
  `$env:CSI_NO_EXTENSION   Set to 1 to skip the unpacked extension zip.
  `$env:CSI_NO_AUTOSTART   Set to 1 to skip login autostart.

Skill target directories:
  claude    ~\.claude\skills           (Claude Code)
  codex     ~\.codex\skills            (Codex App / CLI)
  cursor    ~\.cursor\skills           (Cursor)
  agents    ~\.agents\skills           (cross-tool standard; Cursor & OpenCode read it)
  opencode  ~\.config\opencode\skills  (OpenCode)

What it does:
  1. Download the prebuilt daemon  -> $BinPath
  2. Download the built extension  -> $ExtDir  (sideload; skip with -NoExtension)
  3. Install the skills            -> each target's skills dir (see above)
  4. Register login autostart (skip with -NoAutostart / CSI_NO_AUTOSTART=1)
  5. Start the daemon (restart if it was already running)
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

$script:DL_LAST_TIME = 0
function Download ([string]$url, [string]$dest) {
    # 交互式：临时切 Continue 让 IWR 显示进度条；非交互式 (CI/irm|iex 重定向) 走全局 SilentlyContinue
    $interactive = -not [Console]::IsOutputRedirected
    $oldPref = $ProgressPreference
    if ($interactive) { $ProgressPreference = 'Continue' }
    # 简单重试：网络抖动时重试 2 次再放弃
    for ($i = 1; $i -le 3; $i++) {
        try {
            $start = Get-Date
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 60
            $script:DL_LAST_TIME = ((Get-Date) - $start).TotalSeconds
            $ProgressPreference = $oldPref
            return
        } catch {
            if ($i -eq 3) { $ProgressPreference = $oldPref; Die "download failed: $url" }
            Warn "download failed, retrying ($i/3)..."
            Start-Sleep -Seconds 3
        }
    }
    $ProgressPreference = $oldPref
}

# ---------- upgrade detection ----------

# 换二进制前记录旧 daemon 是否在跑：在跑则装完提示 restarted，否则幂等 start。
# Windows 下运行中的 csi.exe 被占用，替换前必须先 stop。
$script:WasRunning = $false
if (Test-Path $BinPath) {
    $port = if ($env:CSI_PORT) { $env:CSI_PORT } else { '10088' }
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 2 | Out-Null
        $script:WasRunning = $true
    } catch {
        $script:WasRunning = $false
    }
}

# ---------- checksums ----------

# checksums.txt 里的文件名是 release 原始名（csi-windows-amd64.zip），
# 而落盘名是 daemon.zip——算 hash 字符串比对，与 install.sh 的 sha256_check 对齐。
$checksumsFile = Join-Path $TmpDir 'checksums.txt'

function Assert-Sha256 ([string]$File, [string]$AssetName) {
    $want = $null
    foreach ($line in Get-Content $checksumsFile) {
        $parts = $line -split '\s+'
        if ($parts.Count -ge 2 -and $parts[1] -eq $AssetName) { $want = $parts[0]; break }
    }
    if (-not $want) { Die "checksums.txt missing entry: $AssetName" }
    $got = (Get-FileHash -Algorithm SHA256 $File).Hash
    if ($got -ne $want.ToUpper()) { Die "checksum mismatch: $AssetName" }
}

try {
    # ---------- 1. daemon ----------

    Step '[1/5] Installing daemon (windows-amd64)'

    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    Download "$DL/checksums.txt" $checksumsFile
    $daemonZip = Join-Path $TmpDir 'daemon.zip'
    Download "$DL/csi-windows-amd64.zip" $daemonZip
    Assert-Sha256 $daemonZip 'csi-windows-amd64.zip'
    # Windows 会锁住运行中的 csi.exe，升级替换前必须先停掉旧 daemon
    if ($script:WasRunning) {
        & $BinPath stop
        if ($LASTEXITCODE -ne 0) { Die "failed to stop the running daemon before upgrade - run: $BinPath stop --force" }
    }
    Expand-Archive $daemonZip -DestinationPath $TmpDir -Force
    Move-Item (Join-Path $TmpDir 'csi.exe') $BinPath -Force
    Ok "daemon: $BinPath ($(Format-Elapsed $script:DL_LAST_TIME))"

    # ---------- 2. extension ----------

    if ($NoExtension) {
        Step '[2/5] Chrome extension - skipped (-NoExtension)'
        Info 'install from the Chrome Web Store:'
        Info '  https://chromewebstore.google.com/detail/csi/mlnlngdpkodcnblmdgdnlaidijaffeol'
    } else {
        Step '[2/5] Installing Chrome extension'

        $extZip = Join-Path $TmpDir 'extension.zip'
        Download "$DL/csi-extension.zip" $extZip
        Assert-Sha256 $extZip 'csi-extension.zip'
        if (Test-Path $ExtDir) { Remove-Item $ExtDir -Recurse -Force }
        Expand-Archive $extZip -DestinationPath $ExtDir
        Ok "extension: $ExtDir ($(Format-Elapsed $script:DL_LAST_TIME))"
    }

    # ---------- 3. coding-agent skills ----------

    function Install-Skill ([string]$TarName, [string]$DestDir) {
        $tar = Join-Path $TmpDir $TarName
        # tarball 只下载一次，多目标复用
        if (-not (Test-Path $tar)) {
            Download "$DL/$TarName" $tar
            Assert-Sha256 $tar $TarName
            Ok "  fetched $TarName ($(Format-Elapsed $script:DL_LAST_TIME))"
        }
        if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force }
        New-Item -ItemType Directory -Path (Split-Path -Parent $DestDir) -Force | Out-Null
        # Windows 10+ 自带 bsdtar，可直接解 tar.gz
        & tar -xzf $tar -C (Split-Path -Parent $DestDir)
        if ($LASTEXITCODE -ne 0) { Die "failed to extract $TarName" }
        Ok "skill: $DestDir"
    }

    if ($NoSkill) {
        Step '[3/5] Coding-agent skills - skipped (-NoSkill)'
    } else {
        Step '[3/5] Coding-agent skills'

        if ($Agents -eq 'all') { $Agents = 'claude,codex,cursor,agents,opencode' }
        # 先解析全部目标，任何一个不认识就整体失败，不装一半
        $agentList = @($Agents -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($agentList.Count -eq 0) { Die 'no skill targets given (-Agents)' }
        $bases = @($agentList | ForEach-Object { ,@($_, (Get-SkillsBase $_)) })

        $doInstall = $true
        $existing = @($bases | Where-Object { (Test-Path (Join-Path $_[1] 'csi')) -or (Test-Path (Join-Path $_[1] 'csi-e2e')) } |
            ForEach-Object { $_[1] })
        if ($existing.Count -gt 0 -and -not $Yes) {
            $answer = Read-Host "    skills already present under $($existing -join ', ') - overwrite? [y/N]"
            $doInstall = ($answer -match '^(y|yes)$')
        }

        if ($doInstall) {
            foreach ($pair in $bases) {
                $agent = $pair[0]; $base = $pair[1]
                Info "$agent -> $base"
                Install-Skill 'csi-skill.tar.gz' (Join-Path $base 'csi')
                Install-Skill 'csi-e2e-skill.tar.gz' (Join-Path $base 'csi-e2e')
            }
        } else {
            Info 'skipped (kept existing)'
        }
    }

    # ---------- 4. login autostart ----------

    if ($NoAutostart) {
        Step '[4/5] Login autostart - skipped (-NoAutostart)'
        Info "enable later with:  $BinPath autostart on"
    } else {
        Step '[4/5] Login autostart'
        $start = Get-Date
        $autoOk = $false
        try {
            & $BinPath autostart on
            $autoOk = ($LASTEXITCODE -eq 0)
        } catch {
            $autoOk = $false
        }
        if ($autoOk) {
            Ok "login autostart registered ($(Format-Elapsed ((Get-Date) - $start).TotalSeconds))"
        } else {
            Warn "failed to register login autostart - after reboot run: $BinPath autostart on"
        }
    }

    # ---------- 5. start daemon ----------

    if ($NoStart) {
        Step '[5/5] Start daemon - skipped (-NoStart)'
        Info "start it later with:  $BinPath start"
        if ($script:WasRunning) {
            Warn "old daemon is still running the previous version - restart it with:  $BinPath restart"
        }
    } else {
        Step '[5/5] Starting daemon'
        $start = Get-Date
        $started = $false
        try {
            & $BinPath start
            $started = ($LASTEXITCODE -eq 0)
        } catch {
            $started = $false
        }
        if ($started) {
            if ($script:WasRunning) {
                Ok "daemon restarted on new version ($(Format-Elapsed ((Get-Date) - $start).TotalSeconds))"
            } else {
                Ok "daemon is running ($(Format-Elapsed ((Get-Date) - $start).TotalSeconds))"
            }
        } else {
            Warn "daemon failed to start - check logs at $InstallDir\logs\ (daemon-<date>.log)"
        }
    }
} finally {
    Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

# 落版本文件，供 csi update / 排障时对照安装来源版本
try {
    $verOut = & $BinPath version 2>$null
    $ver = ($verOut -split '\s+')[1]
    if ($ver) { Set-Content -Path (Join-Path $InstallDir 'VERSION') -Value $ver -NoNewline }
} catch { }

# ---------- done ----------

Step 'Done. Next steps:'
if ($NoExtension) {
    Info '1. Install the CSI extension from the Chrome Web Store if you haven''t:'
    Info '     https://chromewebstore.google.com/detail/csi/mlnlngdpkodcnblmdgdnlaidijaffeol'
} else {
    Info '1. Load the extension in Chrome:'
    Info '     chrome://extensions -> Developer mode -> Load unpacked -> select:'
    Info "       $ExtDir"
}
Info "2. Open the extension popup and confirm it shows 'connected'"
Info '3. Check status:  curl.exe -s http://127.0.0.1:10088/status'
Write-Host ''
