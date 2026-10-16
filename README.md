# ALLTV local setup for Claude Desktop

Per-user installers for the ALLTV MCP application. No ALLTV server deployment
or private source repository access is required. Windows x64/ARM64 and
macOS 13.5+ Intel/Apple Silicon are supported.

## Install

Fully quit Claude Desktop before installing. On Windows, also quit its tray
icon. Do not reopen it until setup finishes. No administrator access should
be needed for ALLTV or its private Node.js runtime; corporate device policies
may still require IT approval for Claude Desktop.

### Windows 10/11

Download [install-windows.ps1](https://github.com/adobe-dss-aep/tps_tv_alltv_local/releases/download/v1.0.0/install-windows.ps1)
and save it in Downloads. Open **Windows PowerShell** and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\install-windows.ps1"
```

This applies the execution-policy option only to that process, not the laptop.
Organization-enforced policies cannot be bypassed by this option; contact IT
if scripts or third-party applications are blocked.

### Mac

Download [install-macos.command](https://github.com/adobe-dss-aep/tps_tv_alltv_local/releases/download/v1.0.0/install-macos.command)
and save it in Downloads. Open **Terminal** and run:

```bash
/bin/bash "$HOME/Downloads/install-macos.command"
```

Alternatively, download the repository's tagged source ZIP, extract it, and
run the appropriate script from the extracted folder. When downloaded alone,
each script fetches the matching `v1.0.0` source archive from this public repo.
These download links become available when that release is published.

### After setup

Open Claude Desktop and start a **new chat**. Request an ALLTV action, or run
`/my-tv-opportunities` if that command is available in your Claude setup.
The installer configures MCP tools; it does not install organization-specific
slash commands, Claude accounts, licenses, or permissions.

All 11 ALLTV tools are available in offline discovery immediately. A manual
`alltv_connect` call is not required. Authentication opens in your default
browser only when an actual operation needs it. Existing usable credentials
are reused; idle/startup discovery does not authenticate or refresh tokens.
Complete your usual Adobe sign-in on first use. Installing the software does
not grant access to ALLTV or its upstream systems.

## What setup changes

- Installs the official, checksum-pinned Claude Desktop build **only if missing**.
  Existing Claude installations are not downgraded or replaced. Windows uses
  Anthropic's signed per-user installer. Mac installs the verified/notarized
  official app in `~/Applications` when neither user nor system Claude exists.
  Claude's own automatic updates remain enabled.
- Downloads a checksum-pinned **Node.js 24.22.0 LTS** runtime for ALLTV only.
  No global Node/npm installation, PATH changes, Git, Python, or Homebrew.
- Installs exact dependencies from [the lockfile](launcher/package-lock.json)
  using public npm, with package lifecycle scripts disabled.
- Verifies the new launcher locally with an empty temporary credential/cache
  directory. The check lists tools/resources and pings; it does not sign in or
  invoke business operations.
- Adds or updates `mcpServers.tps-tv-alltv-assist` in Claude's JSON configuration,
  with absolute paths and callback port **8145**. Other top-level settings and
  other servers are preserved. Existing entries targeting the exact same ALLTV
  endpoint are consolidated to prevent running an old eager launcher alongside
  the new one. Custom ALLTV environment settings are preserved.
- Backs up existing configuration byte-for-byte before changing it, using a
  unique sibling name containing `.alltv-backup-`. Invalid JSON is rejected,
  not replaced. A configuration lock prevents two setup helpers editing it
  simultaneously.
- Installs each launcher update in a separate version directory. Existing
  installations and OAuth credentials are not deleted. The config is changed
  only after dependencies and offline verification succeed.

The public bundle contains only local launcher code, tool/resource schemas,
and synthetic tests. It contains no credentials, business records, private
server implementation, or proprietary embedded fonts. Its completion page
uses system fonts and no external assets.

### Locations

| Item | Windows | Mac |
|---|---|---|
| ALLTV files | `%LOCALAPPDATA%\ALLTV-MCP` | `~/Library/Application Support/ALLTV-MCP` |
| Packaged Claude config | `%LOCALAPPDATA%\Packages\<Claude package family>\LocalCache\Roaming\Claude\claude_desktop_config.json` | n/a |
| Classic Claude config | `%APPDATA%\Claude\claude_desktop_config.json` | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Existing OAuth storage | `~\.mcp-auth` | `~/.mcp-auth` |

Windows detects the installed Claude package family instead of assuming the
classic configuration path. The installer prints the actual config and backup
paths without printing their contents. Backups can contain your existing
private server settings: keep them local.

## Rerun, rollback, and removal

Rerun the script to repair or update ALLTV. It reuses its pinned runtime and
creates a fresh launcher directory; it does not stop or uninstall applications.
If setup fails, read the reported error and retry after fixing it. Unreferenced
version directories from failed attempts may remain and can be removed after
checking that no Claude configuration references them.

To roll back, quit Claude and restore the printed configuration backup. Old
launcher/runtime directories remain available for that reason. Restore the
whole backup only if no newer unrelated settings need preserving.

To remove ALLTV, quit Claude, remove only the `tps-tv-alltv-assist` entry from
its configuration, and remove the ALLTV installation folder after confirming
it contains no other required installation. Do not delete Claude's entire
configuration or `~/.mcp-auth`; they may serve other connectors. Claude Desktop
itself is not removed.

If setup was interrupted while writing the configuration and reports a lock,
check that no installer is running before removing only the reported
`.alltv-install.lock` file. Never remove another active installer's lock.
Mac also uses `.setup-lock` inside the installation folder; check its `pid`
file before removing an interrupted setup's lock. Windows uses an automatically
released file handle; its empty `.setup.lock` file can remain.

## Network and trust

Installation downloads from `github.com`, GitHub's archive/asset hosts,
`nodejs.org`, `registry.npmjs.org`, and (if needed) `downloads.claude.ai`.
Corporate proxies and application controls must allow these destinations.
Normal use also needs access to the configured ALLTV endpoint and your usual
Adobe authentication services. Callback port 8145 must be available on the
laptop during interactive sign-in; it is a loopback callback, not a hosted
service.

[installer.json](installer.json) pins Node and Claude versions/checksums.
Node checksums come from the official Node release's `SHASUMS256.txt`;
Claude download URLs/hashes were verified against the public WinGet manifest
and Homebrew cask metadata on October 16, 2026. Windows additionally checks
the Claude Authenticode signer; Mac checks its bundle identity, signature,
and Gatekeeper assessment. Installers and repository source are distributed
over GitHub HTTPS; the ALLTV scripts are **not code-signed**.

## Development and publishing

All files in this repo are standalone; the private ALLTV application checkout
is not needed to install or test them.

```text
npm test
npm --prefix launcher ci --ignore-scripts
npm run test:launcher
```

The platform workflow also stages two real installations against isolated
settings with paths containing spaces, tests preserved settings/backups,
and exercises private runtime download plus npm installation. Those tests
skip Claude installation and never touch real Claude settings. A separate CI
step also exercises official Claude installation on the disposable runner.

Advanced staging options (not needed by laptop users):

```powershell
.\install-windows.ps1 -InstallRoot "$env:TEMP\ALLTV staging" -ConfigPath "$env:TEMP\ALLTV settings\claude_desktop_config.json" -SkipClaudeInstall
```

```bash
/bin/bash install-macos.command \
  --install-root "$TMPDIR/ALLTV staging" \
  --config-path "$TMPDIR/ALLTV settings/claude_desktop_config.json" \
  --skip-claude-install
```

The skip flag bypasses Claude installation and running-process checks only
for explicit custom-config staging. It does not bypass runtime hashes,
dependency installation, offline verification, or config safety checks.

For each release, update the version in both platform scripts,
[installer.json](installer.json), [package.json](package.json), and the download
links above. Refresh pinned vendor versions/checksums as needed and retain
the upstream `mcp-remote` fingerprint checks. When changing the bundled catalog,
regenerate it from the private application's production registrations using
its neutral-identity generator, not a signed-in user's cache.

After both platform CI jobs pass, create a matching tag and release:

```text
gh release create v1.0.0 install-windows.ps1 install-macos.command --repo adobe-dss-aep/tps_tv_alltv_local --title "ALLTV local setup 1.0.0" --generate-notes
```

Users can then download either standalone script from the release. Creating a
release before pushing the complete matching source would break bootstrap
downloads, so publish the tested source first.
