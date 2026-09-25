# Shared dotenv loader for the native Windows scripts. Dot-source this file,
# then call Import-BabbageEnv before reading $env: variables.
# Precedence: process environment > infra/.env > infra/.env.example.
$script:BabbageDotenvInfraDir = $PSScriptRoot

function Import-BabbageDotenvFile {
    param([string]$Path)
    $values = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $values }
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        $line = $line.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
        if ($line -match '^export\s+(.+)$') { $line = $Matches[1].TrimStart() }
        $eq = $line.IndexOf('=')
        if ($eq -lt 0) { continue }
        $key = $line.Substring(0, $eq).Trim()
        if ($key -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
        $value = $line.Substring($eq + 1).Trim()
        if ($value.Length -ge 2) {
            $quote = $value[0]
            if (($quote -eq "'" -or $quote -eq '"') -and $value[$value.Length - 1] -eq $quote) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $values[$key] = $value
    }
    return $values
}

function Import-BabbageEnv {
    $merged = Import-BabbageDotenvFile (Join-Path $script:BabbageDotenvInfraDir '.env.example')
    foreach ($entry in (Import-BabbageDotenvFile (Join-Path $script:BabbageDotenvInfraDir '.env')).GetEnumerator()) {
        $merged[$entry.Key] = $entry.Value
    }
    foreach ($key in $merged.Keys) {
        if ($null -ne [Environment]::GetEnvironmentVariable($key, 'Process')) { continue }
        [Environment]::SetEnvironmentVariable($key, $merged[$key], 'Process')
    }
}
