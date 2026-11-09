# ── Orca: resume the Claude session that was running before the host restarted ──
__orca_claude_resume() {
  [ -z "${_ORCA_CLAUDE_RESUME_CHECKED:-}" ] || return 0
  _ORCA_CLAUDE_RESUME_CHECKED=1
  [ -n "${ORCA_PANE_KEY:-}" ] || return 0

  local out sid prompt
  out=$(python3 "$HOME/.claude/hooks/orca-claude-resume-lookup.py" 2>/dev/null) || return 0
  sid=${out%%$'\n'*}
  prompt=""
  [[ "$out" == *$'\n'* ]] && prompt=${out#*$'\n'}
  [ -n "$sid" ] || return 0

  # A dead TUI may leave mouse reporting armed; ground it before the shell echoes 35;x;yM.
  printf '\033[?9l\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?1016l\033[?1005l\033[?1015l'
  local -a args=(--resume "$sid")
  [ -n "$prompt" ] && args+=("$prompt")
  claude "${args[@]}"
}

if declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then
  case "${PROMPT_COMMAND[*]:-}" in
    *__orca_claude_resume*) ;;
    *) PROMPT_COMMAND=(__orca_claude_resume "${PROMPT_COMMAND[@]}") ;;
  esac
else
  case ";${PROMPT_COMMAND:-};" in
    *";__orca_claude_resume;"*) ;;
    *) PROMPT_COMMAND="__orca_claude_resume${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
fi
