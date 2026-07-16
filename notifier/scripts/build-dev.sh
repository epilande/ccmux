#!/usr/bin/env bash
# Idempotent dev build loop for ccmux-notifier. Regenerates the Xcode project,
# builds a Debug app with ad-hoc signing (no DEVELOPMENT_TEAM required), then
# smoke-tests --version. Safe to re-run.
#
# Requires: Xcode + xcodegen on PATH. For a signed/notarized build, use the
# release CI pipeline instead — this is the local, unsigned loop.
set -euo pipefail

NOTIFIER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$NOTIFIER_DIR"

DERIVED="$NOTIFIER_DIR/build"
APP="$DERIVED/Build/Products/Debug/ccmux-notifier.app"
BIN="$APP/Contents/MacOS/ccmux-notifier"

echo "==> Rendering app icon from the ccmux orb logo"
swift scripts/render-icon.swift >/dev/null

echo "==> xcodegen generate"
xcodegen generate

echo "==> xcodebuild (Debug, ad-hoc signed)"
xcodebuild \
	-project ccmux-notifier.xcodeproj \
	-scheme ccmux-notifier \
	-configuration Debug \
	-derivedDataPath "$DERIVED" \
	CODE_SIGN_IDENTITY="-" \
	CODE_SIGNING_REQUIRED=NO \
	CODE_SIGNING_ALLOWED=NO \
	DEVELOPMENT_TEAM="" \
	build

echo "==> Ad-hoc codesigning the bundle"
codesign --force --deep -s - "$APP"

echo "==> Built: $APP"
echo "==> Smoke test: --version"
"$BIN" --version
