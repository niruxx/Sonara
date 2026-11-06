<#
.SYNOPSIS
  Sonara updater for Windows.

.DESCRIPTION
  Pulls the latest code from git, refreshes dependencies if they changed and
  restarts the "Sonara" Scheduled Task. Your data is never touched:
    - data\ (database, logins, playlists, favourites, cover art, config) is git-ignored
    - your music folders live outside the app entirely
  A database snapshot is saved to data\backups\ before every update.

.PARAMETER Force
  Stash local edits to Sonara's code instead of stopping.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\update.ps1
#>
[CmdletBinding()]
param([switch]$Force, [switch]$Elevated)

$ErrorActionPreference = 'Stop'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TaskName = 'Sonara'
$Safe = $AppDir -replace '\\', '/'

function Step($m) { Write-Host ''; Write-Host "> $m" -ForegroundColor Magenta }
function Ok($m) { Write-Host "  + $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Done($code) {
  if ($Elevated) { Write-Host ''; Read-Host '  Press Enter to close this window' | Out-Null }
  exit $code
}
function Die($m) { Write-Host ''; Write-Host "  x $m" -ForegroundColor Red; Done 1 }
function Invoke-Git { & git -c "safe.directory=$Safe" -C $AppDir @args }
function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Stop-SonaraProcess {
  $needle = (Join-Path $AppDir 'server\index.js')
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.Principal.UserId -eq 'SYSTEM' -and -not (Test-Admin)) {
  Write-Host 'Restarting the Sonara task needs administrator rights. Requesting...' -ForegroundColor Yellow
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
  if ($Force) { $argList += '-Force' }
  try { $proc = Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait -PassThru; exit $proc.ExitCode }
  catch { Write-Host '  x Administrator rights were declined.' -ForegroundColor Red; exit 1 }
}

Write-Host ''
Write-Host '   Updating Sonara  ' -ForegroundColor Magenta -NoNewline
Write-Host $AppDir -ForegroundColor DarkGray

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git is not installed.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Node.js is not installed. Run scripts\install.ps1 first.' }
if (-not (Test-Path (Join-Path $AppDir '.git'))) { Die "$AppDir is not a git checkout, so it can't be updated with git. Re-install by cloning the repository." }

# --- Safety checks -------------------------------------------------------------
Step 'Checking your installation'
$dirty = Invoke-Git status --porcelain --untracked-files=no
if ($dirty) {
  if ($Force) {
    Invoke-Git stash push -m ("sonara-update-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) | Out-Null
    Warn 'Local code changes were stashed (see: git stash list).'
  } else {
    $dirty | ForEach-Object { Write-Host "    $_" }
    Die 'You have local changes to Sonara''s code (shown above). Commit them, or re-run with -Force to stash them.'
  }
}
Ok ("On branch " + (Invoke-Git rev-parse --abbrev-ref HEAD))

# --- Backup ----------------------------------------------------------------------
Step 'Backing up your database'
Push-Location $AppDir
try {
  & node --disable-warning=ExperimentalWarning scripts\backup.js | ForEach-Object { Write-Host "  $_" }

  # --- Pull -------------------------------------------------------------------------
  Step 'Fetching updates'
  $old = Invoke-Git rev-parse HEAD
  Invoke-Git fetch --prune --quiet
  if ($LASTEXITCODE -ne 0) { Die 'git fetch failed (are you online?).' }
  Invoke-Git pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { Die "Couldn't fast-forward. Your branch has diverged from upstream - resolve it with git manually." }
  $new = Invoke-Git rev-parse HEAD

  if ($old -eq $new) {
    Ok ("Already up to date (" + (Invoke-Git rev-parse --short HEAD) + ")")
  } else {
    Ok ("Updated " + (Invoke-Git rev-parse --short $old) + " -> " + (Invoke-Git rev-parse --short $new))
    Invoke-Git --no-pager log --oneline --no-decorate "$old..$new" | Select-Object -First 20 | ForEach-Object { Write-Host "    - $_" }
  }

  $depsChanged = $true
  if ($old -ne $new) {
    Invoke-Git diff --quiet $old $new -- package.json package-lock.json
    $depsChanged = ($LASTEXITCODE -ne 0)
  } else {
    $depsChanged = -not (Test-Path 'node_modules')
  }
  if (-not (Test-Path 'node_modules')) { $depsChanged = $true }

  if ($old -eq $new -and -not $depsChanged) {
    Write-Host ''
    Write-Host '  Sonara is up to date. Nothing to restart.' -ForegroundColor Green
    Done 0
  }

  # --- Stop, refresh dependencies, start ---------------------------------------
  Step 'Restarting Sonara'
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  Stop-SonaraProcess

  if ($depsChanged) {
    Step 'Updating dependencies'
    & npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Die 'npm failed to install dependencies (see output above).' }
    Ok 'Dependencies installed'
  } else {
    Ok 'Dependencies unchanged'
  }

  if ($task) {
    Start-ScheduledTask -TaskName $TaskName
    Ok 'Scheduled Task restarted'
  } else {
    Warn 'No Sonara Scheduled Task found. If you run it manually, start it again with: npm start'
  }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host '  Sonara is up to date. Database migrations run automatically on start.' -ForegroundColor Green
Done 0
