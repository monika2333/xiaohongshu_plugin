# Package script for the extension (Windows PowerShell 5.1 compatible).
# Copies the runtime whitelist to a temp folder, then writes shuye-<version>.zip
# with manifest.json at the archive root. Keep this file ASCII-only so Windows
# PowerShell 5.1 can parse it regardless of the console code page.

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ManifestPath = Join-Path $Root "manifest.json"
if (-not (Test-Path $ManifestPath)) {
    throw "Missing manifest.json: $ManifestPath"
}

$Manifest = Get-Content -Path $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = [string]$Manifest.version
if ([string]::IsNullOrWhiteSpace($Version)) {
    throw "manifest.json is missing the version field."
}

# Runtime whitelist. Update this list when adding a runtime file.
$Files = @(
    "manifest.json",
    "panel.html",
    "panel.css",
    "panel.js",
    "options.html",
    "options.css",
    "options.js",
    "prompts.js",
    "ai-pipeline.js",
    "service-worker.js",
    "capture-common.js",
    "content-script.js",
    "weibo-content-script.js",
    "main-world.js"
)

foreach ($Name in $Files) {
    $Source = Join-Path $Root $Name
    if (-not (Test-Path $Source -PathType Leaf)) {
        throw "Whitelisted file is missing: $Name"
    }
}

$Stage = Join-Path ([System.IO.Path]::GetTempPath()) ("shuye-package-" + [guid]::NewGuid().ToString("N"))
$ZipPath = Join-Path $Root ("shuye-" + $Version + ".zip")

try {
    New-Item -ItemType Directory -Path $Stage -Force | Out-Null

    foreach ($Name in $Files) {
        Copy-Item -Path (Join-Path $Root $Name) -Destination (Join-Path $Stage $Name)
    }

    $Icons = Join-Path $Root "icons"
    if (Test-Path $Icons -PathType Container) {
        Copy-Item -Path $Icons -Destination (Join-Path $Stage "icons") -Recurse
    }

    $Locales = Join-Path $Root "_locales"
    if (Test-Path $Locales -PathType Container) {
        Copy-Item -Path $Locales -Destination (Join-Path $Stage "_locales") -Recurse
    }

    if (Test-Path $ZipPath) {
        Remove-Item $ZipPath -Force
    }

    # Write entries manually so names use forward slashes and no directory
    # entries are stored. Compress-Archive on PS 5.1 writes backslashes.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $StageFull = (Resolve-Path $Stage).Path.TrimEnd("\") + "\"
    $WriteArchive = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Get-ChildItem -Path $Stage -Recurse -File | ForEach-Object {
            $Relative = $_.FullName.Substring($StageFull.Length).Replace("\", "/")
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $WriteArchive,
                $_.FullName,
                $Relative,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    }
    finally {
        $WriteArchive.Dispose()
    }

    $Archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $Entries = @($Archive.Entries | ForEach-Object { $_.FullName })
    }
    finally {
        $Archive.Dispose()
    }
    if ($Entries -notcontains "manifest.json") {
        throw "manifest.json is not at the zip root."
    }

    Write-Host ("Created: " + $ZipPath)
    Write-Host ("Entries: " + $Entries.Count)
    $Entries | Sort-Object | ForEach-Object { Write-Host ("  " + $_) }
}
finally {
    if (Test-Path $Stage) {
        Remove-Item $Stage -Recurse -Force
    }
}
