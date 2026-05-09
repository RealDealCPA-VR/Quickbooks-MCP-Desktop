#Requires -RunAsAdministrator
<#
.SYNOPSIS
  One-shot setup for a Windows + QuickBooks Desktop PC so it can run
  the QuickBooks Desktop MCP server in live mode.

.DESCRIPTION
  Idempotent. Re-running skips anything already installed. Performs:
    1. Verifies Administrator + winget availability
    2. Installs Node.js LTS (64-bit) if missing
    3. Installs Python 3 if missing (needed by node-gyp)
    4. Installs Visual Studio 2022 Build Tools with C++ workload
       if missing (needed to compile winax / node-activex)
    5. Verifies the QuickBooks SDK 16.0 is installed by probing for
       the QBXMLRP2.RequestProcessor COM class. If missing, opens
       Intuit's download page (login required) and waits.
    6. Runs npm install + npm run build in the repo
    7. Scaffolds a .env file in live mode
    8. Probes a real QBXMLRP2 connection (OpenConnection2 -> BeginSession ->
       EndSession -> CloseConnection). On first run this triggers
       QuickBooks' "Application Certificate" dialog -- the operator must
       approve "Yes, always; allow access even if QuickBooks is not running."

.PARAMETER CompanyFile
  Absolute path to the .qbw file. Prompted for if omitted and no .env
  exists yet.

.PARAMETER QbxmlVersion
  qbXML schema version. Defaults to 16.0 (matches the SDK we expect).

.PARAMETER AppName
  App name passed to BeginSession. The first-run cert dialog grants
  consent for THIS exact name, so changing it later re-prompts.

.PARAMETER SkipProbe
  Skip step 8 (the live COM probe). Useful for unattended runs before
  QuickBooks has been authorized.

