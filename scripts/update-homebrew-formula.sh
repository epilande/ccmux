#!/usr/bin/env bash
set -euo pipefail

# Generate a Homebrew formula for ccmux. Defaults to the stable formula.
# Usage: update-homebrew-formula.sh <output-path>
# Requires env: VERSION (no 'v' prefix), SHA_MACOS_ARM64, SHA_MACOS_X64,
# SHA_LINUX_X64, SHA_NOTIFIER_APP.
# Optional env: CLASS_NAME, DESCRIPTION, and CONFLICTS_WITH (a formula that
# installs the same binary; also adds caveats for switching back to it).

OUTPUT_PATH="${1:-}"

if [[ -z "$OUTPUT_PATH" ]]; then
	echo "Error: Output path required" >&2
	echo "Usage: $0 <output-path>" >&2
	exit 1
fi

for var in VERSION SHA_MACOS_ARM64 SHA_MACOS_X64 SHA_LINUX_X64 SHA_NOTIFIER_APP; do
	if [[ -z "${!var:-}" ]]; then
		echo "Error: $var environment variable is required" >&2
		exit 1
	fi
done

# Defaults to the canonical name; the workflow passes ${{ github.repository }}
# so asset URLs always track the publishing repo.
REPO="${REPO:-epilande/ccmux}"

CLASS_NAME="${CLASS_NAME:-Ccmux}"
DESCRIPTION="${DESCRIPTION:-Monitor AI coding agent sessions running in tmux}"
CONFLICTS_WITH="${CONFLICTS_WITH:-}"
FORMULA_NAME="$(basename "$OUTPUT_PATH" .rb)"

CONFLICTS_BLOCK=""
CAVEATS_BLOCK=""
if [[ -n "$CONFLICTS_WITH" ]]; then
	CONFLICTS_BLOCK="
  conflicts_with \"${CONFLICTS_WITH}\", because: \"both install a ccmux binary\"
"
	# The daemon is stopped first because an older ccmux never replaces a newer
	# daemon; setup runs last so the hooks match the binary that stays.
	CAVEATS_BLOCK="
  def caveats
    <<~EOS
      To switch back to the ${CONFLICTS_WITH} formula:
        ccmux daemon stop
        brew uninstall ${FORMULA_NAME}
        brew install epilande/tap/${CONFLICTS_WITH}
        ccmux setup

      If ${CONFLICTS_WITH} is already installed but unlinked, use
      \"brew link ${CONFLICTS_WITH}\" in place of the install step.
    EOS
  end
"
fi

mkdir -p "$(dirname "$OUTPUT_PATH")"

# The heredoc is unquoted, so an unescaped backtick inside it RUNS a command
# here. The doubled space in "after  returns" is where one used to be; filling
# it in would change the stable formula's bytes.
cat >"$OUTPUT_PATH" <<EOF
class ${CLASS_NAME} < Formula
  desc "${DESCRIPTION}"
  homepage "https://github.com/${REPO}"
  version "${VERSION}"
  license "MIT"

  on_macos do
    # Actionable-notification backend: the signed + notarized ccmux-notifier
    # helper app, staged into libexec below. Gives real ccmux identity,
    # Approve/Deny buttons, inline reply, per-session grouping, and retraction
    # (ccmux falls back to osascript without it).
    resource "notifier" do
      url "https://github.com/${REPO}/releases/download/v${VERSION}/ccmux-notifier.zip"
      sha256 "${SHA_NOTIFIER_APP}"
    end

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
${CONFLICTS_BLOCK}
  def install
    binary_name = stable.url.split("/").last
    bin.install binary_name => "ccmux"
    # The release asset is a bare binary, downloaded as 0644. Homebrew only
    # fixes bin/ permissions after  returns, so make it executable
    # here or the completion step below fails with EACCES.
    chmod 0755, bin/"ccmux"

    # \`ccmux completion <shell>\` only prints a static script: no daemon,
    # tmux, or HOME involved, so it is safe to run in the build sandbox.
    generate_completions_from_executable(bin/"ccmux", "completion")

    # Stage the notarized helper app alongside the binary. The ccmux daemon
    # resolves it at ../libexec/ccmux-notifier.app relative to bin/ccmux.
    # Homebrew strips a sole top-level directory when unpacking, so the
    # staged tree is usually the bundle's *contents* (Contents/...) and the
    # bundle must be reconstructed around them; the branch also handles an
    # unstripped archive in case that behavior ever changes.
    if OS.mac?
      resource("notifier").stage do
        if File.directory?("ccmux-notifier.app")
          libexec.install "ccmux-notifier.app"
        else
          (libexec/"ccmux-notifier.app").install Dir["*"]
        end
      end
    end
  end
${CAVEATS_BLOCK}
  test do
    system "#{bin}/ccmux", "--version"
  end
end
EOF

echo "Generated formula at $OUTPUT_PATH"
