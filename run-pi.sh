#!/bin/sh
set -eu

script_path=$0
while [ -L "$script_path" ]; do
  link_target=$(readlink "$script_path")
  case "$link_target" in
    /*) script_path=$link_target ;;
    *) script_path="$(dirname -- "$script_path")/$link_target" ;;
  esac
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd)
export RESEARCH_PI_DEV_MODE=1
exec node "$script_dir/bin/pi.mjs" "$@"
