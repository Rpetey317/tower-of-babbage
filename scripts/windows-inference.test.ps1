[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$repoRoot = Split-Path -Parent $PSScriptRoot
$devScript = Join-Path $repoRoot 'dev.ps1'
$pullScript = Join-Path $repoRoot 'infra/pull-model.ps1'
$transcribeScript = Join-Path $repoRoot 'scripts/transcribe-file.ps1'

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('babbage-win-test-' + [Guid]::NewGuid().ToString('N'))
$stubBin = Join-Path $testRoot 'stubbin'
New-Item -ItemType Directory -Force -Path $stubBin | Out-Null

$stubWavBytes = [byte[]](@(0x52, 0x49, 0x46, 0x46) + @(0x24) + @(0x00, 0x00, 0x00) +
    [Text.Encoding]::ASCII.GetBytes('WAVEfmt ') + @(0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00) +
    @(0x80, 0x3E, 0x00, 0x00, 0x00, 0x7D, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00) +
    [Text.Encoding]::ASCII.GetBytes('data') + @(0x00, 0x00, 0x00, 0x00))
$stubWavPath = Join-Path $testRoot 'ffmpeg-source.wav'
[IO.File]::WriteAllBytes($stubWavPath, $stubWavBytes)
$audioInput = Join-Path $testRoot 'input audio.wav'
[IO.File]::WriteAllBytes($audioInput, $stubWavBytes)

$ffmpegStub = @'
@echo off
> "%FFMPEG_ARGS_FILE%" echo %*
if "%FFMPEG_FAIL%"=="1" exit /b 1
set "OUT="
:loop
if "%~1"=="" goto after
if "%~1"=="-y" set "OUT=%~2"
shift
goto loop
:after
if not defined OUT exit /b 2
copy /b /y "%FFMPEG_SOURCE_WAV%" "%OUT%" >nul
exit /b %ERRORLEVEL%
'@
[IO.File]::WriteAllText((Join-Path $stubBin 'ffmpeg.cmd'), $ffmpegStub, (New-Object System.Text.ASCIIEncoding))

$llamaStubSource = @'
using System;
public static class StubServer {
    public static int Main(string[] args) {
        Console.Out.WriteLine("STUB_EXE=" + System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName);
        for (int i = 0; i < args.Length; i++) { Console.Out.WriteLine("ARGV[" + i + "]=" + args[i]); }
        Console.Error.WriteLine("stub-stderr");
        int ms;
        if (int.TryParse(Environment.GetEnvironmentVariable("STUB_SLEEP_MS"), out ms) && ms > 0) {
            System.Threading.Thread.Sleep(ms);
        }
        int code;
        if (int.TryParse(Environment.GetEnvironmentVariable("STUB_EXIT_CODE"), out code)) { return code; }
        return 0;
    }
}
'@
$llamaStub = Join-Path $testRoot 'llama-stub.exe'
Add-Type -TypeDefinition $llamaStubSource -OutputAssembly $llamaStub -OutputType ConsoleApplication

$explicitBin = Join-Path $testRoot 'explicit-bin'
New-Item -ItemType Directory -Force -Path $explicitBin | Out-Null
$explicitStub = Join-Path $explicitBin 'explicit-llama.exe'
Copy-Item $llamaStub $explicitStub
$pathBin = Join-Path $testRoot 'path-bin'
New-Item -ItemType Directory -Force -Path $pathBin | Out-Null
Copy-Item $llamaStub (Join-Path $pathBin 'llama-server.exe')
$emptyBin = Join-Path $testRoot 'empty-bin'
New-Item -ItemType Directory -Force -Path $emptyBin | Out-Null
$elsewhereDir = Join-Path $testRoot 'elsewhere'
New-Item -ItemType Directory -Force -Path $elsewhereDir | Out-Null
$markerDir = Join-Path $testRoot 'marker-dir'
New-Item -ItemType Directory -Force -Path $markerDir | Out-Null

$replica = Join-Path $testRoot 'replica'
foreach ($sub in @('infra', 'infra\models', 'scripts', 'bin\llama')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $replica $sub) | Out-Null
}
Copy-Item $devScript (Join-Path $replica 'dev.ps1')
Copy-Item $pullScript (Join-Path $replica 'infra\pull-model.ps1')
Copy-Item (Join-Path $repoRoot 'infra\start-inference.ps1') (Join-Path $replica 'infra\start-inference.ps1')
Copy-Item (Join-Path $repoRoot 'infra\env.ps1') (Join-Path $replica 'infra\env.ps1')
Copy-Item $transcribeScript (Join-Path $replica 'scripts\transcribe-file.ps1')
Copy-Item $llamaStub (Join-Path $replica 'bin\llama\llama-server.exe')
$replicaModels = Join-Path $replica 'infra\models'
[IO.File]::WriteAllBytes((Join-Path $replicaModels 'gemma-4-E2B-it-Q8_0.gguf'), $stubWavBytes)
[IO.File]::WriteAllBytes((Join-Path $replicaModels 'mmproj-gemma-4-E2B-it-BF16.gguf'), $stubWavBytes)
$replicaDev = Join-Path $replica 'dev.ps1'
$replicaLauncher = Join-Path $replica 'infra\start-inference.ps1'

$replicaBare = Join-Path $testRoot 'replica-bare'
New-Item -ItemType Directory -Force -Path (Join-Path $replicaBare 'infra') | Out-Null
Copy-Item (Join-Path $repoRoot 'infra\start-inference.ps1') (Join-Path $replicaBare 'infra\start-inference.ps1')
Copy-Item (Join-Path $repoRoot 'infra\env.ps1') (Join-Path $replicaBare 'infra\env.ps1')
$bareLauncher = Join-Path $replicaBare 'infra\start-inference.ps1'

$envProbeBody = @'
param([string]$Loader, [string]$Keys)
. $Loader
Import-BabbageEnv
foreach ($k in ($Keys -split ',')) { Write-Output ("{0}={1}" -f $k, [Environment]::GetEnvironmentVariable($k, 'Process')) }
'@
$envProbe = Join-Path $testRoot 'env-probe.ps1'
[IO.File]::WriteAllText($envProbe, $envProbeBody, (New-Object System.Text.ASCIIEncoding))

$portProbe = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$port = $portProbe.LocalEndpoint.Port
$portProbe.Stop()

$script:listener = New-Object System.Net.HttpListener
$script:listener.Prefixes.Add("http://127.0.0.1:$port/")
$script:listener.Start()
$script:pendingContext = $null
$script:responder = $null
$script:captured = @()

function Send-StubResponse {
    param($Ctx, [int]$Status, [byte[]]$Body, [string]$ContentType = 'application/octet-stream')
    $Ctx.Response.StatusCode = $Status
    $Ctx.Response.ContentType = $ContentType
    $Ctx.Response.ContentLength64 = $Body.Length
    if ($Body.Length -gt 0) { $Ctx.Response.OutputStream.Write($Body, 0, $Body.Length) }
    $Ctx.Response.Close()
}

