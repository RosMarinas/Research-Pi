#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then
  echo 'Run this installer on your Mac.' >&2
  exit 1
fi
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python=$(command -v python3 || true)
if [ -z "$python" ]; then echo 'Python 3 is required (for example: brew install python).' >&2; exit 1; fi
case ${SHELL:-/bin/zsh} in
  */zsh) rc=${ZDOTDIR:-$HOME}/.zshrc ;;
  */bash) rc=$HOME/.bash_profile ;;
  *) echo 'This installer supports zsh and bash.' >&2; exit 1 ;;
esac
if [ "${1:-install}" = install ]; then "$python" "$src/bridge.py" doctor; fi
"$python" "$src/install.py" "$src" "$rc" "${1:-install}"
