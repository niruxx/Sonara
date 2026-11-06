<#
.SYNOPSIS
  Sonara installer for Windows.

.DESCRIPTION
  - Checks for / installs Node.js (>= 22.13) and git (via winget)
  - Installs npm dependencies
  - Creates data\config.json (port + music folder)
  - Registers a Scheduled Task named "Sonara" so the server runs in the background
  - Optionally opens the port in Windows Firewall for other devices on your network

.PARAMETER Port
  Port to listen on (default 7700, or the currently configured port).

.PARAMETER Music
  A music folder to add to the library.

.PARAMETER RunAs
  System (default) - starts when Windows boots, even before anyone logs in.
  User             - starts when you log in. Use this if your music is on a
                     mapped drive or network share that only your account can see.

.PARAMETER NoService
  Don't create the Scheduled Task (run it yourself with "npm start").

.PARAMETER Yes
  Accept all defaults without prompting.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Port 8080 -Music "D:\Music" -Yes
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [string]$Music = '',
  [ValidateSet('System', 'User')][string]$RunAs = 'System',
  [switch]$NoService,
  [switch]$Yes,
  [string]$ForUser = "$env:USERDOMAIN\$env:USERNAME",
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TaskName = 'Sonara'
$NodeMin = [version]'22.13.0'

