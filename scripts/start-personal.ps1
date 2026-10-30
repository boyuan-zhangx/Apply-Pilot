param([string]$DataHome = '', [int]$Port = 4321)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$workspaceDir = Split-Path -Parent $projectDir
if (-not $DataHome) { $DataHome = Join-Path $workspaceDir 'ApplyPilot-Private' }
$runtime = Get-Command node.exe -ErrorAction SilentlyContinue
if ($runtime) { $nodePath = $runtime.Source }
else {
  $portable = Get-ChildItem -LiteralPath (Join-Path $workspaceDir '.tools') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'node-*-win-x64' } | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $portable) { throw 'Install Node.js 20+ or put a portable Node runtime in the workspace .tools folder.' }
  $nodePath = Join-Path $portable.FullName 'node.exe'
}
$env:Path = (Split-Path -Parent $nodePath) + ';' + $env:Path
$env:APPLY_PILOT_HOME = [System.IO.Path]::GetFullPath($DataHome)
$cliPath = Join-Path $projectDir 'bin\apply-pilot.mjs'
Push-Location $projectDir
try {
  if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'node_modules\jszip'))) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  }
  & $nodePath $cliPath init --example cn-eu-careers
  if ($LASTEXITCODE -ne 0) { throw 'Initialization failed' }
  & $nodePath $cliPath ui --port $Port --open
} finally { Pop-Location }
