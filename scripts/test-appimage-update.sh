#!/usr/bin/env bash
# Prove, end to end, that a released AppImage updates itself to a newer one.
#
#   ./scripts/test-appimage-update.sh <from-tag> [work-dir]
#   ./scripts/test-appimage-update.sh v1.0.1-dev.44.ab10706414
#
# Runs on any x86_64 Linux box with no desktop: it brings its own display. The
# fleet's only Linux host is a headless server, and this is what makes it a
# usable test target for a GUI app.
#
# Why this exists rather than a note saying "it should work". Everything about
# the Linux update path is invisible when it succeeds -- no console output, no
# log file, the app simply carries on -- so "is auto-update working" and "has
# auto-update been silently broken for a month" look identical from outside. The
# only honest answer is to run one and hash the result.
#
# What it proves, in order, each from evidence rather than inference:
#   1. the app resolves its channel and picks INSTALL   (its own startup line)
#   2. it finds the newer release and downloads it      (the updater cache)
#   3. the payload is the published artifact            (sha512 vs the release)
#   4. quitAndInstall replaces the running file in place (sha512 of the file)
#
# Requires: xvfb, xdotool, libfuse2 (AppImage type 2 needs fuse2, not fuse3),
# curl, openssl, gh. On Debian/Ubuntu:
#   sudo apt-get install -y xvfb xdotool libfuse2t64
#
# Leaves nothing behind but the work directory, which it prints. Put that
# somewhere with room: two AppImages plus a browser profile is ~400 MB, so on
# our server it belongs under /azuredata1, never a root disk.

set -euo pipefail

FROM_TAG="${1:?usage: $0 <from-tag> [work-dir]}"
WORK="${2:-${TMPDIR:-/tmp}/claw-appimage-update-test}"
REPO="${CLAW_REPO:-azuretek/claw-desktop}"
DISPLAY_NUM="${CLAW_TEST_DISPLAY:-:77}"
# The app's first update check is 60s after launch (UPDATE_FIRST_CHECK_MS), and
# the download is ~125 MB, so the dialog cannot appear before then.
SETTLE_S="${CLAW_TEST_SETTLE_S:-200}"

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\n!! %s\n' "$*" >&2; exit 1; }

for c in curl openssl xvfb-run xdotool gh; do
  command -v "$c" >/dev/null || fail "missing $c -- see the header of this script"
done

sha512b64() { openssl dgst -sha512 -binary "$1" | openssl base64 -A; }

say "work directory: $WORK"
mkdir -p "$WORK/app" "$WORK/home"
export HOME="$WORK/home"

# --------------------------------------------------------------- the old build
OLD_NAME="$(gh release view "$FROM_TAG" --repo "$REPO" --json assets \
  --jq '.assets[].name | select(endswith("x86_64.AppImage"))' | head -1)"
[ -n "$OLD_NAME" ] || fail "$FROM_TAG has no x86_64 AppImage asset"

say "installing $OLD_NAME as the starting version"
gh release download "$FROM_TAG" --repo "$REPO" -p "$OLD_NAME" -O "$WORK/app/Claw.AppImage" --clobber
chmod +x "$WORK/app/Claw.AppImage"
BEFORE="$(sha512b64 "$WORK/app/Claw.AppImage")"

# --------------------------------------------------- what it should update to
# Read from the published channel file rather than "the newest release": that is
# the exact document the updater itself will fetch, so a mismatch here is the
# same mismatch the app would hit.
say "reading the dev channel's published metadata"
gh release download "$FROM_TAG" --repo "$REPO" -p dev-linux.yml -O "$WORK/from-channel.yml" --clobber 2>/dev/null || true
LATEST_TAG="$(gh release list --repo "$REPO" --limit 1 --json tagName --jq '.[0].tagName')"
gh release download "$LATEST_TAG" --repo "$REPO" -p dev-linux.yml -O "$WORK/to-channel.yml" --clobber
WANT_SHA="$(awk '/^sha512:/ {print $2; exit}' "$WORK/to-channel.yml")"
WANT_NAME="$(awk '/^path:/ {print $2; exit}' "$WORK/to-channel.yml")"
printf '   from: %s\n     to: %s (%s)\n' "$FROM_TAG" "$LATEST_TAG" "$WANT_NAME"
[ "$FROM_TAG" != "$LATEST_TAG" ] || fail "$FROM_TAG is already the newest release; nothing to update to"

# ------------------------------------------------------------------ run it
say "running under Xvfb $DISPLAY_NUM for ${SETTLE_S}s"
export DISPLAY="$DISPLAY_NUM"
Xvfb "$DISPLAY_NUM" -screen 0 1280x900x24 >/dev/null 2>&1 &
XVFB_PID=$!
# Kill by the PID we started, never by pattern: another Xvfb on this host is
# somebody else's.
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT
sleep 3

( cd "$WORK/app" && ./Claw.AppImage >"$WORK/app.log" 2>&1 ) &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true; kill "$XVFB_PID" 2>/dev/null || true' EXIT
sleep "$SETTLE_S"

# The "ready to update" dialog carries the app name, not the message, so there
# is no window title to wait for -- press the default button (Restart now) and
# judge by what happens to the file.
say "accepting the restart prompt"
xdotool key --clearmodifiers Return || true
sleep 30

# ---------------------------------------------------------------- the verdict
say "results"
grep -E '^\[claw\] updates:' "$WORK/app.log" || echo "   (no update policy line -- did the app start?)"

PENDING="$HOME/.cache/claw-desktop-updater/pending"
if [ -d "$PENDING" ]; then
  echo "   downloaded: $(ls "$PENDING" | grep AppImage || echo none)"
else
  fail "no updater cache at $PENDING -- the check never downloaded anything"
fi

AFTER="$(sha512b64 "$WORK/app/Claw.AppImage")"
if [ "$AFTER" = "$BEFORE" ]; then
  fail "the AppImage is unchanged -- it downloaded but did not install"
fi
if [ "$AFTER" != "$WANT_SHA" ]; then
  fail "the AppImage changed but does not match the published $WANT_NAME"
fi

say "PASS: $FROM_TAG updated itself in place to $LATEST_TAG"
echo "   sha512 matches the published $WANT_NAME"
echo
echo "clean up with: rm -rf $WORK"