function Handle-Context {
    param($Ctx)
    try {
        $ms = New-Object IO.MemoryStream
        $Ctx.Request.InputStream.CopyTo($ms)
        $script:captured += ,@{
            Method = $Ctx.Request.HttpMethod
            Path = $Ctx.Request.Url.PathAndQuery
            Body = $ms.ToArray()
        }
        if ($null -ne $script:responder) { & $script:responder $Ctx }
        else { Send-StubResponse $Ctx 404 ([byte[]]@()) }
    } catch {
        try { $Ctx.Response.Abort() } catch {}
    }
}

function Pump-Server {
    param([System.Diagnostics.Process]$Proc, [datetime]$Deadline)
    if ($null -eq $script:pendingContext) { $script:pendingContext = $script:listener.GetContextAsync() }
    while (-not $Proc.HasExited -and [DateTime]::UtcNow -lt $Deadline) {
        if ($script:pendingContext.Wait(150)) {
            Handle-Context $script:pendingContext.Result
            $script:pendingContext = $script:listener.GetContextAsync()
        }
    }
    while ($script:pendingContext.Wait(50)) {
        Handle-Context $script:pendingContext.Result
        $script:pendingContext = $script:listener.GetContextAsync()
    }
}

$managedEnv = @('LLAMA_MODEL', 'LLAMA_CPU_MODEL', 'HF_ENDPOINT', 'MODEL_DIR', 'INFERENCE_URLS',
    'INFERENCE_AUDIO_FORMAT', 'INFERENCE_MODEL', 'INFERENCE_TEMPERATURE',
    'FFMPEG_ARGS_FILE', 'FFMPEG_SOURCE_WAV', 'FFMPEG_FAIL',
    'LLAMA_SERVER_EXE', 'LLAMA_BIND_HOST', 'LLAMA_PORT', 'LLAMA_PARALLEL',
    'LLAMA_CTX', 'LLAMA_NGL', 'STUB_EXIT_CODE', 'STUB_SLEEP_MS',
    'POSTGRES_PASSWORD', 'POSTGRES_BIND_HOST', 'SHARED_SECRET', 'AUTH_SECRET',
    'ADMIN_PASSWORD', 'PUBLIC_WEB_URL', 'PUBLIC_PIPELINE_WS_URL',
    'DOTENV_ALPHA', 'DOTENV_BETA', 'DOTENV_GAMMA', 'DOTENV_DELTA',
    'DOTENV_EMPTY', 'DOTENV_SPACED', 'BAD-KEY', 'NOEQUALS')

function Invoke-Child {
    param(
        [string]$Script,
        [string[]]$Arguments = @(),
        [hashtable]$Env = @{},
        [scriptblock]$Responder = $null,
        [string]$WorkingDirectory = '',
        [string]$PathPrefix = ''
    )
    $script:captured = @()
    $script:responder = $Responder
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $argLine = '-NoProfile -File "' + $Script + '"'
    foreach ($a in $Arguments) { $argLine += ' "' + $a + '"' }
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $psi.CreateNoWindow = $true
    foreach ($key in $managedEnv) {
        if ($psi.EnvironmentVariables.ContainsKey($key)) { $psi.EnvironmentVariables.Remove($key) }
    }
    $pathPrefixValue = if ($PathPrefix) { $PathPrefix } else { $stubBin }
    $psi.EnvironmentVariables['PATH'] = "$pathPrefixValue;$env:SystemRoot\System32;$env:SystemRoot;$PSHOME"
    if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
    foreach ($key in $Env.Keys) {
        if ($null -ne $Env[$key]) { $psi.EnvironmentVariables[$key] = [string]$Env[$key] }
    }
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    Pump-Server $proc ([DateTime]::UtcNow.AddSeconds(45))
    if (-not $proc.HasExited) {
        $proc.Kill()
        throw "child process did not exit within 45s: $Script $Arguments"
    }
    $proc.WaitForExit()
    [pscustomobject]@{
        ExitCode = $proc.ExitCode
        Stdout = [string]$stdoutTask.Result
        Stderr = [string]$stderrTask.Result
        Requests = $script:captured
    }
}

function Assert-True {
    param($Condition, [string]$Message)
    if (-not $Condition) { throw "assert failed: $Message" }
}

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    if ($Actual -ne $Expected) { throw "assert failed: $Message (expected '$Expected', got '$Actual')" }
}

function Get-StubExe {
    param([string]$Stdout)
    $m = [regex]::Match($Stdout, 'STUB_EXE=([^\r\n]+)')
    if ($m.Success) { $m.Groups[1].Value.Trim() } else { $null }
}

function Assert-Argv {
    param([string]$Stdout, [string[]]$Expected)
    $lines = @($Stdout -split "`r?`n" | Where-Object { $_ -match '^ARGV\[\d+\]=' } |
        ForEach-Object { $_ -replace '^ARGV\[\d+\]=', '' })
    Assert-Equal $lines.Count $Expected.Count 'argv count'
    for ($i = 0; $i -lt $Expected.Count; $i++) {
        Assert-True ($lines[$i] -ceq $Expected[$i]) "argv[$i]: expected '$($Expected[$i])', got '$($lines[$i])'"
    }
}

function Get-Sha256Hex([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
}

function New-HFFile {
    param([string]$Path, [byte[]]$Bytes, [string]$Oid = '')
    if (-not $Oid) { $Oid = Get-Sha256Hex $Bytes }
    @{ type = 'file'; path = $Path; size = $Bytes.Length; lfs = @{ oid = $Oid; size = $Bytes.Length } }
}

function New-ModelResponder {
    param([object[]]$Metadata, [hashtable]$Files = @{}, [hashtable]$ResolveStatus = @{})
    return {
        param($Ctx)
        $p = $Ctx.Request.Url.PathAndQuery
        if ($p -like '/api/models/*/tree/main*') {
            $json = ConvertTo-Json -InputObject @($Metadata) -Depth 5 -Compress
            Send-StubResponse $Ctx 200 ([Text.Encoding]::UTF8.GetBytes($json)) 'application/json'
            return
        }
        if ($p -match '/resolve/main/([^/]+)$') {
            $name = $Matches[1]
            if ($ResolveStatus.ContainsKey($name)) {
                Send-StubResponse $Ctx ([int]$ResolveStatus[$name]) ([byte[]]@())
                return
            }
            if ($Files.ContainsKey($name)) { Send-StubResponse $Ctx 200 $Files[$name]; return }
            Send-StubResponse $Ctx 404 ([byte[]]@())
            return
        }
        Send-StubResponse $Ctx 404 ([byte[]]@())
    }.GetNewClosure()
}

function New-ChatBody {
    param([object]$Content = '__absent__', [string]$Finish = 'stop')
    $message = @{ role = 'assistant' }
    if ($Content -cne '__absent__') { $message.content = $Content }
    $obj = @{ choices = @(@{ finish_reason = $Finish; message = $message }) }
    [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $obj -Depth 6 -Compress))
}

