param(
  [ValidateSet('xdpool', 'ccswitch')]
  [string]$Target = 'xdpool',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:LOCALAPPDATA 'Claude-3p\configLibrary'
$metaPath = Join-Path $dir '_meta.json'
$profileId = '7f3d2a1c-5b6e-4c9a-9f21-8e6d4b0a3c71'
$profilePath = Join-Path $dir "$profileId.json"

if (-not (Test-Path -LiteralPath $metaPath)) {
  throw "Claude desktop config library not found: $metaPath"
}

# The app reads appliedId at launch; switching while it runs would silently do
# nothing (and the next launch would still use the old profile).
if (-not $DryRun) {
  $running = Get-CimInstance Win32_Process -Filter "Name='Claude.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -like '*\WindowsApps\*' -or $_.CommandLine -like '*\WindowsApps\*' }
  if ($running) {
    throw 'Claude desktop is running. Close it completely, then run this launcher again.'
  }
}

$meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
$entries = @($meta.entries)

$profile = [ordered]@{
  coworkEgressAllowedHosts    = @()
  disableDeploymentModeChooser = $true
  inferenceGatewayApiKey      = 'xdpool-local'
  inferenceGatewayAuthScheme  = 'bearer'
  inferenceGatewayBaseUrl     = 'http://127.0.0.1:8327'
  inferenceModels             = @(
    [ordered]@{ labelOverride = 'deepseek-v4.1-flash'; name = 'claude-haiku-4-5' }
    [ordered]@{ labelOverride = 'deepseek-v4.1-flash'; name = 'claude-sonnet-4-6' }
    [ordered]@{ labelOverride = 'deepseek-v4.1-flash'; name = 'claude-opus-4-8' }
  )
  inferenceProvider           = 'gateway'
}

if ($Target -eq 'xdpool') {
  $appliedId = $profileId
} else {
  $other = $entries | Where-Object { $_.id -ne $profileId -and $_.name -eq 'CC Switch' } | Select-Object -First 1
  if (-not $other) {
    $other = $entries | Where-Object { $_.id -ne $profileId } | Select-Object -First 1
  }
  if (-not $other) {
    throw 'No other deployment profile found to switch back to (expected CC Switch).'
  }
  $appliedId = $other.id
}

if (-not ($entries | Where-Object { $_.id -eq $profileId })) {
  $entries += [pscustomobject]@{ id = $profileId; name = 'XD Pool Bridge' }
}

# Rewrite _meta.json preserving both entries; appliedId is what the app reads.
$meta.entries = $entries
$meta | Add-Member -NotePropertyName appliedId -NotePropertyValue $appliedId -Force

$metaJson = $meta | ConvertTo-Json -Depth 10
$profileJson = $profile | ConvertTo-Json -Depth 10

if ($DryRun) {
  Write-Output "DRY RUN: would write $profilePath"
  Write-Output $profileJson
  Write-Output "DRY RUN: would set appliedId=$appliedId"
  Write-Output $metaJson
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $metaPath -Destination "$metaPath.bak-$stamp" -Force

# UTF-8 without BOM: a BOM can make the app's JSON parse fail.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($profilePath, $profileJson, $utf8)
[System.IO.File]::WriteAllText($metaPath, $metaJson, $utf8)

Write-Output "Deployment profile written: $profilePath"
Write-Output "appliedId -> $appliedId ($Target)"
