#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ALLTV-MCP'),
    [string]$ConfigPath,
    [switch]$SkipClaudeInstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '1.0.2'
$work = Join-Path ([IO.Path]::GetTempPath()) ('alltv-installer-' + [Guid]::NewGuid().ToString('N'))
$installLock = $null

function Get-Download([string]$Url, [string]$Destination) {
    if (-not $Url.StartsWith('https://', [StringComparison]::Ordinal)) {
        throw 'Installer downloads must use HTTPS.'
    }
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Assert-Hash([string]$Path, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ine $Expected) {
        throw "Download checksum mismatch: $Path. No downloaded program was run."
    }
}

function Get-ClaudeInstallation {
    $package = Get-AppxPackage -Name Claude | Select-Object -First 1
    if ($package) { return $package }
    foreach ($relative in @('AnthropicClaude\Claude.exe', 'Programs\Claude\Claude.exe', 'Claude\Claude.exe')) {
        if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA $relative) -PathType Leaf) {
            return [PSCustomObject]@{ PackageFamilyName = $null }
        }
    }
    return $null
}

function Read-ConsentAnswer([string]$Prompt) {
    if ([Console]::IsInputRedirected) {
        Write-Host $Prompt
        return [Console]::ReadLine()
    }
    Read-Host $Prompt
}

function Confirm-YesNo([string]$Question) {
    while ($true) {
        $answer = Read-ConsentAnswer "$Question (yes/no)"
        if ($null -eq $answer) { throw 'No answer received. Run the installer in an interactive PowerShell window.' }
        switch ($answer.Trim().ToLowerInvariant()) {
            { $_ -in 'yes', 'y' } { return $true }
            { $_ -in 'no', 'n' } { return $false }
            default { Write-Host 'Please answer yes or no.' }
        }
    }
}

function Get-ClaudeProcesses {
    Get-Process | Where-Object { $_.ProcessName -eq 'Claude' -or $_.ProcessName -like 'Claude Helper*' }
}