function New-ChatResponder {
    param([int]$Status, [byte[]]$Body)
    return {
        param($Ctx)
        Send-StubResponse $Ctx $Status $Body 'application/json'
    }.GetNewClosure()
}

function New-LauncherReplica {
    param([string]$Name)
    $root = Join-Path $testRoot $Name
    foreach ($sub in @('infra', 'infra\models', 'bin\llama')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $root $sub) | Out-Null
    }
    Copy-Item (Join-Path $repoRoot 'infra\env.ps1') (Join-Path $root 'infra\env.ps1')
    Copy-Item (Join-Path $repoRoot 'infra\start-inference.ps1') (Join-Path $root 'infra\start-inference.ps1')
    Copy-Item $llamaStub (Join-Path $root 'bin\llama\llama-server.exe')
    $models = Join-Path $root 'infra\models'
    [IO.File]::WriteAllBytes((Join-Path $models 'gemma-4-E2B-it-Q8_0.gguf'), $stubWavBytes)
    [IO.File]::WriteAllBytes((Join-Path $models 'mmproj-gemma-4-E2B-it-BF16.gguf'), $stubWavBytes)
    return $root
}

$script:passed = 0
$script:failed = 0
function Invoke-Case {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        $script:passed++
        Write-Output "PASS $Name"
    } catch {
        $script:failed++
        Write-Output "FAIL $Name -- $($_.Exception.Message)"
    }
}

function Get-TranscribeTempDirCount {
    (@(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'babbage-transcribe-*' -ErrorAction SilentlyContinue)).Count
}

$modelBytes = [Text.Encoding]::UTF8.GetBytes('fake model weights q8')
$projectorBytes = [Text.Encoding]::UTF8.GetBytes('fake bf16 projector')
$modelName = 'gemma-4-E2B-it-Q8_0.gguf'
$projectorName = 'mmproj-gemma-4-E2B-it-BF16.gguf'
$defaultMetadata = @(
    (New-HFFile $modelName $modelBytes),
    (New-HFFile $projectorName $projectorBytes),
    (New-HFFile 'mmproj-gemma-4-E2B-it-Q8_0.gguf' ([Text.Encoding]::UTF8.GetBytes('quantized projector'))),
    (New-HFFile 'mtp-gemma-4-Q8_0.gguf' ([Text.Encoding]::UTF8.GetBytes('mtp weights'))),
    (New-HFFile 'gemma-4-E2B-it-Q4_0.gguf' ([Text.Encoding]::UTF8.GetBytes('other quant'))),
    (New-HFFile 'README.md' ([Text.Encoding]::UTF8.GetBytes('readme')) 'x')
)
$defaultFiles = @{ $modelName = $modelBytes; $projectorName = $projectorBytes }

