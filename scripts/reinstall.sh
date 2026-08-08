#!/usr/bin/env bash
#
# Install the current release build into /Applications.
#
# The `tccutil reset` in the middle is the part that is easy to skip and expensive to skip.
# Every build produces a binary with a different code-signing hash, and macOS ties the Screen
# Recording grant to that hash — so a fresh build inherits an entry that System Settings still
# draws as switched **on** while the system treats it as denied. Captures then come back as
# the bare desktop wallpaper. Toggling the switch off and on does not repair it; the entry has
# to be removed, which is what the reset does.
#
# Signing with a real identity (see `bundle.macOS.signingIdentity` in tauri.conf.json) is what
# makes this stop happening, because the grant then follows the certificate rather than the
# hash of one particular build. The reset is kept here anyway: it costs a re-grant and it is
# the difference between a broken install and a confusing one.

set -euo pipefail

APP="Capture Studio.app"
BUNDLE_ID="com.quocanhdang.capture-studio"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILT="$REPO/src-tauri/target/release/bundle/macos/$APP"
DEST="/Applications/$APP"

if [[ ! -d "$BUILT" ]]; then
  echo "No build at $BUILT — run 'npm run tauri build' first." >&2
  exit 1
fi

echo "==> Quitting any running copy"
pkill -f "$DEST" 2>/dev/null || true
sleep 1

echo "==> Installing to $DEST"
rm -rf "$DEST"
# ditto rather than cp: it preserves the bundle's extended attributes and symlinks, which a
# plain recursive copy mangles.
ditto "$BUILT" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo "==> Clearing the stale Screen Recording grant"
tccutil reset ScreenCapture "$BUNDLE_ID" >/dev/null

echo "==> Launching"
open -a "$DEST"

cat <<'EOF'

Installed. To finish:
  1. Trigger any capture — macOS will ask for Screen Recording permission.
  2. Allow it.
  3. Quit (Cmd+Q) and reopen. The permission only applies to a fresh launch, because
     CGPreflightScreenCaptureAccess caches its answer for the life of the process.
EOF