.NOTES
  Run from the repo root, elevated:
    powershell -ExecutionPolicy Bypass -File scripts\setup-qb-pc.ps1

  Or with overrides:
    powershell -ExecutionPolicy Bypass -File scripts\setup-qb-pc.ps1 `
      -CompanyFile "C:\Users\Public\Documents\Intuit\QuickBooks\Acme.qbw"
#>

[CmdletBinding()]
param(
  [string]$CompanyFile,
  [string]$QbxmlVersion = "16.0",
  [string]$AppName = "MCP QuickBooks Manager",
  [switch]$SkipProbe
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Step($n, $msg) {
  Write-Host ""
  Write-Host "==[ Step $n ]== $msg" -ForegroundColor Cyan
}
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Note($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  [X]  $msg" -ForegroundColor Red }

function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path","User")
}

# Locate nvm.exe regardless of whether the in-process PATH has it. nvm-windows
# 1.2.x installs to LOCALAPPDATA, older versions used APPDATA, and some manual
# installs land in C:\nvm or C:\nvm4w. The HKCU NVM_HOME registry value is the
# most authoritative when it's set.
function Find-NvmExe {
  $nvmHome = [System.Environment]::GetEnvironmentVariable("NVM_HOME", "User")
  if (-not $nvmHome) {
    $nvmHome = [System.Environment]::GetEnvironmentVariable("NVM_HOME", "Machine")
  }
  $candidates = @()
  if ($nvmHome) { $candidates += (Join-Path $nvmHome "nvm.exe") }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "nvm\nvm.exe") }
  if ($env:APPDATA)      { $candidates += (Join-Path $env:APPDATA      "nvm\nvm.exe") }
  $candidates += "C:\nvm\nvm.exe"
  $candidates += "C:\nvm4w\nvm.exe"
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

# Add nvm's directories to the in-process PATH so subsequent `nvm` calls work
# even when the installer's env-var changes haven't propagated to this shell.
function Stitch-NvmPath($nvmExe) {
  $nvmDir = Split-Path $nvmExe
  $symlink = [System.Environment]::GetEnvironmentVariable("NVM_SYMLINK", "User")
  if (-not $symlink) {
    $symlink = [System.Environment]::GetEnvironmentVariable("NVM_SYMLINK", "Machine")
  }
  $prefix = $nvmDir
  if ($symlink) { $prefix = "$prefix;$symlink" }
  $env:Path = "$prefix;" + $env:Path
}

# winget returns these for "no work needed" outcomes that we want to treat as
# success rather than hard-failure when the package is already in place.
$WINGET_EXIT_OK = @(
  0,
  -1978335189,  # APPINSTALLER_CLI_ERROR_NO_APPLICABLE_UPDATE_FOUND
  -1978335212   # APPINSTALLER_CLI_ERROR_INSTALL_PACKAGE_ALREADY_INSTALLED
)

function Test-QbxmlRp2Registered {
  $keys = @(
    "HKLM:\SOFTWARE\Classes\QBXMLRP2.RequestProcessor",
    "HKLM:\SOFTWARE\WOW6432Node\Classes\QBXMLRP2.RequestProcessor"
  )
  foreach ($k in $keys) {
    if (Test-Path $k) { return $true }
  }
  return $false
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Fail "winget not found. Install 'App Installer' from the Microsoft Store first, then re-run."
  exit 1
}

# 64-bit check -- QB 2022+ is 64-bit and Node must match.
if (-not [Environment]::Is64BitOperatingSystem) {
  Write-Fail "This script targets 64-bit Windows. 32-bit installs are out of scope."
  exit 1
}
if (-not [Environment]::Is64BitProcess) {
  Write-Note "PowerShell is running as 32-bit. Re-run from a 64-bit PowerShell host to match QB Desktop bitness."
}

# ---------------------------------------------------------------------------
# Step 1: Node.js 20 LTS (pinned -- winax has no prebuilt for Node 22+)
# ---------------------------------------------------------------------------
# See DECISIONS.md ("Pin Node 20 LTS for live mode") for why this is hard-pinned
# instead of just installing whatever winget calls "LTS." TL;DR: winax's only
# published prebuilt binaries are for the Node 20 ABI, and source-compile against
# Node 22's V8 12.x fails with a HolderV2 API mismatch.
Write-Step 1 "Node.js 20 LTS (pinned via nvm-windows)"

$wantMajor = 20
$nodeMajor = $null
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodeVerString = (& node --version)
  $nodeMajor = [int](($nodeVerString -replace '^v', '').Split('.')[0])
}

if ($nodeMajor -eq $wantMajor) {
  Write-Ok "Node $nodeVerString already active (matches required major v$wantMajor)"
} else {
  if ($nodeMajor) {
    Write-Note "Found Node $nodeVerString on PATH but this project requires Node $wantMajor."
    Write-Note "winax (the COM bridge) has no prebuilt for Node 22+, and source-compile fails."
    Write-Note "Will install nvm-windows so multiple Node versions can coexist."
  } else {
    Write-Host "  No Node detected. Installing nvm-windows + Node $wantMajor..."
  }

  # Find nvm. Order: PATH first (cheapest), then canonical install paths
  # (handles "already installed but PATH not propagated" -- the most common
  # outcome on a re-run). Only invoke winget if neither check finds nvm.
  $nvmCmd = Get-Command nvm -ErrorAction SilentlyContinue
  if (-not $nvmCmd) {
    $existingNvm = Find-NvmExe
    if ($existingNvm) {
      Write-Note "nvm-windows is installed at $existingNvm but not on this shell's PATH."
      Stitch-NvmPath $existingNvm
      $nvmCmd = Get-Command nvm -ErrorAction SilentlyContinue
    }
  }

  if (-not $nvmCmd) {
    Write-Host "  Installing nvm-windows via winget (CoreyButler.NVMforWindows)..."
    winget install --id CoreyButler.NVMforWindows --silent `
      --accept-source-agreements --accept-package-agreements
    $wgExit = $LASTEXITCODE
    if ($WINGET_EXIT_OK -notcontains $wgExit) {
      Write-Fail "nvm-windows install failed (winget exit $wgExit)."
      Write-Host "  Manual install: https://github.com/coreybutler/nvm-windows/releases"
      exit 1
    }
    Refresh-Path

    # winget reported success (or "already installed"). Find nvm.exe so we can
    # invoke it without depending on PATH propagation in this process.
    $nvmCmd = Get-Command nvm -ErrorAction SilentlyContinue
    if (-not $nvmCmd) {
      $found = Find-NvmExe
      if (-not $found) {
        Write-Fail "winget reported success but nvm.exe not found in any standard location."
        Write-Host "  Open a NEW elevated PowerShell and re-run this script."
        exit 1
      }
      Stitch-NvmPath $found
      $nvmCmd = Get-Command nvm -ErrorAction SilentlyContinue
      if (-not $nvmCmd) {
        Write-Fail "Even after PATH stitch, nvm still not invocable. Open a NEW elevated PowerShell and re-run."
        exit 1
      }
    }
    Write-Ok "nvm-windows installed (or already present)."
  } else {
    Write-Ok "nvm-windows already on PATH."
  }

  # Install Node 20 via nvm and switch to it. nvm install accepts a major-only
  # version string and picks the latest LTS in that line.
  Write-Host "  Running: nvm install $wantMajor"
  & nvm install $wantMajor
  if ($LASTEXITCODE -ne 0) { Write-Fail "nvm install $wantMajor failed."; exit 1 }

  Write-Host "  Running: nvm use $wantMajor"
  & nvm use $wantMajor
  if ($LASTEXITCODE -ne 0) { Write-Fail "nvm use $wantMajor failed."; exit 1 }

  # Note: nvm-windows 1.2.x has no `alias default` subcommand (that's nvm-osx).
  # Stickiness across new shells is handled instead by detecting and warning
  # about a competing system-PATH Node install (Step 1.5 below).

  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "Node not on PATH after nvm install. Open a NEW elevated PowerShell, run 'nvm use $wantMajor', and re-run this script."
    exit 1
  }

  $nodeVerString = (& node --version)
  $nodeMajor = [int](($nodeVerString -replace '^v', '').Split('.')[0])
  if ($nodeMajor -ne $wantMajor) {
    Write-Fail "After nvm install, Node is still $nodeVerString (wanted v$wantMajor.x)."
    Write-Host "  Open a new shell, run 'nvm use $wantMajor', and re-run this script."
    exit 1
  }
  Write-Ok "Node $nodeVerString active via nvm-windows."
}

