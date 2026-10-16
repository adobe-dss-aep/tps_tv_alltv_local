#!/bin/bash
set -euo pipefail
umask 077
version="1.0.0"
install_root="$HOME/Library/Application Support/ALLTV-MCP"
config_path="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
skip_claude=0
custom_config=0

fail() { printf 'ALLTV installation failed: %s\n' "$*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
    case "$1" in
        --install-root) [[ $# -ge 2 ]] || fail "Missing --install-root value."; install_root="$2"; shift 2 ;;
        --config-path) [[ $# -ge 2 ]] || fail "Missing --config-path value."; config_path="$2"; custom_config=1; shift 2 ;;
        --skip-claude-install) skip_claude=1; shift ;;
        *) fail "Unknown option: $1" ;;
    esac
done
[[ "$(uname -s)" == Darwin ]] || fail "Run this installer on macOS 13.5 or newer."
[[ "${install_root:0:1}" == / && "${config_path:0:1}" == / ]] || fail "Use absolute installation and configuration paths."
[[ "$skip_claude" == 0 || "$custom_config" == 1 ]] || fail "--skip-claude-install requires an explicit --config-path for staging."
macos_version="$(/usr/bin/sw_vers -productVersion)"
macos_major="${macos_version%%.*}"
macos_minor="${macos_version#*.}"
macos_minor="${macos_minor%%.*}"
[[ "$macos_major" -gt 13 || ( "$macos_major" -eq 13 && "$macos_minor" -ge 5 ) ]] || fail "macOS 13.5 or newer is required by the private Node.js runtime."
if [[ "$skip_claude" == 0 ]] && /usr/bin/pgrep -x Claude >/dev/null; then
    fail "Fully quit Claude Desktop, then run this installer again."
fi
case "$(uname -m)" in
    arm64) arch="arm64" ;;
    x86_64) arch="x64" ;;
    *) fail "Unsupported Mac architecture." ;;
esac
work="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/alltv-installer.XXXXXXXX")"
lock="$install_root/.setup-lock"
lock_owned=0
cleanup() {
    /bin/rm -rf -- "$work"
    if [[ "$lock_owned" == 1 ]]; then
        /bin/rm -f "$lock/pid"
        /bin/rmdir "$lock"
    fi
}
trap cleanup EXIT
trap 'fail "Setup interrupted. Existing Claude settings may not yet have been updated; rerun setup."' INT TERM
/bin/mkdir -p "$install_root"
if ! /bin/mkdir "$lock"; then
    fail "Another setup may be running. If it was interrupted, check $lock/pid before removing that lock directory."
fi
lock_owned=1
printf '%s\n' "$$" > "$lock/pid"
source_dir="$(cd "$(dirname "$0")" && pwd)"
download() { /usr/bin/curl --fail --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --output "$2" "$1"; }
if [[ ! -f "$source_dir/installer.json" ]]; then
    printf 'Downloading ALLTV installer v%s...\n' "$version"
    download "https://github.com/adobe-dss-aep/tps_tv_alltv_local/archive/refs/tags/v$version.zip" "$work/source.zip"
    /usr/bin/ditto -x -k "$work/source.zip" "$work/source"
    source_dir="$work/source/tps_tv_alltv_local-$version"
fi
manifest="$source_dir/installer.json"
value() { /usr/bin/plutil -extract "$1" raw -o - "$manifest"; }
[[ "$(value version)" == "$version" ]] || fail "Installer and bundle versions do not match."
check_hash() {
    local actual
    actual="$(/usr/bin/shasum -a 256 "$1" | /usr/bin/cut -d' ' -f1)"
    [[ "$actual" == "$2" ]] || fail "Download checksum mismatch: $1. No downloaded program was run."
}
node_version="$(value node.version)"
node_name="node-v$node_version-darwin-$arch"
runtime="$install_root/runtimes/$node_name"
node="$runtime/bin/node"
if [[ ! -x "$node" ]]; then
    printf 'Downloading private Node.js %s (%s)...\n' "$node_version" "$arch"
    download "https://nodejs.org/dist/v$node_version/$node_name.tar.gz" "$work/node.tar.gz"
    check_hash "$work/node.tar.gz" "$(value "node.sha256.darwin-$arch")"
    /usr/bin/tar -xzf "$work/node.tar.gz" -C "$work"
    /bin/mkdir -p "$install_root/runtimes"
    /bin/mv "$work/$node_name" "$runtime"
fi
[[ "$("$node" --version)" == "v$node_version" ]] || fail "The private Node.js runtime is not the expected version."
if [[ "$skip_claude" == 0 && ! -d /Applications/Claude.app && ! -d "$HOME/Applications/Claude.app" ]]; then
    printf 'Installing Claude Desktop into ~/Applications...\n'
    download "$(value claude.macos.url)" "$work/claude.zip"
    check_hash "$work/claude.zip" "$(value claude.macos.sha256)"
    /usr/bin/ditto -x -k "$work/claude.zip" "$work/claude"
    app="$work/claude/Claude.app"
    [[ -d "$app" ]] || fail "The official Claude archive did not contain Claude.app."
    /usr/bin/codesign --verify --deep --strict "$app"
    /usr/sbin/spctl --assess --type execute "$app"
    [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" == com.anthropic.claudefordesktop ]] || fail "Unexpected Claude app identity."
    /bin/mkdir -p "$HOME/Applications"
    /usr/bin/ditto "$app" "$HOME/Applications/Claude.app"
fi
deployment="$install_root/versions/$version-$(/usr/bin/uuidgen)"
launcher="$deployment/launcher"
/bin/mkdir -p "$launcher/pages"
for file in launch.mjs upstream.mjs on-demand.mjs coordination.mjs loader.mjs catalog.json package.json package-lock.json pages/completed.html; do
    /bin/cp "$source_dir/launcher/$file" "$launcher/$file"
done
printf 'Installing locked ALLTV dependencies (no package install scripts)...\n'
(
    cd "$launcher"
    "$node" "$runtime/lib/node_modules/npm/bin/npm-cli.js" ci --prefix "$launcher" --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
)
"$node" "$source_dir/tools/verify.mjs" "$node" "$launcher/launch.mjs"
"$node" "$source_dir/tools/configure.mjs" --config "$config_path" --runtime "$node" --launcher "$launcher/launch.mjs"
printf 'ALLTV installed successfully at %s\nClaude settings: %s\n' "$deployment" "$config_path"
printf 'Open Claude Desktop and start a new chat. Run /my-tv-opportunities or request an ALLTV action.\n'
printf 'No ALLTV sign-in was performed. Sign-in opens in your default browser only when an action needs it.\n'
