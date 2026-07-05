# notme — force a US timezone for Claude Code (CLI) on Windows PowerShell.
#
# Claude Code is a Node process: it reports the OS timezone (via the TZ env var)
# in its system prompt. This adds a `claude` wrapper to your PowerShell profile
# so `claude` runs with TZ set to a US zone, while the rest of your session keeps
# its real timezone.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 America/New_York
#
# Re-running is safe (it replaces the previous block). WSL users: use install.sh
# inside WSL instead.
param([string]$Tz = "America/Los_Angeles")
$ErrorActionPreference = "Stop"

$begin = "# >>> notme: force US timezone for Claude Code >>>"
$end   = "# <<< notme: force US timezone for Claude Code <<<"

if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }

# Strip any previous notme block.
$lines = @(Get-Content -LiteralPath $PROFILE)
$out = New-Object System.Collections.Generic.List[string]
$skip = $false
foreach ($l in $lines) {
  if ($l -eq $begin) { $skip = $true; continue }
  if ($l -eq $end)   { $skip = $false; continue }
  if (-not $skip) { $out.Add($l) }
}

# Append the wrapper. Single-quoted literals avoid any escaping; only the TZ
# value is interpolated. `-CommandType Application` finds the real claude
# executable (not this function), so there's no recursion.
$block = @(
  $begin,
  ('$env:NOTME_CLAUDE_TZ = "' + $Tz + '"'),
  'function claude {',
  '    $exe = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source',
  '    if (-not $exe) { Write-Error "claude not found on PATH"; return }',
  '    $prev = $env:TZ',
  '    $env:TZ = $env:NOTME_CLAUDE_TZ',
  '    try { & $exe @args } finally { $env:TZ = $prev }',
  '}',
  $end
)
foreach ($b in $block) { $out.Add($b) }
Set-Content -LiteralPath $PROFILE -Value $out

Write-Host "OK: added the claude wrapper (TZ=$Tz) to $PROFILE"
Write-Host "Open a NEW PowerShell (or run: . `$PROFILE), then Claude Code reports $Tz."
Write-Host "Verify: `$env:TZ='$Tz'; node -e `"console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)`""
