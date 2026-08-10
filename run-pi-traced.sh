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
trace_extension="$script_dir/.pi/vendor/pi-trace-extension-0.1.14/trace/index.ts"
export PI_TRACE_DIR="$script_dir/.pi/agent/traces"

if [ "${1:-}" = "--workspace" ]; then
  if [ "$#" -lt 2 ]; then
    echo "Usage: $0 --workspace <project-directory> [pi options...]" >&2
    exit 2
  fi
  workspace=$2
  shift 2
  exec "$script_dir/run-pi.sh" --workspace "$workspace" --extension "$trace_extension" "$@"
fi

exec "$script_dir/run-pi.sh" --extension "$trace_extension" "$@"
