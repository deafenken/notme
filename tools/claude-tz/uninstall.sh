#!/usr/bin/env bash
# notme — remove the Claude Code US-timezone wrapper from your shell profile.
set -eu
MARK_BEGIN="# >>> notme: force US timezone for Claude Code >>>"
MARK_END="# <<< notme: force US timezone for Claude Code <<<"

shell_name="$(basename "${SHELL:-sh}")"
case "$shell_name" in
  zsh)  rc="$HOME/.zshrc" ;;
  bash) rc="$HOME/.bashrc" ;;
  fish) rc="$HOME/.config/fish/config.fish" ;;
  *)    rc="$HOME/.profile" ;;
esac

if [ -f "$rc" ] && grep -qF "$MARK_BEGIN" "$rc"; then
  tmp="$(mktemp)"
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0==b {skip=1} skip {if ($0==e) skip=0; next} {print}' "$rc" > "$tmp"
  mv "$tmp" "$rc"
  echo "OK: removed the claude wrapper from $rc. Open a new terminal to apply."
else
  echo "Nothing to remove in $rc."
fi
