#!/bin/sh
# The Nod Board hook launcher. Claude Code calls this for every event in hooks.json, with the
# event name as $1 and the payload on stdin. Codex calls it the same way with "codex" as $2
# (hooks/codex-hooks.json). It only finds Bun and hands over to hook.ts.
#
# Contract: always exit 0, so a session is never blocked. When Bun is missing, the session
# start says so once in a line shown to the user; every other event stays silent.
root=$(dirname "$0")/..
bun=$(command -v bun 2>/dev/null)
[ -z "$bun" ] && [ -x "$HOME/.bun/bin/bun" ] && bun="$HOME/.bun/bin/bun"
if [ -n "$bun" ]; then
  "$bun" "$root/hook.ts" "$1" "$2"
  exit 0
fi
cat >/dev/null 2>&1
if [ "$1" = "SessionStart" ]; then
  printf '%s\n' '{"systemMessage":"The Nod Board: Bun is not installed, so nothing is being captured. Install it from https://bun.sh and start a new session."}'
fi
exit 0
