[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envLoader = Join-Path $repoRoot 'infra/env.ps1'
if (Test-Path -LiteralPath $envLoader -PathType Leaf) {
    . $envLoader
    Import-BabbageEnv
}
$modelRef = if ($env:LLAMA_MODEL) { $env:LLAMA_MODEL } else { 'ggml-org/gemma-4-E2B-it-GGUF:Q8_0' }
if ($modelRef -cnotmatch '^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$') {
    throw 'LLAMA_MODEL must use owner/repository:quantization'
}
$modelRepo, $quantization = $modelRef.Split(':')
$endpoint = if ($env:HF_ENDPOINT) { $env:HF_ENDPOINT.TrimEnd('/') } else { 'https://huggingface.co' }
$modelDir = if ($env:MODEL_DIR) { $env:MODEL_DIR } else { Join-Path $repoRoot 'infra/models' }

$endpointUri = $null
if (-not [Uri]::TryCreate($endpoint, [UriKind]::Absolute, [ref]$endpointUri) -or
    ($endpointUri.Scheme -ne 'http' -and $endpointUri.Scheme -ne 'https')) {
    throw "HF_ENDPOINT must be an absolute HTTP(S) URL: $endpoint"
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    throw 'curl.exe is required (it ships with Windows 10 and later)'
}

$metadataUrl = "$endpoint/api/models/$modelRepo/tree/main?recursive=true"
$metadataJson = & curl.exe --fail --location --silent --show-error --retry 3 $metadataUrl
if ($LASTEXITCODE -ne 0) {
    throw "Model metadata request failed: $metadataUrl"
}
$parsed = ($metadataJson -join "`n") | ConvertFrom-Json
$files = @($parsed)

$modelFiles = @($files | Where-Object {
    $name = ($_.path -split '[/\\]')[-1]
    $_.path.EndsWith("-$quantization.gguf", [StringComparison]::Ordinal) -and
        $name -cnotmatch '^(mmproj|mtp)-'
})
$projectorFiles = @($files | Where-Object {
    $name = ($_.path -split '[/\\]')[-1]
    $name -cmatch '^mmproj-' -and
        $_.path.EndsWith('-BF16.gguf', [StringComparison]::Ordinal)
})
if ($modelFiles.Count -ne 1) {
    throw "Expected exactly one model file ending -$quantization.gguf in $modelRepo, found $($modelFiles.Count)"
}
if ($projectorFiles.Count -ne 1) {
    throw "Expected exactly one mmproj-*-BF16.gguf projector in $modelRepo, found $($projectorFiles.Count)"
}

$selected = @($modelFiles[0], $projectorFiles[0])
foreach ($file in $selected) {
    if ($file.path -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*\.gguf$') {
        throw "Unsafe file path in model metadata: $($file.path)"
    }
    if ($file.lfs.oid -notmatch '^[0-9a-f]{64}$') {
        throw "Missing or invalid SHA-256 (lfs.oid) for $($file.path)"
    }
}

New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
foreach ($file in $selected) {
    $fileName = $file.path
    $checksum = $file.lfs.oid
    $destination = Join-Path $modelDir $fileName

    if (Test-Path -LiteralPath $destination) {
        if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
            throw "Destination exists and is not a file: $destination"
        }
        $existingHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
        if ($existingHash -eq $checksum) {
            Write-Output "Already verified: $destination"
            continue
        }
        throw "Existing file does not match the expected SHA-256: $destination`nRemove or move the file, then run this script again."
    }

    $partial = "$destination.part"
    Write-Output "Downloading $fileName"
    & curl.exe --fail --location --show-error --retry 3 --continue-at - `
        --output $partial "$endpoint/$modelRepo/resolve/main/$fileName"
    if ($LASTEXITCODE -ne 0) {
        throw "Download failed for $fileName; partial file retained at $partial. Run the script again to resume."
    }
    $partialHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash
    if ($partialHash -ne $checksum) {
        throw "Checksum mismatch for $fileName; remove the corrupt partial file $partial before retrying"
    }
    Move-Item -LiteralPath $partial -Destination $destination
    Write-Output "Verified: $destination"
}
