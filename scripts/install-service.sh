#!/bin/sh
# Installs tmuxlab as a systemd user service that starts at boot.
set -eu
cd "$(dirname "$0")/.."
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/tmuxlab.service <<UNIT
[Unit]
Description=tmuxlab (tmux from web and Android)
After=network-online.target

[Service]
WorkingDirectory=$PWD
ExecStart=$(command -v node) $PWD/server.js
Environment=PATH=$PATH
Environment=PORT=${PORT:-7681}
Environment=HOST=${HOST:-0.0.0.0}
Restart=on-failure
# tmux forks its own server; only kill node on restart, never your sessions
KillMode=process

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now tmuxlab
loginctl enable-linger "$USER" 2>/dev/null || echo "Run 'sudo loginctl enable-linger $USER' to keep it running while logged out."
sleep 1
journalctl --user -u tmuxlab -n 20 --no-pager | grep -E 'http|token' || systemctl --user status tmuxlab --no-pager
