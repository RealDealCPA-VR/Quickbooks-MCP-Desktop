/**
 * The one-line workstation installer the hub serves at /connector/install.ps1
 * (docs/CONNECTOR_DESIGN.md, #111):
 *
 *   irm http://<hub>:8765/connector/install.ps1 | iex
 *
 * It installs a private Node.js 20 (winax needs 20) under
 * %LOCALAPPDATA%\QuickBooksMcpConnector, installs the connector from the
 * hub's own build (/connector/package.tgz, so it always matches the hub and
 * needs no git), starts it hidden at every logon from the user's Startup
 * folder (no admin; it must run in the logon session to reach QuickBooks'
 * window and mapped drives) with a restart loop, opens TCP 8766 to the
 * tailnet only (one UAC prompt), and starts it now. Re-running it updates.
 * `$env:QB_CONNECTOR_UNINSTALL='1'` before the same line removes it.
 *
 * The script must stay pure ASCII: Windows PowerShell 5.1 reads BOM-less
 * text as ANSI.
 */

export const CONNECTOR_INSTALL_DIR = "QuickBooksMcpConnector";

export function connectorInstallScript(hubUrl: string, port: number): string {
  const script = String.raw`# QuickBooks MCP connector installer, served by the hub at __HUB__
# Install or update:  irm __HUB__/connector/install.ps1 | iex
# Remove:             $env:QB_CONNECTOR_UNINSTALL='1'; irm __HUB__/connector/install.ps1 | iex
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $Hub = '__HUB__'
  $Port = __PORT__
  $Root = Join-Path $env:LOCALAPPDATA '__DIR__'
  $NodeDir = Join-Path $Root 'node'
  $AppDir = Join-Path $Root 'app'
  $Launcher = Join-Path ([Environment]::GetFolderPath('Startup')) 'QuickBooks MCP Connector.vbs'
  $RuleName = 'QuickBooks MCP Connector (tailnet)'

  function Stop-Connector {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cmd.exe'" |
      Where-Object { $_.CommandLine -like '*__DIR__*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  function Test-Port {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $Port); return $true } catch { return $false } finally { $c.Close() }
  }
  function Invoke-Elevated([string]$command) {
    try {
      Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', $command)
      return $true
    } catch {
      return $false
    }
  }

  if ($env:QB_CONNECTOR_UNINSTALL -eq '1') {
    Remove-Item Env:\QB_CONNECTOR_UNINSTALL -ErrorAction SilentlyContinue
    Stop-Connector
    Remove-Item $Launcher -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
    if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
      if (-not (Invoke-Elevated "Remove-NetFirewallRule -DisplayName '$RuleName'")) { Write-Warning "Firewall rule '$RuleName' was left in place (admin prompt declined)." }
    }
    Write-Host 'QuickBooks MCP connector removed from this PC. The hub shows it as offline; use Forget there to remove it from the list.'
    return
  }

  Write-Host "Installing the QuickBooks MCP connector for hub $Hub"
  New-Item -ItemType Directory -Force -Path $Root | Out-Null

  # 1. A private Node.js 20 (the QuickBooks COM bridge needs Node 20).
  $Node = Join-Path $NodeDir 'node.exe'
  $haveNode = $false
  if (Test-Path $Node) { $haveNode = ((& $Node -v) -like 'v20.*') }
  if (-not $haveNode) {
    Write-Host '  Downloading Node.js 20 (a private copy, separate from any Node already installed)...'
    $base = 'https://nodejs.org/dist/latest-v20.x'
    $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "\r?\n"
    $line = $sums | Where-Object { $_ -match 'node-v20\.[0-9.]+-win-x64\.zip$' } | Select-Object -First 1
    if (-not $line) { throw 'Could not find the Node.js 20 download.' }
    $parts = $line.Trim() -split '\s+'
    $zip = Join-Path $env:TEMP $parts[1]
    Invoke-WebRequest "$base/$($parts[1])" -OutFile $zip -UseBasicParsing
    if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $parts[0]) { throw 'The Node.js download failed its checksum.' }
    $tmp = Join-Path $env:TEMP ('qbmcp-node-' + [guid]::NewGuid().ToString('N'))
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    Stop-Connector
    if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
    Move-Item (Join-Path $tmp ($parts[1] -replace '\.zip$', '')) $NodeDir
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  # 2. The connector, built by this hub.
  Write-Host '  Installing the connector from the hub...'
  Stop-Connector
  $tgz = Join-Path $Root 'connector.tgz'
  Invoke-WebRequest "$Hub/connector/package.tgz" -OutFile $tgz -UseBasicParsing
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  $env:Path = "$NodeDir;$env:Path"
  & (Join-Path $NodeDir 'npm.cmd') install --prefix $AppDir --omit=dev --no-audit --no-fund --loglevel=error $tgz
  if ($LASTEXITCODE -ne 0) { throw 'npm install of the connector failed (see the messages above).' }
  $Main = Join-Path $AppDir 'node_modules\quickbooks-desktop-mcp\dist\connector\main.js'
  if (-not (Test-Path $Main)) { throw "The connector is missing after install: $Main" }

  # 3. Start hidden at every logon, restarting if it ever exits.
  $Run = Join-Path $Root 'run.cmd'
  $cmd = @(
    '@echo off',
    'set QB_HUB_URL=' + $Hub,
    ':loop',
    'for %%F in ("%~dp0connector.log") do if %%~zF GTR 5000000 move /y "%~dp0connector.log" "%~dp0connector.old.log" >nul',
    '"%~dp0node\node.exe" "%~dp0app\node_modules\quickbooks-desktop-mcp\dist\connector\main.js" >> "%~dp0connector.log" 2>&1',
    'ping -n 16 127.0.0.1 >nul',
    'goto loop'
  )
  Set-Content -Path $Run -Value $cmd -Encoding Ascii
  $vbs = 'CreateObject("WScript.Shell").Run """' + $Run + '""", 0, False'
  Set-Content -Path $Launcher -Value $vbs -Encoding Ascii

  # 4. Let the hub reach this connector: TCP $Port from tailnet addresses only.
  if (-not (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)) {
    Write-Host '  Opening the firewall for the hub (Windows asks for admin once)...'
    $rule = "New-NetFirewallRule -DisplayName '$RuleName' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any | Out-Null"
    if (-not (Invoke-Elevated $rule)) { Write-Warning "Admin prompt declined: the hub may not reach this PC until TCP $Port is allowed from 100.64.0.0/10." }
  }

  # 5. Start it now.
  if (Test-Port) {
    Write-Warning "Something else already listens on port $Port, probably a connector started by hand (npx). Close that window, then run this installer again."
    return
  }
  Start-Process wscript.exe -ArgumentList ('"' + $Launcher + '"')
  $up = $false
  for ($i = 0; $i -lt 30 -and -not $up; $i++) { Start-Sleep -Seconds 1; $up = Test-Port }
  if ($up) {
    Write-Host ''
    Write-Host "Done. $env:COMPUTERNAME should show as Available on the control page within a minute: $Hub/"
    Write-Host "It starts by itself at every logon. Log: $Root\connector.log"
  } else {
    Write-Warning "The connector didn't start. See $Root\connector.log"
  }
}
`;
  return script
    .replaceAll("__HUB__", hubUrl)
    .replaceAll("__PORT__", String(port))
    .replaceAll("__DIR__", CONNECTOR_INSTALL_DIR)
    .replace(/\n/g, "\r\n");
}
