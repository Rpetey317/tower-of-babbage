[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envLoader = Join-Path $repoRoot 'infra/env.ps1'
if (Test-Path -LiteralPath $envLoader -PathType Leaf) {
    . $envLoader
    Import-BabbageEnv
}

function Get-IntegerSetting {
    param([string]$Name, [int]$Default, [int]$Minimum, [int]$Maximum = [int]::MaxValue)
    $raw = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrEmpty($raw)) { return $Default }
    $value = 0
    if (-not [int]::TryParse($raw, [ref]$value) -or $value -lt $Minimum -or $value -gt $Maximum) {
        throw "$Name must be an integer from $Minimum to $Maximum"
    }
    return $value
}

$modelRef = if ($env:LLAMA_MODEL) { $env:LLAMA_MODEL } else { 'ggml-org/gemma-4-E2B-it-GGUF:Q8_0' }
if ($modelRef -cnotmatch '^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$') { throw 'LLAMA_MODEL must use owner/repository:quantization' }
$quantization = $modelRef.Split(':')[1]
$bindHost = if ($env:LLAMA_BIND_HOST) { $env:LLAMA_BIND_HOST } else { '127.0.0.1' }
if ([string]::IsNullOrWhiteSpace($bindHost)) { throw 'LLAMA_BIND_HOST must not be blank' }
$port = Get-IntegerSetting 'LLAMA_PORT' 8080 1 65535
$parallel = Get-IntegerSetting 'LLAMA_PARALLEL' 4 1
$context = Get-IntegerSetting 'LLAMA_CTX' 16384 1
$gpuLayers = Get-IntegerSetting 'LLAMA_NGL' 99 0

$bundledServer = Join-Path $repoRoot 'bin/llama/llama-server.exe'
if ($env:LLAMA_SERVER_EXE) {
    if (-not (Test-Path -LiteralPath $env:LLAMA_SERVER_EXE -PathType Leaf)) { throw "LLAMA_SERVER_EXE does not name a file: $env:LLAMA_SERVER_EXE" }
    $server = (Resolve-Path -LiteralPath $env:LLAMA_SERVER_EXE).Path
} elseif (Test-Path -LiteralPath $bundledServer -PathType Leaf) {
    $server = $bundledServer
} else {
    $command = Get-Command llama-server.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw 'Native Vulkan llama-server.exe not found. Extract it and its DLLs into bin/llama, set LLAMA_SERVER_EXE, or add it to PATH; see docs/deployment.md.' }
    $server = $command.Source
}
$modelDir = if ($env:MODEL_DIR) { $env:MODEL_DIR } else { Join-Path $repoRoot 'infra/models' }
if (-not (Test-Path -LiteralPath $modelDir -PathType Container)) { throw 'Model directory not found. Run .\dev.ps1 model-pull first.' }
$files = @(Get-ChildItem -LiteralPath $modelDir -File)
$models = @($files | Where-Object {
    $_.Name.EndsWith("-$quantization.gguf", [StringComparison]::Ordinal) -and $_.Name -notmatch '^(mmproj|mtp)-'
})
$projectors = @($files | Where-Object {
    $_.Name.StartsWith('mmproj-', [StringComparison]::Ordinal) -and $_.Name.EndsWith('-BF16.gguf', [StringComparison]::Ordinal)
})
if ($models.Count -eq 0 -or $projectors.Count -eq 0) { throw 'Model or BF16 projector not found. Run .\dev.ps1 model-pull with the same LLAMA_MODEL and MODEL_DIR.' }
if ($models.Count -ne 1 -or $projectors.Count -ne 1) { throw 'Ambiguous model files. Use a separate MODEL_DIR for each model family, with exactly one matching model and BF16 projector.' }
$serverArguments = @(
    '-m', $models[0].FullName, '--mmproj', $projectors[0].FullName,
    '--host', $bindHost, '--port', "$port", '--parallel', "$parallel",
    '-c', "$context", '-ngl', "$gpuLayers", '--jinja'
)
Write-Output "Model: $($models[0].FullName)"
Write-Output "Projector: $($projectors[0].FullName)"
Write-Output "Starting inference at http://${bindHost}:$port. Wait for the server ready message; press Ctrl+C to stop."
& $server @serverArguments
exit $LASTEXITCODE
