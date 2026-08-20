# herdr-web-broker demo site: real herdr + the broker plugin + the React
# console, one container — the full "real usage" stack.
#
#   docker build -f demo/web/Dockerfile -t herdr-web-demo .
#   docker run --rm -p 5173:5173 -p 7591:7591 herdr-web-demo
#
#   site    http://localhost:5173   (vite preview, proxies to the broker)
#   broker  http://localhost:7591   (bearer: demo-token)
#
# Build context is the REPO ROOT (-f demo/web/Dockerfile .) so the image runs
# THIS working tree, not a published clone.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq procps \
  && rm -rf /var/lib/apt/lists/*

# herdr via its official installer
RUN curl -fsSL https://herdr.dev/install.sh | sh
# GitHub Copilot CLI so spawned `kind: copilot` agents have a real binary
# (unauthenticated without COPILOT_GITHUB_TOKEN — spawn/attach still works)
RUN curl -fsSL https://gh.io/copilot-install | bash

ENV PATH="/root/.local/bin:${PATH}"

# the plugin + demo site from the local checkout
COPY . /opt/herdr-web-broker
RUN cd /opt/herdr-web-broker \
  && npm install --include=dev \
  && npm run build \
  && cd demo/web \
  && npm install --include=dev \
  && npm run build

COPY demo/web/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5173 7591

# BROKER_TOKEN: bearer token the site and any HTTP client presents
ENV BROKER_TOKEN=demo-token

ENTRYPOINT ["/entrypoint.sh"]
