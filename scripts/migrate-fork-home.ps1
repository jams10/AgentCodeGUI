param(
    [string]$Source = (Join-Path $env:USERPROFILE '.agentcodegui'),
    [string]$Destination = (Join-Path $env:USERPROFILE '.agentcodegui3')
)
$ErrorActionPreference = 'Stop'
$sourceFull = [IO.Path]::GetFullPath($Source).TrimEnd('\')
$destinationFull = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
if (-not (Test-Path -LiteralPath $sourceFull -PathType Container)) { throw 'Legacy app home was not found.' }
if ((Test-Path -LiteralPath $destinationFull) -or $destinationFull.StartsWith($sourceFull + '\', [StringComparison]::OrdinalIgnoreCase) -or $destinationFull -eq $sourceFull) {
    throw 'The destination must be new and outside the source. Existing data is never overwritten.'
}
$parentFull = [IO.Path]::GetDirectoryName($destinationFull)
$stagingFull = $destinationFull + '-import-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
if ([IO.Path]::GetDirectoryName($stagingFull) -ne $parentFull -or (Test-Path -LiteralPath $stagingFull)) { throw 'Unsafe staging path.' }
New-Item -ItemType Directory -Path $stagingFull | Out-Null

# Copy user data, including installed engines, without following account junctions.
# The app recreates shared-state junctions under its new home on the next run.
$directories = @('accounts','attachments','chats','codex','codex-engines','engines','multi-agent','session-chats','shared','tools')
foreach ($name in $directories) {
    $from = Join-Path $sourceFull $name
    if (-not (Test-Path -LiteralPath $from -PathType Container)) { continue }
    & robocopy $from (Join-Path $stagingFull $name) /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /XF '*.lock' '.instance-lock' | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copy failed for $name; staging data was preserved for inspection." }
}
Get-ChildItem -LiteralPath $sourceFull -File -Force | Where-Object {
    $_.Extension -eq '.json' -or $_.Name -eq '.mcp-oauth-imported'
} | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stagingFull $_.Name) }

# Retain the original Electron OSCrypt key so existing encrypted accounts/keys decrypt.
$localStates = @((Join-Path $sourceFull 'userData\Local State'), (Join-Path $env:APPDATA 'agent-code-gui\Local State'))
foreach ($stateFile in $localStates) {
    if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
        New-Item -ItemType Directory -Path (Join-Path $stagingFull 'userData') -Force | Out-Null
        Copy-Item -LiteralPath $stateFile -Destination (Join-Path $stagingFull 'userData\Local State')
        break
    }
}
@{ version = 1; source = $sourceFull; importedAt = (Get-Date).ToUniversalTime().ToString('o'); sourceUnchanged = $true } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stagingFull 'fork-import.json') -Encoding utf8

# Verify both absolute targets immediately before the directory move.
if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($stagingFull)) -ne $parentFull -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($destinationFull)) -ne $parentFull -or (Test-Path -LiteralPath $destinationFull)) {
    throw 'Destination changed during import; staging data was preserved.'
}
Move-Item -LiteralPath $stagingFull -Destination $destinationFull
Write-Output "Imported legacy app data to $destinationFull. Original data remains at $sourceFull."
