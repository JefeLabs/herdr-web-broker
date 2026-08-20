#!/usr/bin/env bash
# Boots herdr, links the herdr-web-broker plugin, starts its daemon, then
# serves the demo site (vite preview) whose proxy targets the broker over
# loopback — which is also what lets the site's Admin cards work.
set -euo pipefail

log() { printf '[demo-web] %s\n' "$*"; }

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

PLUGIN_CONF_DIR="$HOME/.config/herdr/plugins/config/jefelabs.web-broker"
mkdir -p "$PLUGIN_CONF_DIR"
cat > "$PLUGIN_CONF_DIR/config.toml" <<EOF
listen = "0.0.0.0:7591"

[token_mint]
enabled = true

[[client_tokens]]
name = "demo"
token = "${BROKER_TOKEN}"
EOF
log "broker config written (listen 0.0.0.0:7591, bearer ${BROKER_TOKEN})"

log "starting broker daemon via the plugin's start action"
herdr plugin action invoke jefelabs.web-broker.start >/dev/null

for _ in $(seq 1 100); do
  if curl -fsS http://127.0.0.1:7591/health >/dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -fsS http://127.0.0.1:7591/health >/dev/null || { log "broker never became healthy"; exit 1; }
log "broker healthy on :7591"

ADMIN_TOKEN_FILE=$(find "$HOME/.local/state/herdr" "$HOME/.config/herdr" -name admin-token 2>/dev/null | head -1 || true)
[ -n "$ADMIN_TOKEN_FILE" ] && log "admin token: $(cat "$ADMIN_TOKEN_FILE") (loopback only — usable through the site's proxy)"

# ------------------------------------------------- copilot auth passthrough
# docker run -e COPILOT_GITHUB_TOKEN=... seeds the env registry (kind
# copilot); spawn injection exports it into the pane before agent.start, so
# demo Copilot agents start authenticated instead of stopping at /login.
if [ -n "${COPILOT_GITHUB_TOKEN:-}" ]; then
  BODY=$(printf '{"name":"COPILOT_GITHUB_TOKEN","value":"%s","kind":"copilot"}' "$COPILOT_GITHUB_TOKEN")
  if curl -fsS -X POST http://127.0.0.1:7591/parent/runtime/env \
      -H "Authorization: Bearer ${BROKER_TOKEN}" -H "content-type: application/json" \
      -d "$BODY" >/dev/null; then
    log "COPILOT_GITHUB_TOKEN seeded into the env registry (kind copilot) — Copilot agents spawn authenticated"
  else
    log "WARNING: could not seed COPILOT_GITHUB_TOKEN into the env registry"
  fi
else
  log "no COPILOT_GITHUB_TOKEN — Copilot agents stop at /login (add: docker run -e COPILOT_GITHUB_TOKEN=...)"
fi

# ------------------------------------------------------------- demo site up
log "serving the demo site on :5173 (proxy → 127.0.0.1:7591)"
cd /opt/herdr-web-broker/packages/demo-web
# hand the admin token to the site server so POST /demo/mint (self-serve
# demo tokens) can forward it — the secret stays server-side
ADMIN_TOKEN_VALUE=""
[ -n "$ADMIN_TOKEN_FILE" ] && ADMIN_TOKEN_VALUE=$(cat "$ADMIN_TOKEN_FILE")
# DEMO_MINT_ALLOW_REMOTE: this container is a deliberately-open demo box
# (its bearer is printed in the docs) — dev servers stay loopback-only
VITE_BROKER_TARGET=http://127.0.0.1:7591 BROKER_ADMIN_TOKEN="$ADMIN_TOKEN_VALUE" DEMO_MINT_ALLOW_REMOTE=1 \
  exec npx vite preview --host 0.0.0.0 --port 5173
