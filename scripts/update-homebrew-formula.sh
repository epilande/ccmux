#!/usr/bin/env bash
set -euo pipefail

# Generate the Homebrew formula for ccmux.
# Usage: update-homebrew-formula.sh <output-path>
# Requires env: VERSION (no 'v' prefix), SHA_MACOS_ARM64, SHA_MACOS_X64, SHA_LINUX_X64.

OUTPUT_PATH="${1:-}"

if [[ -z "$OUTPUT_PATH" ]]; then
	echo "Error: Output path required" >&2
	echo "Usage: $0 <output-path>" >&2
	exit 1
fi

for var in VERSION SHA_MACOS_ARM64 SHA_MACOS_X64 SHA_LINUX_X64; do
	if [[ -z "${!var:-}" ]]; then
		echo "Error: $var environment variable is required" >&2
		exit 1
	fi
done

# Defaults to the canonical name; the workflow passes ${{ github.repository }}
# so asset URLs always track the publishing repo.
REPO="${REPO:-epilande/ccmux}"

mkdir -p "$(dirname "$OUTPUT_PATH")"

cat >"$OUTPUT_PATH" <<EOF
class Ccmux < Formula
  desc "Monitor AI coding agent sessions running in tmux"
  homepage "https://github.com/${REPO}"
  version "${VERSION}"
  license "MIT"

  on_macos do
    # Notification backend: gives the daemon's notifications and \`ccmux
    # notify\` click-to-jump, per-session grouping, and the terminal's icon
    # out of the box (ccmux falls back to osascript without it).
    depends_on "terminal-notifier"

    if Hardware::CPU.arm?
      url "https://github.com/${REPO}/releases/download/v${VERSION}/ccmux-macos-arm64"
      sha256 "${SHA_MACOS_ARM64}"
    else
      url "https://github.com/${REPO}/releases/download/v${VERSION}/ccmux-macos-x64"
      sha256 "${SHA_MACOS_X64}"
    end
  end

  on_linux do
    url "https://github.com/${REPO}/releases/download/v${VERSION}/ccmux-linux-x64"
    sha256 "${SHA_LINUX_X64}"
  end

  def install
    binary_name = stable.url.split("/").last
    bin.install binary_name => "ccmux"
  end

  test do
    system "#{bin}/ccmux", "--version"
  end
end
EOF

echo "Generated formula at $OUTPUT_PATH"
