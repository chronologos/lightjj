#!/bin/sh
# lightjj installer — detects OS/arch, downloads the latest release binary.
# Usage: curl -fsSL https://raw.githubusercontent.com/chronologos/lightjj/main/install.sh | sh

set -e

REPO="chronologos/lightjj"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case "$OS" in
        darwin) OS="macos" ;;
        linux)  OS="linux" ;;
        *)      echo "Unsupported OS: $OS" >&2; exit 1 ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x86_64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
    esac

    # macOS: only arm64 binary available
    if [ "$OS" = "macos" ] && [ "$ARCH" != "arm64" ]; then
        echo "Intel macOS: no prebuilt binary — build from source (see README 'Building from source')" >&2
        exit 1
    fi

    BINARY="lightjj-${OS}-${ARCH}"
}

download() {
    URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"
    echo "Downloading ${BINARY}..."
    mkdir -p "$INSTALL_DIR"
    TMP=$(mktemp "${INSTALL_DIR}/.lightjj.XXXXXX")
    trap 'rm -f "$TMP"' EXIT INT TERM HUP
    curl -fsSL "$URL" -o "$TMP"
    chmod +x "$TMP"
    mv "$TMP" "${INSTALL_DIR}/lightjj"
    trap - EXIT INT TERM HUP
}

sign_macos() {
    if [ "$OS" = "macos" ]; then
        echo "Signing for macOS Gatekeeper..."
        xattr -cr "${INSTALL_DIR}/lightjj"
        codesign -s - -f "${INSTALL_DIR}/lightjj"
    fi
}

verify_path() {
    case ":$PATH:" in
        *":${INSTALL_DIR}:"*) ;;
        *) echo "Note: add ${INSTALL_DIR} to your \$PATH" ;;
    esac
}

detect_platform
download
sign_macos
verify_path

VERSION=$("${INSTALL_DIR}/lightjj" --version 2>/dev/null || echo "unknown")
echo "Installed lightjj ${VERSION} to ${INSTALL_DIR}/lightjj"
