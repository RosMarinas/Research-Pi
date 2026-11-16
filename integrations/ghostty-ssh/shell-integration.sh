# Source once, after Ghostty's own shell integration (zsh or bash).
if [ "${_RESEARCH_PI_GHOSTTY_LOADED:-}" = 1 ]; then return; fi
_RESEARCH_PI_GHOSTTY_LOADED=1

function _research_pi_ssh {
  if [ "${_RESEARCH_PI_SSH_ACTIVE:-}" = 1 ]; then command ssh "$@"; return $?; fi
  # Aliases remain user-owned; noninteractive SSH and explicit commands bypass.
  if [ "${RESEARCH_PI_GHOSTTY_DISABLE:-}" = 1 ] ||
     [ "${TERM_PROGRAM:-}" != ghostty ] || [ ! -t 0 ] || [ ! -t 1 ]; then
    _research_pi_original_ssh "$@"
    return $?
  fi
  local plan arg result
  local -a bridge_args
  if plan=$("$RESEARCH_PI_GHOSTTY_PYTHON" "$RESEARCH_PI_GHOSTTY_HOME/bridge.py" prepare "$$" "$(tty)" "$@"); then result=0; else result=$?; fi
  if [ "$result" -ne 0 ]; then
    if [ "$result" -ne 2 ]; then
      printf '%s\n' 'Research Pi: Ghostty bridge unavailable; using normal SSH.' >&2
    fi
    _research_pi_original_ssh "$@"
    return $?
  fi
  while IFS= read -r -d '' arg; do bridge_args+=("$arg"); done < "$plan/argv"
  local _RESEARCH_PI_SSH_ACTIVE=1
  if _research_pi_original_ssh "${bridge_args[@]}"; then result=0; else result=$?; fi
  "$RESEARCH_PI_GHOSTTY_PYTHON" "$RESEARCH_PI_GHOSTTY_HOME/bridge.py" cleanup "$plan"
  return "$result"
}

# Ghostty itself defines ssh after user rc files (zsh defers it to precmd).
# Install at the first prompt, after that initialization, and wrap only once.
function _research_pi_install_ssh_once {
  local prompt_status=$?
  if [ "${_RESEARCH_PI_SSH_WRAPPED:-}" = 1 ]; then return "$prompt_status"; fi
  _RESEARCH_PI_SSH_WRAPPED=1
  if [ -n "${ZSH_VERSION:-}" ]; then
    if (( ${+functions[ssh]} )); then
      functions[_research_pi_original_ssh]=${functions[ssh]}
    else
      function _research_pi_original_ssh { command ssh "$@"; }
    fi
  else
    if declare -F ssh >/dev/null; then
      eval "$(declare -f ssh | sed '1s/ssh/_research_pi_original_ssh/')"
    else
      function _research_pi_original_ssh { command ssh "$@"; }
    fi
  fi
  function ssh { _research_pi_ssh "$@"; }
  return "$prompt_status"
}

case $- in
  *i*)
    if [ -n "${ZSH_VERSION:-}" ]; then
      precmd_functions+=(_research_pi_install_ssh_once)
    elif [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
      PROMPT_COMMAND+=(_research_pi_install_ssh_once)
    else
      PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }_research_pi_install_ssh_once"
    fi
    ;;
  *) _research_pi_install_ssh_once ;;
esac
