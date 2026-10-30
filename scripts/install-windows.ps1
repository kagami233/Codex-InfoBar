[CmdletBinding()]
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$node = (Get-Command node -ErrorAction Stop).Source
if ($Uninstall) { & $node src/install.mjs --uninstall } else { & $node src/install.mjs }
if ($LASTEXITCODE -ne 0) { throw "Codex-InfoBar installer exited $LASTEXITCODE" }
