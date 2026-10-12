param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDirectory,

    [Parameter(Mandatory = $true)]
    [string]$DestinationPath
)

$ErrorActionPreference = "Stop"
$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
$destination = [System.IO.Path]::GetFullPath($DestinationPath)
$trackFiles = @(& git -C $source ls-files -- data)
if ($LASTEXITCODE -ne 0) {
    throw "Unable to list committed tracks in $source"
}
$trackFiles = @($trackFiles | Where-Object { $_ -match '^data/tracks/[^/]+\.json$' })
if ($trackFiles.Count -eq 0) {
    throw "No committed circuits found in data/tracks; refusing to package an empty catalog."
}

foreach ($requiredPath in @("dist/server", "dist/client", "package.json") + $trackFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $requiredPath))) {
        throw "Required deployment content not found: $requiredPath"
    }
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("car-game-deploy-" + [guid]::NewGuid())
try {
    New-Item -ItemType Directory -Path $staging | Out-Null
    Copy-Item -LiteralPath (Join-Path $source "dist") -Destination $staging -Recurse

    $package = Get-Content -LiteralPath (Join-Path $source "package.json") -Raw | ConvertFrom-Json
    $package.PSObject.Properties.Remove("devDependencies")
    $package | ConvertTo-Json -Depth 10 |
        Set-Content -LiteralPath (Join-Path $staging "package.json") -Encoding utf8

    $tracksDirectory = Join-Path $staging "data/tracks"
    New-Item -ItemType Directory -Path $tracksDirectory -Force | Out-Null
    foreach ($trackFile in $trackFiles) {
        Copy-Item -LiteralPath (Join-Path $source $trackFile) -Destination $tracksDirectory
    }

    $items = @("dist", "package.json", "data") | ForEach-Object { Join-Path $staging $_ }
    Compress-Archive -LiteralPath $items -DestinationPath $destination -Force
    Write-Host "Packaged $($trackFiles.Count) committed circuits from data/tracks."
} finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
