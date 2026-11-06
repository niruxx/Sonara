<#
.SYNOPSIS
  Sonara uninstaller for Windows.

.DESCRIPTION
  Removes the "Sonara" Scheduled Task, the firewall rule and installed dependencies.
  Your music files are NEVER touched. Your Sonara data (database, logins,
  playlists, cover cache) is kept unless you pass -Purge or confirm deletion.

.PARAMETER Purge
  Also delete the data folder without asking.

.PARAMETER Yes
  Accept defaults without prompting (keeps data unless -Purge is given).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
#>
[CmdletBinding()]
param([switch]$Purge, [switch]$Yes, [switch]$Elevated)

$ErrorActionPreference = 'Stop'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TaskName = 'Sonara'

function Step($m) { Write-Host ''; Write-Host "> $m" -ForegroundColor Magenta }
function Ok($m) { Write-Host "  + $m" -ForegroundColor Green }
function Done($code) {
  if ($Elevated) { Write-Host ''; Read-Host '  Press Enter to close this window' | Out-Null }
  exit $code
}
function Confirm-Choice($q, [bool]$def = $false) {
  if ($Yes) { return $def }
  $d = 'n'; if ($def) { $d = 'y' }
  $a = Read-Host "  $q (y/n) [$d]"
  if ([string]::IsNullOrWhiteSpace($a)) { $a = $d }
  return ($a -match '^[Yy]')
}
function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host 'Removing the Sonara task needs administrator rights. Requesting...' -ForegroundColor Yellow
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
  if ($Purge) { $argList += '-Purge' }
  if ($Yes) { $argList += '-Yes' }
  try { $proc = Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait -PassThru; exit $proc.ExitCode }
  catch { Write-Host '  x Administrator rights were declined.' -ForegroundColor Red; exit 1 }
}

Write-Host ''
Write-Host '   Uninstalling Sonara  ' -ForegroundColor Magenta -NoNewline
Write-Host $AppDir -ForegroundColor DarkGray
Write-Host '   Your music files will not be touched.' -ForegroundColor DarkGray

# --- Task + process + firewall ------------------------------------------------------
Step 'Removing the background task'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Ok "Scheduled Task '$TaskName' removed"
} else {
  Ok 'No Scheduled Task found'
}
$needle = (Join-Path $AppDir 'server\index.js')
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$rule = Get-NetFirewallRule -DisplayName 'Sonara' -ErrorAction SilentlyContinue
if ($rule) { $rule | Remove-NetFirewallRule; Ok 'Firewall rule removed' }

# --- Dependencies ---------------------------------------------------------------------
Step 'Removing dependencies'
$nm = Join-Path $AppDir 'node_modules'
if (Test-Path $nm) { Remove-Item -LiteralPath $nm -Recurse -Force }
Ok 'node_modules removed'

# --- Data ---------------------------------------------------------------------------------
Step 'Your Sonara data'
$data = Join-Path $AppDir 'data'
if (Test-Path $data) {
  if ($Purge -or (Confirm-Choice "Delete Sonara's database, logins, playlists and cover cache in $data?" $false)) {
    Remove-Item -LiteralPath $data -Recurse -Force
    Ok 'Data deleted'
  } else {
    Ok "Data kept in $data (reinstall any time to pick up where you left off)"
  }
} else {
  Ok 'No data folder'
}

# --- App folder ----------------------------------------------------------------------------
if (Confirm-Choice "Also delete the Sonara app folder itself ($AppDir)?" $false) {
  Set-Location $env:TEMP
  Remove-Item -LiteralPath $AppDir -Recurse -Force
  Write-Host ''
  Write-Host '  Sonara has been completely removed.' -ForegroundColor Green
  Done 0
}

Write-Host ''
Write-Host '  Sonara has been uninstalled. Run scripts\install.ps1 to reinstall.' -ForegroundColor Green
Done 0
