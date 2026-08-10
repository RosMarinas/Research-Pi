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
env_file="$script_dir/.env"
workspace=${PI_RESEARCH_WORKSPACE:-$PWD}
core_bin=${PI_CORE_BIN:-"$script_dir/node_modules/.bin/pi"}

if [ "${1:-}" = "--workspace" ]; then
  if [ "$#" -lt 2 ]; then
    echo "Usage: $0 --workspace <project-directory> [pi options...]" >&2
    exit 2
  fi
  workspace=$2
  shift 2
fi

if [ ! -d "$workspace" ]; then
  echo "Research workspace does not exist: $workspace" >&2
  exit 2
fi

workspace=$(CDPATH= cd -- "$workspace" && pwd)

if [ ! -x "$core_bin" ]; then
  echo "Pinned Pi core is missing: $core_bin" >&2
  echo "Run 'npm install --ignore-scripts' in $script_dir." >&2
  exit 2
fi

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Copy .env.example to .env and fill DEEPSEEK_API_KEY." >&2
  exit 2
fi

set -a
. "$env_file"
set +a

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "DEEPSEEK_API_KEY is empty in $env_file." >&2
  exit 2
fi

export PI_CODING_AGENT_DIR="$script_dir/.pi/agent"

cd "$workspace"

if [ "$workspace" = "$script_dir" ]; then
  exec "$core_bin" --provider deepseek --model deepseek-v4-flash --thinking high "$@"
fi

exec "$core_bin" \
  --provider deepseek \
  --model deepseek-v4-flash \
  --thinking high \
  --session-dir "$script_dir/.pi/sessions" \
  --append-system-prompt "$script_dir/.pi/APPEND_SYSTEM.md" \
  --extension "$script_dir/.pi/extensions/record-experiment.ts" \
  --extension "$script_dir/.pi/extensions/research-checkpoint.ts" \
  "$@"
