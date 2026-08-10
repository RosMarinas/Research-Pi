#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
user_bin_dir=${XDG_BIN_HOME:-"${HOME:?HOME is not set}/.local/bin"}

if [ ! -x "$script_dir/node_modules/.bin/pi" ]; then
  echo "Pinned Pi core is missing. Run 'npm install --ignore-scripts' in $script_dir first." >&2
  exit 2
fi

mkdir -p "$user_bin_dir"

install_link() {
  name=$1
  target=$2
  destination="$user_bin_dir/$name"

  if [ -L "$destination" ] && [ "$(readlink "$destination")" = "$target" ]; then
    echo "$name already points to $target"
    return
  fi

  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "Refusing to overwrite existing $destination" >&2
    exit 2
  fi

  ln -s "$target" "$destination"
  echo "Installed $destination -> $target"
}

install_link pi "$script_dir/run-pi.sh"
install_link pi-traced "$script_dir/run-pi-traced.sh"
install_link pi-raw "$script_dir/node_modules/.bin/pi"

case ":$PATH:" in
  *":$user_bin_dir:"*) ;;
  *) echo "Add $user_bin_dir to PATH before using pi." >&2 ;;
esac
