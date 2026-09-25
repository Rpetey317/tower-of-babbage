[CmdletBinding()]
param(
    [Parameter(Position = 0)][ValidateSet('help', 'model-pull', 'inference', 'transcribe', 'test-inference')][string]$Task = 'help',
    [string]$AudioFile = 'fixtures/audio/en-kubernetes-60s.wav',
    [ValidateSet('en', 'es', 'pt')][string]$SourceLanguage = 'en',
    [ValidateSet('en', 'es', 'pt')][string]$TargetLanguage = 'es'
)
$ErrorActionPreference = 'Stop'
if ($Task -ne 'transcribe') {
    foreach ($name in @('AudioFile', 'SourceLanguage', 'TargetLanguage')) {
        if ($PSBoundParameters.ContainsKey($name)) { throw "-$name is only supported by the transcribe task" }
    }
}

$envLoader = Join-Path $PSScriptRoot 'infra/env.ps1'
if (Test-Path -LiteralPath $envLoader -PathType Leaf) {
    . $envLoader
    Import-BabbageEnv
}

if ($Task -eq 'help') {
    Write-Output @'
Tower of Babbage task runner (native Windows)

Usage: .\dev.ps1 <task> [options]

Tasks:
  help            Show this message (default when no task is given)
  model-pull      Download the configured GGUF and BF16 projector into infra\models (needs curl.exe)
  inference       Start native Vulkan llama-server in the foreground; press Ctrl+C to stop
  transcribe      Send the first 10 seconds of a WAV to the running server (needs ffmpeg and curl.exe)
  test-inference  Run the offline Windows inference test suite

Transcribe options (paths are repository-relative):
  -AudioFile <wav>          default: fixtures/audio/en-kubernetes-60s.wav
  -SourceLanguage en|es|pt  default: en
  -TargetLanguage en|es|pt  default: es
  Example: .\dev.ps1 transcribe -AudioFile fixtures/audio/es-charla-60s.wav -SourceLanguage es -TargetLanguage en

Prerequisites are installed manually (see docs/deployment.md, "Native
Windows"): a Windows x64 Vulkan llama-server.exe in bin\llama, on PATH, or
named by LLAMA_SERVER_EXE; ffmpeg and curl.exe on PATH.

Overrides come from the process environment or infra\.env (copy
infra\.env.example to infra\.env to customize; precedence: process env >
infra\.env > infra\.env.example > built-in defaults): LLAMA_MODEL, MODEL_DIR,
HF_ENDPOINT, LLAMA_SERVER_EXE, LLAMA_BIND_HOST, LLAMA_PORT, LLAMA_PARALLEL,
LLAMA_CTX, LLAMA_NGL, INFERENCE_URLS, INFERENCE_MODEL, INFERENCE_AUDIO_FORMAT,
INFERENCE_TEMPERATURE.
'@
    return
}

$exitCode = 0
Push-Location -LiteralPath $PSScriptRoot
try {
    switch ($Task) {
        'model-pull' { & (Join-Path $PSScriptRoot 'infra/pull-model.ps1') }
        'inference' {
            & (Join-Path $PSScriptRoot 'infra/start-inference.ps1')
            $exitCode = $LASTEXITCODE
        }
        'transcribe' {
            & (Join-Path $PSScriptRoot 'scripts/transcribe-file.ps1') -AudioFile $AudioFile -SourceLanguage $SourceLanguage -TargetLanguage $TargetLanguage
        }
        'test-inference' {
            & (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -NoProfile -File (Join-Path $PSScriptRoot 'scripts/windows-inference.test.ps1')
            $exitCode = $LASTEXITCODE
        }
    }
}
finally { Pop-Location }
exit $exitCode
