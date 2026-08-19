#!/usr/bin/env bash
# Proves the demo end to end FROM THE HOST, entirely over HTTP:
#   build the image -> run it -> create a workspace -> start Copilot in a
#   pane -> send it a prompt -> read the pane back.
#
# Two tiers:
#   - with COPILOT_GITHUB_TOKEN exported (fine-grained PAT, "Copilot Requests"
#     permission): validates the full round trip — Copilot answers the prompt.
#   - without it: validates everything up to prompt fulfillment — herdr runs,
#     the plugin serves HTTP, Copilot launches in the pane (its sign-in screen
#     is the proof), and the prompt call reaches the agent seam.
set -euo pipefail

PORT="${PORT:-7591}"
TOKEN="${BROKER_TOKEN:-demo-token}"
IMG=herdr-web-broker-demo
NAME=herdr-web-broker-demo
BASE="http://127.0.0.1:${PORT}"
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

rpc() { # rpc <method> <params-json>
  curl -sS -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
    -X POST "${BASE}/parent/runtime/sessions/default/rpc" \
    -d "{\"method\":\"$1\",\"params\":$2}"
}

say "building image"
docker build -q -t "$IMG" "$HERE"

say "running container"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "${PORT}:7591" \
  -e BROKER_TOKEN="$TOKEN" \
  "$IMG" >/dev/null
# The Copilot token never enters the container at start — it travels over
# the API below (POST /parent/runtime/env), the way the headless UI does it.
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

say "waiting for /health"
for _ in $(seq 1 120); do
  curl -fsS "${BASE}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "${BASE}/health" | jq -c .

say "instances (authed)"
curl -fsS -H "Authorization: Bearer ${TOKEN}" "${BASE}/parent" | jq -c .

say "passing env to the broker at runtime (replaces docker -e)"
curl -sS -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  -X POST "${BASE}/parent/runtime/env" \
  -d '{"name":"HERDR_ENV_CANARY","value":"injected-ok","kind":"copilot"}' | jq -c .
if [ -n "${COPILOT_GITHUB_TOKEN:-}" ]; then
  jq -n --arg v "$COPILOT_GITHUB_TOKEN" '{name:"COPILOT_GITHUB_TOKEN",value:$v,kind:"copilot"}' |
    curl -sS -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
      -X POST "${BASE}/parent/runtime/env" -d @- | jq -c .
fi
LIST=$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${BASE}/parent/runtime/env")
echo "$LIST" | jq -c .
echo "$LIST" | grep -q "injected-ok" && { say "FAIL: env value leaked in list"; exit 1; }

say "creating a workspace through the endpoint"
WC=$(rpc workspace.create '{"cwd":"/work","label":"demo"}')
echo "$WC" | jq -c '.result.workspace // .'
PANE=$(echo "$WC" | jq -r '.result.root_pane.pane_id')
[ -n "$PANE" ] && [ "$PANE" != "null" ] || { echo "no pane id"; exit 1; }

say "starting Copilot CLI in pane $PANE through the endpoint"
rpc agent.start "{\"name\":\"copilot\",\"kind\":\"copilot\",\"pane_id\":\"$PANE\",\"timeout_ms\":60000}" | jq -c '.result.agent // .'

say "waiting for the agent to finish launching"
for _ in $(seq 1 60); do
  AGENTS=$(rpc agent.list '{}')
  PENDING=$(echo "$AGENTS" | jq -r '.result.agents[0].launch_pending // empty')
  [ "$PENDING" = "false" ] && break
  sleep 1
done
echo "$AGENTS" | jq -c '.result.agents[0] // .'

say "accepting Copilot's folder-trust dialog through the endpoint"
sleep 2
rpc pane.send_keys "{\"pane_id\":\"$PANE\",\"keys\":[\"1\"]}" | jq -c .
sleep 2

say "sending the prompt over HTTP"
PROMPT="Reply with exactly the word: pong"
PROMPT_JSON=$(jq -Rn --arg t "$PROMPT" '$t')
SENT=$(rpc agent.prompt "{\"target\":\"copilot\",\"text\":${PROMPT_JSON}}")
if echo "$SENT" | jq -e '.result' >/dev/null 2>&1; then
  PROMPT_OK=1
  echo "$SENT" | jq -c .
else
  PROMPT_OK=""
  echo "$SENT" | jq -c .
