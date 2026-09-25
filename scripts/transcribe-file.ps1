[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$AudioFile,
    [Parameter(Position = 1)][ValidateSet('en', 'es', 'pt')][string]$SourceLanguage = 'en',
    [Parameter(Position = 2)][ValidateSet('en', 'es', 'pt')][string]$TargetLanguage = 'es'
)
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envLoader = Join-Path $repoRoot 'infra/env.ps1'
if (Test-Path -LiteralPath $envLoader -PathType Leaf) {
    . $envLoader
    Import-BabbageEnv
}

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$SourceLanguage = $SourceLanguage.ToLowerInvariant()
$TargetLanguage = $TargetLanguage.ToLowerInvariant()

if (-not (Test-Path -LiteralPath $AudioFile -PathType Leaf)) {
    throw "Audio file not found: $AudioFile"
}
$resolvedAudio = (Resolve-Path -LiteralPath $AudioFile).Path
if ($SourceLanguage -eq $TargetLanguage) {
    throw 'Source and target languages must differ'
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw 'ffmpeg is required on PATH'
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    throw 'curl.exe is required (it ships with Windows 10 and later)'
}

$endpoint = 'http://localhost:8080'
if ($env:INFERENCE_URLS) {
    $endpoint = $env:INFERENCE_URLS.Split(',')[0].Trim()
}
$endpoint = $endpoint.TrimEnd('/')
$endpointUri = $null
if (-not [Uri]::TryCreate($endpoint, [UriKind]::Absolute, [ref]$endpointUri) -or
    ($endpointUri.Scheme -ne 'http' -and $endpointUri.Scheme -ne 'https')) {
    throw "INFERENCE_URLS must start with an absolute HTTP(S) endpoint: $endpoint"
}

$audioFormat = if ($env:INFERENCE_AUDIO_FORMAT) { $env:INFERENCE_AUDIO_FORMAT } else { 'input_audio' }
if ($audioFormat -cnotin @('input_audio', 'audio_url')) {
    throw 'INFERENCE_AUDIO_FORMAT must be input_audio or audio_url'
}
$model = if ($env:INFERENCE_MODEL) { $env:INFERENCE_MODEL } else { 'gemma-4' }
$temperature = 0.2
if ($env:INFERENCE_TEMPERATURE) {
    $parsed = 0.0
    if (-not [double]::TryParse($env:INFERENCE_TEMPERATURE, [Globalization.NumberStyles]::Float,
            [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -or
        [double]::IsNaN($parsed) -or [double]::IsInfinity($parsed) -or
        $parsed -lt 0 -or $parsed -gt 2) {
        throw 'INFERENCE_TEMPERATURE must be a number from 0 to 2'
    }
    $temperature = $parsed
}

$workDir = Join-Path ([IO.Path]::GetTempPath()) ('babbage-transcribe-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir | Out-Null
try {
    $chunkPath = Join-Path $workDir 'chunk.wav'
    & ffmpeg -v error -nostdin -i $resolvedAudio -t 10 -ar 16000 -ac 1 -c:a pcm_s16le -y $chunkPath
    if ($LASTEXITCODE -ne 0) {
        throw "ffmpeg failed to extract the first 10 seconds of $resolvedAudio"
    }
    $audioData = [Convert]::ToBase64String([IO.File]::ReadAllBytes($chunkPath))

    $languageNames = @{ en = 'English'; es = 'Spanish'; pt = 'Portuguese' }
    $sourceName = $languageNames[$SourceLanguage]
    $targetName = $languageNames[$TargetLanguage]
    $prompt = "Transcribe the following speech segment in ${sourceName}, then translate it into ${targetName}.`nWhen formatting the answer, first output the transcription in ${sourceName}, then one newline, then output the string '${targetName}: ', then the translation in ${targetName}."
    $audio = if ($audioFormat -eq 'audio_url') {
        @{ type = 'audio_url'; audio_url = @{ url = "data:audio/wav;base64,$audioData" } }
    } else {
        @{ type = 'input_audio'; input_audio = @{ data = $audioData; format = 'wav' } }
    }
    $request = @{
        model = $model
        messages = @(@{ role = 'user'; content = @($audio, @{ type = 'text'; text = $prompt }) })
        temperature = $temperature
        top_p = 0.95
        top_k = 64
        max_tokens = 256
        chat_template_kwargs = @{ enable_thinking = $false }
    }

    $requestPath = Join-Path $workDir 'request.json'
    $requestJson = $request | ConvertTo-Json -Depth 10 -Compress
    [IO.File]::WriteAllText($requestPath, $requestJson, (New-Object System.Text.UTF8Encoding($false)))

    $responsePath = Join-Path $workDir 'response.json'
    $requestTime = & curl.exe --fail-with-body --silent --show-error --max-time 180 `
        --header 'Content-Type: application/json' `
        --data-binary "@$requestPath" `
        --output $responsePath `
        --write-out '%{time_total}' `
        "$endpoint/v1/chat/completions"
    if ($LASTEXITCODE -ne 0) {
        Write-Output "Inference request failed at $endpoint/v1/chat/completions"
        if ((Test-Path -LiteralPath $responsePath) -and (Get-Item -LiteralPath $responsePath).Length -gt 0) {
            Write-Output ([IO.File]::ReadAllText($responsePath, [Text.Encoding]::UTF8))
        }
        throw 'Inference request failed'
    }

    $rawResponse = [IO.File]::ReadAllText($responsePath, [Text.Encoding]::UTF8)
    Write-Output 'Raw response JSON:'
    Write-Output $rawResponse
    Write-Output "Request time: ${requestTime}s"
    $response = $rawResponse | ConvertFrom-Json
    $choice = $response.choices[0]
    $content = $choice.message.content
    if ($content -isnot [string] -or [string]::IsNullOrWhiteSpace($content)) {
        throw 'Model response has no text content'
    }
    Write-Output 'Raw model output:'
    Write-Output $content
    if ($choice.finish_reason -eq 'length') {
        throw 'Model output was truncated (finish_reason: length)'
    }

    $lines = $content -split "`r?`n"
    $marker = "${targetName}:"
    $markerIndex = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].TrimStart().StartsWith($marker, [StringComparison]::Ordinal)) {
            $markerIndex = $i
            break
        }
    }
    if ($markerIndex -lt 0) {
        throw "Model output has no $marker line"
    }
    $beforeLines = if ($markerIndex -gt 0) { $lines[0..($markerIndex - 1)] } else { @() }
    $transcript = (($beforeLines -join ' ') -replace '\s+', ' ').Trim()
    $markerText = $lines[$markerIndex].TrimStart().Substring($marker.Length)
    $afterLines = if ($markerIndex -lt $lines.Count - 1) { $lines[($markerIndex + 1)..($lines.Count - 1)] } else { @() }
    $translation = (((@($markerText) + $afterLines) -join ' ') -replace '\s+', ' ').Trim()
    if (-not $transcript -or -not $translation) {
        throw 'Model output is missing transcript or translation'
    }
    Write-Output ''
    Write-Output "Transcript: $transcript"
    Write-Output "${targetName}: $translation"
}
finally {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