function Step($m) { Write-Host ''; Write-Host "> $m" -ForegroundColor Magenta }
function Ok($m) { Write-Host "  + $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Done($code) {
  if ($Elevated) { Write-Host ''; Read-Host '  Press Enter to close this window' | Out-Null }
  exit $code
}
function Die($m) { Write-Host ''; Write-Host "  x $m" -ForegroundColor Red; Done 1 }
function Ask($q, $def) {
  if ($Yes) { return $def }
  $a = Read-Host "  $q [$def]"
  if ([string]::IsNullOrWhiteSpace($a)) { return $def } else { return $a.Trim().Trim('"') }
}
function Confirm-Choice($q, [bool]$def = $true) {
  $d = 'n'; if ($def) { $d = 'y' }
  return ((Ask "$q (y/n)" $d) -match '^[Yy]')
}
function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Update-PathFromRegistry {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Get-NodeVersion {
  try { $v = & node -p 'process.versions.node' 2>$null; if ($LASTEXITCODE -eq 0 -and $v) { return [version]$v } } catch { }
  return $null
}
function Stop-SonaraProcess {
  $needle = (Join-Path $AppDir 'server\index.js')
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# --- Elevate (needed for the boot-time task and the firewall rule) ---------
if (-not $NoService -and -not (Test-Admin)) {
  Write-Host 'Sonara needs administrator rights to register its background task. Requesting...' -ForegroundColor Yellow
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated', '-ForUser', "`"$ForUser`"", '-RunAs', $RunAs)
  if ($Port) { $argList += @('-Port', $Port) }
  if ($Music) { $argList += @('-Music', "`"$Music`"") }
  if ($Yes) { $argList += '-Yes' }
  try {
    $proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -Wait -PassThru
    exit $proc.ExitCode
  } catch {
    Write-Host '  x Administrator rights were declined. Re-run with -NoService to install without a background task.' -ForegroundColor Red
    exit 1
  }
}

Write-Host ''
Write-Host '   Sonara  ' -ForegroundColor Magenta -NoNewline
Write-Host '- self-hosted music, beautifully.' -ForegroundColor DarkGray
Write-Host "   Installing into $AppDir" -ForegroundColor DarkGray

# --- Node.js ---------------------------------------------------------------
Step 'Checking Node.js'
$nodeVer = Get-NodeVersion
if ($nodeVer -and $nodeVer -ge $NodeMin) {
  Ok "Node.js v$nodeVer found"
} else {
  if ($nodeVer) { Warn "Node.js v$nodeVer is too old (need $NodeMin or newer)." } else { Warn 'Node.js is not installed.' }
  if (-not (Confirm-Choice 'Install Node.js LTS now?' $true)) { Die "Node.js $NodeMin+ is required." }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
  } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    & choco install nodejs-lts -y
  } else {
    Die 'Neither winget nor Chocolatey is available. Install Node.js LTS from https://nodejs.org and re-run.'
  }
  Update-PathFromRegistry
  $nodeVer = Get-NodeVersion
  if (-not $nodeVer -or $nodeVer -lt $NodeMin) { Die 'Node.js was installed but is not on PATH yet. Open a new terminal and re-run this script.' }
  Ok "Node.js v$nodeVer installed"
}
$NodeExe = (Get-Command node).Source

if (Get-Command git -ErrorAction SilentlyContinue) {
  Ok "git found"
} else {
  Warn 'git is not installed - it is needed for scripts\update.ps1.'
  if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Confirm-Choice 'Install git now?' $true)) {
    & winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements --silent
    Update-PathFromRegistry
  }
}

# --- Dependencies ----------------------------------------------------------
Step 'Installing dependencies'
Push-Location $AppDir
try {
  if (Test-Path 'package-lock.json') { & npm ci --omit=dev --no-audit --no-fund } else { & npm install --omit=dev --no-audit --no-fund }
  if ($LASTEXITCODE -ne 0) { Die 'npm failed to install dependencies (see output above).' }
  Ok 'Dependencies installed'

  # --- Configuration -------------------------------------------------------
  Step 'Configuring'
  $current = & node --disable-warning=ExperimentalWarning scripts\configure.js --get port
  if (-not $Port) { $Port = [int](Ask 'Port to listen on?' $(if ($current) { $current } else { '7700' })) }
  & node --disable-warning=ExperimentalWarning scripts\configure.js --port $Port | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "Invalid port: $Port" }
  Ok "Port: $Port"

  if (-not $Music) {
    $defaultMusic = Join-Path $env:USERPROFILE 'Music'
    if (-not (Test-Path $defaultMusic)) { $defaultMusic = '' }
    $Music = Ask 'Music folder? (leave empty to add later in Settings)' $defaultMusic
  }
  if ($Music) {
    if (Test-Path -LiteralPath $Music -PathType Container) {
      & node --disable-warning=ExperimentalWarning scripts\configure.js --add-music "$Music" | Out-Null
      Ok "Music folder: $Music"
    } else {
      Warn "Folder '$Music' doesn't exist - skipped. Add it later in Settings > Music folders."
    }
  }
  Ok "User data lives in $AppDir\data (database, logins, playlists, cover art)"
} finally {
  Pop-Location
}

# --- Background task -------------------------------------------------------
if (-not $NoService) {
  Step 'Setting up the background task'
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Stop-SonaraProcess

  $nodeArgs = "--disable-warning=ExperimentalWarning `"$AppDir\server\index.js`""
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

  if ($RunAs -eq 'System') {
    $action = New-ScheduledTaskAction -Execute $NodeExe -Argument $nodeArgs -WorkingDirectory $AppDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  } else {
    # conhost --headless keeps a console window from popping up at logon.
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$NodeExe`" $nodeArgs" -WorkingDirectory $AppDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $ForUser
    $principal = New-ScheduledTaskPrincipal -UserId $ForUser -LogonType Interactive -RunLevel Limited
  }
  Register-ScheduledTask -TaskName $TaskName -Description 'Sonara music server' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  if ($RunAs -eq 'System') { Ok "Scheduled Task '$TaskName' created (starts at boot, runs as SYSTEM)" }
  else { Ok "Scheduled Task '$TaskName' created (starts when $ForUser logs in)" }
  Write-Host "  Logs: $AppDir\data\logs\sonara.log" -ForegroundColor DarkGray

  if (Confirm-Choice 'Allow other devices on your network to reach Sonara? (adds a Windows Firewall rule)' $true) {
    Get-NetFirewallRule -DisplayName 'Sonara' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName 'Sonara' -Description 'Sonara music server' -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $Port -Profile Private, Domain | Out-Null
    Ok "Firewall: TCP $Port allowed on private networks"
  }

  # Wait for the server to come up.
  $up = $false
  for ($i = 0; $i -lt 20 -and -not $up; $i++) {
    Start-Sleep -Milliseconds 750
    try { Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/api/version" -TimeoutSec 2 | Out-Null; $up = $true } catch { }
  }
  if ($up) { Ok 'Sonara is running' } else { Warn "Sonara didn't respond yet - check $AppDir\data\logs\sonara.log" }
} else {
  Ok 'Skipped background task (-NoService). Start Sonara with: npm start'
}

# --- Done --------------------------------------------------------------------
$ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL' } |
  Select-Object -First 1 -ExpandProperty IPAddress

Write-Host ''
Write-Host '  Sonara is installed!' -ForegroundColor Green
Write-Host ''
Write-Host "    Open http://localhost:$Port" -NoNewline
if ($ip) { Write-Host "   or   http://${ip}:$Port" } else { Write-Host '' }
Write-Host '    The first visit lets you create the admin account.'
Write-Host ''
Write-Host '    Update:     powershell -ExecutionPolicy Bypass -File scripts\update.ps1' -ForegroundColor DarkGray
Write-Host '    Uninstall:  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1' -ForegroundColor DarkGray
Done 0
