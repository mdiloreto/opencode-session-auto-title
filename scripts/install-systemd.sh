#!/usr/bin/env bash

set -euo pipefail

if [[ $(uname -s) != Linux ]]; then
  echo "The scheduled timer is supported only on Linux." >&2
  exit 1
fi

for executable in /usr/bin/node /usr/bin/sqlite3 /usr/bin/systemctl /usr/bin/flock "$HOME/.local/bin/opencode"; do
  if [[ ! -x $executable ]]; then
    echo "Missing required executable: $executable" >&2
    exit 1
  fi
done

if [[ ! -x $HOME/.local/bin/agy ]]; then
  echo "Agy is unavailable; scheduled runs will use OpenCode Luna." >&2
fi

node_version=$(/usr/bin/node -p 'process.versions.node')
node_major=${node_version%%.*}
node_minor=${node_version#*.}
node_minor=${node_minor%%.*}
if (( node_major < 22 || (node_major == 22 && node_minor < 18) )); then
  echo "Node 22.18 or newer is required; found $node_version" >&2
  exit 1
fi

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
script_target="$HOME/.config/opencode/scripts/batch-rename-sessions.ts"
unit_dir="$HOME/.config/systemd/user"

install -Dm0644 "$repo_root/scripts/batch-rename-sessions.ts" "$script_target"
install -Dm0644 "$repo_root/systemd/opencode-session-auto-title.service" "$unit_dir/opencode-session-auto-title.service"
install -Dm0644 "$repo_root/systemd/opencode-session-auto-title.timer" "$unit_dir/opencode-session-auto-title.timer"

systemctl --user daemon-reload
systemctl --user enable --now opencode-session-auto-title.timer
if ! systemctl --user start opencode-session-auto-title.service; then
  echo "Initial backfill failed; the timer remains enabled for retry." >&2
  exit 1
fi
echo "Installed and enabled opencode-session-auto-title.timer"
