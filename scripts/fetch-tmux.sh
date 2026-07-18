#!/usr/bin/env bash
# Vendor the prebuilt tmux sidecar (github.com/tmux/tmux-builds — tmux ISC,
# libevent BSD-3, ncurses MIT/X11, utf8proc MIT; the license texts land in
# binaries/tmux-licenses/ and ship as a bundle resource) into
# client/desktop/binaries/ under Tauri's externalBin naming, plus the lipo'd
# universal binary the release build expects. The app bundles it as
# Contents/MacOS/tmux and skill-term falls back to it when the host has no
# tmux (fresh Macs never do). macOS-only by design: tmux has no Windows port,
# and Linux users get a current tmux from their package manager.
#
# Pinned + checksummed — bump TAG and the three SHAs together.
set -euo pipefail

[ "$(uname -s)" = "Darwin" ] || { echo "fetch-tmux: not macOS — nothing to vendor."; exit 0; }

TAG="v3.7b"
VER="${TAG#v}"
BASE="https://github.com/tmux/tmux-builds/releases/download/$TAG"
SHA_ARM64="ee66dbcd49613eb41dc6b2f3abc5cd39d9135d67b7dfef1fdb180a3dbdc01f1e"
SHA_X86="ea90f0d8e8998cf5a3a5921e985685844a13a7c3b5779f36870bd98b7f147fe6"
SHA_LIC="aeeb2143751b8fb1defcf93224b85dcf84ce68c3a9d7aed4945b9552c57b311f"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/client/desktop/binaries"
STAMP="$DEST/.tmux-$TAG.done"

if [ -f "$STAMP" ] \
  && [ -f "$DEST/tmux-aarch64-apple-darwin" ] \
  && [ -f "$DEST/tmux-x86_64-apple-darwin" ] \
  && [ -f "$DEST/tmux-universal-apple-darwin" ] \
  && [ -d "$DEST/tmux-licenses" ]; then
  echo "fetch-tmux: $TAG already vendored."
  exit 0
fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# fetch <asset> <sha256> — download to $tmp and hard-fail on a checksum mismatch.
fetch() {
  curl -fsSL --retry 3 --retry-all-errors --max-time 120 -o "$tmp/$1" "$BASE/$1"
  echo "$2  $tmp/$1" | shasum -a 256 -c - >/dev/null
}

fetch "tmux-$VER-macos-arm64.tar.gz" "$SHA_ARM64"
fetch "tmux-$VER-macos-x86_64.tar.gz" "$SHA_X86"
fetch "LICENSES.tar.gz" "$SHA_LIC"

mkdir -p "$tmp/arm64" "$tmp/x86_64" "$DEST" "$DEST/tmux-licenses"
tar xzf "$tmp/tmux-$VER-macos-arm64.tar.gz" -C "$tmp/arm64"
tar xzf "$tmp/tmux-$VER-macos-x86_64.tar.gz" -C "$tmp/x86_64"
tar xzf "$tmp/LICENSES.tar.gz" -C "$DEST/tmux-licenses"

install -m 755 "$tmp/arm64/tmux" "$DEST/tmux-aarch64-apple-darwin"
install -m 755 "$tmp/x86_64/tmux" "$DEST/tmux-x86_64-apple-darwin"
lipo -create "$tmp/arm64/tmux" "$tmp/x86_64/tmux" -output "$DEST/tmux-universal-apple-darwin"
chmod 755 "$DEST/tmux-universal-apple-darwin"

touch "$STAMP"
echo "fetch-tmux: vendored tmux $TAG (arm64 + x86_64 + universal) into $DEST"