function Stop-ClaudeWithConsent {
    $processes = @(Get-ClaudeProcesses)
    if (-not $processes.Count) { return }
    if (-not (Confirm-YesNo 'Claude is running. Stop all Claude processes? Unsaved work may be lost.')) {
        throw 'Installation cancelled. Quit Claude Desktop before running this installer again.'
    }
    foreach ($process in $processes) {
        if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
        }
    }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (-not @(Get-ClaudeProcesses).Count) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'Some Claude processes are still running. Quit them and rerun the installer.'
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'Run this installer on Windows 10/11 (64-bit).' }
    if ($SkipClaudeInstall -and -not $ConfigPath) {
        throw '-SkipClaudeInstall is for isolated staging and requires an explicit -ConfigPath.'
    }
    $claude = $null
    if (-not $SkipClaudeInstall) {
        Stop-ClaudeWithConsent
        $claude = Get-ClaudeInstallation
        if (-not $claude -and -not (Confirm-YesNo 'Claude Desktop is not installed. Install it now?')) {
            throw 'This install requires Claude Desktop'
        }
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    $processor = $env:PROCESSOR_ARCHITEW6432
    if (-not $processor) { $processor = $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($processor.ToUpperInvariant()) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        default { throw "Unsupported Windows architecture: $processor" }
    }
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    $installLock = [IO.File]::Open((Join-Path $InstallRoot '.setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    New-Item -ItemType Directory -Path $work | Out-Null
    $source = $PSScriptRoot
    if (-not (Test-Path -LiteralPath (Join-Path $source 'installer.json') -PathType Leaf)) {
        Write-Host "Downloading ALLTV installer v$version..."
        $archive = Join-Path $work 'source.zip'
        Get-Download "https://github.com/adobe-dss-aep/tps_tv_alltv_local/archive/refs/tags/v$version.zip" $archive
        Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $work 'source')
        $source = Join-Path $work "source\tps_tv_alltv_local-$version"
    }
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $source 'installer.json') | ConvertFrom-Json
    if ($manifest.version -ne $version) { throw 'Installer and bundle versions do not match.' }
    $nodeName = "node-v$($manifest.node.version)-win-$arch"
    $runtime = Join-Path $InstallRoot "runtimes\$nodeName"
    $node = Join-Path $runtime 'node.exe'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
        Write-Host "Downloading private Node.js $($manifest.node.version) ($arch)..."
        $archive = Join-Path $work 'node.zip'
        Get-Download "https://nodejs.org/dist/v$($manifest.node.version)/$nodeName.zip" $archive
        Assert-Hash $archive $manifest.node.sha256."win-$arch"
        Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $work 'node')
        New-Item -ItemType Directory -Path (Split-Path $runtime) -Force | Out-Null
        Move-Item -LiteralPath (Join-Path $work "node\$nodeName") -Destination $runtime
    }
    $actualVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or $actualVersion -ne "v$($manifest.node.version)") {
        throw 'The private Node.js runtime is not the expected version.'
    }
    if (-not $SkipClaudeInstall) {
        if (-not $claude) {
            Write-Host 'Installing Claude Desktop for this Windows user...'
            $installer = Join-Path $work 'ClaudeSetup.exe'
            $download = $manifest.claude.windows.$arch
            Get-Download $download.url $installer
            Assert-Hash $installer $download.sha256
            $signature = Get-AuthenticodeSignature -LiteralPath $installer
            if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Anthropic') {
                throw 'Claude installer signature is invalid or is not from Anthropic.'
            }
            $process = Start-Process -FilePath $installer -ArgumentList '--silent' -Wait -PassThru
            if ($process.ExitCode -ne 0) {
                throw "Claude setup exited with $($process.ExitCode). Finish any requested setup/restart and rerun ALLTV setup."
            }
            $claude = Get-ClaudeInstallation
            if (-not $claude) { throw 'Claude setup finished, but Claude Desktop could not be found. Install it from https://claude.com/download and retry.' }
        }
        Stop-ClaudeWithConsent
    }
    if (-not $ConfigPath) {
        if ($claude.PackageFamilyName) {
            $ConfigPath = Join-Path $env:LOCALAPPDATA "Packages\$($claude.PackageFamilyName)\LocalCache\Roaming\Claude\claude_desktop_config.json"
        } else {
            $ConfigPath = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
        }
    }
    $ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
    $deployment = Join-Path $InstallRoot ("versions\$version-" + [Guid]::NewGuid().ToString('N'))
    $launcher = Join-Path $deployment 'launcher'
    New-Item -ItemType Directory -Path (Join-Path $launcher 'pages') -Force | Out-Null
    foreach ($file in @('launch.mjs', 'upstream.mjs', 'on-demand.mjs', 'coordination.mjs', 'loader.mjs', 'catalog.json', 'package.json', 'package-lock.json', 'pages\completed.html')) {
        Copy-Item -LiteralPath (Join-Path $source "launcher\$file") -Destination (Join-Path $launcher $file)
    }
    Write-Host 'Installing locked ALLTV dependencies (no package install scripts)...'
    & $node (Join-Path $runtime 'node_modules\npm\bin\npm-cli.js') ci --prefix $launcher --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
    if ($LASTEXITCODE -ne 0) { throw 'ALLTV dependencies could not be installed. Existing Claude settings are unchanged.' }
    $entry = Join-Path $launcher 'launch.mjs'
    & $node (Join-Path $source 'tools\verify.mjs') $node $entry
    if ($LASTEXITCODE -ne 0) { throw 'The new launcher failed its offline verification. Existing Claude settings are unchanged.' }
    if (-not $SkipClaudeInstall) { Stop-ClaudeWithConsent }
    & $node (Join-Path $source 'tools\configure.mjs') --config $ConfigPath --runtime $node --launcher $entry
    if ($LASTEXITCODE -ne 0) { throw 'Claude configuration could not be updated.' }
    Write-Host "ALLTV installed successfully at $deployment"
    Write-Host "Claude settings: $ConfigPath"
    Write-Host 'Open Claude Desktop and start a new chat. Run /my-tv-opportunities or request an ALLTV action.'
    Write-Host 'No ALLTV sign-in was performed. Sign-in opens in your default browser only when an action needs it.'
} catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    if ($installLock) { $installLock.Dispose() }
    if (Test-Path -LiteralPath $work -PathType Container) {
        Remove-Item -LiteralPath $work -Recurse -Force
    }
}