fi

say "reading the pane back over HTTP"
SCREEN=""
for _ in $(seq 1 45); do
  READ=$(rpc pane.read "{\"pane_id\":\"$PANE\",\"source\":\"visible\"}") || true
  SCREEN=$(echo "$READ" | jq -r '.result.read.text // empty' 2>/dev/null || true)
  # This agent was started via raw rpc agent.start, which bypasses the
  # broker's env injection on purpose — its live UI proves the chain.
  echo "$SCREEN" | grep -qiE "copilot|login" && break
  sleep 2
done
printf '%s\n' "--- pane screen (last read) ---"
printf '%s\n' "$SCREEN" | tail -20
printf '%s\n' "-------------------------------"

echo "$SCREEN" | grep -qiE "copilot|login" || { say "FAIL: Copilot UI never appeared in the pane"; exit 1; }
[ -n "$PROMPT_OK" ] || { say "FAIL: agent.prompt was refused"; exit 1; }
say "PASS (rpc passthrough): herdr + plugin + Copilot drove over HTTP"

echo "--- workspace & repos API ---"
# git and herdr live inside the container, not on the host (Dockerfile) — go
# through docker exec for those; the HTTP calls stay from the host, same as
# the rest of this script, since that's what's actually under test.
docker exec "$NAME" sh -c '
  git init -q /work/demo-repo && cd /work/demo-repo &&
  git config user.email demo@test && git config user.name demo &&
  echo one > a.txt && git add . && git commit -qm init
'

SPAWN=$(curl -sS -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  -X POST "${BASE}/parent/runtime/sessions/default/agents" \
  -d '{"kind":"copilot","cwd":"/work/demo-repo","label":"api-demo","name":"api-demo","timeout_ms":60000}')
echo "$SPAWN" | jq -c .
WS=$(echo "$SPAWN" | jq -r .workspace_id)

curl -sS -H "Authorization: Bearer ${TOKEN}" "${BASE}/parent/runtime/sessions/default/workspaces" | jq -c .
curl -sS -H "Authorization: Bearer ${TOKEN}" \
  "${BASE}/parent/runtime/sessions/default/workspaces/${WS}/repos/-/tree" | jq -c .tree

say "proving spawn injection via /proc environ"
sleep 3
CANARY_OK=""
for pid in $(docker exec "$NAME" pgrep -f copilot); do
  docker exec "$NAME" sh -c "tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep -q '^HERDR_ENV_CANARY=injected-ok$'" && { CANARY_OK=$pid; break; }
done
[ -n "$CANARY_OK" ] || { say "FAIL: no copilot process carries the injected canary"; exit 1; }
say "PASS (injection): pid $CANARY_OK inherited HERDR_ENV_CANARY through the pane shell"

if [ -n "${COPILOT_GITHUB_TOKEN:-}" ]; then
  say "full tier: prompting the runtime-authenticated agent"
  SPAWN_PANE=$(echo "$SPAWN" | jq -r .pane_id)
  sleep 5
  rpc pane.send_keys "{\"pane_id\":\"$SPAWN_PANE\",\"keys\":[\"1\"]}" >/dev/null; sleep 2
  rpc agent.prompt '{"target":"api-demo","text":"Reply with exactly the word: pong"}' | jq -c .
  ANSWERED=""
  for _ in $(seq 1 45); do
    S=$(rpc pane.read "{\"pane_id\":\"$SPAWN_PANE\",\"source\":\"visible\"}" | jq -r '.result.read.text // empty')
    echo "$S" | grep -qi "pong" && { ANSWERED=1; break; }
    sleep 2
  done
  [ -n "$ANSWERED" ] || { say "FAIL: runtime-token agent never answered"; exit 1; }
  say "PASS (full): token POSTed at runtime, agent spawned authenticated, prompt answered"
fi

docker exec "$NAME" sh -c 'echo two > /work/demo-repo/a.txt'
curl -sS -H "Authorization: Bearer ${TOKEN}" \
  "${BASE}/parent/runtime/sessions/default/workspaces/${WS}/repos/-/git/diff" | jq -r '.status, (.diff | length)'

echo "--- herdr schema verification (spec §8) ---"
docker exec "$NAME" herdr api schema --json | jq '[.schemas.request.oneOf[].properties.method.const // empty] | map(select(test("workspace|pane")))'
