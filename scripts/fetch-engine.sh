#!/usr/bin/env bash
# Vendor the prebuilt llama.cpp `llama-server` engine (MIT-licensed) for the local
# platform into src-tauri/binaries/<target-triple>/, so the app can bundle it and
# spawn it on-device. CI runs this for every shipped target before `tauri build`.
#
#   scripts/fetch-engine.sh                 # latest llama.cpp release, host platform
#   LLAMA_BUILD=b9484 scripts/fetch-engine.sh   # pin a specific release tag
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_ROOT="$REPO_ROOT/src-tauri/binaries"

# Host → (llama.cpp release asset substring, Rust target triple).
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)  ASSET_GREP="ubuntu-x64";   TRIPLE="x86_64-unknown-linux-gnu" ;;
  Linux/aarch64) ASSET_GREP="ubuntu-arm64"; TRIPLE="aarch64-unknown-linux-gnu" ;;
  Darwin/arm64)  ASSET_GREP="macos-arm64";  TRIPLE="aarch64-apple-darwin" ;;
  Darwin/x86_64) ASSET_GREP="macos-x64";    TRIPLE="x86_64-apple-darwin" ;;
  *) echo "Unsupported host $(uname -s)/$(uname -m) — vendor the matching llama.cpp release by hand." >&2; exit 1 ;;
esac

API="https://api.github.com/repos/ggml-org/llama.cpp/releases"
REL="$API/latest"; [ -n "${LLAMA_BUILD:-}" ] && REL="$API/tags/$LLAMA_BUILD"

read -r TAG URL < <(curl -fsSL --max-time 30 "$REL" | python3 -c "
import sys, json
d = json.load(sys.stdin)
g = '$ASSET_GREP'
bad = ('vulkan', 'cuda', 'sycl', 'hip', 'musa')  # CPU build for a guaranteed baseline
a = [x for x in d['assets'] if g in x['name'].lower() and not any(k in x['name'].lower() for k in bad)]
print(d.get('tag_name', '?'), a[0]['browser_download_url'] if a else 'NONE')
")
[ "$URL" = "NONE" ] && { echo "No CPU asset matching '$ASSET_GREP' in llama.cpp $TAG" >&2; exit 1; }

echo "llama.cpp $TAG → $TRIPLE  ($(basename "$URL"))"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/x"
# Linux releases ship .tar.gz; macOS/Windows ship .zip — handle both.
case "$URL" in
  *.tar.gz|*.tgz)
    curl -fsSL --max-time 300 "$URL" -o "$tmp/engine.tgz"
    tar -xzf "$tmp/engine.tgz" -C "$tmp/x" ;;
  *)
    curl -fsSL --max-time 300 "$URL" -o "$tmp/engine.zip"
    python3 -c "import zipfile; zipfile.ZipFile('$tmp/engine.zip').extractall('$tmp/x')" ;;
esac

bin="$(find "$tmp/x" -type f -name 'llama-server' | head -1)"
[ -z "$bin" ] && { echo "llama-server not found in the archive" >&2; exit 1; }

dest="$DEST_ROOT/$TRIPLE"
rm -rf "$dest"; mkdir -p "$dest"
cp -a "$(dirname "$bin")/." "$dest/"   # binary + its shared libs (rpath=\$ORIGIN finds them)
chmod +x "$dest/llama-server"
printf '%s\n' "$TAG" > "$dest/.llama-build"
echo "vendored → src-tauri/binaries/$TRIPLE/ ($(du -sh "$dest" | cut -f1))"
