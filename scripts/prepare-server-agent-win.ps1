$ErrorActionPreference = "Stop"

$bundleDir = "apps\server-agent\.bundle"
$tempDir = "$env:TEMP\anybot-server-bundle"

if (Test-Path $bundleDir) { Remove-Item -Recurse -Force $bundleDir }
if (Test-Path $tempDir) { Remove-Item -Recurse -Force $tempDir }

pnpm --filter @anybot/server-agent deploy --legacy --prod $tempDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force $bundleDir | Out-Null
Copy-Item -Recurse -Force "$tempDir\*" $bundleDir
Remove-Item -Recurse -Force $tempDir
