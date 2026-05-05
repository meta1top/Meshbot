$ErrorActionPreference = "Stop"

function Remove-TreeRobocopy {
    param([Parameter(Mandatory)] [string]$PathToDelete)
    if (-not (Test-Path -LiteralPath $PathToDelete)) { return }
    $empty = Join-Path $env:TEMP "robocopy_empty_$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $empty -Force | Out-Null
    try {
        robocopy $empty $PathToDelete /MIR /R:0 /W:0 /NJH /NJS | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed to clear: $PathToDelete (exit $LASTEXITCODE)" }
    } finally {
        Remove-Item -LiteralPath $empty -Force -Recurse -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $PathToDelete) {
        Remove-Item -LiteralPath $PathToDelete -Force -Recurse
    }
}

$repoRoot = (Get-Location).Path
$bundleFull = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "apps\server-agent\.bundle"))
$tempFull = [System.IO.Path]::GetFullPath((Join-Path $env:TEMP "anybot-server-bundle"))

Remove-TreeRobocopy $bundleFull
Remove-TreeRobocopy $tempFull

pnpm --filter @anybot/server-agent deploy --legacy --prod $tempFull
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Copying server-agent bundle..."
robocopy $tempFull $bundleFull /E /R:0 /W:0 /NJH /NJS
if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }

Remove-TreeRobocopy $tempFull
