# herdr-web-broker demo: an HTTP endpoint that fulfills Copilot prompts.
#
# Inside this container:
#   herdr (installed via its official curl script) keeps a GitHub Copilot CLI
#   agent alive in a pane; the herdr-web-broker plugin (installed from GitHub
#   and linked into herdr) lifts herdr's local socket onto HTTP :7591.
# From the host, POST /parent/runtime/sessions/default/rpc drives the agent.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq procps \
  && rm -rf /var/lib/apt/lists/*

# herdr via its official installer
RUN curl -fsSL https://herdr.dev/install.sh | sh
# GitHub Copilot CLI via its official installer (root -> /usr/local/bin)
RUN curl -fsSL https://gh.io/copilot-install | bash

ENV PATH="/root/.local/bin:${PATH}"

# this plugin, from its published repo — the same clone-and-link path the
# README documents for users
RUN git clone --depth 1 https://github.com/JefeLabs/herdr-web-broker /opt/herdr-web-broker \
  && cd /opt/herdr-web-broker \
  && npm install --include=dev \
  && npm run build

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# broker REST/WS endpoint
EXPOSE 7591

# BROKER_TOKEN: bearer token the HTTP client presents (default demo-token)
# COPILOT_GITHUB_TOKEN: fine-grained PAT with the "Copilot Requests"
#   permission — without it the agent runs unauthenticated and the demo
#   validates prompt DELIVERY only
ENV BROKER_TOKEN=demo-token

ENTRYPOINT ["/entrypoint.sh"]
