$ErrorActionPreference = "Stop"

$bundleDir = "apps\server-agent\.bundle"
$tempDir = "$env:TEMP\anybot-server-bundle"

if (Test-Path $bundleDir) { Remove-Item -Recurse -Force $bundleDir }
if (Test-Path $tempDir) { Remove-Item -Recurse -Force $tempDir }

pnpm --filter @anybot/server-agent deploy --legacy --prod $tempDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Copying server-agent bundle..."
robocopy $tempDir $bundleDir /E /R:0 /W:0 /NJH /NJS
if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }

Remove-Item -Recurse -Force $tempDir
