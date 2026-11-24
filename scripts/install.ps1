# Installs or updates Roadie on Windows. In PowerShell:
#
#   irm https://github.com/cconstab/roadie/releases/latest/download/install.ps1 | iex
#
# It downloads the newest release for this machine, checks it against the
# release's checksums, puts it in %LOCALAPPDATA%\Roadie and adds that folder to
# your own PATH. Then it looks for the other things Roadie needs (Git for
# Windows and the GitHub tool gh) and offers to install what is missing with
# winget, showing the exact command first. Roadie itself needs no administrator rights.
#
#   $env:ROADIE_VERSION = "v1.2.3"        install that release instead of the newest
#   $env:ROADIE_INSTALL_DEPS = "yes"|"no" install missing tools without asking / never offer
#   $env:ROADIE_INSTALL_DIR, $env:ROADIE_NO_LINK, $env:ROADIE_BASE_URL   see below
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # PowerShell's own progress display slows a download many times over

$repo = 'cconstab/roadie'
$dest = if ($env:ROADIE_INSTALL_DIR) { $env:ROADIE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Roadie' }
$cpu = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
$file = "roadie-windows-$cpu.zip"
# ROADIE_BASE_URL: download from somewhere else (a mirror, or a local folder being tested).
$base = if ($env:ROADIE_BASE_URL) { $env:ROADIE_BASE_URL } elseif ($env:ROADIE_VERSION) { "https://github.com/$repo/releases/download/$($env:ROADIE_VERSION)" } else { "https://github.com/$repo/releases/latest/download" }

function Test-Tool($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Download one file. curl.exe comes with Windows 10 and later and draws a progress bar
# without slowing the download; without it the download is silent.
function Get-File($url, $out, [switch]$Progress) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (-not $curl) { Invoke-WebRequest -UseBasicParsing $url -OutFile $out; return }
  $show = if ($Progress) { '--progress-bar' } else { '-sS' }
  & $curl.Source -fL $show -o $out $url
  if ($LASTEXITCODE -ne 0) { throw "Could not download $url" }
}

function Confirm-Step($question) {
  if ($env:ROADIE_INSTALL_DEPS -eq 'yes') { return $true }
  if ($env:ROADIE_INSTALL_DEPS -eq 'no') { return $false }
  try { return (Read-Host "$question [y/N]") -match '^(y|yes)$' } catch { return $false }
}

function Test-Needs {
  Write-Host ''
  Write-Host 'Checking what else Roadie needs:'
  $wanted = @()
  if (-not (Test-Tool git)) { $wanted += @{ name = 'git'; id = 'Git.Git'; url = 'https://git-scm.com/download/win' } }
  if (-not (Test-Tool gh)) { $wanted += @{ name = 'gh'; id = 'GitHub.cli'; url = 'https://cli.github.com' } }
  $installedNow = $false
  foreach ($tool in $wanted) {
    $command = "winget install --id $($tool.id) -e --source winget"
    if (-not (Test-Tool winget)) {
      Write-Host "  missing: $($tool.name). Download it from $($tool.url)"
    } elseif (Confirm-Step "  $($tool.name) is missing. Install with:  $command  ?") {
      try { Invoke-Expression $command; $installedNow = $true } catch { Write-Host "  That did not work. Download it from $($tool.url)" }
    } else {
      Write-Host "  To install $($tool.name): $command"
    }
  }
  if ($installedNow) {
    Write-Host '  Newly installed tools are found by terminals opened from now on.'
    Write-Host '  In a new terminal, run:  gh auth login'
    return
  }
  if (Test-Tool git) {
    Write-Host '  git: found'
    if (-not (git config user.name) -or -not (git config user.email)) {
      Write-Host '  git does not know your name and email yet. Run:'
      Write-Host '    git config --global user.name "Your Name"'
      Write-Host '    git config --global user.email you@example.com'
    }
  }
  if (Test-Tool gh) {
    gh auth status --hostname github.com *> $null
    if ($LASTEXITCODE -eq 0) { Write-Host '  gh: found and signed in' }
    elseif ($env:ROADIE_INSTALL_DEPS -ne 'no' -and (Confirm-Step '  gh is not signed in to GitHub. Sign in now?')) { gh auth login --hostname github.com }
    else { Write-Host '  gh is not signed in to GitHub. Run:  gh auth login' }
  }
  if (-not $env:ANTHROPIC_API_KEY -and -not (Test-Tool ollama)) {
    Write-Host '  For the AI, set ANTHROPIC_API_KEY before starting Roadie, or install Ollama (https://ollama.com).'
  }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("roadie-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $file ..."
  Get-File "$base/$file" (Join-Path $tmp $file) -Progress
  Get-File "$base/SHA256SUMS" (Join-Path $tmp 'SHA256SUMS')

  $want = (Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match "\s$([regex]::Escape($file))$" }) -replace '\s.*$', ''
  $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $file)).Hash.ToLower()
  if (-not $want -or $want -ne $got) { throw "The download does not match the release's checksum, so nothing was installed." }

  Expand-Archive -Path (Join-Path $tmp $file) -DestinationPath $tmp
  if (-not (Test-Path (Join-Path $tmp 'roadie\roadie.cmd'))) { throw 'The download is not a Roadie release, so nothing was installed.' }

  # Swap the new copy in. The old one is kept until the new one is in place, and
  # put back if that fails. Sites and settings live in your home folder under "roadie" and are not touched.
  $old = "$dest.old.$PID"
  if (Test-Path $dest) {
    try { Move-Item $dest $old }
    catch { throw "Could not replace $dest. If Roadie is running, stop it and try again." }
  }
  try { Move-Item (Join-Path $tmp 'roadie') $dest }
  catch {
    if (Test-Path $old) { Move-Item $old $dest }
    throw "Could not put Roadie in $dest. The earlier copy, if any, is as it was."
  }
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host "Installed: $((Get-Content (Join-Path $dest 'VERSION'))[0]) in $dest"
$start = 'roadie'
if ($env:ROADIE_NO_LINK) {
  $start = Join-Path $dest 'roadie.cmd'
} else {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $dest)) {
    [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $dest) | Where-Object { $_ }) -join ';'), 'User')
  }
  # The saved PATH only reaches terminals opened later, so add it to this one as well.
  if (-not (($env:Path -split ';') -contains $dest)) { $env:Path = "$env:Path;$dest" }
  Write-Host '(The "roadie" command works in this window and in terminals opened from now on. Terminals that were already open need reopening.)'
}

try { Test-Needs } catch { Write-Host "  Could not finish checking: $_" }
Write-Host ''
Write-Host "Start Roadie with: $start"
