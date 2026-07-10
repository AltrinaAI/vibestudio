#!/usr/bin/env bash
# Build + run VibeStudio in the iOS Simulator. Clears the stale .xcarchive first —
# `tauri ios build` archives then exports and won't overwrite a non-empty archive
# dir from a previous run ("failed to rename app … Directory not empty").
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TAURI_APPLE_DEVELOPMENT_TEAM:=5J5PGFKG9H}"; export TAURI_APPLE_DEVELOPMENT_TEAM
DEVICE="${1:-iPhone 17 Pro Max}"

rm -rf client/desktop/gen/apple/build/*.xcarchive client/desktop/gen/apple/build/arm64-sim
npx tauri ios build --debug -t aarch64-sim --ci

APP="client/desktop/gen/apple/build/arm64-sim/VibeStudio.app"
xcrun simctl boot "$DEVICE" 2>/dev/null || true
open -a Simulator
xcrun simctl install booted "$APP"
xcrun simctl launch --console-pty booted com.vibestudio.app
