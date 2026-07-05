#!/usr/bin/env bash
# notme — force a US timezone for Claude Code (CLI).
#
# Claude Code is a Node process: it reports the OS timezone (via the TZ env var)
# in its system prompt. This installs a `claude` wrapper in your shell profile
# so `claude` runs with TZ set to a US zone, while the REST of your shell keeps
# its real timezone.
#
# Usage:
#   ./install.sh [IANA_TIMEZONE]     # default: America/Los_Angeles
#   ./install.sh America/New_York
#
# Supports zsh (macOS default), bash, and fish, on macOS / Linux / WSL.
# Re-running is safe (it replaces the previous block). To undo, delete the
# marked block from your profile, or run ./uninstall.sh.
set -eu

TZNAME="${1:-America/Los_Angeles}"
MARK_BEGIN="# >>> notme: force US timezone for Claude Code >>>"
MARK_END="# <<< notme: force US timezone for Claude Code <<<"

shell_name="$(basename "${SHELL:-sh}")"
case "$shell_name" in
  zsh)  rc="$HOME/.zshrc" ;;
  bash) rc="$HOME/.bashrc" ;;
  fish) rc="$HOME/.config/fish/config.fish" ;;
  *)    rc="$HOME/.profile"; shell_name="sh" ;;
esac
mkdir -p "$(dirname "$rc")"
touch "$rc"

# Remove any previous notme block so re-installing is idempotent.
if grep -qF "$MARK_BEGIN" "$rc"; then
  tmp="$(mktemp)"
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0==b {skip=1} skip {if ($0==e) skip=0; next} {print}' "$rc" > "$tmp"
  mv "$tmp" "$rc"
fi

{
  echo ""
  echo "$MARK_BEGIN"
  if [ "$shell_name" = "fish" ]; then
    echo "set -gx NOTME_CLAUDE_TZ \"$TZNAME\""
    echo "function claude"
    echo "    env TZ=\$NOTME_CLAUDE_TZ command claude \$argv"
    echo "end"
  else
    echo "export NOTME_CLAUDE_TZ=\"$TZNAME\""
    echo "claude() { TZ=\"\$NOTME_CLAUDE_TZ\" command claude \"\$@\"; }"
  fi
  echo "$MARK_END"
} >> "$rc"

echo "OK: added the claude wrapper (TZ=$TZNAME) to $rc"
echo "Open a NEW terminal (or run: source \"$rc\"), then Claude Code reports $TZNAME."
echo "Verify: TZ=$TZNAME node -e \"console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)\""
