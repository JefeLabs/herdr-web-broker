#!/usr/bin/env bash
# Federation e2e: two REAL containers from the demo image — a parent and a
# child that dials out — driven from the host through the parent's API.
#
#   scripts/federation-test.sh                 # builds the image first
#   FED_SKIP_BUILD=1 scripts/federation-test.sh # reuse herdr-web-demo
set -euo pipefail

NET=herdr-fed
PPORT="${FED_PARENT_PORT:-7691}"

log() { printf '[federation] %s\n' "$*"; }

cleanup() {
  docker rm -f fed-parent fed-child >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

if [ -z "${FED_SKIP_BUILD:-}" ]; then
  log "building herdr-web-demo image"
  docker build -q -f packages/demo-web/Dockerfile -t herdr-web-demo . >/dev/null
fi

docker network create "$NET" >/dev/null
log "starting parent (host port ${PPORT})"
docker run -d --rm --name fed-parent --network "$NET" -p "${PPORT}:7591" herdr-web-demo >/dev/null

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${PPORT}/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "http://127.0.0.1:${PPORT}/health" >/dev/null || { log "parent never became healthy"; docker logs fed-parent; exit 1; }
log "parent healthy"

log "minting child secret on the parent (loopback admin)"
SECRET=$(docker exec fed-parent sh -c '
  ADMIN=$(cat $(find /root -name admin-token 2>/dev/null | head -1));
  curl -s -X POST -H "x-admin-token: $ADMIN" -H "content-type: application/json" \
    -d "{\"name\":\"laptop\"}" http://127.0.0.1:7591/admin/children
' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const b=JSON.parse(d);if(!b.secret){console.error(d);process.exit(1)}console.log(b.secret)})')
log "child secret minted (name: laptop)"

log "starting child — dials ws://fed-parent:7591 over the docker network"
docker run -d --rm --name fed-child --network "$NET" \
  -e BROKER_PARENT_ADDRESS=ws://fed-parent:7591 \
  -e BROKER_PARENT_SECRET="$SECRET" \
  -e BROKER_PARENT_NAME=laptop \
  herdr-web-demo >/dev/null

log "probing the child through the parent"
BROKER_URL="http://127.0.0.1:${PPORT}" node scripts/federation-probe.mjs

log "stopping the child — the parent must notice"
docker stop fed-child >/dev/null
BROKER_URL="http://127.0.0.1:${PPORT}" node scripts/federation-probe.mjs --phase=offline

log "all green"
