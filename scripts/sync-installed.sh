#!/usr/bin/env bash
# Sync the freshly built plugin into the web profile's installed copy.
#
# The profile's pnpm uses nodeLinker: hoisted, which COPIES file: dependencies
# into node_modules (not a symlink). Rebuilding lib/ in the repo does not
# update the copy, so after `pnpm build` you must sync here (or re-install).
# The running DSH serves client bundles from disk per request, so after this
# sync a browser hard refresh (Cmd+Shift+R) is enough — no DSH restart needed
# for client-only changes. Host changes still need a restart.
set -euo pipefail

INST="${DSH_PROFILE_WEB:-$HOME/.dsh/profiles/web}/node_modules/dsh-codex-continue"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$INST" ]; then
  echo "installed copy not found at $INST — run: dsh plugin --profile web add file:$REPO"
  exit 1
fi

cp -R "$REPO/lib/." "$INST/lib/"
cp "$REPO/package.json" "$INST/package.json"
cp "$REPO/cordis.patch.yml" "$INST/cordis.patch.yml"
echo "synced $REPO → $INST"
echo "client bundle: $(stat -f '%z bytes' "$INST/lib/client.js") — 浏览器 ⌘⇧R 强刷即可（host 改动需重启 DSH）"
