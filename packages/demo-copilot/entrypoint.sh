#!/usr/bin/env bash
# Boots herdr, links the herdr-web-broker plugin, and starts its daemon
# through the plugin's own `start` action. The Copilot workspace/agent are
# created by validate.sh FROM OUTSIDE, through the broker's HTTP endpoint —
# the demo's whole point.
set -euo pipefail

log() { printf '[demo] %s\n' "$*"; }

# ------------------------------------------------------------------ herdr up
log "starting herdr server"
herdr server >/var/log/herdr-server.log 2>&1 &

SOCK="$HOME/.config/herdr/herdr.sock"
for _ in $(seq 1 50); do
  [ -S "$SOCK" ] && break
  sleep 0.2
done
[ -S "$SOCK" ] || { log "herdr socket never appeared"; cat /var/log/herdr-server.log; exit 1; }
log "herdr server up ($SOCK)"

mkdir -p /work

# ------------------------------------------------------- broker plugin setup
log "linking herdr-web-broker plugin"
herdr plugin link /opt/herdr-web-broker >/dev/null

# herdr assigns the plugin's config dir deterministically; the broker daemon
# receives it as HERDR_PLUGIN_CONFIG_DIR when launched through an action.
PLUGIN_CONF_DIR="$HOME/.config/herdr/plugins/config/jefelabs.web-broker"
mkdir -p "$PLUGIN_CONF_DIR"
cat > "$PLUGIN_CONF_DIR/config.toml" <<EOF
listen = "0.0.0.0:7591"

[[client_tokens]]
name = "demo"
token = "${BROKER_TOKEN}"
EOF
log "broker config written to $PLUGIN_CONF_DIR (listen 0.0.0.0:7591)"

log "starting broker daemon via the plugin's start action"
herdr plugin action invoke jefelabs.web-broker.start >/dev/null

BROKER_UP=""
for _ in $(seq 1 100); do
  if curl -fsS http://127.0.0.1:7591/health >/dev/null 2>&1; then BROKER_UP=1; break; fi
  sleep 0.2
done
if [ -z "$BROKER_UP" ]; then
  log "broker never became healthy — diagnostics follow"
  herdr plugin log list || true
  ps aux | grep -E 'node|herdr' | grep -v grep || true
  exit 1
fi
log "broker healthy on :7591 — drive it via POST /parent/runtime/sessions/default/rpc"

exec tail -f /var/log/herdr-server.log