try {
    Invoke-Case 'download: default model into infra/models' {
        $dir = Join-Path $testRoot 'models-default'
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $defaultMetadata -Files $defaultFiles)
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-True ($r.Stdout.Contains('Verified:')) 'expected Verified output'
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $dir $modelName))) ([Text.Encoding]::UTF8.GetString($modelBytes)) 'model bytes'
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $dir $projectorName))) ([Text.Encoding]::UTF8.GetString($projectorBytes)) 'projector bytes'
    }

    Invoke-Case 'download: repeat run verifies without downloading' {
        $dir = Join-Path $testRoot 'models-default'
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $defaultMetadata -Files $defaultFiles)
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-True ($r.Stdout.Contains('Already verified:')) 'expected Already verified'
        $downloads = @($r.Requests | Where-Object { $_.Path -match '/resolve/main/' })
        Assert-Equal ($downloads.Count) 0 'no resolve requests expected'
    }

    Invoke-Case 'download: env overrides for model ref and MODEL_DIR with spaces' {
        $dir = Join-Path $testRoot 'model dir with spaces'
        $bytes = [Text.Encoding]::UTF8.GetBytes('custom q4 model')
        $meta = @(
            (New-HFFile 'custom-Q4_0.gguf' $bytes),
            (New-HFFile 'mmproj-custom-BF16.gguf' $projectorBytes)
        )
        $r = Invoke-Child -Script $pullScript `
            -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir; LLAMA_MODEL = 'custom-owner/custom-repo:Q4_0' } `
            -Responder (New-ModelResponder -Metadata $meta -Files @{ 'custom-Q4_0.gguf' = $bytes; 'mmproj-custom-BF16.gguf' = $projectorBytes })
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-True (Test-Path -LiteralPath (Join-Path $dir 'custom-Q4_0.gguf')) 'model in spaced dir'
        Assert-True (Test-Path -LiteralPath (Join-Path $dir 'mmproj-custom-BF16.gguf')) 'projector in spaced dir'
        Assert-True ((@($r.Requests | Where-Object { $_.Path -like '/api/models/custom-owner/custom-repo/*' })).Count -gt 0) 'metadata fetched from custom repo'
    }

    Invoke-Case 'download: missing model file fails before any download' {
        $dir = Join-Path $testRoot 'models-missing'
        $meta = @((New-HFFile $projectorName $projectorBytes))
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $meta -Files $defaultFiles)
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal (@($r.Requests | Where-Object { $_.Path -match '/resolve/main/' })).Count 0 'no downloads'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $dir $projectorName))) 'no final files'
    }

    Invoke-Case 'download: ambiguous model files fail' {
        $dir = Join-Path $testRoot 'models-ambiguous'
        $meta = @(
            (New-HFFile 'a-Q8_0.gguf' $modelBytes),
            (New-HFFile 'b-Q8_0.gguf' $modelBytes),
            (New-HFFile $projectorName $projectorBytes)
        )
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $meta -Files $defaultFiles)
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal (@($r.Requests | Where-Object { $_.Path -match '/resolve/main/' })).Count 0 'no downloads'
    }

    Invoke-Case 'download: ambiguous projector files fail' {
        $dir = Join-Path $testRoot 'models-ambiguous-proj'
        $meta = @(
            (New-HFFile $modelName $modelBytes),
            (New-HFFile 'mmproj-a-BF16.gguf' $projectorBytes),
            (New-HFFile 'mmproj-b-BF16.gguf' $projectorBytes)
        )
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $meta -Files $defaultFiles)
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal (@($r.Requests | Where-Object { $_.Path -match '/resolve/main/' })).Count 0 'no downloads'
    }

    Invoke-Case 'download: missing projector fails' {
        $dir = Join-Path $testRoot 'models-noproj'
        $meta = @((New-HFFile $modelName $modelBytes))
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $meta -Files $defaultFiles)
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
    }

    Invoke-Case 'download: invalid lfs oid fails before downloads' {
        $dir = Join-Path $testRoot 'models-badhash'
        $meta = @(
            (New-HFFile $modelName $modelBytes 'not-a-sha256'),
            (New-HFFile $projectorName $projectorBytes)
        )
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $meta -Files $defaultFiles)
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal (@($r.Requests | Where-Object { $_.Path -match '/resolve/main/' })).Count 0 'no downloads'
    }

    Invoke-Case 'download: unsafe subdirectory path fails' {
        $dir = Join-Path $testRoot 'models-unsafe'
        $meta = @(
            (New-HFFile 'subdir/evil-Q8_0.gguf' $modelBytes),
            (New-HFFile $projectorName $projectorBytes)
        )
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $meta -Files $defaultFiles)
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal (@($r.Requests | Where-Object { $_.Path -match '/resolve/main/' })).Count 0 'no downloads'
    }

    Invoke-Case 'download: unsafe ADS-style filename fails' {
        $dir = Join-Path $testRoot 'models-unsafe-ads'
        $meta = @(
            (New-HFFile 'evil:stream-Q8_0.gguf' $modelBytes),
            (New-HFFile $projectorName $projectorBytes)
        )
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $meta -Files $defaultFiles)
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal (@($r.Requests | Where-Object { $_.Path -match '/resolve/main/' })).Count 0 'no downloads'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $dir 'evil:stream-Q8_0.gguf'))) 'no final file'
    }

    Invoke-Case 'download: checksum mismatch keeps partial and no final' {
        $dir = Join-Path $testRoot 'models-mismatch'
        $badOid = Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes('different bytes'))
        $meta = @(
            (New-HFFile $modelName $modelBytes $badOid),
            (New-HFFile $projectorName $projectorBytes)
        )
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $meta -Files $defaultFiles)
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $dir $modelName))) 'no final model file'
        Assert-True (Test-Path -LiteralPath ((Join-Path $dir $modelName) + '.part')) 'partial retained'
    }

    Invoke-Case 'download: transfer failure leaves no final file' {
        $dir = Join-Path $testRoot 'models-transferfail'
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $defaultMetadata -Files $defaultFiles -ResolveStatus @{ $modelName = 404 })
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $dir $modelName))) 'no final model file'
    }

    Invoke-Case 'download: preexisting wrong final is preserved' {
        $dir = Join-Path $testRoot 'models-wrongfinal'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $existing = [Text.Encoding]::UTF8.GetBytes('user bytes not to overwrite')
        [IO.File]::WriteAllBytes((Join-Path $dir $modelName), $existing)
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $defaultMetadata -Files $defaultFiles)
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $dir $modelName))) ([Text.Encoding]::UTF8.GetString($existing)) 'existing file preserved'
    }

    Invoke-Case 'download: invalid LLAMA_MODEL fails without network' {
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; LLAMA_MODEL = 'badref' } `
            -Responder (New-ModelResponder -Metadata $defaultMetadata -Files $defaultFiles)
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal $r.Requests.Count 0 'no requests'
    }

    Invoke-Case 'download: invalid HF_ENDPOINT fails without network' {
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = 'not-a-url'; MODEL_DIR = (Join-Path $testRoot 'models-badendpoint') } `
            -Responder (New-ModelResponder -Metadata $defaultMetadata -Files $defaultFiles)
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal $r.Requests.Count 0 'no requests'
    }

    Invoke-Case 'download: unreachable endpoint fails nonzero' {
        $r = Invoke-Child -Script $pullScript -Env @{ HF_ENDPOINT = 'http://127.0.0.1:9'; MODEL_DIR = (Join-Path $testRoot 'models-unreachable') }
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
    }

    $expectedPrompt = "Transcribe the following speech segment in English, then translate it into Spanish.`nWhen formatting the answer, first output the transcription in English, then one newline, then output the string 'Spanish: ', then the translation in Spanish."
    $ffmpegArgs = Join-Path $testRoot 'ffmpeg-args.txt'

    Invoke-Case 'transcribe: en -> es happy path' {
        if (Test-Path $ffmpegArgs) { Remove-Item $ffmpegArgs }
        $beforeDirs = Get-TranscribeTempDirCount
        $accentedSpanish = 'hola transcripci' + [char]0x00F3 + 'n'
        $content = "hello`r`nworld`r`nSpanish: $accentedSpanish`r`nextra"
        $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput) `
            -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath } `
            -Responder (New-ChatResponder -Status 200 -Body (New-ChatBody -Content $content))
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr))"
        Assert-True ($r.Stdout.Contains('Raw response JSON:')) 'raw response printed'
        Assert-True ($r.Stdout.Contains('Raw model output:')) 'raw output printed'
        Assert-True ($r.Stdout.Contains('Transcript: hello world')) 'normalized multiline transcript printed'
        Assert-True ($r.Stdout.Contains("Spanish: $accentedSpanish extra")) 'accented translation printed'
        Assert-True ($r.Stdout.Contains('Request time:')) 'request time printed'
        Assert-Equal $r.Requests.Count 1 'one request'
        Assert-Equal $r.Requests[0].Method 'POST' 'method'
        Assert-Equal $r.Requests[0].Path '/v1/chat/completions' 'path'
        $body = $r.Requests[0].Body
        Assert-True (-not ($body.Length -ge 3 -and $body[0] -eq 0xEF -and $body[1] -eq 0xBB -and $body[2] -eq 0xBF)) 'request has no UTF-8 BOM'
        $req = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
        Assert-Equal $req.model 'gemma-4' 'default model'
        Assert-Equal $req.messages[0].role 'user' 'role'
        Assert-Equal $req.messages[0].content.Count 2 'two content blocks'
        Assert-Equal $req.messages[0].content[0].type 'input_audio' 'audio type'
        Assert-Equal $req.messages[0].content[0].input_audio.format 'wav' 'wav format'
        Assert-Equal $req.messages[0].content[0].input_audio.data ([Convert]::ToBase64String($stubWavBytes)) 'audio bytes'
        Assert-True ($req.messages[0].content[1].text -ceq $expectedPrompt) 'prompt text'
        Assert-Equal $req.temperature 0.2 'temperature'
        Assert-Equal $req.top_p 0.95 'top_p'
        Assert-Equal $req.top_k 64 'top_k'
        Assert-Equal $req.max_tokens 256 'max_tokens'
        Assert-Equal $req.chat_template_kwargs.enable_thinking $false 'enable_thinking'
        Assert-True (Test-Path $ffmpegArgs) 'ffmpeg invoked'
        $argText = [IO.File]::ReadAllText($ffmpegArgs)
        foreach ($flag in @('-v error', '-nostdin', '-i ', '-t 10', '-ar 16000', '-ac 1', 'pcm_s16le', '-y ')) {
            Assert-True ($argText.Contains($flag)) "ffmpeg args contain $flag"
        }
        Assert-True ($argText.Contains('input audio.wav')) 'ffmpeg input path'
        Assert-Equal (Get-TranscribeTempDirCount) $beforeDirs 'temp dirs cleaned'
    }

    Invoke-Case 'transcribe: audio_url, pt -> en, env overrides, first URL wins' {
        Remove-Item $ffmpegArgs -ErrorAction SilentlyContinue
        $accentedPortuguese = 'ol' + [char]0x00E1 + ' mundo'
        $content = "$accentedPortuguese`nEnglish: hello world"
        $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput, 'pt', 'en') `
            -Env @{
                INFERENCE_URLS = "http://127.0.0.1:$port , http://127.0.0.1:9"
                INFERENCE_AUDIO_FORMAT = 'audio_url'
                INFERENCE_MODEL = 'custom-model'
                INFERENCE_TEMPERATURE = '1.5'
                FFMPEG_ARGS_FILE = $ffmpegArgs
                FFMPEG_SOURCE_WAV = $stubWavPath
            } -Responder (New-ChatResponder -Status 200 -Body (New-ChatBody -Content $content))
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr))"
        Assert-True ($r.Stdout.Contains('English: hello world')) 'english translation printed'
        Assert-True ($r.Stdout.Contains("Transcript: $accentedPortuguese")) 'portuguese transcript printed'
        Assert-Equal $r.Requests.Count 1 'one request'
        $req = [Text.Encoding]::UTF8.GetString($r.Requests[0].Body) | ConvertFrom-Json
        Assert-Equal $req.model 'custom-model' 'model override'
        Assert-Equal $req.temperature 1.5 'temperature override'
        Assert-Equal $req.messages[0].content[0].type 'audio_url' 'audio_url type'
        Assert-True ($req.messages[0].content[0].audio_url.url.StartsWith('data:audio/wav;base64,')) 'data URI'
        Assert-Equal $req.messages[0].content[0].audio_url.url ("data:audio/wav;base64," + [Convert]::ToBase64String($stubWavBytes)) 'audio bytes in URL'
    }

    $failCases = @(
        @{ Name = 'missing marker'; Content = "just text without marker`nsecond line" },
        @{ Name = 'empty transcript'; Content = 'Spanish: hola mundo' },
        @{ Name = 'empty translation'; Content = "hello world`nSpanish:" },
        @{ Name = 'truncated output'; Content = "hello`nSpanish: hola"; Finish = 'length' },
        @{ Name = 'missing content'; Content = '__absent__' }
    )
    foreach ($fc in $failCases) {
        Invoke-Case "transcribe: nonzero on $($fc.Name)" {
            $finish = if ($fc.Finish) { $fc.Finish } else { 'stop' }
            $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput) `
                -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath } `
                -Responder (New-ChatResponder -Status 200 -Body (New-ChatBody -Content $fc.Content -Finish $finish))
            Assert-True ($r.ExitCode -ne 0) "expected nonzero exit (stdout: $($r.Stdout))"
        }
    }

    Invoke-Case 'transcribe: malformed JSON response fails' {
        $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput) `
            -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath } `
            -Responder (New-ChatResponder -Status 200 -Body ([Text.Encoding]::UTF8.GetBytes('not json {')))
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-True ($r.Stdout.Contains('Raw response JSON:')) 'raw response still printed'
    }

    Invoke-Case 'transcribe: HTTP 500 prints body and fails' {
        $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput) `
            -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath } `
            -Responder (New-ChatResponder -Status 500 -Body ([Text.Encoding]::UTF8.GetBytes('{"error":"server exploded"}')))
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-True ($r.Stdout.Contains('server exploded')) 'error body printed'
    }

    Invoke-Case 'transcribe: ffmpeg failure exits nonzero before request' {
        Remove-Item $ffmpegArgs -ErrorAction SilentlyContinue
        $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput) `
            -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath; FFMPEG_FAIL = '1' }
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal $r.Requests.Count 0 'no requests after ffmpeg failure'
    }

    Invoke-Case 'transcribe: missing audio file fails before tools and network' {
        Remove-Item $ffmpegArgs -ErrorAction SilentlyContinue
        $r = Invoke-Child -Script $transcribeScript -Arguments @(Join-Path $testRoot 'no-such.wav') `
            -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath }
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal $r.Requests.Count 0 'no requests'
        Assert-True (-not (Test-Path $ffmpegArgs)) 'ffmpeg not invoked'
    }

    Invoke-Case 'transcribe: identical languages rejected' {
        $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput, 'en', 'en') `
            -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath }
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal $r.Requests.Count 0 'no requests'
    }

    Invoke-Case 'transcribe: unsupported language rejected' {
        $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput, 'fr', 'es') `
            -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath }
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal $r.Requests.Count 0 'no requests'
    }

    Invoke-Case 'transcribe: invalid INFERENCE_URLS rejected before network' {
        $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput) `
            -Env @{ INFERENCE_URLS = 'not-a-url'; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath }
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal $r.Requests.Count 0 'no requests'
    }

    Invoke-Case 'transcribe: invalid audio format rejected' {
        $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput) `
            -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; INFERENCE_AUDIO_FORMAT = 'bogus'; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath }
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal $r.Requests.Count 0 'no requests'
    }

    Invoke-Case 'transcribe: invalid temperature rejected' {
        foreach ($bad in @('abc', '3', '-1', 'NaN')) {
            $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput) `
                -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; INFERENCE_TEMPERATURE = $bad; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath }
            Assert-True ($r.ExitCode -ne 0) "expected nonzero exit for temperature $bad"
            Assert-Equal $r.Requests.Count 0 "no requests for temperature $bad"
        }
    }

    Invoke-Case 'transcribe: temp dir cleaned after failure' {
        $beforeDirs = Get-TranscribeTempDirCount
        $r = Invoke-Child -Script $transcribeScript -Arguments @($audioInput) `
            -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath } `
            -Responder (New-ChatResponder -Status 200 -Body (New-ChatBody -Content 'no marker here'))
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal (Get-TranscribeTempDirCount) $beforeDirs 'temp dirs cleaned'
    }

    Invoke-Case 'runner: help succeeds without tools' {
        $r = Invoke-Child -Script $devScript -PathPrefix $emptyBin
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr))"
        foreach ($word in @('model-pull', 'inference', 'transcribe', 'test-inference')) {
            Assert-True ($r.Stdout.Contains($word)) "help lists $word"
        }
    }

    Invoke-Case 'runner: invalid task rejected' {
        $r = Invoke-Child -Script $devScript -Arguments @('bogus')
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
    }

    Invoke-Case 'runner: transcribe-only params rejected on other tasks' {
        $r = Invoke-Child -Script $devScript -Arguments @('model-pull', '-AudioFile', 'x.wav')
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-Equal $r.Requests.Count 0 'no requests'
    }

    Invoke-Case 'runner: model-pull routes to downloader' {
        $dir = Join-Path $testRoot 'runner-models'
        $r = Invoke-Child -Script $devScript -Arguments @('model-pull') `
            -Env @{ HF_ENDPOINT = "http://127.0.0.1:$port"; MODEL_DIR = $dir } `
            -Responder (New-ModelResponder -Metadata $defaultMetadata -Files $defaultFiles)
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-True ($r.Stdout.Contains('Verified:')) 'downloader ran'
        Assert-True (Test-Path -LiteralPath (Join-Path $dir $modelName)) 'model file downloaded'
    }

    Invoke-Case 'runner: transcribe uses repo fixture and en/es defaults' {
        Remove-Item $ffmpegArgs -ErrorAction SilentlyContinue
        $r = Invoke-Child -Script $devScript -Arguments @('transcribe') `
            -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath } `
            -Responder (New-ChatResponder -Status 200 -Body (New-ChatBody -Content "hello`nSpanish: mundo"))
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-True ($r.Stdout.Contains('Spanish: mundo')) 'translation printed'
        Assert-True ([IO.File]::ReadAllText($ffmpegArgs).Contains('fixtures\audio\en-kubernetes-60s.wav')) 'repo-relative default resolved'
        $req = [Text.Encoding]::UTF8.GetString($r.Requests[0].Body) | ConvertFrom-Json
        Assert-True ($req.messages[0].content[1].text -ceq $expectedPrompt) 'default en/es prompt'
    }

    Invoke-Case 'runner: transcribe relative path and languages from unrelated cwd' {
        Remove-Item $ffmpegArgs -ErrorAction SilentlyContinue
        $esPrompt = "Transcribe the following speech segment in Spanish, then translate it into English.`nWhen formatting the answer, first output the transcription in Spanish, then one newline, then output the string 'English: ', then the translation in English."
        $r = Invoke-Child -Script $devScript `
            -Arguments @('transcribe', '-AudioFile', 'fixtures/audio/es-charla-60s.wav', '-SourceLanguage', 'es', '-TargetLanguage', 'en') `
            -WorkingDirectory $elsewhereDir `
            -Env @{ INFERENCE_URLS = "http://127.0.0.1:$port"; FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath } `
            -Responder (New-ChatResponder -Status 200 -Body (New-ChatBody -Content "charla`nEnglish: talk"))
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-True ($r.Stdout.Contains('English: talk')) 'translation printed'
        Assert-True ([IO.File]::ReadAllText($ffmpegArgs).Contains('fixtures\audio\es-charla-60s.wav')) 'repo-relative override resolved'
        $req = [Text.Encoding]::UTF8.GetString($r.Requests[0].Body) | ConvertFrom-Json
        Assert-True ($req.messages[0].content[1].text -ceq $esPrompt) 'es/en prompt'
    }

    Invoke-Case 'runner: caller location restored and continues after success and error' {
        $wrapper = Join-Path $testRoot 'wrapper.ps1'
        $wrapperBody = @"
Set-Location -LiteralPath '$($markerDir -replace "'", "''")'
& '$($devScript -replace "'", "''")' help | Out-Null
Write-Output "MARKER-HELP loc=`$((Get-Location).Path)"
try { & '$($devScript -replace "'", "''")' transcribe -AudioFile 'missing.wav' } catch { }
Write-Output "MARKER-ERR loc=`$((Get-Location).Path)"
"@
        [IO.File]::WriteAllText($wrapper, $wrapperBody, (New-Object System.Text.ASCIIEncoding))
        $r = Invoke-Child -Script $wrapper -WorkingDirectory $elsewhereDir
        Assert-True ($r.Stdout.Contains("MARKER-HELP loc=$markerDir")) "location kept after success (stdout: $($r.Stdout) stderr: $($r.Stderr))"
        Assert-True ($r.Stdout.Contains("MARKER-ERR loc=$markerDir")) "location kept after error (stdout: $($r.Stdout) stderr: $($r.Stderr))"
    }

    Invoke-Case 'launcher: default startup args via bundled binary, no network' {
        $r = Invoke-Child -Script $replicaLauncher
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-Equal $r.Requests.Count 0 'no network requests'
        Assert-True ((Get-StubExe $r.Stdout) -like '*bin\llama\llama-server.exe') "bundled stub used (got '$(Get-StubExe $r.Stdout)')"
        Assert-Argv $r.Stdout @('-m', (Join-Path $replicaModels 'gemma-4-E2B-it-Q8_0.gguf'),
            '--mmproj', (Join-Path $replicaModels 'mmproj-gemma-4-E2B-it-BF16.gguf'),
            '--host', '127.0.0.1', '--port', '8080', '--parallel', '4', '-c', '16384', '-ngl', '99', '--jinja')
        Assert-True (-not ($r.Stdout -split "`r?`n" | Where-Object { $_ -match '^ARGV' } | Where-Object { $_.Contains('-hf') })) 'no -hf flag'
    }

    Invoke-Case 'launcher: env overrides apply and NGL 0 retained' {
        $mdir = Join-Path $testRoot 'q4 models'
        New-Item -ItemType Directory -Force -Path $mdir | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $mdir 'm-Q4_0.gguf'), $stubWavBytes)
        [IO.File]::WriteAllBytes((Join-Path $mdir 'mmproj-m-BF16.gguf'), $stubWavBytes)
        $r = Invoke-Child -Script $replicaLauncher `
            -Env @{ LLAMA_SERVER_EXE = $explicitStub; LLAMA_MODEL = 'owner/repo:Q4_0'; MODEL_DIR = $mdir;
                    LLAMA_BIND_HOST = '0.0.0.0'; LLAMA_PORT = '8099'; LLAMA_PARALLEL = '2'; LLAMA_CTX = '8192'; LLAMA_NGL = '0' }
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr))"
        Assert-Argv $r.Stdout @('-m', (Join-Path $mdir 'm-Q4_0.gguf'), '--mmproj', (Join-Path $mdir 'mmproj-m-BF16.gguf'),
            '--host', '0.0.0.0', '--port', '8099', '--parallel', '2', '-c', '8192', '-ngl', '0', '--jinja')
    }

    Invoke-Case 'launcher: explicit override beats bundled and PATH' {
        $r = Invoke-Child -Script $replicaLauncher -Env @{ LLAMA_SERVER_EXE = $explicitStub } -PathPrefix "$stubBin;$pathBin"
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr))"
        Assert-True ((Get-StubExe $r.Stdout) -like '*explicit-bin\explicit-llama.exe') "explicit stub used (got '$(Get-StubExe $r.Stdout)')"
    }

    Invoke-Case 'launcher: bundled beats PATH' {
        $r = Invoke-Child -Script $replicaLauncher -PathPrefix "$stubBin;$pathBin"
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr))"
        Assert-True ((Get-StubExe $r.Stdout) -like '*replica\bin\llama\llama-server.exe') "bundled stub used (got '$(Get-StubExe $r.Stdout)')"
    }

    Invoke-Case 'launcher: PATH fallback when no bundled binary' {
        $r = Invoke-Child -Script $bareLauncher -PathPrefix "$stubBin;$pathBin" -Env @{ MODEL_DIR = $replicaModels }
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr))"
        Assert-True ((Get-StubExe $r.Stdout) -like '*path-bin\llama-server.exe') "PATH stub used (got '$(Get-StubExe $r.Stdout)')"
    }

    Invoke-Case 'launcher: invalid explicit override fails despite bundled fallback' {
        $r = Invoke-Child -Script $replicaLauncher -Env @{ LLAMA_SERVER_EXE = (Join-Path $testRoot 'missing.exe') }
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-True (-not $r.Stdout.Contains('STUB_EXE=')) 'no native invocation'
    }

    Invoke-Case 'launcher: missing binary fails' {
        $r = Invoke-Child -Script $bareLauncher -Env @{ MODEL_DIR = $replicaModels }
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-True (-not $r.Stdout.Contains('STUB_EXE=')) 'no native invocation'
    }

    Invoke-Case 'launcher: missing model dir fails' {
        $r = Invoke-Child -Script $replicaLauncher -Env @{ MODEL_DIR = (Join-Path $testRoot 'no-such-dir') }
        Assert-True ($r.ExitCode -ne 0) 'expected nonzero exit'
        Assert-True (-not $r.Stdout.Contains('STUB_EXE=')) 'no native invocation'
    }

    Invoke-Case 'launcher: missing model or projector fails' {
        $onlyModel = Join-Path $testRoot 'only-model'
        New-Item -ItemType Directory -Force -Path $onlyModel | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $onlyModel 'x-Q8_0.gguf'), $stubWavBytes)
        $r = Invoke-Child -Script $replicaLauncher -Env @{ MODEL_DIR = $onlyModel }
        Assert-True ($r.ExitCode -ne 0) 'missing projector nonzero'
        Assert-True (-not $r.Stdout.Contains('STUB_EXE=')) 'no invocation without projector'
        $onlyProj = Join-Path $testRoot 'only-proj'
        New-Item -ItemType Directory -Force -Path $onlyProj | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $onlyProj 'mmproj-x-BF16.gguf'), $stubWavBytes)
        $r = Invoke-Child -Script $replicaLauncher -Env @{ MODEL_DIR = $onlyProj }
        Assert-True ($r.ExitCode -ne 0) 'missing model nonzero'
        Assert-True (-not $r.Stdout.Contains('STUB_EXE=')) 'no invocation without model'
    }

    Invoke-Case 'launcher: ambiguous candidates fail' {
        $dupModel = Join-Path $testRoot 'dup-model'
        New-Item -ItemType Directory -Force -Path $dupModel | Out-Null
        foreach ($n in @('a-Q8_0.gguf', 'b-Q8_0.gguf', 'mmproj-x-BF16.gguf')) {
            [IO.File]::WriteAllBytes((Join-Path $dupModel $n), $stubWavBytes)
        }
        $r = Invoke-Child -Script $replicaLauncher -Env @{ MODEL_DIR = $dupModel }
        Assert-True ($r.ExitCode -ne 0) 'duplicate models nonzero'
        $dupProj = Join-Path $testRoot 'dup-proj'
        New-Item -ItemType Directory -Force -Path $dupProj | Out-Null
        foreach ($n in @('a-Q8_0.gguf', 'mmproj-x-BF16.gguf', 'mmproj-y-BF16.gguf')) {
            [IO.File]::WriteAllBytes((Join-Path $dupProj $n), $stubWavBytes)
        }
        $r = Invoke-Child -Script $replicaLauncher -Env @{ MODEL_DIR = $dupProj }
        Assert-True ($r.ExitCode -ne 0) 'duplicate projectors nonzero'
        Assert-True (-not $r.Stdout.Contains('STUB_EXE=')) 'no native invocation'
    }

    Invoke-Case 'launcher: distractor files and directories ignored' {
        $mdir = Join-Path $testRoot 'distractors'
        New-Item -ItemType Directory -Force -Path $mdir | Out-Null
        foreach ($n in @('m-Q8_0.gguf', 'mmproj-m-BF16.gguf', 'mmproj-m-Q8_0.gguf', 'mtp-m-Q8_0.gguf', 'm-Q8_0.gguf.part')) {
            [IO.File]::WriteAllBytes((Join-Path $mdir $n), $stubWavBytes)
        }
        New-Item -ItemType Directory -Force -Path (Join-Path $mdir 'stray-Q8_0.gguf') | Out-Null
        $r = Invoke-Child -Script $replicaLauncher -Env @{ MODEL_DIR = $mdir; LLAMA_SERVER_EXE = $explicitStub }
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-Argv $r.Stdout @('-m', (Join-Path $mdir 'm-Q8_0.gguf'), '--mmproj', (Join-Path $mdir 'mmproj-m-BF16.gguf'),
            '--host', '127.0.0.1', '--port', '8080', '--parallel', '4', '-c', '16384', '-ngl', '99', '--jinja')
    }

    Invoke-Case 'launcher: invalid model ref and numeric fields fail before invocation' {
        foreach ($badEnv in @(
            @{ LLAMA_MODEL = 'badref' },
            @{ LLAMA_PORT = 'abc' },
            @{ LLAMA_PORT = '70000' },
            @{ LLAMA_PORT = '0' },
            @{ LLAMA_PARALLEL = '0' },
            @{ LLAMA_CTX = '0' },
            @{ LLAMA_NGL = '-1' },
            @{ LLAMA_BIND_HOST = '   ' }
        )) {
            $label = ($badEnv.Keys | ForEach-Object { "$_=$($badEnv[$_])" }) -join ','
            $r = Invoke-Child -Script $replicaLauncher -Env $badEnv
            Assert-True ($r.ExitCode -ne 0) "expected nonzero exit for $label"
            Assert-True (-not $r.Stdout.Contains('STUB_EXE=')) "no native invocation for $label"
        }
    }

    Invoke-Case 'runner: native exit code propagates through dev.ps1' {
        $r = Invoke-Child -Script $replicaDev -Arguments @('inference') -Env @{ STUB_EXIT_CODE = '23' }
        Assert-Equal $r.ExitCode 23 "native exit 23 propagated (stdout: $($r.Stdout) stderr: $($r.Stderr))"
        Assert-True ($r.Stdout.Contains('STUB_EXE=')) 'stub invoked'
    }

    Invoke-Case 'dotenv: launcher takes port from infra/.env' {
        $root = New-LauncherReplica 'replica-dotenv-port'
        [IO.File]::WriteAllText((Join-Path $root 'infra\.env'), "LLAMA_PORT=8123`n", (New-Object System.Text.ASCIIEncoding))
        $r = Invoke-Child -Script (Join-Path $root 'infra\start-inference.ps1')
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-Argv $r.Stdout @('-m', (Join-Path $root 'infra\models\gemma-4-E2B-it-Q8_0.gguf'),
            '--mmproj', (Join-Path $root 'infra\models\mmproj-gemma-4-E2B-it-BF16.gguf'),
            '--host', '127.0.0.1', '--port', '8123', '--parallel', '4', '-c', '16384', '-ngl', '99', '--jinja')
    }

    Invoke-Case 'dotenv: process env beats infra/.env' {
        $root = New-LauncherReplica 'replica-dotenv-proc'
        [IO.File]::WriteAllText((Join-Path $root 'infra\.env'), "LLAMA_PORT=8123`n", (New-Object System.Text.ASCIIEncoding))
        $r = Invoke-Child -Script (Join-Path $root 'infra\start-inference.ps1') -Env @{ LLAMA_PORT = '8240' }
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-Argv $r.Stdout @('-m', (Join-Path $root 'infra\models\gemma-4-E2B-it-Q8_0.gguf'),
            '--mmproj', (Join-Path $root 'infra\models\mmproj-gemma-4-E2B-it-BF16.gguf'),
            '--host', '127.0.0.1', '--port', '8240', '--parallel', '4', '-c', '16384', '-ngl', '99', '--jinja')
    }

    Invoke-Case 'dotenv: .env wins over .env.example and adds new keys' {
        $root = New-LauncherReplica 'replica-dotenv-merge'
        [IO.File]::WriteAllText((Join-Path $root 'infra\.env.example'),
            "LLAMA_NGL=77`nLLAMA_PARALLEL=4`n", (New-Object System.Text.ASCIIEncoding))
        [IO.File]::WriteAllText((Join-Path $root 'infra\.env'),
            "LLAMA_PARALLEL=7`nLLAMA_PORT=8123`n", (New-Object System.Text.ASCIIEncoding))
        $r = Invoke-Child -Script (Join-Path $root 'infra\start-inference.ps1')
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-Argv $r.Stdout @('-m', (Join-Path $root 'infra\models\gemma-4-E2B-it-Q8_0.gguf'),
            '--mmproj', (Join-Path $root 'infra\models\mmproj-gemma-4-E2B-it-BF16.gguf'),
            '--host', '127.0.0.1', '--port', '8123', '--parallel', '7', '-c', '16384', '-ngl', '77', '--jinja')
    }

    Invoke-Case 'dotenv: parser handles quotes, comments, export and empty values' {
        $root = Join-Path $testRoot 'replica-dotenv-parse'
        New-Item -ItemType Directory -Force -Path (Join-Path $root 'infra') | Out-Null
        Copy-Item (Join-Path $repoRoot 'infra\env.ps1') (Join-Path $root 'infra\env.ps1')
        $envBody = (@(
            '# full-line comment',
            '   # indented comment',
            '',
            'DOTENV_ALPHA=plain',
            'export DOTENV_BETA=exported',
            'DOTENV_GAMMA="double quoted"',
            "DOTENV_DELTA='single quoted'",
            'DOTENV_EMPTY=',
            'DOTENV_SPACED =   spaced value  ',
            'BAD-KEY=nope',
            'NOEQUALS',
            '=nope'
        )) -join "`n"
        [IO.File]::WriteAllText((Join-Path $root 'infra\.env'), $envBody, (New-Object System.Text.ASCIIEncoding))
        $keys = 'DOTENV_ALPHA,DOTENV_BETA,DOTENV_GAMMA,DOTENV_DELTA,DOTENV_EMPTY,DOTENV_SPACED,BAD-KEY,NOEQUALS'
        $r = Invoke-Child -Script $envProbe -Arguments @((Join-Path $root 'infra\env.ps1'), $keys)
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        $vals = @{}
        foreach ($l in ($r.Stdout -split "`r?`n" | Where-Object { $_ -match '=' })) {
            $kv = $l -split '=', 2
            $vals[$kv[0]] = $kv[1]
        }
        Assert-Equal $vals['DOTENV_ALPHA'] 'plain' 'plain value'
        Assert-Equal $vals['DOTENV_BETA'] 'exported' 'export prefix'
        Assert-Equal $vals['DOTENV_GAMMA'] 'double quoted' 'double quotes stripped'
        Assert-Equal $vals['DOTENV_DELTA'] 'single quoted' 'single quotes stripped'
        Assert-Equal $vals['DOTENV_EMPTY'] '' 'empty value'
        Assert-Equal $vals['DOTENV_SPACED'] 'spaced value' 'whitespace trimmed'
        Assert-Equal $vals['BAD-KEY'] '' 'invalid key skipped'
        Assert-Equal $vals['NOEQUALS'] '' 'line without equals skipped'
    }

    Invoke-Case 'dotenv: replica without .env or .env.example uses built-in defaults' {
        $root = New-LauncherReplica 'replica-dotenv-none'
        $r = Invoke-Child -Script (Join-Path $root 'infra\start-inference.ps1')
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-Argv $r.Stdout @('-m', (Join-Path $root 'infra\models\gemma-4-E2B-it-Q8_0.gguf'),
            '--mmproj', (Join-Path $root 'infra\models\mmproj-gemma-4-E2B-it-BF16.gguf'),
            '--host', '127.0.0.1', '--port', '8080', '--parallel', '4', '-c', '16384', '-ngl', '99', '--jinja')
    }

    Invoke-Case 'dotenv: transcribe reads INFERENCE_URLS from infra/.env' {
        $root = Join-Path $testRoot 'replica-dotenv-transcribe'
        foreach ($sub in @('infra', 'scripts')) {
            New-Item -ItemType Directory -Force -Path (Join-Path $root $sub) | Out-Null
        }
        Copy-Item (Join-Path $repoRoot 'infra\env.ps1') (Join-Path $root 'infra\env.ps1')
        Copy-Item $transcribeScript (Join-Path $root 'scripts\transcribe-file.ps1')
        [IO.File]::WriteAllText((Join-Path $root 'infra\.env'), "INFERENCE_URLS=http://127.0.0.1:$port`n", (New-Object System.Text.ASCIIEncoding))
        $r = Invoke-Child -Script (Join-Path $root 'scripts\transcribe-file.ps1') -Arguments @($audioInput) `
            -Env @{ FFMPEG_ARGS_FILE = $ffmpegArgs; FFMPEG_SOURCE_WAV = $stubWavPath } `
            -Responder (New-ChatResponder -Status 200 -Body (New-ChatBody -Content "env test`nSpanish: dotenv"))
        Assert-Equal $r.ExitCode 0 "exit code (stderr: $($r.Stderr); stdout: $($r.Stdout))"
        Assert-True ($r.Stdout.Contains('Spanish: dotenv')) 'translation printed'
        Assert-Equal $r.Requests.Count 1 'one request'
        Assert-Equal $r.Requests[0].Path '/v1/chat/completions' 'request path'
    }
}
finally {
    $script:listener.Stop()
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ""
Write-Output "$($script:passed) passed, $($script:failed) failed"
if ($script:failed -gt 0) { exit 1 }
