#!/bin/sh
# Installs Roadie on macOS or Linux:
#
#   curl -fsSL https://github.com/cconstab/roadie/releases/latest/download/install.sh | sh
#
# It downloads the newest release for this machine, checks it against the
# release's checksums, puts it in ~/.local/share/roadie and links the "roadie"
# command into ~/.local/bin. Nothing needs administrator rights.
# ROADIE_VERSION=v1.2.3 installs that release instead of the newest.
set -eu

REPO="cconstab/roadie"
DEST="${ROADIE_INSTALL_DIR:-$HOME/.local/share/roadie}"
BIN="${ROADIE_BIN_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) echo "This installer is for macOS and Linux. On Windows use install.ps1 (see the README)." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) cpu=arm64 ;;
  x86_64|amd64) cpu=x64 ;;
  *) echo "Roadie has no download for this kind of processor: $(uname -m)" >&2; exit 1 ;;
esac
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  echo "Roadie's downloads do not cover this Linux (musl, such as Alpine). Run it from source instead: see the README." >&2
  exit 1
fi

file="roadie-$os-$cpu.tar.gz"
# ROADIE_BASE_URL: download from somewhere else (a mirror, or a local folder being tested).
if [ -n "${ROADIE_BASE_URL:-}" ]; then base="$ROADIE_BASE_URL"
elif [ -n "${ROADIE_VERSION:-}" ]; then base="https://github.com/$REPO/releases/download/$ROADIE_VERSION"
else base="https://github.com/$REPO/releases/latest/download"; fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $file ..."
curl -fL --progress-bar -o "$tmp/$file" "$base/$file"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"

want=$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/$file" | awk '{ print $1 }')
else got=$(shasum -a 256 "$tmp/$file" | awk '{ print $1 }'); fi
if [ -z "$want" ] || [ "$want" != "$got" ]; then
  echo "The download does not match the release's checksum, so nothing was installed." >&2
  exit 1
fi

tar -xzf "$tmp/$file" -C "$tmp"
# Replace any earlier install. Sites and settings live in ~/roadie and are not touched.
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")" "$BIN"
mv "$tmp/roadie" "$DEST"
ln -sf "$DEST/roadie" "$BIN/roadie"

echo "Installed: $(head -1 "$DEST/VERSION") in $DEST"
case ":$PATH:" in
  *":$BIN:"*) echo "Start it with: roadie" ;;
  *) echo "Start it with: $BIN/roadie"
     echo "(To type just \"roadie\", add $BIN to your PATH.)" ;;
esac
echo "Roadie also needs git and the GitHub tool gh, signed in. It checks both when it starts."
