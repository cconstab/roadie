#!/bin/sh
# Installs or updates Roadie on macOS or Linux:
#
#   curl -fsSL https://github.com/cconstab/roadie/releases/latest/download/install.sh | sh
#
# It downloads the newest release for this machine, checks it against the
# release's checksums, puts it in ~/.local/share/roadie and links the "roadie"
# command into ~/.local/bin. Then it looks for the other things Roadie needs
# (git and the GitHub tool gh) and offers to install what is missing, showing
# the exact command first. Roadie itself needs no administrator rights.
#
#   sh install.sh --check        only look for what Roadie needs; install nothing of Roadie
#
#   ROADIE_VERSION=v1.2.3        install that release instead of the newest
#   ROADIE_INSTALL_DEPS=yes|no   install missing tools without asking / never offer
#   ROADIE_INSTALL_DIR, ROADIE_BIN_DIR, ROADIE_NO_LINK=1, ROADIE_BASE_URL   see below
set -eu

REPO="cconstab/roadie"
DEST="${ROADIE_INSTALL_DIR:-$HOME/.local/share/roadie}"
BIN="${ROADIE_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
can_ask() { [ "${ROADIE_INSTALL_DEPS:-ask}" = ask ] && (: </dev/tty) 2>/dev/null; }

# Ask a yes/no question on the terminal, even when this script arrives through a pipe.
ask() {
  case "${ROADIE_INSTALL_DEPS:-ask}" in yes) return 0 ;; no) return 1 ;; esac
  can_ask || return 1
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r reply </dev/tty || return 1
  case "$reply" in y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
}

# The command that would install the named tools here, or nothing if there is no known way.
install_command() {
  if have brew; then echo "brew install $*"
  elif have apt-get; then echo "sudo apt-get update && sudo apt-get install -y $*"
  elif have dnf; then echo "sudo dnf install -y $*"
  elif have pacman; then echo "sudo pacman -S --needed --noconfirm $(echo "$*" | sed 's/\bgh\b/github-cli/')"
  elif have zypper; then echo "sudo zypper install -y $*"
  fi
}

check_needs() {
  say ""
  say "Checking what else Roadie needs:"
  missing=""
  have git || missing="git"
  have gh || missing="${missing:+$missing }gh"

  if [ -n "$missing" ]; then
    say "  missing: $missing"
    cmd=$(install_command $missing)
    if [ -n "$cmd" ]; then
      if ask "  Install with:  $cmd  ?"; then
        say "  Running: $cmd"
        sh -c "$cmd" </dev/null || say "  That did not work. Install $missing yourself, then start Roadie."
      else
        say "  To install: $cmd"
      fi
    elif [ "$(uname -s)" = Darwin ]; then
      case " $missing " in *" git "*) say "  git: run  xcode-select --install  (Apple's developer tools)" ;; esac
      case " $missing " in *" gh "*) say "  gh:  download it from https://cli.github.com  (or install Homebrew, then: brew install gh)" ;; esac
    else
      say "  Install git from your system's packages, and gh from https://cli.github.com"
    fi
  fi

  if have git; then
    say "  git: found"
    if [ -z "$(git config user.name 2>/dev/null)" ] || [ -z "$(git config user.email 2>/dev/null)" ]; then
      say "  git does not know your name and email yet. Run:"
      say "    git config --global user.name \"Your Name\""
      say "    git config --global user.email you@example.com"
    fi
  fi
  if have gh; then
    if gh auth status --hostname github.com >/dev/null 2>&1; then
      say "  gh: found and signed in"
    elif can_ask && ask "  gh is not signed in to GitHub. Sign in now?"; then
      gh auth login --hostname github.com </dev/tty || say "  Sign-in did not finish. Run  gh auth login  later."
    else
      say "  gh is not signed in to GitHub. Run:  gh auth login"
    fi
  fi
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && ! have ollama; then
    say "  For the AI, set ANTHROPIC_API_KEY before starting Roadie, or install Ollama (https://ollama.com)."
  fi
}

if [ "${1:-}" = "--check" ]; then check_needs; exit 0; fi

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) say "This installer is for macOS and Linux. On Windows use install.ps1 (see the README)." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) cpu=arm64 ;;
  x86_64|amd64) cpu=x64 ;;
  *) say "Roadie has no download for this kind of processor: $(uname -m)" >&2; exit 1 ;;
esac
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  say "Roadie's downloads do not cover this Linux (musl, such as Alpine). Run it from source instead: see the README." >&2
  exit 1
fi
for tool in curl tar; do
  have "$tool" || { say "This installer needs $tool, which is not installed." >&2; exit 1; }
done

file="roadie-$os-$cpu.tar.gz"
# ROADIE_BASE_URL: download from somewhere else (a mirror, or a local folder being tested).
if [ -n "${ROADIE_BASE_URL:-}" ]; then base="$ROADIE_BASE_URL"
elif [ -n "${ROADIE_VERSION:-}" ]; then base="https://github.com/$REPO/releases/download/$ROADIE_VERSION"
else base="https://github.com/$REPO/releases/latest/download"; fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
say "Downloading $file ..."
curl -fL --progress-bar -o "$tmp/$file" "$base/$file"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"

want=$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
if have sha256sum; then got=$(sha256sum "$tmp/$file" | awk '{ print $1 }')
else got=$(shasum -a 256 "$tmp/$file" | awk '{ print $1 }'); fi
if [ -z "$want" ] || [ "$want" != "$got" ]; then
  say "The download does not match the release's checksum, so nothing was installed." >&2
  exit 1
fi

tar -xzf "$tmp/$file" -C "$tmp"
[ -x "$tmp/roadie/roadie" ] || { say "The download is not a Roadie release, so nothing was installed." >&2; exit 1; }

# Swap the new copy in. The old one is kept until the new one is in place, and
# put back if that fails. Sites and settings live in ~/roadie and are not touched.
mkdir -p "$(dirname "$DEST")"
old="$DEST.old.$$"
if [ -e "$DEST" ]; then mv "$DEST" "$old"; fi
if ! mv "$tmp/roadie" "$DEST"; then
  [ -e "$old" ] && mv "$old" "$DEST"
  say "Could not put Roadie in $DEST. The earlier copy, if any, is as it was." >&2
  exit 1
fi
rm -rf "$old"

say "Installed: $(head -1 "$DEST/VERSION") in $DEST"
if [ -z "${ROADIE_NO_LINK:-}" ]; then
  mkdir -p "$BIN"
  ln -sf "$DEST/roadie" "$BIN/roadie"
  case ":$PATH:" in
    *":$BIN:"*) start="roadie" ;;
    *) start="$BIN/roadie"; say "(To type just \"roadie\", add $BIN to your PATH.)" ;;
  esac
else
  start="$DEST/roadie"
fi

check_needs || true
say ""
say "Start Roadie with: $start"
