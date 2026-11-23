# Installs Roadie on Windows. In PowerShell:
#
#   irm https://github.com/cconstab/roadie/releases/latest/download/install.ps1 | iex
#
# It downloads the newest release for this machine, checks it against the
# release's checksums, puts it in %LOCALAPPDATA%\Roadie and adds that folder to
# your own PATH. Nothing needs administrator rights.
# $env:ROADIE_VERSION = "v1.2.3" installs that release instead of the newest.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'cconstab/roadie'
$dest = if ($env:ROADIE_INSTALL_DIR) { $env:ROADIE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Roadie' }
$cpu = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
$file = "roadie-windows-$cpu.zip"
$base = if ($env:ROADIE_BASE_URL) { $env:ROADIE_BASE_URL } elseif ($env:ROADIE_VERSION) { "https://github.com/$repo/releases/download/$($env:ROADIE_VERSION)" } else { "https://github.com/$repo/releases/latest/download" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("roadie-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $file ..."
  Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile (Join-Path $tmp $file)
  Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')

  $want = (Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match "\s$([regex]::Escape($file))$" }) -replace '\s.*$', ''
  $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $file)).Hash.ToLower()
  if (-not $want -or $want -ne $got) { throw "The download does not match the release's checksum, so nothing was installed." }

  Expand-Archive -Path (Join-Path $tmp $file) -DestinationPath $tmp
  # Replace any earlier install. Sites and settings live in your home folder under "roadie" and are not touched.
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item (Join-Path $tmp 'roadie') $dest
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $dest)) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath, $dest) -ne '' -join ';'), 'User')
  $added = $true
}
Write-Host "Installed: $((Get-Content (Join-Path $dest 'VERSION'))[0]) in $dest"
if ($added) { Write-Host 'Open a new terminal, then start it with: roadie' } else { Write-Host 'Start it with: roadie' }
Write-Host 'Roadie also needs Git for Windows and the GitHub tool gh, signed in. It checks both when it starts.'
