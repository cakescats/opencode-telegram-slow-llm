#!/usr/bin/env bash
# Install or update the Telegram bridge for opencode.
#
#   scripts/install.sh --project ~/my-project        install / update, (re)start the service
#   scripts/install.sh --project ~/my-project --no-systemd   files only
#
# Copies the plugin and the agent into ~/.config/opencode (the previous versions go to
# ~/.config/opencode/backup/), creates telegram.env from the example if there is none,
# writes the systemd user service with the project path and a random server password
# (an existing password is kept), then enables and restarts it.
set -euo pipefail
cd "$(dirname "$0")/.."

project=""; systemd=1
while [ $# -gt 0 ]; do
    case "$1" in
        --project) project=$2; shift ;;
        --no-systemd) systemd=0 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done
[ -n "$project" ] || { echo "give the project the agent works in: --project DIR" >&2; exit 1; }
project=$(cd "$project" && pwd)

cfg="$HOME/.config/opencode"
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$cfg/plugin" "$cfg/agent" "$cfg/backup"
for f in plugin/telegram.ts agent/telegram.md; do
    if [ -f "$cfg/$f" ] && ! cmp -s "$f" "$cfg/$f"; then
        cp "$cfg/$f" "$cfg/backup/$(basename "$f").$stamp"
        echo "backed up $cfg/$f"
    fi
    cp "$f" "$cfg/$f"
done
echo "installed plugin and agent into $cfg"

env="$cfg/telegram.env"
if [ ! -f "$env" ]; then
    install -m 600 telegram.env.example "$env"
    echo "created $env: put the bot token and a password in it"
fi
chmod 600 "$env"

[ "$systemd" = 1 ] || { echo "done (no systemd)"; exit 0; }

bin=$(command -v opencode || true)
[ -n "$bin" ] || { echo "opencode not found in PATH" >&2; exit 1; }
unit="$HOME/.config/systemd/user/opencode-telegram.service"
mkdir -p "$(dirname "$unit")"
pw=""
[ -f "$unit" ] && pw=$(sed -n 's/^Environment=OPENCODE_SERVER_PASSWORD=//p' "$unit" | head -1)
[ -n "$pw" ] && [ "$pw" != "CHANGE-ME" ] || pw=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
[ -f "$unit" ] && cp "$unit" "$cfg/backup/opencode-telegram.service.$stamp"
umask 077
sed -e "s|^WorkingDirectory=.*|WorkingDirectory=$project|" \
    -e "s|^Environment=OPENCODE_SERVER_PASSWORD=.*|Environment=OPENCODE_SERVER_PASSWORD=$pw|" \
    -e "s|^ExecStart=.*|ExecStart=$bin serve --port 45130 --hostname 127.0.0.1|" \
    systemd/opencode-telegram.service > "$unit"
echo "wrote $unit (project $project)"

systemctl --user daemon-reload
systemctl --user enable opencode-telegram.service >/dev/null
systemctl --user restart opencode-telegram.service
echo "service restarted; follow it with: journalctl --user -u opencode-telegram -f"
if ! grep -q '^TELEGRAM_BOT_TOKEN=.\+' "$env"; then
    echo "note: TELEGRAM_BOT_TOKEN is empty in $env, the bot stays off until you set it and restart"
fi
