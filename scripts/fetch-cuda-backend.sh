#!/usr/bin/env bash
# Vendor the ggml CUDA backend "bridge" (libggml-cuda.so / ggml-cuda.dll) into
# src-tauri/binaries/<target-triple>/, next to the CPU engine that fetch-engine.sh
# vendors. It MUST come from the same llama.cpp build as that engine — ggml
# backends are only ABI-compatible within one build — so the build tag is read
# from the engine's .llama-build (or $LLAMA_BUILD).
#
# We deliberately do NOT ship the CUDA runtime (cuBLAS/cudart, ~1 GB): the bridge
# links the *user's own* CUDA install at load time. Driver + CUDA runtime present
# → GPU; absent → the backend fails to load (non-fatal) and llama-server runs on
# CPU. See crates/skill-core/src/gpu.rs.
#
# Linux : built from source in a CUDA Docker image (there is no official Linux
#         CUDA prebuilt). Needs Docker; no GPU required to compile.
# Windows: extracted from the official llama.cpp win-cuda release (a prebuilt
#         exists). The cuda runtime (cudart/cublas DLLs) is the user's, not ours.
# macOS : nothing — the macOS engine has Metal compiled in.
#
#   scripts/fetch-cuda-backend.sh                 # uses the vendored engine's tag
#   LLAMA_BUILD=b9486 scripts/fetch-cuda-backend.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_ROOT="$REPO_ROOT/src-tauri/binaries"

# The bridge must match the CPU engine's build exactly. Prefer an explicit
# $LLAMA_BUILD; otherwise read the tag fetch-engine.sh wrote next to the engine.
LLAMA_BUILD="${LLAMA_BUILD:-$(cat "$DEST_ROOT"/*/.llama-build 2>/dev/null | head -1 || true)}"
[ -z "${LLAMA_BUILD:-}" ] && { echo "No build tag: set LLAMA_BUILD or run scripts/fetch-engine.sh first." >&2; exit 1; }

# CUDA compute arches to compile for: Turing(75) Ampere(80,86) Ada(89) Hopper(90)
# Blackwell(120). Pre-Turing GPUs fall back to CPU. sm_120 requires CUDA >= 12.8.
CUDA_ARCHS="${CUDA_ARCHS:-75;80;86;89;90;120}"
CUDA_IMAGE="${CUDA_IMAGE:-nvidia/cuda:12.8.0-devel-ubuntu22.04}"

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)                              TRIPLE="x86_64-unknown-linux-gnu"; LIB="libggml-cuda.so"; MODE="build" ;;
  MINGW*/x86_64|MSYS*/x86_64|CYGWIN*/x86_64) TRIPLE="x86_64-pc-windows-msvc";   LIB="ggml-cuda.dll";   MODE="fetch"; ASSET_GREP="win-cuda-12.4-x64" ;;
  Darwin/*)                                  echo "macOS uses built-in Metal; no CUDA bridge needed."; exit 0 ;;
  *)                                         echo "No CUDA bridge for $(uname -s)/$(uname -m) (CPU only)."; exit 0 ;;
esac

dest="$DEST_ROOT/$TRIPLE"
mkdir -p "$dest"

if [ "$MODE" = "build" ]; then
  command -v docker >/dev/null 2>&1 || { echo "Docker is required to build the Linux CUDA bridge." >&2; exit 1; }
  echo "Building $LIB from llama.cpp $LLAMA_BUILD (arches $CUDA_ARCHS) in $CUDA_IMAGE — this is slow."
  docker run --rm -v "$dest:/out" "$CUDA_IMAGE" bash -euo pipefail -c "
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq git cmake ninja-build >/dev/null
    git clone --depth 1 --branch '$LLAMA_BUILD' https://github.com/ggml-org/llama.cpp /llama
    cd /llama
    cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DGGML_CUDA=ON -DGGML_BACKEND_DL=ON -DGGML_NATIVE=OFF -DGGML_CUDA_NCCL=OFF \
      -DCMAKE_CUDA_ARCHITECTURES='$CUDA_ARCHS' -DLLAMA_CURL=OFF
    cmake --build build --target ggml-cuda -j\"\$(nproc)\"
    cp -av \"\$(find build -name 'libggml-cuda.so' | head -1)\" /out/
  "
  chmod +r "$dest/$LIB" 2>/dev/null || true
else
  # Windows: pull ggml-cuda.dll out of the official win-cuda zip (NOT the separate
  # cudart-* zip — that runtime is the user's). Mirrors fetch-engine.sh's tooling.
  PY="$(command -v python3 || command -v python || true)"
  [ -z "$PY" ] && { echo "Python 3 not found (need python3 or python)." >&2; exit 1; }
  auth=(); [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  URL="$(curl -fsSL "${auth[@]}" "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$LLAMA_BUILD" \
    | "$PY" -c "import sys,json; d=json.load(sys.stdin); print(next((a['browser_download_url'] for a in d['assets'] if '$ASSET_GREP' in a['name'] and a['name'].endswith('.zip') and 'cudart' not in a['name']), 'NONE'))")"
  [ "$URL" = "NONE" ] && { echo "No win-cuda asset for $LLAMA_BUILD." >&2; exit 1; }
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "${auth[@]}" "$URL" -o "$tmp/cuda.zip"
  zip="$tmp/cuda.zip"; out="$tmp/x"
  command -v cygpath >/dev/null 2>&1 && { zip="$(cygpath -w "$zip")"; out="$(cygpath -w "$out")"; }
  "$PY" -c "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$zip" "$out"
  bin="$(find "$tmp/x" -name "$LIB" | head -1)"
  [ -z "$bin" ] && { echo "$LIB not found in the win-cuda asset." >&2; exit 1; }
  cp -a "$bin" "$dest/"
fi

echo "vendored CUDA bridge → src-tauri/binaries/$TRIPLE/$LIB  ($(du -h "$dest/$LIB" | cut -f1))"
