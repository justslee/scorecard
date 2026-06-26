#!/usr/bin/env bash
# Guardrail hook (PreToolUse): block edits to protected paths and dangerous
# commands. Reads the tool-call JSON on stdin. Exit 2 = block (message returns
# to Claude). Fails open if jq is unavailable, but keeps a raw backstop.

input="$(cat)"
block() { printf 'GUARDRAIL BLOCKED: %s\n' "$1" >&2; exit 2; }

# Raw backstop — catches the worst even without jq.
printf '%s' "$input" | grep -Eq 'rm[[:space:]]+-[a-z]*r[a-z]*f[[:space:]]+/' \
  && block "destructive 'rm -rf /' is not allowed."

if command -v jq >/dev/null 2>&1; then
  tool="$(printf '%s' "$input" | jq -r '.tool_name // empty')"
  case "$tool" in
    Bash)
      cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
      printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]])rm[[:space:]]+-[a-z]*r[a-z]*f' \
        && block "destructive recursive rm is not allowed."
      printf '%s' "$cmd" | grep -Eq 'push[[:space:]].*(--force|--force-with-lease|-f([[:space:]]|$))' \
        && block "force-push is not allowed."
      printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push[[:space:]][^|&;]*\bmain\b' \
        && block "never push to main — branch + open a PR."
      ;;
    Edit|Write|MultiEdit)
      path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
      case "$path" in
        *.env|*.env.*|*.env.local) block "editing a secret/.env file is not allowed." ;;
        */deploy/*) block "editing deploy/ (production infra) is not allowed." ;;
        */supabase/migrations/*) block "editing DB migrations is not allowed." ;;
      esac
      ;;
  esac
fi
exit 0
