$ErrorActionPreference = "Stop"

function Remove-TreeRobocopy {
    param([Parameter(Mandatory)] [string]$PathToDelete)
    if (-not (Test-Path -LiteralPath $PathToDelete)) {
        Write-Host "[prepare] skip remove (not found): $PathToDelete"
        return
    }
    Write-Host "[prepare] emptying via robocopy /MIR (long paths): $PathToDelete"
    $empty = Join-Path $env:TEMP "robocopy_empty_$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $empty -Force | Out-Null
    try {
        robocopy $empty $PathToDelete /MIR /R:0 /W:0 /NP /NDL /NFL
        $rc = $LASTEXITCODE
        if ($rc -ge 8) { throw "robocopy failed to clear: $PathToDelete (exit $rc)" }
        Write-Host "[prepare] robocopy clear finished (exit $rc, 0-7 = success)"
    } finally {
        Remove-Item -LiteralPath $empty -Force -Recurse -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $PathToDelete) {
        Remove-Item -LiteralPath $PathToDelete -Force -Recurse
    }
    Write-Host "[prepare] removed folder: $PathToDelete"
}

$repoRoot = (Get-Location).Path
$bundleFull = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "apps\server-agent\.bundle"))
$tempFull = [System.IO.Path]::GetFullPath((Join-Path $env:TEMP "anybot-server-bundle"))

Write-Host "[prepare] repo root: $repoRoot"
Remove-TreeRobocopy $bundleFull
Remove-TreeRobocopy $tempFull

Write-Host "[prepare] pnpm deploy -> $tempFull (may take 1-3 min; streaming output below)"
pnpm --reporter append-only --filter @anybot/server-agent deploy --legacy --prod $tempFull
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[prepare] copying deploy output -> $bundleFull (robocopy /E, may take 1-2 min)"
robocopy $tempFull $bundleFull /E /R:0 /W:0 /NP /NDL /NFL
$copyRc = $LASTEXITCODE
if ($copyRc -ge 8) { exit $copyRc }
Write-Host "[prepare] robocopy copy finished (exit $copyRc, 0-7 = success)"

Write-Host "[prepare] removing temp: $tempFull"
Remove-TreeRobocopy $tempFull

Write-Host "[prepare] done."
