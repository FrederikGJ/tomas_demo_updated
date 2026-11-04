#!/usr/bin/env bash
# Launch k9s with this project's config (skin, aliases, hotkeys, plugins) from scripts/k9s/.
# If k9s isn't on PATH, it's installed locally into ~/.local/bin first (no admin rights needed).
#
# Usage: make k9s                      (or: bash scripts/k9s.sh [extra k9s flags])
set -euo pipefail

K9S_VERSION="${K9S_VERSION:-v0.51.0}"
K9S_BIN_DIR="${K9S_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="$(cd "$(dirname "$0")" && pwd)/k9s"

export PATH="$K9S_BIN_DIR:$PATH"

is_windows() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

install_k9s() {
  local os arch ext asset base_url expected actual

  case "$(uname -s)" in
    Linux*)  os=Linux;  ext=tar.gz ;;
    Darwin*) os=Darwin; ext=tar.gz ;;
    MINGW*|MSYS*|CYGWIN*) os=Windows; ext=zip ;;
    *) echo "❌ Unsupported OS '$(uname -s)'. Install k9s manually: https://k9scli.io/topics/install/"; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "❌ Unsupported CPU '$(uname -m)'. Install k9s manually: https://k9scli.io/topics/install/"; exit 1 ;;
  esac

  asset="k9s_${os}_${arch}.${ext}"
  base_url="https://github.com/derailed/k9s/releases/download/${K9S_VERSION}"
  K9S_TMP="$(mktemp -d)"
  trap 'rm -rf "$K9S_TMP"' EXIT

  echo "⬇️  Downloading k9s ${K9S_VERSION} (${os}/${arch})..."
  curl -fsSL -o "$K9S_TMP/$asset" "$base_url/$asset"
  curl -fsSL -o "$K9S_TMP/checksums.sha256" "$base_url/checksums.sha256"

  expected="$(awk -v f="$asset" '$2 == f { print $1 }' "$K9S_TMP/checksums.sha256")"
  if command -v sha256sum &> /dev/null; then
    actual="$(sha256sum "$K9S_TMP/$asset" | awk '{ print $1 }')"
  else
    actual="$(shasum -a 256 "$K9S_TMP/$asset" | awk '{ print $1 }')"
  fi
  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    echo "❌ Checksum verification of $asset failed. Aborting."
    exit 1
  fi

  mkdir -p "$K9S_BIN_DIR"
  if [[ "$ext" == "zip" ]]; then
    powershell.exe -NoProfile -Command \
      "Expand-Archive -LiteralPath '$(cygpath -w "$K9S_TMP/$asset")' -DestinationPath '$(cygpath -w "$K9S_TMP")' -Force"
    cp "$K9S_TMP/k9s.exe" "$K9S_BIN_DIR/k9s.exe"
  else
    tar -xzf "$K9S_TMP/$asset" -C "$K9S_TMP" k9s
    cp "$K9S_TMP/k9s" "$K9S_BIN_DIR/k9s"
    chmod +x "$K9S_BIN_DIR/k9s"
  fi
  rm -rf "$K9S_TMP"
  trap - EXIT
  echo "✅ k9s ${K9S_VERSION} installed in $K9S_BIN_DIR"
}

if command -v k9s &> /dev/null; then
  echo "✅ k9s is already installed ($(command -v k9s))."
else
  echo "⚠️ k9s not found! Installing k9s locally..."
  install_k9s
fi

# Point k9s at the project config. Native Windows binaries need a Windows path.
if is_windows; then
  K9S_CONFIG_DIR="$(cygpath -w "$CONFIG_DIR")"
else
  K9S_CONFIG_DIR="$CONFIG_DIR"
fi
export K9S_CONFIG_DIR

echo "🚀 Starting k9s with project config from scripts/k9s/ ..."

# The classic Git Bash window (mintty) can't host full-screen Windows console apps directly,
# so go through winpty there. Windows Terminal / VS Code terminals don't need this.
if is_windows && [[ "${TERM_PROGRAM:-}" == "mintty" ]] && command -v winpty &> /dev/null; then
  exec winpty k9s --namespace default "$@"
fi
exec k9s --namespace default "$@"