# ---------------------------------------------------------------------------
# Step 2: Python 3 (for node-gyp)
# ---------------------------------------------------------------------------
Write-Step 2 "Python 3 (for node-gyp)"
$pyOk = $false
$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if ($pyCmd) {
  $pyVer = (& python --version) 2>&1
  if ($pyVer -match "Python 3\.") { $pyOk = $true; Write-Ok "Python already installed ($pyVer)" }
}
if (-not $pyOk) {
  Write-Host "  Installing Python 3.12 via winget..."
  winget install --id Python.Python.3.12 --silent `
    --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { Write-Fail "Python install failed (exit $LASTEXITCODE)."; exit 1 }
  Refresh-Path
  Write-Ok "Python installed."
}

# ---------------------------------------------------------------------------
# Step 3: Visual Studio Build Tools 2022 (C++ workload)
# ---------------------------------------------------------------------------
Write-Step 3 "Visual Studio Build Tools 2022 + C++ workload"
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$haveVcTools = $false
if (Test-Path $vsWhere) {
  $found = & $vsWhere -products * `
    -requires Microsoft.VisualStudio.Workload.VCTools `
    -property installationPath -latest 2>$null
  if ($found) { $haveVcTools = $true }
}
if ($haveVcTools) {
  Write-Ok "VS Build Tools with C++ workload already present."
} else {
  Write-Note "Installing VS Build Tools + C++ workload. This is several GB and can take 10-25 minutes."
  $override = '--quiet --wait --norestart ' +
              '--add Microsoft.VisualStudio.Workload.VCTools ' +
              '--add Microsoft.VisualStudio.Component.Windows10SDK.20348 ' +
              '--includeRecommended'
  winget install --id Microsoft.VisualStudio.2022.BuildTools `
    --silent --accept-source-agreements --accept-package-agreements `
    --override $override
  # winget can return 0x8A150061 / non-zero even on success -- verify via vswhere.
  if (Test-Path $vsWhere) {
    $found = & $vsWhere -products * `
      -requires Microsoft.VisualStudio.Workload.VCTools `
      -property installationPath -latest 2>$null
    if (-not $found) {
      Write-Fail "VS Build Tools install did not register the VCTools workload."
      Write-Host "  Install manually: https://aka.ms/vs/17/release/vs_BuildTools.exe"
      Write-Host "  Select 'Desktop development with C++' workload."
      exit 1
    }
  }
  Write-Ok "VS Build Tools installed."
}

# ---------------------------------------------------------------------------
# Step 4: QuickBooks SDK 16.0
# ---------------------------------------------------------------------------
Write-Step 4 "QuickBooks SDK 16.0 (registers QBXMLRP2 COM)"
if (Test-QbxmlRp2Registered) {
  Write-Ok "QBXMLRP2.RequestProcessor is registered."
} else {
  Write-Note "QuickBooks SDK not detected -- QBXMLRP2 ProgID is not in the registry."
  Write-Host "  Intuit requires a (free) developer account login to download the SDK,"
  Write-Host "  so this step is partially manual."
  Write-Host ""
  Write-Host "  1. The browser will open the SDK download page in 5 seconds."
  Write-Host "  2. Sign in (or create a free Intuit Developer account)."
  Write-Host "  3. Download 'QuickBooks Desktop SDK 16.0' (Windows .exe)."
  Write-Host "  4. Run the installer with default options."
  Write-Host "  5. Return here and press ENTER."
  Start-Sleep -Seconds 5
  Start-Process "https://developer.intuit.com/app/developer/qbdesktop/docs/get-started/download-and-install-the-sdk"
  Read-Host "  Press ENTER once the SDK installer has finished"
  if (-not (Test-QbxmlRp2Registered)) {
    Write-Fail "SDK still not detected. Verify the installer finished cleanly, then re-run this script."
    exit 1
  }
  Write-Ok "QBXMLRP2.RequestProcessor registered."
}

# ---------------------------------------------------------------------------
# Step 5: npm install + build
# ---------------------------------------------------------------------------
Write-Step 5 "Project dependencies + build"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repoRoot "package.json"))) {
  Write-Fail "package.json not found in $repoRoot. Place this script in <repo>/scripts/ and run from there."
  exit 1
}
Push-Location $repoRoot
try {
  Write-Host "  Running npm install..."
  & npm install
  if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed (exit $LASTEXITCODE)."; exit 1 }
  Write-Host "  Running npm run build..."
  & npm run build
  if ($LASTEXITCODE -ne 0) { Write-Fail "npm run build failed (exit $LASTEXITCODE)."; exit 1 }
  Write-Ok "Project built into dist/"
} finally {
  Pop-Location
}

# ---------------------------------------------------------------------------
# Step 6: .env scaffold
# ---------------------------------------------------------------------------
Write-Step 6 ".env configuration"
$envPath = Join-Path $repoRoot ".env"
if (Test-Path $envPath) {
  Write-Ok ".env already exists at $envPath (leaving as-is)."
  if (-not $CompanyFile) {
    $existing = Get-Content $envPath | Where-Object { $_ -match '^QB_COMPANY_FILE=' }
    if ($existing) { $CompanyFile = ($existing -split '=', 2)[1] }
  }
} else {
  if (-not $CompanyFile) {
    $CompanyFile = Read-Host "  Full path to your .qbw company file"
  }
  if (-not (Test-Path $CompanyFile)) {
    Write-Note "File '$CompanyFile' does not exist yet. Continuing -- fix QB_COMPANY_FILE in .env later."
  }
  $companyRoot = Split-Path -Parent $CompanyFile
  $envContent = @"
# Generated by scripts/setup-qb-pc.ps1
QB_LIVE=1
QB_SIMULATION=false
QB_COMPANY_FILE=$CompanyFile
QB_COMPANY_ROOT=$companyRoot
QB_APP_NAME=$AppName
QB_QBXML_VERSION=$QbxmlVersion
"@
  $envContent | Out-File -FilePath $envPath -Encoding utf8
  Write-Ok "Wrote $envPath"
}

# ---------------------------------------------------------------------------
# Step 7: COM probe
# ---------------------------------------------------------------------------
Write-Step 7 "QBXMLRP2 connectivity probe"
if ($SkipProbe) {
  Write-Note "Skipping probe (-SkipProbe)."
} elseif (-not $CompanyFile) {
  Write-Note "No company file path available; skipping probe."
} else {
  Write-Host "  Before continuing:"
  Write-Host "    * Open QuickBooks Desktop"
  Write-Host "    * Load the company file: $CompanyFile"
  Write-Host "    * Log in as Admin"
  Write-Host "    * (First run only) switch to single-user mode: File > Switch to Single-user Mode"
  Write-Host ""
  Read-Host "  Press ENTER once QuickBooks is ready"

  $rp = $null
  $ticket = $null
  try {
    $rp = New-Object -ComObject QBXMLRP2.RequestProcessor
    Write-Ok "Created QBXMLRP2.RequestProcessor"

    Write-Host "  Calling OpenConnection2($AppName, ctLocalQBD=1)..."
    $rp.OpenConnection2("", $AppName, 1)
    Write-Ok "OpenConnection2 succeeded"

    Write-Host "  Calling BeginSession (omDontCare=2)..."
    Write-Host "  If this is the first time '$AppName' has connected to this file,"
    Write-Host "  QuickBooks will pop an Application Certificate dialog. Choose:"
    Write-Host "    * 'Yes, always; allow access even if QuickBooks is not running'"
    Write-Host "    * Continue"
    $ticket = $rp.BeginSession($CompanyFile, 2)
    if ([string]::IsNullOrEmpty($ticket)) {
      Write-Fail "BeginSession returned an empty ticket."
      exit 1
    }
    Write-Ok "BeginSession ticket: $ticket"
  } catch {
    Write-Fail "Probe failed: $($_.Exception.Message)"
    Write-Host "  Common causes:"
    Write-Host "    - QuickBooks isn't running, or company file isn't open"
    Write-Host "    - Logged-in user isn't Admin"
    Write-Host "    - Application Certificate dialog wasn't approved"
    Write-Host "    - 32/64-bit mismatch between Node and QuickBooks"
    Write-Host "    - Company file path mismatch (must match exactly what QB has open)"
    exit 1
  } finally {
    if ($rp -ne $null) {
      try { if ($ticket) { $rp.EndSession($ticket) | Out-Null } } catch {}
      try { $rp.CloseConnection() | Out-Null } catch {}
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($rp) | Out-Null
    }
  }
  Write-Ok "Session closed cleanly. COM path is fully working end-to-end."
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. From repo root: node dist\index.js </NUL"
Write-Host "     -> banner should NOT say 'Mode: simulation' once Item 1 lands."
Write-Host "     -> until Item 1 lands, the server will throw 'Live QuickBooks"
Write-Host "        connection requires Windows...' on first tool call. That's"
Write-Host "        the expected pre-Item-1 state -- env wiring is correct."
Write-Host "  2. Pull the latest branch from the dev machine after Item 1 ships,"
Write-Host "     re-run: npm install ; npm run build ; node dist\index.js"
Write-Host "  3. Use an MCP client to call qb_session_connect -> qb_company_info."
Write-Host ""
